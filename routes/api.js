'use strict';
const express = require('express');
const router  = express.Router();
const data    = require('../services/nepseData');
const { generateSignal, getIndicatorSeries } = require('../services/signalEngine');

// ─── HEALTH / STATUS ─────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  res.json({ ok: true, marketOpen: data.isMarketOpen(), ts: new Date().toISOString(), cache: data.getCacheStats() });
});

// ─── NEPSE INDEX ─────────────────────────────────────────────────────────────
router.get('/index', async (req, res) => {
  try {
    const result = await data.getNEPSEIndex();
    res.json(result);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── LIVE QUOTES ─────────────────────────────────────────────────────────────
router.get('/quotes', async (req, res) => {
  try {
    const result = await data.getLiveQuotes();
    res.json(result);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── SECTORS ─────────────────────────────────────────────────────────────────
router.get('/sectors', async (req, res) => {
  try {
    const result = await data.getSectorPerformance();
    res.json(result);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── STOCK PRICE HISTORY ──────────────────────────────────────────────────────
router.get('/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days   = Math.min(365, Math.max(20, parseInt(req.query.days) || 120));
  try {
    const result = await data.getStockHistory(symbol, days);
    res.json(result);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message, symbol });
  }
});

// ─── TECHNICAL INDICATORS ─────────────────────────────────────────────────────
router.get('/indicators/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days   = Math.min(365, Math.max(60, parseInt(req.query.days) || 120));
  try {
    const hist = await data.getStockHistory(symbol, days);
    if (!hist.success) return res.status(502).json(hist);

    const indicators = getIndicatorSeries({
      closes:  hist.closes,
      highs:   hist.highs,
      lows:    hist.lows,
      volumes: hist.volumes,
    });
    res.json({
      success: true,
      symbol,
      dates:   hist.dates,
      ohlcv:   { opens: hist.opens, highs: hist.highs, lows: hist.lows, closes: hist.closes, volumes: hist.volumes },
      indicators,
      source:  hist.source,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message, symbol });
  }
});

// ─── SINGLE SIGNAL ────────────────────────────────────────────────────────────
router.get('/signal/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const hist = await data.getStockHistory(symbol, 160);
    if (!hist.success) return res.status(502).json({ success: false, error: hist.error, symbol });

    // Also try to get the current LTP
    const quotesRes = await data.getLiveQuotes();
    const liveQuote = quotesRes.success ? quotesRes.data.find(q => q.symbol === symbol) : null;

    const sig = generateSignal({ symbol, ...hist });
    if (!sig) return res.status(422).json({ success: false, error: 'Insufficient data for signal', symbol });

    // Override LTP with live price if available
    if (liveQuote) {
      sig.ltp       = liveQuote.ltp;
      sig.change    = liveQuote.change;
      sig.changePct = liveQuote.changePct;
    }

    res.json({ success: true, data: sig, source: hist.source });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message, symbol });
  }
});

// ─── ALL SIGNALS (batch, runs in parallel with concurrency limit) ─────────────
router.get('/signals', async (req, res) => {
  try {
    const quotesRes = await data.getLiveQuotes();
    if (!quotesRes.success) return res.status(502).json(quotesRes);

    const symbols = quotesRes.data.map(q => q.symbol).slice(0, 40); // top 40 by volume
    const liveMap = Object.fromEntries(quotesRes.data.map(q => [q.symbol, q]));

    // Fetch history in parallel with concurrency limit of 5
    const CONCURRENCY = 5;
    const results = [];
    for (let i = 0; i < symbols.length; i += CONCURRENCY) {
      const batch = symbols.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async sym => {
          const hist = await data.getStockHistory(sym, 160);
          if (!hist.success || hist.closes.length < 30) return null;
          const sig = generateSignal({ symbol: sym, ...hist });
          if (!sig) return null;
          const lq = liveMap[sym];
          if (lq) { sig.ltp = lq.ltp; sig.change = lq.change; sig.changePct = lq.changePct; }
          return sig;
        })
      );
      results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean));
    }

    const sorted = results.sort((a,b) => {
      const order = { BUY:0, HOLD:1, SELL:2 };
      return (order[a.action] - order[b.action]) || (b.confidence - a.confidence);
    });

    res.json({ success: true, data: sorted, count: sorted.length, source: quotesRes.source });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── SCANNER ─────────────────────────────────────────────────────────────────
