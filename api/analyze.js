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
    console.error('[analyze] ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
  }

  // Validate messages array
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
        system: 'You are NZR, an elite AI trading intelligence assistant. Follow the formatting instructions given in each user message exactly — if JSON is requested return only JSON, if a conversational answer is requested respond in clear prose.',
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.error?.message || `Anthropic API error (${response.status})`;
      console.error('[analyze] Anthropic API error:', response.status, errMsg);
      return res.status(response.status).json({ error: 'AI service unavailable. Please try again.' });
    }

    const text = data.content?.[0]?.text ?? '';
    if (!text) {
      console.error('[analyze] Empty content in Anthropic response:', JSON.stringify(data));
      return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
    }

    // Return in the shape the frontend expects: { content: [{ type, text }] }
    return res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('[analyze] Unexpected error:', err);
    return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
  }
}
