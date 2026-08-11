// ============================================================
// LYVON x TUPS Thailand — Omise charge server (example)
//
// This is the ONLY place your Omise Secret Key should ever live.
// Never put the secret key in checkout.html or any browser code.
//
// Deploy this on a real server (Render, Railway, Fly.io, your own
// VPS, etc.) — it cannot run from a static file host.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const omise = require('omise')({
  publicKey: process.env.OMISE_PUBLIC_KEY,
  secretKey: process.env.OMISE_SECRET_KEY, // skey_test_... or skey_live_...  — from .env only
  omiseVersion: '2019-05-29',
});

const app = express();
app.use(cors());          // restrict this to your real site domain in production
app.use(express.json());

// POST /charge
// body: { omiseToken, amount, currency, customer: { name, phone, address } }
app.post('/charge', async (req, res) => {
  const { omiseToken, amount, currency, customer } = req.body;

  if (!omiseToken || !amount || !currency) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const charge = await omise.charges.create({
      amount,                 // amount in satang (THB x 100)
      currency,                // "thb"
      card: omiseToken,        // token or source id from Omise.js on the frontend
      description: `TUPS Thailand order — ${customer?.name || 'customer'}`,
      metadata: {
        customer_name: customer?.name || '',
        customer_phone: customer?.phone || '',
        shipping_address: customer?.address || '',
      },
    });

    if (charge.status === 'successful' || charge.paid) {
      // TODO: save the order to your database here
      // TODO: send order confirmation (e.g. LINE Notify, email) here
      return res.json({ success: true, chargeId: charge.id });
    }

    return res.status(402).json({
      success: false,
      message: charge.failure_message || 'Payment was not successful',
    });
  } catch (err) {
    console.error('Omise charge error:', err);
    return res.status(500).json({ success: false, message: 'Server error while processing payment' });
  }
});

app.get('/', (req, res) => res.send('LYVON TUPS payment server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Payment server listening on port ${PORT}`));
