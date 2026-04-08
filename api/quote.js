function withTimeout(promise, ms = 8000, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

module.exports = async function handler(req, res) {
  // Hard 8 s deadline — avoids 504 if upstream Polygon is slow
  const _deadline = setTimeout(() => {
    if (!res.headersSent) res.status(200).json({ error: 'timeout', price: null, change: null });
  }, 8000);
  const allowedOrigins = ['https://nzr-platform2.vercel.app', 'http://localhost:3000']
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const symbol = (req.query.symbol || '').toUpperCase().trim()
  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' })
  }

  const apiKey = process.env.POLYGON_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Market data not configured' })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)

    const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`
    const prevRes = await fetch(prevUrl, { signal: controller.signal })
    clearTimeout(timeout)

    if (!prevRes.ok) {
      console.error('[quote] Polygon prev error:', prevRes.status, 'for', symbol)
      return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' })
    }

    const prevData = await prevRes.json()
    console.log('[quote] Polygon status:', prevData.status, 'resultsCount:', prevData.resultsCount, 'for', symbol)

    if (!prevData.results || prevData.results.length === 0) {
      return res.status(200).json({ symbol, price: null, error: 'No data available' })
    }

    const bar = prevData.results[0]
    const price = bar.c
    const prevClose = bar.o
    const change = price - prevClose
    const changePercent = (change / prevClose) * 100

    return res.status(200).json({
      symbol,
      price: parseFloat(price.toFixed(2)),
      open: parseFloat(bar.o.toFixed(2)),
      high: parseFloat(bar.h.toFixed(2)),
      low: parseFloat(bar.l.toFixed(2)),
      prevClose: parseFloat(bar.o.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      volume: bar.v,
      timestamp: bar.t
    })
  } catch (err) {
    console.error('[quote] Error for', symbol, ':', err.message)
    return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' })
  } finally {
    clearTimeout(_deadline)
  }
}
