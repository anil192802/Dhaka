const express = require('express');
const router = express.Router();
const { generateSignal, getIndicatorSeries } = require('../services/signalEngine');
const {
  NEPSE_STOCKS, generatePriceHistory,
  fetchLiveQuotes, fetchNEPSEIndex, fetchSectorData,
  fetchBrokerData, fetchFloorsheet, fetchIPOData, isMarketOpen
} = require('../services/nepseData');

// ─── MARKET INDEX ────────────────────────────────────────────────────────────
router.get('/index', async (req, res) => {
  try {
    const data = await fetchNEPSEIndex();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SECTOR DATA ─────────────────────────────────────────────────────────────
router.get('/sectors', async (req, res) => {
  try {
    const data = await fetchSectorData();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── LIVE QUOTES ─────────────────────────────────────────────────────────────
router.get('/quotes', async (req, res) => {
  try {
    const quotes = await fetchLiveQuotes();
    res.json({ success: true, data: quotes, marketOpen: isMarketOpen() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── STOCK UNIVERSE ───────────────────────────────────────────────────────────
router.get('/stocks', (req, res) => {
  res.json({ success: true, data: NEPSE_STOCKS });
});

// ─── PRICE HISTORY ───────────────────────────────────────────────────────────
router.get('/history/:symbol', (req, res) => {
  const { symbol } = req.params;
  const days = parseInt(req.query.days) || 120;
  const upper = symbol.toUpperCase();
  const stock = NEPSE_STOCKS.find(s => s.symbol === upper);
  if (!stock) return res.status(404).json({ success: false, error: 'Symbol not found' });
  const data = generatePriceHistory(upper, days);
  res.json({ success: true, data });
});

// ─── INDICATORS ───────────────────────────────────────────────────────────────
router.get('/indicators/:symbol', (req, res) => {
  const upper = req.params.symbol.toUpperCase();
  const days = parseInt(req.query.days) || 120;
  const priceData = generatePriceHistory(upper, days);
  const indicators = getIndicatorSeries(priceData);
  res.json({
    success: true,
    data: {
      dates: priceData.dates,
      ohlcv: {
        opens: priceData.opens, highs: priceData.highs,
        lows: priceData.lows, closes: priceData.closes, volumes: priceData.volumes
      },
      indicators
    }
  });
});

// ─── SINGLE SIGNAL ────────────────────────────────────────────────────────────
router.get('/signal/:symbol', (req, res) => {
  const upper = req.params.symbol.toUpperCase();
  const stock = NEPSE_STOCKS.find(s => s.symbol === upper);
  if (!stock) return res.status(404).json({ success: false, error: 'Symbol not found' });
  const priceData = generatePriceHistory(upper, 120);
  const signal = generateSignal(priceData);
  res.json({ success: true, data: { ...signal, name: stock.name, sector: stock.sector } });
});

// ─── ALL SIGNALS (Batch) ──────────────────────────────────────────────────────
router.get('/signals', (req, res) => {
  const signals = NEPSE_STOCKS.map(stock => {
    const priceData = generatePriceHistory(stock.symbol, 120);
    const signal = generateSignal(priceData);
    if (!signal) return null;
    return {
      ...signal,
      name: stock.name,
      sector: stock.sector,
    };
  }).filter(Boolean);

  const sorted = signals.sort((a, b) => {
    const order = { BUY: 0, HOLD: 1, SELL: 2 };
    if (order[a.action] !== order[b.action]) return order[a.action] - order[b.action];
    return b.confidence - a.confidence;
  });

  res.json({ success: true, data: sorted, count: sorted.length });
});

// ─── SCANNER ─────────────────────────────────────────────────────────────────
router.post('/scan', (req, res) => {
  const filters = req.body || {};
  let results = NEPSE_STOCKS.map(stock => {
    const priceData = generatePriceHistory(stock.symbol, 120);
    const signal = generateSignal(priceData);
    if (!signal) return null;
    const last = priceData.closes[priceData.closes.length - 1];
    const vol20avg = priceData.volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const lastVol = priceData.volumes[priceData.volumes.length - 1];
    return {
      ...signal,
      name: stock.name,
      sector: stock.sector,
      volumeRatio: parseFloat((lastVol / vol20avg).toFixed(2)),
    };
  }).filter(Boolean);

  // Apply filters
  if (filters.action && filters.action !== 'all') results = results.filter(r => r.action === filters.action.toUpperCase());
  if (filters.sector && filters.sector !== 'all') results = results.filter(r => r.sector === filters.sector);
  if (filters.minConfidence) results = results.filter(r => r.confidence >= parseInt(filters.minConfidence));
  if (filters.minRSI) results = results.filter(r => r.rsi && r.rsi >= parseFloat(filters.minRSI));
  if (filters.maxRSI) results = results.filter(r => r.rsi && r.rsi <= parseFloat(filters.maxRSI));
  if (filters.macdBullish) results = results.filter(r => r.macdValue && r.macdValue > 0);
  if (filters.volumeSpike) results = results.filter(r => r.volumeRatio >= 1.5);
  if (filters.breakout) results = results.filter(r => r.score >= 30);
  if (filters.oversold) results = results.filter(r => r.rsi && r.rsi < 35);

  results.sort((a, b) => b.confidence - a.confidence);
  res.json({ success: true, data: results, count: results.length });
});

// ─── BROKER ANALYTICS ─────────────────────────────────────────────────────────
router.get('/brokers/:symbol', async (req, res) => {
  const upper = req.params.symbol.toUpperCase();
  const data = await fetchBrokerData(upper);
  res.json({ success: true, data });
});

// ─── FLOORSHEET ───────────────────────────────────────────────────────────────
router.get('/floorsheet/:symbol', async (req, res) => {
  const upper = req.params.symbol.toUpperCase();
  const page = parseInt(req.query.page) || 0;
  const data = await fetchFloorsheet(upper, page);
  res.json({ success: true, data });
});

// ─── VOLUME ANALYTICS ─────────────────────────────────────────────────────────
router.get('/volume', async (req, res) => {
  const quotes = await fetchLiveQuotes();
  const volumeData = quotes.map(q => {
    const buyRatio = 0.4 + Math.random() * 0.4;
    return {
      symbol: q.symbol,
      totalVolume: q.volume,
      buyVolume: Math.round(q.volume * buyRatio),
      sellVolume: Math.round(q.volume * (1 - buyRatio)),
      buyPercent: parseFloat((buyRatio * 100).toFixed(1)),
      sellPercent: parseFloat(((1 - buyRatio) * 100).toFixed(1)),
      turnover: q.turnover,
    };
  }).sort((a, b) => b.totalVolume - a.totalVolume);
  res.json({ success: true, data: volumeData });
});

// ─── BLOCK TRADES ─────────────────────────────────────────────────────────────
router.get('/blocktrades', (req, res) => {
  const trades = NEPSE_STOCKS.slice(0, 8).map((stock, i) => {
    const price = BASE_PRICES[stock.symbol] || 500;
    const qty = (Math.round(1000 + Math.random() * 9000) / 10 | 0) * 10;
    const mins = i * 18 + Math.round(Math.random() * 15);
    const time = new Date(Date.now() - mins * 60000);
    return {
      symbol: stock.symbol,
      name: stock.name,
      quantity: qty,
      price: parseFloat((price * (1 + (Math.random()-0.5)*0.01)).toFixed(2)),
      amount: Math.round(qty * price),
      type: Math.random() > 0.5 ? 'Block' : 'Bulk',
      time: time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      buyer: `B${Math.round(10 + Math.random()*40)}`,
      seller: `B${Math.round(10 + Math.random()*40)}`,
    };
  }).sort((a, b) => b.amount - a.amount);
  res.json({ success: true, data: trades });
});

// ─── SUPPORT & RESISTANCE ─────────────────────────────────────────────────────
router.get('/sr/:symbol', (req, res) => {
  const upper = req.params.symbol.toUpperCase();
  const priceData = generatePriceHistory(upper, 120);
  const signal = generateSignal(priceData);
  res.json({ success: true, data: { symbol: upper, supports: signal?.supports || [], resistances: signal?.resistances || [], ltp: signal?.ltp } });
});

// ─── IPO / RIGHTS / MF ────────────────────────────────────────────────────────
router.get('/ipo', async (req, res) => {
  const data = await fetchIPOData();
  res.json({ success: true, data });
});

// ─── BACKTEST ─────────────────────────────────────────────────────────────────
router.post('/backtest', (req, res) => {
  const { symbol = 'NABIL', strategy = 'rsi', startDate, endDate, capital = 100000 } = req.body;
  const priceData = generatePriceHistory(symbol.toUpperCase(), 365);
  const { closes, dates } = priceData;
  const { rsi: rsiValues } = getIndicatorSeries(priceData);

  let cash = capital, shares = 0;
  const equity = [];
  let trades = 0, wins = 0, peak = capital, maxDD = 0;

  for (let i = 20; i < closes.length; i++) {
    const rsiVal = rsiValues[i];
    const price = closes[i];
    let action = 'hold';

    if (strategy === 'rsi') {
      if (rsiVal < 35 && shares === 0) action = 'buy';
      else if (rsiVal > 65 && shares > 0) action = 'sell';
    } else if (strategy === 'ema') {
      // EMA cross
      const ema20v = priceData.closes.slice(Math.max(0,i-20),i).reduce((a,b)=>a+b,0)/Math.min(20,i);
      const ema50v = priceData.closes.slice(Math.max(0,i-50),i).reduce((a,b)=>a+b,0)/Math.min(50,i);
      if (ema20v > ema50v && shares === 0) action = 'buy';
      else if (ema20v < ema50v && shares > 0) action = 'sell';
    }

    if (action === 'buy' && cash > price) {
      shares = Math.floor(cash / price / 10) * 10;
      cash -= shares * price;
      trades++;
    } else if (action === 'sell' && shares > 0) {
      const proceeds = shares * price;
      if (proceeds > shares * closes[i-10]) wins++;
      cash += proceeds;
      shares = 0;
    }

    const eqVal = cash + shares * price;
    equity.push({ date: dates[i], value: Math.round(eqVal) });
    if (eqVal > peak) peak = eqVal;
    const dd = (peak - eqVal) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Force close
  if (shares > 0) { cash += shares * closes[closes.length - 1]; shares = 0; }
  const finalEquity = cash;
  const totalReturn = ((finalEquity - capital) / capital * 100);
  const winRate = trades > 0 ? ((wins / trades) * 100) : 0;

  res.json({
    success: true,
    data: {
      symbol: symbol.toUpperCase(),
      strategy,
      capital,
      finalValue: Math.round(finalEquity),
      totalReturn: parseFloat(totalReturn.toFixed(2)),
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      totalTrades: trades,
      winRate: parseFloat(winRate.toFixed(1)),
      sharpeRatio: parseFloat((totalReturn / (maxDD + 1) * 0.12).toFixed(2)),
      equityCurve: equity,
    }
  });
});

// ─── MARKET STATUS ────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ success: true, data: { marketOpen: isMarketOpen(), time: new Date().toISOString() } });
});

// ─── ACCUMULATION/DISTRIBUTION ───────────────────────────────────────────────
router.get('/accumdist', (req, res) => {
  const data = NEPSE_STOCKS.map(stock => {
    const priceData = generatePriceHistory(stock.symbol, 40);
    const { closes, volumes } = priceData;
    const recentClose = closes.slice(-5);
    const avgClose5 = recentClose.reduce((a,b)=>a+b,0)/5;
    const older = closes.slice(-20,-5);
    const avgClose20 = older.reduce((a,b)=>a+b,0)/older.length;
    const pctChg = ((avgClose5 - avgClose20) / avgClose20 * 100);
    const avgVol = volumes.slice(-5).reduce((a,b)=>a+b,0)/5;
    const baseVol = volumes.slice(-20,-5).reduce((a,b)=>a+b,0)/15;
    const volRatio = avgVol / baseVol;
    const phase = pctChg > 0 && volRatio > 1 ? 'accumulation' :
                  pctChg < 0 && volRatio > 1 ? 'distribution' : 'neutral';
    return {
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      phase, pctChange: parseFloat(pctChg.toFixed(2)),
      volumeRatio: parseFloat(volRatio.toFixed(2)),
      accumPercent: phase === 'accumulation' ? Math.round(50 + volRatio * 20) :
                    phase === 'distribution' ? Math.round(50 - volRatio * 20) : 50,
    };
  });
  res.json({ success: true, data });
});

module.exports = router;
