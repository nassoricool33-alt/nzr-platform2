'use strict';
const { createClient } = require('@supabase/supabase-js');

let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
} catch(e) { console.error('Supabase init failed:', e.message); }

const optionsLogBuffer = [];
function pushLog(message, type = 'info') {
  const entry = { timestamp: new Date().toISOString(), message, type };
  optionsLogBuffer.unshift(entry);
  if (optionsLogBuffer.length > 200) optionsLogBuffer.pop();
  console.log('[OPTIONS-BOT]', type.toUpperCase(), message);
}

const OPTIONS_UNIVERSE = [
  'AAPL','MSFT','NVDA','AMD','TSLA','META','GOOGL','AMZN',
  'SPY','QQQ','PLTR','COIN','ARM','JPM','MSTR','NFLX'
];

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch(e) {
    clearTimeout(timeout);
    return null;
  }
}

async function scoreOptionsSignal(symbol) {
  try {
    pushLog('Analyzing ' + symbol, 'info');

    const snapshotUrl = 'https://api.polygon.io/v3/snapshot/options/' + symbol + '?limit=50&apiKey=' + process.env.POLYGON_API_KEY;
    const snapshot = await fetchWithTimeout(snapshotUrl);

    let callVolume = 0, putVolume = 0, avgIV = 0, ivCount = 0;
    if (snapshot && snapshot.results) {
      for (const contract of snapshot.results) {
        const details = contract.details || {};
        const day = contract.day || {};
        if (details.contract_type === 'call') callVolume += day.volume || 0;
        else putVolume += day.volume || 0;
        if (contract.implied_volatility) { avgIV += contract.implied_volatility; ivCount++; }
      }
    }
    avgIV = ivCount > 0 ? avgIV / ivCount : 0.3;
    const totalVolume = callVolume + putVolume;
    const callPutRatio = totalVolume > 0 ? callVolume / totalVolume : 0.5;
    const ivRank = Math.min(100, Math.round(avgIV * 100));

    const [rsiData, macdData] = await Promise.all([
      fetchWithTimeout('https://api.polygon.io/v1/indicators/rsi/' + symbol + '?timespan=day&window=14&series_type=close&order=desc&limit=1&apiKey=' + process.env.POLYGON_API_KEY),
      fetchWithTimeout('https://api.polygon.io/v1/indicators/macd/' + symbol + '?timespan=day&short_window=12&long_window=26&signal_window=9&series_type=close&order=desc&limit=1&apiKey=' + process.env.POLYGON_API_KEY)
    ]);

    const rsi = rsiData?.results?.values?.[0]?.value || 50;
    const macdHist = macdData?.results?.values?.[0]?.histogram || 0;
    const macdValue = macdData?.results?.values?.[0]?.value || 0;
    const macdSignal = macdData?.results?.values?.[0]?.signal || 0;

    const newsData = await fetchWithTimeout('https://api.polygon.io/v2/reference/news?ticker=' + symbol + '&limit=5&order=desc&apiKey=' + process.env.POLYGON_API_KEY);
    const headlines = newsData?.results?.map(n => n.title).join(' | ') || 'No recent news';

    let aiScore = 50, aiDirection = 'calls', aiCatalyst = 'Technical setup', aiDaysToPlay = 30, aiConfidence = 'medium';
    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 300,
          messages: [{ role: 'user', content: 'Rate this stock options trade potential. Symbol: ' + symbol + '. Headlines: ' + headlines + '. RSI: ' + rsi.toFixed(1) + '. MACD hist: ' + macdHist.toFixed(3) + '. Call/Put ratio: ' + callPutRatio.toFixed(2) + '. Return ONLY valid JSON: { "optionsScore": 0-100, "direction": "calls" or "puts", "catalyst": "one sentence", "daysToPlay": 7-60, "confidence": "high" or "medium" or "low" }' }]
        })
      });
      const aiData = await aiRes.json();
      const aiText = aiData?.content?.[0]?.text || '{}';
      const aiJson = JSON.parse(aiText.replace(/```json|```/g, '').trim());
      aiScore = aiJson.optionsScore || 50;
      aiDirection = aiJson.direction || 'calls';
      aiCatalyst = aiJson.catalyst || 'Technical setup';
      aiDaysToPlay = aiJson.daysToPlay || 30;
      aiConfidence = aiJson.confidence || 'medium';
    } catch(e) { pushLog('AI_ERROR ' + symbol + ': ' + e.message, 'warn'); }

    let techScore = 50;
    if (rsi > 50 && rsi < 70) techScore += 15;
    if (macdHist > 0 && macdValue > macdSignal) techScore += 20;
    if (callPutRatio > 0.6) techScore += 15;
    if (rsi >= 70) techScore -= 20;
    if (macdHist < 0) techScore -= 15;
    techScore = Math.max(0, Math.min(100, techScore));

    // Legislative sector bonus
    const SECTOR_BONUS = {
      'NVDA': 15, 'AMD': 10, 'MSFT': 10, 'GOOGL': 10, 'ARM': 12, 'PLTR': 15,
      'COIN': 12, 'MSTR': 10,
      'SPY': 5, 'QQQ': 5,
      'META': 8, 'AMZN': 8, 'AAPL': 5
    };
    const sectorBonus = SECTOR_BONUS[symbol] || 0;

    // Unusual options volume bonus
    const volumeBonus = callVolume > 10000 ? 10 : callVolume > 5000 ? 5 : 0;

    // Momentum bonus
    const momentumBonus = (rsi > 55 && macdHist > 0) ? 15 : (rsi > 50 && macdHist > 0) ? 8 : 0;

    // News catalyst / AI confidence bonus
    const confidenceBonus = aiConfidence === 'high' ? 15 : aiConfidence === 'medium' ? 5 : 0;

    const finalScore = Math.min(100, Math.round(
      (aiScore * 0.35) +
      (techScore * 0.25) +
      (Math.min(100, callPutRatio * 100) * 0.15) +
      sectorBonus +
      volumeBonus +
      momentumBonus +
      confidenceBonus
    ));
    const ivCrushRisk = avgIV > 1.2;
    const recommendation = finalScore >= 80 ? 'strong_buy' : finalScore >= 65 ? 'buy' : finalScore >= 50 ? 'watch' : 'skip';

    pushLog(symbol + ' score=' + finalScore + ' dir=' + aiDirection + ' ' + aiCatalyst, finalScore >= 65 ? 'pass' : 'info');

    return { symbol, optionsScore: finalScore, direction: aiDirection, flowScore: Math.round(callPutRatio * 100), sentimentScore: aiScore, technicalScore: techScore, catalyst: aiCatalyst, daysToPlay: aiDaysToPlay, ivRank, avgIV: (avgIV * 100).toFixed(1) + '%', ivCrushRisk, confidence: aiConfidence, recommendation, rsi: rsi.toFixed(1), macdHist: macdHist.toFixed(3) };
  } catch(e) {
    pushLog('SIGNAL_ERROR ' + symbol + ': ' + e.message, 'warn');
    return { symbol, optionsScore: 0, recommendation: 'skip', error: e.message };
  }
}

