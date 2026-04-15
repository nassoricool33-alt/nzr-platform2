'use strict';

// Module-level dedup set — persists across warm invocations
const inFlight = new Set();

// ── Retry wrapper ─────────────────────────────────────────────────────────────
async function callAnthropicWithRetry(body, key, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const data = await response.json();

      if (response.ok) return { success: true, data };

      // Retry on overload or server error
      if (response.status === 529 || response.status === 500) {
        console.error('[analyze] Attempt', attempt + 1, 'failed with status', response.status);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }

      // Non-retryable error (4xx, etc.)
      return {
        success: false,
        status: response.status,
        error: data?.error?.message,
        type: data?.error?.type,
      };

    } catch (err) {
      console.error('[analyze] Attempt', attempt + 1, 'threw:', err.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return { success: false, status: 503, error: 'Max retries exceeded' };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  console.log('[analyze] env check - ANTHROPIC_API_KEY:', !!process.env.ANTHROPIC_API_KEY);
  console.log('[analyze] method:', req.method);

  // GET = lightweight health check — no Anthropic call, safe to poll every 60s
  if (req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status: 'ok',
      configured: !!process.env.ANTHROPIC_API_KEY,
    });
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  if (!req.body.messages) {
    return res.status(400).json({ error: 'Missing messages in request body' });
  }

  const messages = Array.isArray(req.body.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required and must not be empty' });
  }

  console.log('[analyze] messages count:', messages.length, 'max_tokens:', req.body.max_tokens);

  // ── Deduplication ─────────────────────────────────────────────────────────
  // Key = first 120 chars of first message content — catches identical analysis requests
  const dedupKey = String(messages[0]?.content || '').slice(0, 120);
  if (inFlight.has(dedupKey)) {
    return res.status(429).json({ error: 'Analysis already in progress for this symbol' });
  }

  // ── Token cap ─────────────────────────────────────────────────────────────
  // Chat calls (≤400 requested) stay at ≤400; everything else capped at 800.
  // Shorter = faster responses, less likely to hit 30s Vercel timeout.
  const requested = req.body.max_tokens;
  const max_tokens = (requested && requested <= 400)
    ? Math.min(requested, 400)
    : Math.min(requested || 800, 800);

  inFlight.add(dedupKey);
  try {
    const defaultSystem = 'You are NZR, an elite AI trading intelligence assistant. Follow the formatting instructions given in each user message exactly — if JSON is requested return only JSON, if a conversational answer is requested respond in clear prose.';
    const systemPrompt = (typeof req.body.system === 'string' && req.body.system.length > 0) ? req.body.system : defaultSystem;

    const result = await callAnthropicWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens,
      system: systemPrompt,
      messages,
    }, key);

    if (!result.success) {
      console.error('[analyze] Anthropic error after retries:', result.status, result.error);
      return res.status(503).json({
        error: 'AI analysis temporarily unavailable. Please try again in 30 seconds.',
      });
    }

    const text = result.data.content?.[0]?.text ?? '';
    if (!text) {
      console.error('[analyze] Empty content in Anthropic response');
      return res.status(500).json({
        error: 'AI analysis failed',
        status: 500,
        detail: 'Empty response from model',
      });
    }

    return res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error('[analyze] Unexpected error:', err);
    return res.status(500).json({ error: 'AI analysis failed', status: 500, detail: err.message });
  } finally {
    inFlight.delete(dedupKey);
  }
};
