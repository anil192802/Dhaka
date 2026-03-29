/**
 * NepTrade Pro — Signal Engine
 * Implements the Chukul-style composite algo:
 *  RSI + MACD + Bollinger Bands + EMA Cross + SuperTrend +
 *  Candlestick Patterns + Volume Analysis + Support/Resistance
 *  → Weighted composite score → BUY / HOLD / SELL + confidence
 */

// ─── INDICATOR PRIMITIVES ────────────────────────────────────────────────────

function sma(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    const slice = data.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (prev === null) {
      if (i < period - 1) { result.push(null); continue; }
      prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result.push(prev);
    } else {
      prev = data[i] * k + prev * (1 - k);
      result.push(prev);
    }
  }
  return result;
}

function rsi(closes, period = 14) {
  const result = [];
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }
  for (let i = 0; i < gains.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (i === period - 1) {
      const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    } else {
      const prevAvgGain = (result[result.length - 1] !== null)
        ? ((100 - result[result.length - 1]) === 0 ? gains[i] : (gains[i] + (period - 1) * (result[result.length - 1] < 100 ? gains[i] : 0)) / period)
        : gains[i];
      const prevResult = result[result.length - 1];
      const rs = prevResult === null ? 1 : (100 / (100 - prevResult) - 1);
      const newAvgGain = (rs * (period - 1) / period + gains[i] / period);
      const prevAvgLoss = rs === 0 ? losses[i] : (rs > 0 ? (prevResult !== null ? (100 / (100 - prevResult) - 1) : 1) : 1);
      const newAvgLoss = (prevAvgLoss * (period - 1) + losses[i]) / period;
      const newRs = newAvgLoss === 0 ? 100 : newAvgGain / newAvgLoss;
      result.push(100 - 100 / (1 + newRs));
    }
  }
  // Re-calculate properly
  return calcRSI(closes, period);
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const result = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => (v !== null && emaSlow[i] !== null) ? v - emaSlow[i] : null);
  const validMacd = macdLine.filter(v => v !== null);
  const signalLineRaw = ema(validMacd, signal);
  const signalLine = new Array(macdLine.length - validMacd.length).fill(null).concat(
    new Array(validMacd.length - signalLineRaw.length).fill(null).concat(signalLineRaw)
  );
  const histogram = macdLine.map((v, i) => (v !== null && signalLine[i] !== null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

function bollingerBands(closes, period = 20, stdDevMult = 2) {
  const mid = sma(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push(mean + stdDevMult * sd);
    lower.push(mean - stdDevMult * sd);
  }
  return { upper, mid, lower };
}

function superTrend(highs, lows, closes, period = 10, multiplier = 3) {
  const atr = calcATR(highs, lows, closes, period);
  const upperBand = [], lowerBand = [], trend = [];
  for (let i = 0; i < closes.length; i++) {
    if (atr[i] === null) { upperBand.push(null); lowerBand.push(null); trend.push(null); continue; }
    const mid = (highs[i] + lows[i]) / 2;
    upperBand.push(mid + multiplier * atr[i]);
    lowerBand.push(mid - multiplier * atr[i]);
  }
  const finalUpper = [...upperBand];
  const finalLower = [...lowerBand];
  for (let i = 1; i < closes.length; i++) {
    if (finalLower[i] === null || finalLower[i-1] === null) continue;
    if (finalLower[i] < finalLower[i-1] || closes[i-1] < finalLower[i-1]) finalLower[i] = finalLower[i];
    else finalLower[i] = Math.max(finalLower[i], finalLower[i-1]);
    if (finalUpper[i] > finalUpper[i-1] || closes[i-1] > finalUpper[i-1]) finalUpper[i] = finalUpper[i];
    else finalUpper[i] = Math.min(finalUpper[i], finalUpper[i-1]);
  }
  const superTrendLine = [];
  let dir = 1;
  for (let i = 0; i < closes.length; i++) {
    if (finalLower[i] === null) { superTrendLine.push(null); continue; }
    if (i === 0) { superTrendLine.push(finalLower[i]); continue; }
    if (superTrendLine[i-1] === finalUpper[i-1]) {
      dir = closes[i] > finalUpper[i] ? 1 : -1;
    } else {
      dir = closes[i] < finalLower[i] ? -1 : 1;
    }
    superTrendLine.push(dir === 1 ? finalLower[i] : finalUpper[i]);
  }
  return { superTrend: superTrendLine, upperBand: finalUpper, lowerBand: finalLower };
}

function calcATR(highs, lows, closes, period = 14) {
  const tr = [null];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i-1]);
    const lc = Math.abs(lows[i] - closes[i-1]);
    tr.push(Math.max(hl, hc, lc));
  }
  const atr = [null];
  for (let i = 1; i < tr.length; i++) {
    if (i < period) { atr.push(null); continue; }
    if (i === period) {
      atr.push(tr.slice(1, period+1).reduce((a,b)=>a+b,0)/period); continue;
    }
    atr.push((atr[i-1] * (period-1) + tr[i]) / period);
  }
  return atr;
}

