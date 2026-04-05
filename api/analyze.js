export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'API not configured' });
  }

  // Extract and validate the messages array from the request body
  const messages = req.body && Array.isArray(req.body.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const max_tokens = (req.body.max_tokens && Number.isInteger(req.body.max_tokens))
    ? Math.min(req.body.max_tokens, 2048)
    : 1024;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens,
        system: 'You are NZR, an elite AI trading analyst. Return only valid JSON as instructed. Never include markdown fences or extra commentary outside the JSON.',
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    // Normalise to the shape the frontend already expects: { content: [{ type, text }] }
    const text = data.content?.[0]?.text ?? '';
    return res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
