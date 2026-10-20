// ============================================================
// LYVON x TUPS Thailand — Omise charge server + order database
//
// This is the ONLY place your Omise Secret Key and Supabase keys
// should ever live. Never put secret keys in checkout.html,
// signup.html, admin.html, or any browser code.
//
// Deploy this on a real server (Render, Railway, Fly.io, your own
// VPS, etc.) — it cannot run from a static file host.
//
// Endpoints:
//   POST /charge                 — card payments. Handles 3-D Secure: if the
//                                   card issuer requires it, returns
//                                   { pending: true, authorizeUri } instead of
//                                   an immediate success/fail — the frontend
//                                   must redirect the browser to authorizeUri.
//   POST /promptpay-charge       — creates a PromptPay source + charge for the
//                                   EXACT order amount, and returns the QR
//                                   code image (embedded as base64)
//   GET  /charge-status/:id      — poll this until status is "successful"
//                                   (paid=true) to confirm the exact amount
//                                   was actually received before telling the
//                                   customer their order is confirmed
//   POST /signup                 — create a member account (password is
//                                   hashed before it's ever stored)
//   POST /login                  — verify a member's email + password
//   GET  /my-orders               — a logged-in member's own order history
//   POST /my-orders/:chargeId/cancel — customer self-cancels + refunds their
//                                   own order (only before it has shipped)
//   GET  /admin/orders           — list all orders (requires x-admin-key header)
//   GET  /admin/members          — list all signed-up members (requires x-admin-key header)
//   PATCH /admin/orders/:chargeId — update shipping_status / tracking_number /
//                                   courier for one order (requires x-admin-key header)
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const omise = require('omise')({
  publicKey: process.env.OMISE_PUBLIC_KEY,
  secretKey: process.env.OMISE_SECRET_KEY, // skey_test_... or skey_live_...  — from .env only
  omiseVersion: '2019-05-29',
});

const app = express();
app.use(cors());          // restrict this to your real site domain in production
app.use(express.json());

// Fallback return_uri for 3-D Secure if the frontend doesn't send one —
// Omise redirects the customer's browser here after they complete their
// bank's verification step.
const DEFAULT_RETURN_URI = 'https://lyvonthai.com/checkout.html';

// ------------------------------------------------------------
// SUPABASE (order + member database)
//
// We talk to Supabase's built-in REST API (PostgREST) directly with
// fetch() instead of adding the @supabase/supabase-js package — this
// keeps the server to zero new dependencies, which matters since this
// repo is edited through GitHub's web editor rather than a local dev
// setup with npm install.
//
// Required env vars on Render:
//   SUPABASE_URL          e.g. https://xxxxxxxx.supabase.co
//   SUPABASE_SERVICE_KEY   the "secret key (default)" from Supabase → API Keys
//   ADMIN_KEY               any password you choose, used to protect /admin/*
// ------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseRequest(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(options.headers || {}),
    },
  });
}

// Writes (or updates, if we've already seen this charge id before) one row
// into the `orders` table from a live Omise charge object. Safe to call more
// than once for the same charge (e.g. every time /charge-status is polled) —
// it upserts on charge_id, so the row's status just gets kept up to date.
async function saveOrderFromCharge(charge) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Supabase not configured — SUPABASE_URL / SUPABASE_SERVICE_KEY missing, order not saved');
    return;
  }
  try {
    let items = [];
    try { items = JSON.parse(charge?.metadata?.items_json || '[]'); } catch (e) { items = []; }
    const paymentMethod = charge?.card ? 'card' : (charge?.source && charge.source.type) || 'unknown';
    const row = {
      charge_id: charge.id,
      customer_name: charge?.metadata?.customer_name || '',
      customer_phone: charge?.metadata?.customer_phone || '',
      shipping_address: charge?.metadata?.shipping_address || '',
      member_email: (charge?.metadata?.member_email || '').toLowerCase() || null,
      items,
      amount: charge.amount,
      currency: charge.currency,
      payment_method: paymentMethod,
      status: charge.status,
      // Deliberately NOT including shipping_status / tracking_number / courier
      // here: those are set later by /admin (or, once wired up, automatically
      // by the courier integration) and must survive every repeat call this
      // function gets from /charge-status polling. Omitting a key from this
      // upsert leaves whatever is already in that column untouched.
    };
    const res = await supabaseRequest('orders?on_conflict=charge_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error('Supabase order save failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Supabase order save error:', err);
  }
}

