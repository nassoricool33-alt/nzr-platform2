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
    // 1. Fetch snapshot for real-time intraday data
    const snapUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${apiKey}`
    const snapRes = await withTimeout(fetch(snapUrl), 6000)

    let ticker = null
    if (snapRes && snapRes.ok) {
      const snapData = await snapRes.json()
      ticker = snapData.ticker || null

      // Debug: log raw snapshot structure for Vercel function logs
      console.log('[quote][raw]', symbol, JSON.stringify({
        dayC: ticker?.day?.c,
        dayO: ticker?.day?.o,
        dayV: ticker?.day?.v,
        minC: ticker?.min?.c,
        lastTradeP: ticker?.lastTrade?.p,
        prevDayC: ticker?.prevDay?.c,
        todaysChange: ticker?.todaysChange,
        todaysChangePerc: ticker?.todaysChangePerc,
      }))
    } else {
      console.error('[quote] Polygon snapshot failed:', symbol, 'status=', snapRes?.status)
    }

    if (!ticker) {
      return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' })
    }

    // 2. Extract price: prefer day.c (updates intraday), then min.c, then lastTrade.p
    const prevClose = ticker.prevDay?.c || 0;
    let price = ticker.day?.c || ticker.min?.c || ticker.lastTrade?.p || 0;
    const open = ticker.day?.o || 0;
    const high = ticker.day?.h || 0;
    const low = ticker.day?.l || 0;
    const volume = ticker.day?.v || 0;

    // 3. If no intraday data yet, fall back to last trade endpoint
    if ((!price || !volume) && prevClose > 0) {
      try {
        const lastTradeUrl = `https://api.polygon.io/v2/last/trade/${symbol}?apiKey=${apiKey}`
        const ltRes = await withTimeout(fetch(lastTradeUrl), 4000)
        if (ltRes && ltRes.ok) {
          const ltData = await ltRes.json()
          const ltPrice = ltData.results?.p || 0
          console.log('[quote][lastTrade]', symbol, 'price=', ltPrice)
          if (ltPrice > 0) price = ltPrice
        }
      } catch (ltErr) {
        console.warn('[quote] last trade fallback failed for', symbol, ':', ltErr.message)
      }
    }

    // 4. Final fallback: use prevClose as price (shows 0% change, better than null)
    if (!price) price = prevClose;

    // 5. Use Polygon's pre-calculated change values when available (most reliable),
    //    otherwise calculate from price vs prevClose
    let change, changePercent;
    if (ticker.todaysChangePerc != null && ticker.todaysChange != null) {
      change = ticker.todaysChange;
      changePercent = ticker.todaysChangePerc;
    } else {
      change = price - prevClose;
      changePercent = prevClose > 0 ? (change / prevClose * 100) : 0;
    }

    console.log('[quote]', symbol, 'price=', price, 'prevClose=', prevClose,
      'change=', change.toFixed(2), 'chg%=', changePercent.toFixed(2), 'vol=', volume)

    return res.status(200).json({
      symbol,
      price: parseFloat(price.toFixed(2)),
      open: open ? parseFloat(open.toFixed(2)) : null,
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
