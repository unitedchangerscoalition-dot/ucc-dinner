export default async function handler(req, res) {
  // Allow CORS from any origin (this is our own frontend)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    email, fname, lname, org,
    tierLabel, seatsLabel, paymentLabel,
    dietary, note, payment
  } = req.body;

  if (!email || !fname || !tierLabel) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const API_KEY = process.env.BREVO_API_KEY;
  const isPrepay = payment === 'prepay';

  try {
    // Step 1 — Create/update Brevo contact
    const contactRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
      body: JSON.stringify({
        email,
        updateEnabled: true,
        listIds: [2],
        attributes: {
          FIRSTNAME: fname,
          LASTNAME: lname,
          COMPANY: org,
          UCC_DINNER_TIER: tierLabel,
          UCC_DINNER_SEATS: seatsLabel,
          UCC_DINNER_PAYMENT: paymentLabel,
          UCC_DINNER_DIETARY: dietary,
          UCC_DINNER_NOTE: note
        }
      })
    });

    // Step 2 — Send confirmation email
    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
      body: JSON.stringify({
        to: [{ email, name: `${fname} ${lname}` }],
        templateId: 1,
        params: {
          TIER: tierLabel,
          SEATS: seatsLabel,
          PAYMENT_CHOICE: isPrepay ? 'Prepay' : 'Pay at Event',
          PAYMENT_COLOR: isPrepay ? '#2A9D8F' : '#5B2A86',
          PAYMENT_HEADLINE: isPrepay ? 'Payment instructions incoming' : 'Your seat is held on your commitment',
          PAYMENT_BODY: isPrepay
            ? `UCC leadership will send wire transfer or card payment instructions to ${email} within 24 hours. Your seat is held for 72 hours pending receipt of payment. Prepaid seats receive priority placement.`
            : `We're holding your seat on your word. Payment of ${tierLabel.split('—')[1]?.trim()} is due at check-in on the evening of the event. Accepted: card, wire, or check. A payment reminder will be sent 7 days before the event.`,
          NEXT_STEP_1: isPrepay
            ? 'Check your email — wire or card payment instructions arrive within 24 hours'
            : 'Check your email — a payment reminder will be sent 7 days before the event'
        }
      })
    });

    if (!contactRes.ok && contactRes.status !== 204) {
      const err = await contactRes.json();
      console.error('Contact error:', err);
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('RSVP error:', err);
    return res.status(500).json({ error: 'Submission failed' });
  }
}