router.post('/scan', async (req, res) => {
  const f = req.body || {};
  try {
    const quotesRes = await data.getLiveQuotes();
    if (!quotesRes.success) return res.status(502).json(quotesRes);

    const symbols  = quotesRes.data.map(q => q.symbol).slice(0, 40);
    const liveMap  = Object.fromEntries(quotesRes.data.map(q => [q.symbol, q]));
    const CONC     = 5;
    let   results  = [];

    for (let i = 0; i < symbols.length; i += CONC) {
      const batch = symbols.slice(i, i + CONC);
      const batchR = await Promise.allSettled(batch.map(async sym => {
        const hist = await data.getStockHistory(sym, 160);
        if (!hist.success || hist.closes.length < 30) return null;
        const sig = generateSignal({ symbol: sym, ...hist });
        if (!sig) return null;
        const lq  = liveMap[sym];
        if (lq) { sig.ltp = lq.ltp; sig.volume = lq.volume; sig.changePct = lq.changePct; }
        return sig;
      }));
      results.push(...batchR.map(r => r.status==='fulfilled'?r.value:null).filter(Boolean));
    }

    // Apply filters
    if (f.action && f.action !== 'all') results = results.filter(r => r.action === f.action.toUpperCase());
    if (f.minConfidence) results = results.filter(r => r.confidence >= +f.minConfidence);
    if (f.maxRSI)        results = results.filter(r => r.rsi && r.rsi <= +f.maxRSI);
    if (f.minRSI)        results = results.filter(r => r.rsi && r.rsi >= +f.minRSI);
    if (f.minScore)      results = results.filter(r => r.score >= +f.minScore);
    if (f.oversold)      results = results.filter(r => r.rsi && r.rsi < 35);
    if (f.macdBullish)   results = results.filter(r => r.macdValue && r.macdValue > 0);
    if (f.buyOnly)       results = results.filter(r => r.action === 'BUY');

    results.sort((a,b) => b.confidence - a.confidence);
    res.json({ success: true, data: results, count: results.length, source: quotesRes.source });
  } catch(e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── VOLUME ANALYTICS ─────────────────────────────────────────────────────────
router.get('/volume', async (req, res) => {
  try {
    const result = await data.getVolumeAnalytics();
    res.json(result);
  } catch(e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── BROKER ANALYTICS ─────────────────────────────────────────────────────────
router.get('/brokers/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const result = await data.getBrokerAnalysis(symbol);
    res.json(result);
  } catch(e) {
    res.status(502).json({ success: false, error: e.message, symbol });
  }
});

// ─── S/R LEVELS ───────────────────────────────────────────────────────────────
router.get('/sr/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const hist = await data.getStockHistory(symbol, 160);
    if (!hist.success) return res.status(502).json(hist);
    const sig  = generateSignal({ symbol, ...hist });
    if (!sig)  return res.status(422).json({ success: false, error: 'Insufficient data' });
    res.json({ success: true, data: { symbol, ltp: sig.ltp, supports: sig.supports, resistances: sig.resistances }, source: hist.source });
  } catch(e) {
    res.status(502).json({ success: false, error: e.message, symbol });
  }
});

// ─── IPO ─────────────────────────────────────────────────────────────────────
router.get('/ipo', async (req, res) => {
  try {
    const result = await data.getIPOData();
    res.json(result);
  } catch(e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── BACKTEST (uses real historical data) ─────────────────────────────────────
router.post('/backtest', async (req, res) => {
  const { symbol = 'NABIL', strategy = 'rsi', capital = 100000 } = req.body;
  try {
    const hist = await data.getStockHistory(symbol.toUpperCase(), 365);
    if (!hist.success) return res.status(502).json(hist);
    if (hist.closes.length < 60) return res.status(422).json({ success: false, error: `Insufficient history: only ${hist.closes.length} trading days available for ${symbol}` });

    const ind   = getIndicatorSeries({ closes: hist.closes, highs: hist.highs, lows: hist.lows, volumes: hist.volumes });
    const { closes, dates } = hist;
    let   cash = capital, shares = 0, trades = 0, wins = 0, peak = capital, maxDD = 0;
    const equity = [];

    for (let i = 30; i < closes.length; i++) {
      const p = closes[i];
      let action = 'hold';
      if (strategy === 'rsi' && ind.rsi[i]) {
        if (ind.rsi[i] < 35 && shares === 0) action = 'buy';
        else if (ind.rsi[i] > 65 && shares > 0) action = 'sell';
      } else if (strategy === 'ema') {
        const [e20, e50, pe20, pe50] = [ind.ema20[i], ind.ema50[i], ind.ema20[i-1], ind.ema50[i-1]];
        if (e20 && e50 && pe20 && pe50) {
          if (e20 > e50 && pe20 <= pe50 && shares === 0) action = 'buy';
          else if (e20 < e50 && pe20 >= pe50 && shares > 0) action = 'sell';
        }
      } else if (strategy === 'macd') {
        const [lm, ls, pm, ps] = [ind.macdLine[i], ind.macdSignal[i], ind.macdLine[i-1], ind.macdSignal[i-1]];
        if (lm && ls && pm && ps) {
          if (lm > ls && pm <= ps && shares === 0) action = 'buy';
          else if (lm < ls && pm >= ps && shares > 0) action = 'sell';
        }
      }

      if (action === 'buy' && cash >= p * 10) {
        shares = Math.floor(cash / p / 10) * 10;
        cash  -= shares * p;
        trades++;
      } else if (action === 'sell' && shares > 0) {
        if (p > closes[Math.max(0, i - 20)]) wins++;
        cash  += shares * p;
        shares = 0;
      }

      const ev = cash + shares * p;
      equity.push({ date: dates[i], value: Math.round(ev) });
      if (ev > peak) peak = ev;
      const dd = (peak - ev) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    if (shares > 0) { cash += shares * closes[closes.length-1]; shares = 0; }
    const totalRet = ((cash - capital) / capital * 100);
    const winRate  = trades > 0 ? (wins / trades * 100) : 0;

    res.json({ success: true, data: {
      symbol: symbol.toUpperCase(), strategy, capital,
      finalValue:  Math.round(cash),
      totalReturn: +totalRet.toFixed(2),
      maxDrawdown: +maxDD.toFixed(2),
      totalTrades: trades,
      winRate:     +winRate.toFixed(1),
      sharpeRatio: +(totalRet / (maxDD + 1) * 0.12).toFixed(2),
      equityCurve: equity,
      dataPoints:  closes.length,
    }, source: hist.source });
  } catch(e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// ─── CACHE CONTROL ────────────────────────────────────────────────────────────
router.post('/cache/clear', (req, res) => {
  data.clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

module.exports = router;