async function selectOptionsContract(symbol, direction, daysToPlay, currentPrice) {
  try {
    const contractType = direction === 'calls' ? 'call' : 'put';
    const url = 'https://api.polygon.io/v3/snapshot/options/' + symbol + '?contract_type=' + contractType + '&limit=20&apiKey=' + process.env.POLYGON_API_KEY;
    const data = await fetchWithTimeout(url, {}, 5000);

    if (!data?.results?.length) {
      pushLog('No contracts found for ' + symbol, 'warn');
      return null;
    }

    const today = new Date();
    const minDays = 14;
    const maxDays = 90;

    const validContracts = data.results.filter(c => {
      const details = c.details || {};
      if (!details.expiration_date) return false;
      const expiry = new Date(details.expiration_date);
      const daysToExpiry = (expiry - today) / 86400000;
      return daysToExpiry >= minDays && daysToExpiry <= maxDays;
    });

    if (!validContracts.length) {
      pushLog('No valid expiry contracts for ' + symbol, 'warn');
      return null;
    }

    const best = validContracts[0];
    const details = best.details || {};
    const price = best.day?.close || best.last_quote?.midpoint || best.last_trade?.price || 1.0;

    pushLog('CONTRACT_FOUND: ' + symbol + ' ' + details.ticker + ' strike=' + details.strike_price + ' expiry=' + details.expiration_date + ' price=$' + price, 'pass');

    return {
      ticker: details.ticker || symbol,
      strike: details.strike_price || currentPrice,
      expiry: details.expiration_date || '',
      contractType: details.contract_type || contractType,
      mid: price,
      ask: price * 1.02
    };
  } catch(e) {
    pushLog('CONTRACT_ERROR ' + symbol + ': ' + e.message, 'warn');
    return null;
  }
}

