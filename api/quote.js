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
    const timeout = setTimeout(() => controller.abort(), 6000)

    // Use snapshot endpoint for real-time prices during market hours
    const snapUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${apiKey}`
    const snapRes = await fetch(snapUrl, { signal: controller.signal })
    clearTimeout(timeout)

    if (!snapRes.ok) {
      console.error('[quote] Polygon snapshot error:', snapRes.status, 'for', symbol)
      return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' })
    }

    const snapData = await snapRes.json()
    const ticker = snapData.ticker

    if (!ticker) {
      return res.status(200).json({ symbol, price: null, error: 'No data available' })
    }

    const price = ticker.lastTrade?.p || ticker.day?.c || ticker.prevDay?.c || 0;
    const open = ticker.day?.o || ticker.prevDay?.c || 0;
    const high = ticker.day?.h || 0;
    const low = ticker.day?.l || 0;
    const prevClose = ticker.prevDay?.c || 0;
    const change = price - prevClose;
    const changePercent = prevClose ? (change / prevClose * 100) : 0;
    const volume = ticker.day?.v || 0;

    console.log('[quote]', symbol, 'price=', price, 'prevClose=', prevClose, 'change=', change.toFixed(2))

    return res.status(200).json({
      symbol,
      price: parseFloat(price.toFixed(2)),
      open: parseFloat(open.toFixed(2)),
      high: high ? parseFloat(high.toFixed(2)) : null,
      low: low ? parseFloat(low.toFixed(2)) : null,
      prevClose: parseFloat(prevClose.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      volume,
      timestamp: Date.now()
    })
  } catch (err) {
    console.error('[quote] Error for', symbol, ':', err.message)
    return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' })
  } finally {
    clearTimeout(_deadline)
  }
}
