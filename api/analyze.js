// In-memory rate limit store (per serverless instance; best-effort across cold starts)
const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 1000;

const ALLOWED_ORIGINS = [
  'https://nzr-platform2.vercel.app',
  'https://nzr-platform2-git-main-nassoricool33-alt.vercel.app',
  'https://nzr-platform.vercel.app',
  'http://localhost:3000',
];

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const requests = (rateLimitMap.get(ip) || []).filter(t => t > windowStart);
  requests.push(now);
  rateLimitMap.set(ip, requests);
  return requests.length <= RATE_LIMIT;
}

function setSecurityHeaders(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
}

export default async function handler(req, res) {
  setSecurityHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Analysis service error. Please try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}