// ─── SUPPORT & RESISTANCE ────────────────────────────────────────────────────

function detectSupportResistance(highs, lows, closes, lookback = 20) {
  const supports = [], resistances = [];
  for (let i = lookback; i < closes.length - lookback; i++) {
    const isSwingLow = lows.slice(i-lookback, i).every(v => v >= lows[i]) &&
                       lows.slice(i+1, i+lookback+1).every(v => v >= lows[i]);
    const isSwingHigh = highs.slice(i-lookback, i).every(v => v <= highs[i]) &&
                        highs.slice(i+1, i+lookback+1).every(v => v <= highs[i]);
    if (isSwingLow) supports.push({ price: lows[i], index: i, strength: 1 });
    if (isSwingHigh) resistances.push({ price: highs[i], index: i, strength: 1 });
  }
  // Cluster nearby levels
  const clusterLevels = (levels, threshold = 0.015) => {
    const clustered = [];
    levels.sort((a,b) => a.price - b.price);
    for (const lvl of levels) {
      const existing = clustered.find(c => Math.abs(c.price - lvl.price) / c.price < threshold);
      if (existing) { existing.strength++; existing.price = (existing.price + lvl.price) / 2; }
      else clustered.push({ ...lvl });
    }
    return clustered.sort((a,b) => b.strength - a.strength).slice(0, 5);
  };
  return { supports: clusterLevels(supports), resistances: clusterLevels(resistances) };
}

// ─── CANDLESTICK PATTERNS ─────────────────────────────────────────────────────

function detectCandlestickPatterns(opens, highs, lows, closes) {
  const n = closes.length - 1;
  const o = opens[n], h = highs[n], l = lows[n], c = closes[n];
  const po = opens[n-1], ph = highs[n-1], pl = lows[n-1], pc = closes[n-1];
  const body = Math.abs(c - o);
  const pBody = Math.abs(pc - po);
  const patterns = [];

  // Doji
  if (body / (h - l + 0.001) < 0.1) patterns.push({ name: 'Doji', bias: 0, weight: 0.5 });
  // Hammer
  if (c > o && (o - l) > 2 * body && (h - c) < body * 0.3) patterns.push({ name: 'Hammer', bias: 1, weight: 1.5 });
  // Shooting Star
  if (c < o && (h - o) > 2 * body && (c - l) < body * 0.3) patterns.push({ name: 'Shooting Star', bias: -1, weight: 1.5 });
  // Bullish Engulfing
  if (pc < po && c > o && c > po && o < pc) patterns.push({ name: 'Bullish Engulfing', bias: 1, weight: 2 });
  // Bearish Engulfing
  if (pc > po && c < o && c < po && o > pc) patterns.push({ name: 'Bearish Engulfing', bias: -1, weight: 2 });
  // Morning Star (simplified)
  if (n >= 2) {
    const ppo = opens[n-2], ppc = closes[n-2];
    if (ppc < ppo && Math.abs(pc-po) < pBody*0.3 && c > o && c > (ppo+ppc)/2) {
      patterns.push({ name: 'Morning Star', bias: 1, weight: 2.5 });
    }
  }
  // Evening Star
  if (n >= 2) {
    const ppo = opens[n-2], ppc = closes[n-2];
    if (ppc > ppo && Math.abs(pc-po) < pBody*0.3 && c < o && c < (ppo+ppc)/2) {
      patterns.push({ name: 'Evening Star', bias: -1, weight: 2.5 });
    }
  }
  // Marubozu Bullish
  if (c > o && (c - o) / (h - l + 0.001) > 0.85) patterns.push({ name: 'Bullish Marubozu', bias: 1, weight: 1.5 });
  // Marubozu Bearish
  if (c < o && (o - c) / (h - l + 0.001) > 0.85) patterns.push({ name: 'Bearish Marubozu', bias: -1, weight: 1.5 });

  return patterns;
}