// ------------------------------------------------------------
// POST /charge  (card payments)
// body: { omiseToken, amount, currency, customer: { name, phone, address }, items, returnUri, memberEmail }
// ------------------------------------------------------------
app.post('/charge', async (req, res) => {
  const { omiseToken, amount, currency, customer, items, returnUri, memberEmail } = req.body;

  if (!omiseToken || !amount || !currency) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const charge = await omise.charges.create({
      amount,                 // amount in satang (THB x 100)
      currency,                // "thb"
      card: omiseToken,        // token or source id from Omise.js on the frontend
      return_uri: returnUri || DEFAULT_RETURN_URI, // required whenever 3-D Secure is triggered
      description: `TUPS Thailand order — ${customer?.name || 'customer'}`,
      metadata: {
        customer_name: customer?.name || '',
        customer_phone: customer?.phone || '',
        shipping_address: customer?.address || '',
        items_json: JSON.stringify(items || []),
        // Only set when the customer was logged in at checkout — lets /my-orders
        // find this order later. Guest checkouts simply have no member_email.
        member_email: memberEmail || '',
      },
    });

    // Record this charge attempt in the order database no matter how it
    // turns out (successful / pending-3DS / failed) — this is what lets the
    // admin page show the full picture, not just completed sales.
    await saveOrderFromCharge(charge);

    if (charge.status === 'successful' || charge.paid) {
      return res.json({ success: true, chargeId: charge.id });
    }

    if (charge.status === 'pending' && charge.authorize_uri) {
      // 3-D Secure (or another authorize-type step) is required. The frontend
      // must redirect the customer's whole browser to authorize_uri; Omise
      // will send them back to return_uri once they finish verifying with
      // their bank, at which point /charge-status/:id tells us the outcome.
      return res.json({
        success: true,
        pending: true,
        chargeId: charge.id,
        authorizeUri: charge.authorize_uri,
      });
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
// POST /promptpay-charge
//
// Creates a real Omise PromptPay Source for the EXACT order total, so the
// QR that comes back has that amount baked in — the customer cannot pay a
// different amount.
//
// body: { amount, currency, customer: { name, phone, address }, items, memberEmail }
//   amount   = integer, in satang (THB total x 100) — e.g. ฿2,150 -> 215000
//   currency = "thb"
//
// response: { success, chargeId, status, qrImageBase64, expiresAt }
// ------------------------------------------------------------
app.post('/promptpay-charge', async (req, res) => {
  const { amount, currency, customer, items, memberEmail } = req.body;

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
        items_json: JSON.stringify(items || []),
        member_email: memberEmail || '',
      },
    });

    // Record the attempt right away (status will be "pending" here — the
    // row gets updated to "successful" once /charge-status sees it paid).
    await saveOrderFromCharge(charge);

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
// GET /charge-status/:id
//
// The frontend polls this every few seconds after showing the QR, or after
// the customer returns from a 3-D Secure redirect. Only when this reports
// paid=true / status="successful" should the site tell the customer their
// order is confirmed and notify LINE — this is what guarantees the FULL,
// EXACT amount actually arrived. Each poll also refreshes the order's row
// in the database, so a PromptPay order's status moves from "pending" to
// "successful" (or "failed"/"expired") automatically.
// ------------------------------------------------------------
app.get('/charge-status/:id', async (req, res) => {
  try {
    const charge = await omise.charges.retrieve(req.params.id);
    await saveOrderFromCharge(charge);
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

// ------------------------------------------------------------
// Password hashing (built into Node, no extra dependency needed)
// ------------------------------------------------------------
// Must include an uppercase letter, a lowercase letter, and at least one
// symbol (non-letter, non-number character), minimum 8 characters total.
// Kept in sync with the same rule enforced in signup.html on the frontend —
// this is the real gate, since the frontend check alone can be bypassed.
const PASSWORD_RULE = /^(?=.*[A-Z])(?=.*[a-z])(?=.*[^A-Za-z0-9]).{8,}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  try {
    const hashBuffer = Buffer.from(hash, 'hex');
    const suppliedBuffer = crypto.scryptSync(password, salt, 64);
    if (hashBuffer.length !== suppliedBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, suppliedBuffer);
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// POST /signup
// body: { email, password, name, phone }
// ------------------------------------------------------------
app.post('/signup', async (req, res) => {
  const { email, password, name, phone } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }
  if (!PASSWORD_RULE.test(password)) {
    return res.status(400).json({
      success: false,
      message: 'Password must include an uppercase letter, a lowercase letter, and a symbol, with at least 8 characters.',
    });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ success: false, message: 'Database is not configured yet' });
  }

  try {
    const row = {
      email: String(email).trim().toLowerCase(),
      password_hash: hashPassword(password),
      name: name || '',
      phone: phone || '',
    };
    const sbRes = await supabaseRequest('members', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });

    if (sbRes.ok) {
      return res.json({ success: true });
    }

    const errText = await sbRes.text();
    if (sbRes.status === 409 || errText.includes('duplicate key')) {
      return res.status(409).json({ success: false, message: 'This email is already registered' });
    }
    console.error('Supabase signup error:', sbRes.status, errText);
    return res.status(500).json({ success: false, message: 'Server error while creating account' });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ success: false, message: 'Server error while creating account' });
  }
});

