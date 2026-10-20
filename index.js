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
//   GET  /admin/orders           — list all orders (requires x-admin-key header)
//   GET  /admin/members          — list all signed-up members (requires x-admin-key header)
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
      items,
      amount: charge.amount,
      currency: charge.currency,
      payment_method: paymentMethod,
      status: charge.status,
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
// body: { omiseToken, amount, currency, customer: { name, phone, address }, items, returnUri }
// ------------------------------------------------------------
app.post('/charge', async (req, res) => {
  const { omiseToken, amount, currency, customer, items, returnUri } = req.body;

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
// body: { amount, currency, customer: { name, phone, address }, items }
//   amount   = integer, in satang (THB total x 100) — e.g. ฿2,150 -> 215000
//   currency = "thb"
//
// response: { success, chargeId, status, qrImageBase64, expiresAt }
// ------------------------------------------------------------
app.post('/promptpay-charge', async (req, res) => {
  const { amount, currency, customer, items } = req.body;

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
