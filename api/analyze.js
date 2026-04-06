module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  console.log('[analyze] Request received, method:', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const key = process.env.ANTHROPIC_API_KEY;
  console.log('[analyze] API key present:', !!key);
  if (!key) {
    console.error('[analyze] ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'AI service not configured' });
  }

  if (!req.body) {
    console.error('[analyze] Request body is empty');
    return res.status(400).json({ error: 'Request body is empty' });
  }

  console.log('[analyze] Request body:', JSON.stringify(req.body));

  const messages = Array.isArray(req.body.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const max_tokens = (req.body.max_tokens && Number.isInteger(req.body.max_tokens))
    ? Math.min(req.body.max_tokens, 2048)
    : 1024;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens,
          system: 'You are NZR, an elite AI trading intelligence assistant. Follow the formatting instructions given in each user message exactly — if JSON is requested return only JSON, if a conversational answer is requested respond in clear prose.',
          messages,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      console.error('[analyze] Anthropic response:', response.status, JSON.stringify(data));
      return res.status(response.status).json({
        error: data?.error?.message || 'AI analysis failed',
        status: response.status,
        detail: data?.error?.message,
        type: data?.error?.type,
      });
    }

    const text = data.content?.[0]?.text ?? '';
    if (!text) {
      console.error('[analyze] Empty content in Anthropic response:', JSON.stringify(data));
      return res.status(500).json({ error: 'AI analysis failed', status: 500, detail: 'Empty response from model' });
    }

    return res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('[analyze] Unexpected error:', err);
    return res.status(500).json({ error: 'AI analysis failed', status: 500, detail: err.message });
  }
};