// ─── VOLUME ANALYSIS ─────────────────────────────────────────────────────────

function analyzeVolume(volumes, closes, period = 20) {
  if (volumes.length < period) return { signal: 0, obv: [], accumDist: 0 };
  const avgVol = volumes.slice(-period).reduce((a,b)=>a+b,0) / period;
  const lastVol = volumes[volumes.length - 1];
  const volRatio = lastVol / avgVol;

  // OBV
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) obv.push(obv[i-1] + volumes[i]);
    else if (closes[i] < closes[i-1]) obv.push(obv[i-1] - volumes[i]);
    else obv.push(obv[i-1]);
  }

  // Accumulation/Distribution
  let ad = 0;
  for (let i = 0; i < closes.length; i++) {
    const range = (closes[i] !== volumes[i] ? 1 : 0);
    // simplified clv
    const high = closes[i] * 1.005, low = closes[i] * 0.995;
    const clv = ((closes[i] - low) - (high - closes[i])) / (high - low + 0.001);
    ad += clv * volumes[i];
  }

  const obvTrend = obv.length > 5 ? Math.sign(obv[obv.length-1] - obv[obv.length-6]) : 0;
  const signal = volRatio > 1.5 ? obvTrend : 0;
  return { signal, obv, volumeRatio: volRatio, obvTrend, accumDist: ad };
}

// ─── COMPOSITE SIGNAL ENGINE (Chukul-style) ───────────────────────────────────
/**
 * Scoring weights (total = 100):
 *  RSI:              20
 *  MACD:             20
 *  Bollinger:        15
 *  EMA Cross:        15
 *  SuperTrend:       10
 *  Candlestick:      10
 *  Volume/OBV:       10
 */

