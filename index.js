// ============================================================
// LYVON x TUPS Thailand — Omise charge server
//
// This is the ONLY place your Omise Secret Key should ever live.
// Never put the secret key in checkout.html or any browser code.
//
// Deploy this on a real server (Render, Railway, Fly.io, your own
// VPS, etc.) — it cannot run from a static file host.
//
// Endpoints:
//   POST /charge                 — card payments (existing, unchanged)
//   POST /promptpay-charge       — NEW: creates a PromptPay source + charge
//                                   for the EXACT order amount, and returns
//                                   the QR code image (embedded as base64)
//   GET  /charge-status/:id      — NEW: poll this until status is
//                                   "successful" (paid=true) to confirm the
//                                   exact amount was actually received
//                                   before telling the customer their order
//                                   is confirmed
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

// ------------------------------------------------------------
// POST /charge  (existing — card payments)
// body: { omiseToken, amount, currency, customer: { name, phone, address } }
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// POST /promptpay-charge  (NEW)
//
// This is the fix for "손님이 담은 금액만큼 딱 결제를 청구해야 한다":
// instead of a static QR where the customer types in whatever amount
// they feel like, we create a real Omise PromptPay Source for the
// EXACT order total. The QR that comes back has that amount baked
// into it — scanning it in any Thai banking app pre-fills the amount
// and the customer CANNOT change it or pay a different amount.
//
// body: { amount, currency, customer: { name, phone, address } }
//   amount   = integer, in satang (THB total x 100) — e.g. ฿2,150 -> 215000
//   currency = "thb"
//
// response: { success, chargeId, status, qrImageBase64, expiresAt }
// ------------------------------------------------------------
app.post('/promptpay-charge', async (req, res) => {
  const { amount, currency, customer } = req.body;

  if (!amount || !currency) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  if (!Number.isInteger(amount) || amount < 100) {
    // Omise requires >= 20 THB (2000 satang) for PromptPay in practice;
    // 100 satang (1 THB) is the hard floor we allow for test orders.
    return res.status(400).json({ success: false, message: 'Invalid amount' });
  }

  try {
    // 1. Create the PromptPay source for this exact amount.
    const source = await omise.sources.create({
      type: 'promptpay',
      amount,
      currency,
    });

    // 2. Create a charge against that source. This is what actually
    //    generates the scannable QR code tied to this exact amount.
    const charge = await omise.charges.create({
      amount,
      currency,
      source: source.id,
      description: `TUPS Thailand order — ${customer?.name || 'customer'}`,
      metadata: {
        customer_name: customer?.name || '',
        customer_phone: customer?.phone || '',
        shipping_address: customer?.address || '',
      },
    });

    // 3. Fetch the QR image bytes from Omise (requires secret-key auth,
    //    which is why this has to happen on the server, not the browser)
    //    and hand them back to the frontend as a data URI so checkout.html
    //    can just drop it straight into an <img src="..."> with no further
    //    authenticated requests needed.
    const downloadUri = charge?.source?.scannable_code?.image?.download_uri;
    let qrImageBase64 = null;

    if (downloadUri) {
      const basicAuth = Buffer.from(`${process.env.OMISE_SECRET_KEY}:`).toString('base64');
      const imgResp = await fetch(downloadUri, {
        headers: { Authorization: `Basic ${basicAuth}` },
      });
      if (imgResp.ok) {
        const buf = Buffer.from(await imgResp.arrayBuffer());
        const contentType = imgResp.headers.get('content-type') || 'image/png';
        qrImageBase64 = `data:${contentType};base64,${buf.toString('base64')}`;
      }
    }

    return res.json({
      success: true,
      chargeId: charge.id,
      status: charge.status,          // "pending" right after creation
      paid: !!charge.paid,
      amount: charge.amount,
      qrImageBase64,                   // null if Omise hasn't generated the image yet — frontend should treat this as "try charge-status shortly" or show a fallback
      expiresAt: charge.expires_at || null,
    });
  } catch (err) {
    console.error('Omise PromptPay charge error:', err?.message || err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Server error while creating PromptPay charge',
    });
  }
});

// ------------------------------------------------------------
// GET /charge-status/:id  (NEW)
//
// The frontend polls this every few seconds after showing the QR.
// Only when this reports paid=true / status="successful" should the
// site tell the customer their order is confirmed and notify LINE —
// this is what guarantees the FULL, EXACT amount actually arrived.
// ------------------------------------------------------------
app.get('/charge-status/:id', async (req, res) => {
  try {
    const charge = await omise.charges.retrieve(req.params.id);
    return res.json({
      success: true,
      status: charge.status,   // "pending" | "successful" | "failed" | "expired" | "reversed"
      paid: !!charge.paid,
      amount: charge.amount,
      currency: charge.currency,
    });
  } catch (err) {
    console.error('Omise charge-status error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Server error while checking charge status' });
  }
});

app.get('/', (req, res) => res.send('LYVON TUPS payment server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Payment server listening on port ${PORT}`));