async function executeOptionsOrder(contract, signal, capitalAmount) {
  try {
    if (process.env.BOT_LIVE_TRADING !== 'true') {
      pushLog('PAPER_MODE: options signal logged — ' + contract.ticker, 'info');
      return null;
    }

    const maxCapital = (capitalAmount || 10000) * 0.05;
    const contractCost = contract.mid * 100;
    const numContracts = Math.max(1, Math.min(10, Math.floor(maxCapital / contractCost)));

    if (contractCost <= 0) { pushLog('OPTIONS_SKIP: invalid cost ' + contract.ticker, 'warn'); return null; }

    pushLog('OPTIONS_ATTEMPT: ' + contract.ticker + ' x' + numContracts + ' @ $' + contract.mid.toFixed(2), 'info');

    const orderRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
      method: 'POST',
      headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: contract.ticker,
        qty: String(numContracts),
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: (contract.ask * 1.05).toFixed(2),
        client_order_id: 'NZR-OPTIONS-' + signal.symbol + '-' + Date.now()
      })
    });

    const orderData = await orderRes.json();

    if (orderRes.ok) {
      pushLog('OPTIONS_ORDER_PLACED: ' + contract.ticker + ' x' + numContracts + ' @ $' + contract.mid.toFixed(2) + ' strike=' + contract.strike + ' expiry=' + contract.expiry, 'pass');
      if (supabase) {
        try {
          await supabase.from('journal').insert({ symbol: contract.ticker, entry_price: contract.mid, trade_date: new Date().toISOString().split('T')[0], notes: 'Options Bot: ' + signal.catalyst + ' | Score=' + signal.optionsScore + ' | Strike=$' + contract.strike + ' | Expiry=' + contract.expiry + ' | Contracts=' + numContracts + ' | IV=' + signal.avgIV + ' | OrderID=' + orderData.id });
        } catch(je) { pushLog('JOURNAL_ERROR: ' + je.message, 'warn'); }
      }
      return orderData;
    } else {
      pushLog('OPTIONS_REJECTED: ' + contract.ticker + ' — ' + JSON.stringify(orderData), 'warn');
      return null;
    }
  } catch(e) { pushLog('OPTIONS_EXEC_ERROR: ' + e.message, 'warn'); return null; }
}

