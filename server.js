const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const app     = express();

// ── One-time confirmation tokens ─────────────────────────────────────────────
// Tokens are valid for 10 minutes and consumed on first use.
const confirmTokens = new Map(); // token → { dest, expires }

function issueToken(dest) {
  const token   = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + 10 * 60 * 1000; // 10 min
  confirmTokens.set(token, { dest, expires });
  // Purge stale tokens periodically
  for (const [k, v] of confirmTokens) {
    if (v.expires < Date.now()) confirmTokens.delete(k);
  }
  return token;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/rsvp', async (req, res) => {
  const {
    email, fname, lname, org,
    tierLabel, seatsLabel, paymentLabel,
    dietary, note, payment
  } = req.body;

  if (!email || !fname || !tierLabel) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const BREVO_KEY      = process.env.BREVO_API_KEY;
  const AT_TOKEN       = process.env.AIRTABLE_TOKEN;
  const AT_BASE        = process.env.AIRTABLE_BASE  || 'appO5M6E0blQZQGZ8';
  const AT_TABLE       = process.env.AIRTABLE_TABLE || 'tblANDnQIZaUEjt7S';
  const isPrepay       = payment === 'prepay';

  try {
    // ── Step 1: Brevo contact ──────────────────────────────────────────────
    await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify({
        email,
        updateEnabled: true,
        listIds: [2],
        attributes: {
          FIRSTNAME:           fname,
          LASTNAME:            lname,
          COMPANY:             org,
          UCC_DINNER_TIER:     tierLabel,
          UCC_DINNER_SEATS:    seatsLabel,
          UCC_DINNER_PAYMENT:  paymentLabel,
          UCC_DINNER_DIETARY:  dietary,
          UCC_DINNER_NOTE:     note
        }
      })
    });

    // ── Step 2: Brevo confirmation email ──────────────────────────────────
    // Compute amount string from seatsLabel (e.g. "2 seats" → $10,000)
    const seatMatch  = (seatsLabel || '').match(/^(\d+)/);
    const seatCount  = seatMatch ? parseInt(seatMatch[1]) : 1;
    const amountStr  = seatsLabel && seatsLabel.includes('+')
      ? 'Contact UCC'
      : `$${(seatCount * 5000).toLocaleString()}`;

    // Build the prepay URL so the email can link directly to /pay
    const BASE_URL   = process.env.BASE_URL || 'https://ucc-dinner.onrender.com';
    const payParams  = new URLSearchParams({
      name:   `${fname} ${lname}`,
      tier:   seatsLabel,
      amount: amountStr,
      email
    });
    const payLink    = `${BASE_URL}/pay?${payParams.toString()}`;

    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify({
        to: [{ email, name: `${fname} ${lname}` }],
        replyTo: { email: 'info@unitedchangerscoalition.org', name: 'United Changers Coalition' },
        templateId: isPrepay ? 2 : 1,
        params: {
          FNAME:            fname,
          LNAME:            lname,
          ORG:              org || '',
          TIER:             tierLabel,
          SEATS:            seatsLabel,
          AMOUNT:           amountStr,
          IS_PREPAY:        isPrepay,
          PAY_LINK:         payLink,
          PAYMENT_CHOICE:   isPrepay ? 'Prepay' : 'Pay at Event',
          PAYMENT_COLOR:    isPrepay ? '#2A9D8F' : '#5B2A86',
          PAYMENT_HEADLINE: isPrepay ? 'Complete your payment to lock your seat' : 'Your seat is held on your commitment',
          PAYMENT_BODY:     isPrepay
            ? `Your seat is held for 72 hours. Use the link below to complete payment now, or wait for wire/card instructions from UCC within 24 hours.`
            : `Payment is due at check-in. Accepted: card, wire, or check. A reminder will be sent 7 days before the event.`,
          NEXT_STEP_1:      isPrepay
            ? 'Complete payment via the link below — seat held 72 hours'
            : 'A payment reminder will be sent 7 days before the event'
        }
      })
    });

    // ── Step 3: Airtable — ensure fields exist, then write row ───────────
    const AT_HEADERS = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${AT_TOKEN}`
    };

    const REQUIRED_FIELDS = [
      { name: 'First Name',         type: 'singleLineText' },
      { name: 'Last Name',          type: 'singleLineText' },
      { name: 'Email',              type: 'email' },
      { name: 'Organization',       type: 'singleLineText' },
      { name: 'Tier',               type: 'singleLineText' },
      { name: 'Seats',              type: 'singleLineText' },
      { name: 'Payment Preference', type: 'singleLineText' },
      { name: 'Dietary / Access',   type: 'singleLineText' },
      { name: 'Note to UCC',        type: 'multilineText'  },
      { name: 'Submitted At',       type: 'singleLineText' }
    ];

    // Auto-create any missing fields
    try {
      const schemaRes = await fetch(
        `https://api.airtable.com/v0/meta/bases/${AT_BASE}/tables`,
        { headers: AT_HEADERS }
      );
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const table  = (schema.tables || []).find(t => t.id === AT_TABLE);
        const existingNames = new Set((table?.fields || []).map(f => f.name));
        for (const field of REQUIRED_FIELDS) {
          if (!existingNames.has(field.name)) {
            await fetch(
              `https://api.airtable.com/v0/meta/bases/${AT_BASE}/tables/${AT_TABLE}/fields`,
              {
                method: 'POST',
                headers: AT_HEADERS,
                body: JSON.stringify({ name: field.name, type: field.type })
              }
            );
            console.log(`Created Airtable field: ${field.name}`);
          }
        }
      }
    } catch (schemaErr) {
      console.error('Airtable schema check (non-fatal):', schemaErr.message);
    }

    // Write the record
    const atRes = await fetch(
      `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`,
      {
        method: 'POST',
        headers: AT_HEADERS,
        body: JSON.stringify({
          fields: {
            'First Name':          fname,
            'Last Name':           lname,
            'Email':               email,
            'Organization':        org          || '',
            'Tier':                tierLabel,
            'Seats':               seatsLabel,
            'Payment Preference':  paymentLabel,
            'Dietary / Access':    dietary      || '',
            'Note to UCC':         note         || '',
            'Submitted At':        new Date().toISOString()
          }
        })
      }
    );

    if (!atRes.ok) {
      const atErr = await atRes.text();
      console.error('Airtable write error:', atErr);
    } else {
      console.log('Airtable record created successfully');
    }

    // Issue a short-lived token so the client can access the gated confirmation page
    const confirmToken = issueToken('confirm');
    return res.status(200).json({ success: true, token: confirmToken });

  } catch (err) {
    console.error('RSVP error:', err);
    return res.status(500).json({ error: 'Submission failed' });
  }
});

// ── Gated confirmation pages ─────────────────────────────────────────────────
function serveGated(page) {
  return (req, res) => {
    const token = req.query.token;
    if (!token) return res.redirect('/');
    const entry = confirmTokens.get(token);
    if (!entry || entry.expires < Date.now()) {
      confirmTokens.delete(token);
      return res.redirect('/');
    }
    // Consume the token (one-time use)
    confirmTokens.delete(token);
    res.sendFile(path.join(__dirname, 'public', page));
  };
}

app.get('/confirm', serveGated('confirm.html'));
app.get('/pay',     serveGated('pay.html'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UCC Dinner running on port ${PORT}`));
