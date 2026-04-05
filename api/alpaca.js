/**
 * NZR — Alpaca Broker Proxy
 * All Alpaca API calls go through here so credentials never touch the browser.
 * Requires env vars: ALPACA_KEY_ID, ALPACA_SECRET_KEY
 * Optional:          ALPACA_BASE_URL (default: paper trading)
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];
const DEFAULT_BASE    = 'paper-api.alpaca.markets'; // swap to 'api.alpaca.markets' for live

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}

function alpacaRequest({ host, method, path, body, keyId, secretKey }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: host,
      path,
      method,
      headers: {
        'APCA-API-KEY-ID':     keyId,
        'APCA-API-SECRET-KEY': secretKey,
        'Content-Type':        'application/json',
        'Accept':              'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          resolve({ status: r.statusCode, body: d ? JSON.parse(d) : null });
        } catch {
          resolve({ status: r.statusCode, body: d });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const keyId     = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) {
    return res.status(503).json({ error: 'Alpaca not configured', connected: false });
  }

  const rawBase = process.env.ALPACA_BASE_URL || DEFAULT_BASE;
  const host    = rawBase.replace(/^https?:\/\//, '');
  const action  = req.query.action || '';
  const ctx     = { host, keyId, secretKey };

  try {
    // ── GET positions ───────────────────────────────────────────────────────
    if (action === 'positions' && req.method === 'GET') {
      const r = await alpacaRequest({ ...ctx, method: 'GET', path: '/v2/positions' });
      return res.status(r.status).json(r.body);
    }

    // ── GET orders ──────────────────────────────────────────────────────────
    if (action === 'orders' && req.method === 'GET') {
      const status = req.query.status || 'open';
      const after  = req.query.after  || '';
      const limit  = req.query.limit  || '500';
      let path = `/v2/orders?status=${encodeURIComponent(status)}&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const r = await alpacaRequest({ ...ctx, method: 'GET', path });
      return res.status(r.status).json(r.body);
    }

    // ── DELETE cancel single order ──────────────────────────────────────────
    if (action === 'cancel' && req.method === 'DELETE') {
      const orderId = String(req.query.orderId || '').replace(/[^a-zA-Z0-9\-]/g, '');
      if (!orderId) return res.status(400).json({ error: 'orderId required' });
      const r = await alpacaRequest({ ...ctx, method: 'DELETE', path: `/v2/orders/${orderId}` });
      return res.status(r.status).json(r.body ?? { cancelled: true });
    }

    // ── DELETE cancel all open orders ───────────────────────────────────────
    if (action === 'cancelall' && req.method === 'DELETE') {
      const r = await alpacaRequest({ ...ctx, method: 'DELETE', path: '/v2/orders' });
      return res.status(r.status).json(r.body ?? { cancelled: true });
    }

    // ── POST place order ────────────────────────────────────────────────────
    if (action === 'order' && req.method === 'POST') {
      const b = req.body || {};
      // Validate required fields
      const symbol = String(b.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
      const qty    = Number(b.qty);
      const side   = String(b.side || '').toLowerCase();
      const type   = String(b.type || 'market').toLowerCase();
      const tif    = String(b.time_in_force || 'day').toLowerCase();

      if (!symbol || !qty || !['buy','sell'].includes(side)) {
        return res.status(400).json({ error: 'symbol, qty, and side (buy/sell) are required' });
      }
      // Only allow market orders for kill switch emergency exit
      const allowedTypes = ['limit', 'market'];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: `Order type '${type}' not allowed` });
      }

      const orderBody = {
        symbol,
        qty,
        side,
        type,
        time_in_force: tif,
        ...(type === 'limit' && b.limit_price != null ? { limit_price: String(b.limit_price) } : {}),
        ...(b.client_order_id ? { client_order_id: String(b.client_order_id).slice(0, 48) } : {}),
      };
      console.log(`[alpaca] Placing ${type} ${side} order: ${qty}x ${symbol}`);
      const r = await alpacaRequest({ ...ctx, method: 'POST', path: '/v2/orders', body: orderBody });
      return res.status(r.status).json(r.body);
    }

    // ── GET portfolio history ────────────────────────────────────────────────
    if (action === 'history' && req.method === 'GET') {
      const period    = String(req.query.period    || '1M').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
      const timeframe = String(req.query.timeframe || '1D').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
      const path = `/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=false`;
      const r = await alpacaRequest({ ...ctx, method: 'GET', path });
      return res.status(r.status).json(r.body);
    }

    // ── GET account (connection check) ──────────────────────────────────────
    if (action === 'account' || (req.method === 'GET' && !action)) {
      const r = await alpacaRequest({ ...ctx, method: 'GET', path: '/v2/account' });
      if (r.status === 200 && r.body?.status) {
        return res.status(200).json({ connected: true, status: r.body.status, equity: r.body.equity, buying_power: r.body.buying_power });
      }
      return res.status(r.status).json({ connected: false, error: 'Alpaca auth failed' });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[alpaca]', action, err.message);
    return res.status(500).json({ error: 'Alpaca request failed', connected: false });
  }
};
