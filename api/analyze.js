const https = require('https');

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 20;
  if (!rateLimit.has(ip)) { rateLimit.set(ip, {c: 1, s: now}); return true; }
  const e = rateLimit.get(ip);
  if (now - e.s > w) { rateLimit.set(ip, {c: 1, s: now}); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const SYSTEM_PROMPT = `You are NZR, an elite AI trading assistant. You only answer questions related to:
- Stock analysis and price action
- Technical indicators (RSI, MACD, Bollinger Bands, moving averages, golden cross)
- Options flow and unusual activity
- Earnings reports and fundamental analysis
- Portfolio management and position sizing
- Risk management and stop loss strategy
- Market news and sector analysis
- Trading psychology and discipline
- Halal investing and Islamic finance screening

If the user asks anything unrelated to trading, investing, or financial markets, respond with exactly: 'I am NZR, your trading assistant. I can only help with stock analysis, market research, and trading strategy.'

Never discuss politics, entertainment, general knowledge, coding help, or any non-financial topic. Always be concise, data-driven, and professional.`;

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({error: 'Too many requests'});

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return res.status(500).json({error: 'DEEPSEEK_API_KEY not configured'});

  try {
    const raw = (req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
    // Strip any client-supplied system messages to prevent prompt injection
    const userMessages = raw.filter(m => m && m.role !== 'system');
    if (!userMessages.length) return res.status(400).json({error: 'No messages'});
    if (userMessages.length > 20) return res.status(400).json({error: 'Too many messages'});
    for (const m of userMessages) {
      if (typeof m.content !== 'string') return res.status(400).json({error: 'Invalid message format'});
      if (m.content.length > 4000) return res.status(400).json({error: 'Message too long'});
    }
    const messages = [{role: 'system', content: SYSTEM_PROMPT}, ...userMessages];
    const payload = JSON.stringify({model: 'deepseek-chat', max_tokens: 900, messages});
    const result = await new Promise((resolve, reject) => {
      const options = {hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(payload)}};
      const r = https.request(options, (apiRes) => { let d = ''; apiRes.on('data', c => d += c); apiRes.on('end', () => resolve({status: apiRes.statusCode, body: d})); });
      r.on('error', reject); r.write(payload); r.end();
    });
    const data = JSON.parse(result.body);
    if (result.status !== 200) return res.status(result.status).json({error: 'AI service error'});
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    return res.status(200).json({content: [{type: 'text', text}]});
  } catch (err) { return res.status(500).json({error: 'An unexpected error occurred'}); }
};