async function getPelosiIntelligence() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: 'As of April 2026, list the top 5 US stocks most likely to benefit from current legislation and macro trends. Return ONLY JSON: { "topStocks": [{"symbol": "string", "thesis": "string", "optionPlay": "buy calls or buy puts", "confidence": "high or medium"}], "keyThemes": ["string", "string", "string"], "summary": "string" }' }] })
    });
    clearTimeout(timeout);
    const data = await res.json();
    const text = data?.content?.[0]?.text || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch(e) { return { topSectors: [], topStocks: [], keyThemes: [], riskFactors: [], summary: 'Intelligence unavailable', error: e.message }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type || 'status';
  console.log('[OPTIONS-BOT] type=' + type);

  try {
    if (type === 'status') return res.json({ status: 'active', universe: OPTIONS_UNIVERSE.length });

    if (type === 'log') {
      const since = req.query.since;
      const logs = since ? optionsLogBuffer.filter(l => l.timestamp > since) : optionsLogBuffer;
      return res.json({ logs, count: logs.length });
    }

    if (type === 'pelosi') {
      pushLog('Fetching Pelosi intelligence...', 'info');
      const intel = await getPelosiIntelligence();
      return res.json(intel);
    }

    if (type === 'positions') {
      const posRes = await fetch('https://paper-api.alpaca.markets/v2/positions', {
        headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY }
      });
      const positions = await posRes.json();
      const optPos = Array.isArray(positions) ? positions.filter(p => p.symbol && p.symbol.length > 6) : [];
      return res.json({ positions: optPos, count: optPos.length });
    }

    if (type === 'scan') {
      const startTime = Date.now();
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etHour = nowET.getHours(), etMinute = nowET.getMinutes(), etDay = nowET.getDay();
      const etTime = etHour + etMinute / 60;
      const isMarketOpen = etDay >= 1 && etDay <= 5 && etTime >= 9.5 && etTime < 15.75;

      if (!isMarketOpen) {
        pushLog('MARKET_CLOSED: ' + etHour + ':' + String(etMinute).padStart(2,'0') + ' ET', 'info');
        return res.json({ success: true, message: 'Market closed', symbolsScanned: 0, signalsFound: 0, ordersPlaced: 0 });
      }

      pushLog('OPTIONS_SCAN_START: ' + OPTIONS_UNIVERSE.length + ' symbols', 'info');

      let capitalAmount = 10000;
      if (supabase) {
        try {
          const { data } = await supabase.from('bot_state').select('value').eq('key', 'capital_amount').single();
          if (data) capitalAmount = parseFloat(data.value) || 10000;
        } catch(e) {}
      }

      let symbolsScanned = 0, signalsFound = 0, ordersPlaced = 0;
      const results = [];

      for (let i = 0; i < OPTIONS_UNIVERSE.length; i += 3) {
        if (Date.now() - startTime > 20000) { pushLog('TIME_BUDGET: stopping early', 'warn'); break; }
        const batch = OPTIONS_UNIVERSE.slice(i, i + 3);
        const batchResults = await Promise.all(batch.map(async (symbol) => { symbolsScanned++; return await scoreOptionsSignal(symbol); }));

        for (const signal of batchResults) {
          if (!signal || signal.error) continue;
          results.push(signal);

          if (signal.optionsScore >= 75 && !signal.ivCrushRisk && (signal.recommendation === 'strong_buy' || signal.recommendation === 'buy')) {
            signalsFound++;
            const priceData = await fetchWithTimeout('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/' + signal.symbol + '?apiKey=' + process.env.POLYGON_API_KEY);
            const currentPrice = priceData?.ticker?.day?.c || priceData?.ticker?.lastTrade?.p || 100;
            const contract = await selectOptionsContract(signal.symbol, signal.direction, signal.daysToPlay, currentPrice);
            if (contract) {
              const order = await executeOptionsOrder(contract, signal, capitalAmount);
              if (order) ordersPlaced++;
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      pushLog('OPTIONS_SCAN_DONE: ' + symbolsScanned + ' scanned, ' + signalsFound + ' signals, ' + ordersPlaced + ' orders, ' + duration + 'ms', 'info');
      return res.json({ success: true, symbolsScanned, signalsFound, ordersPlaced, duration: duration + 'ms', results });
    }

    return res.json({ error: 'unknown type: ' + type });
  } catch(e) {
    console.error('[OPTIONS-BOT] Error:', e);
    return res.status(200).json({ error: e.message, type });
  }
};