function generateSignal(priceData) {
  const { opens, highs, lows, closes, volumes, symbol } = priceData;
  if (closes.length < 30) return null;

  let score = 0; // -100 to +100
  const components = {};

  // 1. RSI (weight 20)
  const rsiValues = calcRSI(closes, 14);
  const lastRSI = rsiValues[rsiValues.length - 1];
  const prevRSI = rsiValues[rsiValues.length - 2];
  if (lastRSI !== null) {
    let rsiScore = 0;
    if (lastRSI < 30) rsiScore = 20; // Oversold → BUY
    else if (lastRSI < 40) rsiScore = 10;
    else if (lastRSI > 70) rsiScore = -20; // Overbought → SELL
    else if (lastRSI > 60) rsiScore = -10;
    else rsiScore = 0; // Neutral
    // RSI momentum
    if (prevRSI && lastRSI > prevRSI && lastRSI < 50) rsiScore += 5;
    if (prevRSI && lastRSI < prevRSI && lastRSI > 50) rsiScore -= 5;
    score += rsiScore;
    components.rsi = { value: lastRSI.toFixed(2), score: rsiScore };
  }

  // 2. MACD (weight 20)
  const { macdLine, signalLine, histogram } = macd(closes);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const lastHist = histogram[histogram.length - 1];
  const prevHist = histogram[histogram.length - 2];
  if (lastMACD !== null && lastSignal !== null) {
    let macdScore = 0;
    if (lastMACD > lastSignal) macdScore += 10; // Bullish
    else macdScore -= 10;
    if (lastHist !== null && prevHist !== null) {
      if (lastHist > 0 && lastHist > prevHist) macdScore += 10; // Momentum up
      else if (lastHist < 0 && lastHist < prevHist) macdScore -= 10;
      else if (lastHist > 0 && lastHist < prevHist) macdScore += 3;
    }
    score += macdScore;
    components.macd = { macd: lastMACD?.toFixed(3), signal: lastSignal?.toFixed(3), hist: lastHist?.toFixed(3), score: macdScore };
  }

  // 3. Bollinger Bands (weight 15)
  const bb = bollingerBands(closes, 20, 2);
  const lastClose = closes[closes.length - 1];
  const lastUpper = bb.upper[bb.upper.length - 1];
  const lastLower = bb.lower[bb.lower.length - 1];
  const lastMid = bb.mid[bb.mid.length - 1];
  if (lastUpper !== null) {
    let bbScore = 0;
    const bbPos = (lastClose - lastLower) / (lastUpper - lastLower);
    if (bbPos < 0.1) bbScore = 15; // Near lower band → BUY
    else if (bbPos < 0.3) bbScore = 7;
    else if (bbPos > 0.9) bbScore = -15; // Near upper → SELL
    else if (bbPos > 0.7) bbScore = -7;
    score += bbScore;
    components.bollinger = { upper: lastUpper?.toFixed(2), lower: lastLower?.toFixed(2), mid: lastMid?.toFixed(2), position: (bbPos * 100).toFixed(1), score: bbScore };
  }

  // 4. EMA Cross (weight 15) — EMA20 vs EMA50
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const lastEMA20 = ema20[ema20.length - 1];
  const lastEMA50 = ema50[ema50.length - 1];
  const prevEMA20 = ema20[ema20.length - 2];
  const prevEMA50 = ema50[ema50.length - 2];
  if (lastEMA20 !== null && lastEMA50 !== null) {
    let emaScore = 0;
    if (lastEMA20 > lastEMA50) {
      emaScore += 10;
      if (prevEMA20 <= prevEMA50) emaScore += 5; // Golden cross just happened
    } else {
      emaScore -= 10;
      if (prevEMA20 >= prevEMA50) emaScore -= 5; // Death cross
    }
    if (lastClose > lastEMA20) emaScore += 3;
    else emaScore -= 3;
    score += emaScore;
    components.emaCross = { ema20: lastEMA20?.toFixed(2), ema50: lastEMA50?.toFixed(2), score: emaScore };
  }

  // 5. SuperTrend proxy — EMA trend + ATR channel (robust, deterministic)
  {
    const atrVals = calcATR(highs || closes.map(c=>c*1.01), lows || closes.map(c=>c*0.995), closes, 10);
    const lastATRv   = atrVals[atrVals.length - 1];
    const ema50now   = ema50[ema50.length - 1];
    const ema50prev  = ema50[ema50.length - 6] || ema50[0];
    let stScore = 0;
    if (lastATRv && ema50now && ema50prev) {
      const emaTrend   = ema50now - ema50prev;
      const closeAbove = lastClose - ema50now;
      if (emaTrend > 0 && closeAbove > -lastATRv * 0.6) stScore = 10;
      else if (emaTrend < 0 && closeAbove < lastATRv * 0.6) stScore = -10;
      else stScore = emaTrend > 0 ? 4 : -4;
    }
    score += stScore;
    components.superTrend = { ema50: ema50now && ema50now.toFixed(2), score: stScore, bullish: stScore > 0 };
  }

  // 6. Candlestick Patterns (weight 10)
  if (opens && opens.length >= 3) {
    const patterns = detectCandlestickPatterns(opens, highs, lows, closes);
    let candleScore = 0;
    for (const p of patterns) {
      candleScore += p.bias * p.weight * (10 / 3);
    }
    candleScore = Math.max(-10, Math.min(10, candleScore));
    score += candleScore;
    components.candlestick = { patterns: patterns.map(p => p.name), score: candleScore };
  }

  // 7. Volume / OBV (weight 10)
  if (volumes && volumes.length >= 20) {
    const volAnalysis = analyzeVolume(volumes, closes, 20);
    let volScore = 0;
    if (volAnalysis.volumeRatio > 1.5) volScore = volAnalysis.obvTrend * 10;
    else if (volAnalysis.volumeRatio > 1.2) volScore = volAnalysis.obvTrend * 5;
    score += volScore;
    components.volume = { ratio: volAnalysis.volumeRatio?.toFixed(2), obvTrend: volAnalysis.obvTrend, score: volScore };
  }

  // ─── FINAL SIGNAL ────────────────────────────────────────────────────────
  // Normalize score to -100..+100 range
  const normalizedScore = Math.max(-100, Math.min(100, score));
  const confidence = Math.round(50 + Math.abs(normalizedScore) / 2);

  let action, color;
  if (normalizedScore >= 15) { action = 'BUY'; color = 'green'; }
  else if (normalizedScore <= -15) { action = 'SELL'; color = 'red'; }
  else { action = 'HOLD'; color = 'amber'; }

  // Support/Resistance
  const sr = detectSupportResistance(highs || closes.map(c=>c*1.01), lows || closes.map(c=>c*0.99), closes, 5);
  const currentPrice = lastClose;

  // Target and Stop Loss calculation
  const atr = calcATR(highs || closes.map(c=>c*1.01), lows || closes.map(c=>c*0.99), closes, 14);
  const lastATR = atr[atr.length - 1] || currentPrice * 0.02;

  let target, stopLoss;
  if (action === 'BUY') {
    const nearRes = sr.resistances.filter(r => r.price > currentPrice).sort((a,b) => a.price - b.price)[0];
    target = nearRes ? nearRes.price : currentPrice + 2.5 * lastATR;
    stopLoss = currentPrice - 1.5 * lastATR;
  } else if (action === 'SELL') {
    const nearSup = sr.supports.filter(s => s.price < currentPrice).sort((a,b) => b.price - a.price)[0];
    target = nearSup ? nearSup.price : currentPrice - 2.5 * lastATR;
    stopLoss = currentPrice + 1.5 * lastATR;
  } else {
    target = currentPrice + lastATR;
    stopLoss = currentPrice - lastATR;
  }

  return {
    symbol,
    action,
    confidence,
    score: Math.round(normalizedScore),
    ltp: currentPrice,
    target: parseFloat(target.toFixed(2)),
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    rsi: lastRSI ? parseFloat(lastRSI.toFixed(2)) : null,
    macdValue: lastMACD ? parseFloat(lastMACD.toFixed(3)) : null,
    ema20: lastEMA20 ? parseFloat(lastEMA20.toFixed(2)) : null,
    ema50: lastEMA50 ? parseFloat(lastEMA50.toFixed(2)) : null,
    bbUpper: lastUpper ? parseFloat(lastUpper.toFixed(2)) : null,
    bbLower: lastLower ? parseFloat(lastLower.toFixed(2)) : null,
    supports: sr.supports.slice(0, 3).map(s => ({ price: parseFloat(s.price.toFixed(2)), strength: s.strength })),
    resistances: sr.resistances.slice(0, 3).map(r => ({ price: parseFloat(r.price.toFixed(2)), strength: r.strength })),
    components,
    patterns: components.candlestick?.patterns || [],
    generatedAt: new Date().toISOString(),
  };
}

// ─── INDICATOR SERIES FOR CHARTS ─────────────────────────────────────────────

function getIndicatorSeries(priceData) {
  const { closes, highs, lows, volumes } = priceData;
  const rsiVals = calcRSI(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes);
  const bb = bollingerBands(closes, 20, 2);
  const ema20v = ema(closes, 20);
  const ema50v = ema(closes, 50);
  const atrVals = calcATR(highs || closes.map(c=>c*1.01), lows || closes.map(c=>c*0.995), closes, 14);
  return { rsi: rsiVals, macdLine, macdSignal: signalLine, macdHist: histogram, bbUpper: bb.upper, bbMid: bb.mid, bbLower: bb.lower, ema20: ema20v, ema50: ema50v, atr: atrVals };
}

module.exports = { generateSignal, getIndicatorSeries, calcRSI, macd, bollingerBands, ema, sma, calcATR, detectSupportResistance, detectCandlestickPatterns, analyzeVolume };