// ------------------------------------------------------------
// POST /login
// body: { email, password }
// Note: this is a lightweight check, not a full session/auth system —
// there's no login token issued. The frontend just remembers the
// returned member info locally after a successful check. Good enough
// for a simple membership page; upgrade later if real account pages
// (order history, saved addresses, etc.) get built.
// ------------------------------------------------------------
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ success: false, message: 'Database is not configured yet' });
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const sbRes = await supabaseRequest(
      `members?email=eq.${encodeURIComponent(normalizedEmail)}&select=id,email,name,phone,password_hash`
    );
    if (!sbRes.ok) {
      console.error('Supabase login lookup failed:', sbRes.status, await sbRes.text());
      return res.status(500).json({ success: false, message: 'Server error while logging in' });
    }
    const rows = await sbRes.json();
    const member = rows[0];

    if (!member || !verifyPassword(password, member.password_hash)) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password' });
    }

    return res.json({
      success: true,
      member: { id: member.id, email: member.email, name: member.name, phone: member.phone },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Server error while logging in' });
  }
});

// ------------------------------------------------------------
// GET /my-orders?email=...
//
// Lets a logged-in customer see their own order history, including the
// shipping status (order_placed / preparing / shipped / delivered) and
// tracking number once one is set. There's no login token/session here —
// the frontend just sends the email it has stored from /login — so this
// is a lightweight convenience, not a hardened private endpoint. Good
// enough for a small membership site; revisit if that ever matters more.
// ------------------------------------------------------------
app.get('/my-orders', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ success: false, message: 'Database is not configured yet' });
  }
  try {
    const sbRes = await supabaseRequest(
      `orders?member_email=eq.${encodeURIComponent(email)}&select=charge_id,items,amount,currency,payment_method,status,shipping_status,tracking_number,courier,refund_status,created_at&order=created_at.desc&limit=200`
    );
    if (!sbRes.ok) {
      console.error('My-orders fetch failed:', sbRes.status, await sbRes.text());
      return res.status(500).json({ success: false, message: 'Server error' });
    }
    const data = await sbRes.json();
    return res.json({ success: true, orders: data });
  } catch (err) {
    console.error('My-orders fetch error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /my-orders/:chargeId/cancel
// body: { email }
//
// Lets a customer cancel an order THEY placed, themselves — but only up
// until an admin has moved it to "shipped" or "delivered" in /admin/orders.
// Once it's shipped, the package may already be on its way, so the customer
// needs to contact us directly instead. Same lightweight auth as
// /my-orders: we just check the email the frontend has stored from /login
// against the order's member_email — this is not a hardened private
// endpoint, same caveat as /my-orders and /login above.
//
// IMPORTANT: Omise does NOT support refunding PromptPay charges through
// their API at all ("PromptPay charges cannot be voided or refunded through
// Opn Payments") — only card charges can be refunded automatically here.
// So this branches on payment_method:
//   - card:      calls Omise's refund API right away -> charge becomes
//                "reversed" and the customer is refunded automatically.
//   - promptpay: Omise can't do this for us. We still stop the order going
//                any further (shipping_status -> "cancelled"), but the
//                actual money has to be sent back manually (bank transfer)
//                by us — refund_status is set to "pending_manual" so it
//                shows up clearly in /admin until someone marks it done.
// ------------------------------------------------------------
app.post('/my-orders/:chargeId/cancel', async (req, res) => {
  const chargeId = req.params.chargeId;
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ success: false, message: 'Database is not configured yet' });
  }

  try {
    const sbRes = await supabaseRequest(`orders?charge_id=eq.${encodeURIComponent(chargeId)}&select=*`);
    if (!sbRes.ok) {
      console.error('Cancel-order lookup failed:', sbRes.status, await sbRes.text());
      return res.status(500).json({ success: false, message: 'Server error' });
    }
    const rows = await sbRes.json();
    const order = rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if ((order.member_email || '').toLowerCase() !== email) {
      return res.status(403).json({ success: false, message: 'You can only cancel your own orders' });
    }
    if (order.status !== 'successful') {
      return res.status(400).json({ success: false, message: 'Only paid orders can be cancelled' });
    }
    const NON_CANCELLABLE_SHIPPING = ['shipped', 'delivered', 'cancelled'];
    if (NON_CANCELLABLE_SHIPPING.includes(order.shipping_status)) {
      return res.status(400).json({
        success: false,
        message: order.shipping_status === 'cancelled'
          ? 'This order has already been cancelled.'
          : 'This order has already shipped and can no longer be cancelled here — please contact us directly.',
      });
    }

    if (order.payment_method === 'card') {
      // Real Omise refund — this is the part that actually reverses the
      // card charge and returns the money to the customer's card.
      await omise.charges.createRefund(chargeId, { amount: order.amount });

      // Pull the now-refunded charge back and let the same upsert every
      // other endpoint uses keep the orders table's status column
      // consistent (it should come back as "reversed").
      const charge = await omise.charges.retrieve(chargeId);
      await saveOrderFromCharge(charge);

      await supabaseRequest(`orders?charge_id=eq.${encodeURIComponent(chargeId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ shipping_status: 'cancelled', refund_status: 'refunded' }),
      });

      return res.json({ success: true, manual: false, status: charge.status, refund_status: 'refunded' });
    }

    // Non-card (PromptPay, etc.) — Omise can't refund this for us, so we
    // only stop fulfillment here and flag it for a manual bank transfer.
    await supabaseRequest(`orders?charge_id=eq.${encodeURIComponent(chargeId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ shipping_status: 'cancelled', refund_status: 'pending_manual' }),
    });

    return res.json({
      success: true,
      manual: true,
      status: order.status,
      refund_status: 'pending_manual',
      message: 'Your cancellation request has been received. Since this order was paid via PromptPay, our team will transfer your refund manually within 1–3 business days.',
    });
  } catch (err) {
    console.error('Cancel-order error:', err?.message || err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Server error while cancelling this order',
    });
  }
});

// ------------------------------------------------------------
// Admin endpoints — protected by a shared secret (ADMIN_KEY env var).
// The admin.html page asks for this key once and sends it as the
// x-admin-key header on every request.
// ------------------------------------------------------------
function requireAdminKey(req, res) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/admin/orders', async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  try {
    const sbRes = await supabaseRequest('orders?select=*&order=created_at.desc&limit=300');
    if (!sbRes.ok) {
      console.error('Admin orders fetch failed:', sbRes.status, await sbRes.text());
      return res.status(500).json({ success: false, message: 'Server error' });
    }
    const data = await sbRes.json();
    return res.json({ success: true, orders: data });
  } catch (err) {
    console.error('Admin orders fetch error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /admin/orders/:chargeId
// body: { shipping_status?, tracking_number?, courier?, refund_status? }
// Manual way to move an order through order_placed -> preparing -> shipped
// -> delivered and attach a tracking number, until the Kerry Express API
// integration is wired up to do this automatically. "cancelled" is also a
// valid shipping_status — either the customer self-cancelled via
// /my-orders/:chargeId/cancel, or an admin sets it here directly.
// refund_status lets an admin mark a PromptPay order's manual bank refund
// as done once they've actually sent the money back (see the cancel
// endpoint above for why PromptPay can't be refunded through Omise).
app.patch('/admin/orders/:chargeId', async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const { shipping_status, tracking_number, courier, refund_status } = req.body;
  const ALLOWED_STATUSES = ['order_placed', 'preparing', 'shipped', 'delivered', 'cancelled'];
  if (shipping_status && !ALLOWED_STATUSES.includes(shipping_status)) {
    return res.status(400).json({ success: false, message: 'Invalid shipping_status' });
  }
  const ALLOWED_REFUND_STATUSES = ['none', 'pending_manual', 'refunded'];
  if (refund_status && !ALLOWED_REFUND_STATUSES.includes(refund_status)) {
    return res.status(400).json({ success: false, message: 'Invalid refund_status' });
  }
  const patch = {};
  if (shipping_status !== undefined) patch.shipping_status = shipping_status;
  if (tracking_number !== undefined) patch.tracking_number = tracking_number;
  if (courier !== undefined) patch.courier = courier;
  if (refund_status !== undefined) patch.refund_status = refund_status;
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, message: 'Nothing to update' });
  }
  try {
    const sbRes = await supabaseRequest(`orders?charge_id=eq.${encodeURIComponent(req.params.chargeId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!sbRes.ok) {
      console.error('Admin order update failed:', sbRes.status, await sbRes.text());
      return res.status(500).json({ success: false, message: 'Server error' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin order update error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/admin/members', async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  try {
    // Never select password_hash here.
    const sbRes = await supabaseRequest('members?select=id,email,name,phone,created_at&order=created_at.desc&limit=1000');
    if (!sbRes.ok) {
      console.error('Admin members fetch failed:', sbRes.status, await sbRes.text());
      return res.status(500).json({ success: false, message: 'Server error' });
    }
    const data = await sbRes.json();
    return res.json({ success: true, members: data });
  } catch (err) {
    console.error('Admin members fetch error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/', (req, res) => res.send('LYVON TUPS payment server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Payment server listening on port ${PORT}`));
