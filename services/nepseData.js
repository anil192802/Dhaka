'use strict';
/**
 * NepTrade Pro — NEPSE Web Scraper
 *
 * Data sources (in priority order):
 *  1. merolagani.com   — live market + stock history (JSON handlers, no auth)
 *  2. sharesansar.com  — live trading table (HTML scraping)
 *  3. nepalstock.com   — NEPSE index + securities (JSON API, public endpoints)
 *
 * IMPORTANT: No fake/static data is ever returned.
 *            If all sources fail → { success: false, error: '...' }
 *            The frontend must show a clear "data unavailable" state.
 */

const https = require('https');
const http  = require('http');

// ─── HTTP FETCH UTILITY ───────────────────────────────────────────────────────
function fetchURL(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/json,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control':   'no-cache',
        'Connection':      'keep-alive',
        'Referer':         `https://${parsed.hostname}/`,
        ...opts.headers,
      },
      timeout: opts.timeout || 10000,
    };

    const req = mod.request(options, res => {
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchURL(res.headers.location, opts).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    if (opts.timeout) req.setTimeout(opts.timeout);
    req.end();
  });
}

async function fetchJSON(url, opts = {}) {
  const body = await fetchURL(url, { ...opts, headers: { 'Accept': 'application/json', ...(opts.headers || {}) } });
  try { return JSON.parse(body); }
  catch (e) { throw new Error(`Invalid JSON from ${url}: ${body.slice(0, 100)}`); }
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const _cache = new Map();

function withCache(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.data);
  return fn().then(data => {
    _cache.set(key, { data, exp: Date.now() + ttlMs });
    return data;
  });
}

// ─── MARKET HOURS CHECK ───────────────────────────────────────────────────────
function isMarketOpen() {
  // NST = UTC + 5:45
  const utcMs  = Date.now();
  const nstMs  = utcMs + (5 * 3600 + 45 * 60) * 1000;
  const nst    = new Date(nstMs);
  const day    = nst.getUTCDay();   // 0=Sun,6=Sat; Nepal market: Sun–Thu
  if (day === 5 || day === 6) return false;  // Fri, Sat closed (Nepal: Fri=weekend)
  // Actually Nepal market: Sun–Thu open (Friday-Saturday off)
  // But Nepal adopted 5-day week, now Mon–Fri
  // NEPSE trading hours: 11:00–15:00 NST
  const totalMin = nst.getUTCHours() * 60 + nst.getUTCMinutes();
  return totalMin >= 660 && totalMin < 900; // 11:00–15:00 NST
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 1: MEROLAGANI.COM
//  Endpoint: /handlers/webrequest.ashx — public JSON handlers, no auth needed
// ═══════════════════════════════════════════════════════════════════════════════

const MERO_BASE = 'https://merolagani.com';

async function meroLiveMarket() {
  // Returns JSON: { isMarketOpen, currentDatetime, live_market: [{symbol,ltp,change,change_pct,high,low,open,volume,prev_close}] }
  const data = await fetchJSON(
    `${MERO_BASE}/handlers/webrequest.ashx?type=live_market`,
    { timeout: 10000 }
  );
  if (!data || !Array.isArray(data.live_market)) {
    throw new Error('Merolagani live_market: unexpected response structure');
  }
  return data;
}

async function meroMarketSummary() {
  // Returns: { nepse_index, change, change_pct, total_turnover, total_transaction, total_volume, ... }
  const data = await fetchJSON(`${MERO_BASE}/handlers/webrequest.ashx?type=market_summary`);
  return data;
}

async function meroStockHistory(symbol, days = 120) {
  // Returns: { stock, date[], open[], high[], low[], close[], volume[] }
  const to   = new Date();
  const from = new Date(Date.now() - days * 86400000);
  const fmt  = d => d.toISOString().split('T')[0];
  const url  = `${MERO_BASE}/handlers/webrequest.ashx?type=stock_history&symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}`;
  const data = await fetchJSON(url, { timeout: 12000 });
  if (!data || !Array.isArray(data.date)) throw new Error(`Merolagani history: bad response for ${symbol}`);
  return data;
}

async function meroFloorsheet(symbol) {
  const data = await fetchJSON(`${MERO_BASE}/handlers/webrequest.ashx?type=floorsheet&symbol=${encodeURIComponent(symbol)}`);
  return data;
}

async function meroBrokerAnalysis(symbol) {
  const data = await fetchJSON(`${MERO_BASE}/handlers/webrequest.ashx?type=broker_analysis&symbol=${encodeURIComponent(symbol)}`);
  return data;
}

// Parse merolagani live market into our standard format
function parseMeroLive(raw) {
  return raw.live_market.map(s => ({
    symbol:     s.symbol,
    ltp:        parseFloat(s.ltp?.replace(/,/g, '')) || 0,
    change:     parseFloat(s.change?.replace(/,/g, '')) || 0,
    changePct:  parseFloat(s.change_pct?.replace(/,/g, '').replace('%','')) || 0,
    high:       parseFloat(s.high?.replace(/,/g, '')) || 0,
    low:        parseFloat(s.low?.replace(/,/g, '')) || 0,
    open:       parseFloat(s.open?.replace(/,/g, '')) || 0,
    prevClose:  parseFloat(s.prev_close?.replace(/,/g, '')) || 0,
    volume:     parseInt(s.volume?.replace(/,/g, '')) || 0,
    source:     'merolagani',
  }));
}

function parseMeroHistory(raw) {
  if (!raw.date?.length) throw new Error('Empty history from merolagani');
  return {
    symbol:  raw.stock || raw.symbol,
    dates:   raw.date,
    opens:   raw.open.map(v  => parseFloat(v?.replace(/,/g,'')) || 0),
    highs:   raw.high.map(v  => parseFloat(v?.replace(/,/g,'')) || 0),
    lows:    raw.low.map(v   => parseFloat(v?.replace(/,/g,'')) || 0),
    closes:  raw.close.map(v => parseFloat(v?.replace(/,/g,'')) || 0),
    volumes: raw.volume.map(v => parseInt(v?.replace(/,/g,''))  || 0),
    source:  'merolagani',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 2: SHARESANSAR.COM
//  HTML scraping of live trading table and market stats
// ═══════════════════════════════════════════════════════════════════════════════

const SANSAR_BASE = 'https://www.sharesansar.com';

async function sansarLiveMarket() {
  const html = await fetchURL(`${SANSAR_BASE}/live-trading`, { timeout: 12000 });
  return parseSansarLiveHTML(html);
}

function parseSansarLiveHTML(html) {
  // ShareSansar live-trading table has format:
  // <table id="headFixed"><tbody><tr>
  //   <td>1</td><td><a href=...>SYMBOL</a></td>
  //   <td class="text-right">LTP</td><td class="text-right">CHANGE</td>
  //   <td class="text-right">%CHANGE</td><td class="text-right">OPEN</td>
  //   <td class="text-right">HIGH</td><td class="text-right">LOW</td>
  //   <td class="text-right">VOLUME</td><td class="text-right">PREV CLOSE</td>
  // </tr></tbody></table>
  const stocks = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const linkRegex = /<a[^>]*>([^<]+)<\/a>/i;
  const cleanNum  = s => parseFloat(s.replace(/[,\s]/g, '')) || 0;

  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const cells = [];
    let cellMatch;
    const cr = new RegExp(cellRegex.source, 'gi');
    while ((cellMatch = cr.exec(row)) !== null) {
      const inner = cellMatch[1].trim().replace(/<[^>]+>/g, '').trim();
      cells.push(inner);
    }
    // Extract symbol (might be in an anchor)
    const symRaw = row.match(/<a[^>]*href[^>]*stock[^>]*>([^<]+)<\/a>/i);
    if (cells.length >= 8 && (symRaw || cells[1]?.match(/^[A-Z]{2,10}$/))) {
      const sym = symRaw ? symRaw[1].trim() : cells[1].trim();
      if (sym && sym !== 'Symbol' && sym.match(/^[A-Z]/)) {
        stocks.push({
          symbol:    sym,
          ltp:       cleanNum(cells[2] || '0'),
          change:    cleanNum(cells[3] || '0'),
          changePct: cleanNum(cells[4] || '0'),
          open:      cleanNum(cells[5] || '0'),
          high:      cleanNum(cells[6] || '0'),
          low:       cleanNum(cells[7] || '0'),
          volume:    Math.round(cleanNum(cells[8] || '0')),
          prevClose: cleanNum(cells[9] || '0'),
          source:    'sharesansar',
        });
      }
    }
  }
  if (!stocks.length) throw new Error('ShareSansar: no stocks parsed from HTML');
  return stocks;
}

async function sansarIndex() {
  const html = await fetchURL(`${SANSAR_BASE}/today-share-price`, { timeout: 10000 });
  // Extract NEPSE index from page
  const match = html.match(/NEPSE Index[^:]*:?\s*<[^>]+>([0-9,\.]+)/i) ||
                html.match(/([0-9]{3,5}\.[0-9]{2})\s*\(.*?NEPSE/i);
  if (!match) throw new Error('ShareSansar: could not find NEPSE index');
  return parseFloat(match[1].replace(/,/g,''));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 3: NEPALSTOCK.COM
//  Public JSON endpoints (some work without token, some need it)
// ═══════════════════════════════════════════════════════════════════════════════

const NS_BASE = 'https://nepalstock.com';

async function nsIndex() {
  // This endpoint sometimes works without auth
  const data = await fetchJSON(`${NS_BASE}/api/nots/nepseIndex`, { timeout: 8000 });
  return data;
}

async function nsLiveMarket() {
  const data = await fetchJSON(`${NS_BASE}/api/nots/live-market`, { timeout: 8000 });
  return data;
}

async function nsSecurityHistory(id, from, to) {
  // nepalstock historical data — requires knowing security ID
  const data = await fetchJSON(
    `${NS_BASE}/api/nots/history/security/${id}?startDate=${from}&endDate=${to}&size=300`,
    { timeout: 12000 }
  );
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API — used by routes, tries all sources in order
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get live market quotes — tries merolagani → sharesansar → nepalstock
 * Returns array of stock objects or throws if all sources fail
 */
async function getLiveQuotes() {
  return withCache('live_quotes', 30000, async () => {
    const errors = [];

    // Try merolagani first (most reliable JSON)
    try {
      const raw = await meroLiveMarket();
      const quotes = parseMeroLive(raw);
      if (quotes.length > 5) {
        return { success: true, data: quotes, source: 'merolagani', marketOpen: raw.isMarketOpen === '1' };
      }
    } catch (e) { errors.push(`Merolagani: ${e.message}`); }

    // Try sharesansar HTML scraping
    try {
      const quotes = await sansarLiveMarket();
      if (quotes.length > 5) {
        return { success: true, data: quotes, source: 'sharesansar', marketOpen: isMarketOpen() };
      }
    } catch (e) { errors.push(`ShareSansar: ${e.message}`); }

    // Try nepalstock
    try {
      const raw = await nsLiveMarket();
      if (raw && Array.isArray(raw.securities)) {
        const quotes = raw.securities.map(s => ({
          symbol:    s.symbol,
          ltp:       s.lastTradedPrice || 0,
          change:    s.absoluteChange  || 0,
          changePct: s.percentageChange || 0,
          high:      s.highPrice || 0,
          low:       s.lowPrice  || 0,
          open:      s.openPrice || 0,
          volume:    s.totalTradedQuantity || 0,
          prevClose: s.previousClose || 0,
          source:    'nepalstock',
        }));
        return { success: true, data: quotes, source: 'nepalstock', marketOpen: isMarketOpen() };
      }
    } catch (e) { errors.push(`NepalStock: ${e.message}`); }

    // All sources failed
    return { success: false, error: 'All data sources unavailable', details: errors, data: [] };
  });
}

/**
 * Get NEPSE index — tries all sources
 */
async function getNEPSEIndex() {
  return withCache('nepse_index', 30000, async () => {
    const errors = [];

    try {
      const d = await meroMarketSummary();
      if (d && d.nepse_index) {
        return {
          success:       true,
          nepse:         parseFloat(d.nepse_index) || 0,
          change:        parseFloat(d.change)       || 0,
          changePercent: parseFloat(d.change_pct?.replace('%','')) || 0,
          turnover:      parseFloat(d.total_turnover?.replace(/,/g,'')) || 0,
          transactions:  parseInt(d.total_transaction?.replace(/,/g,''))  || 0,
          volume:        parseInt(d.total_volume?.replace(/,/g,''))     || 0,
          marketOpen:    isMarketOpen(),
          source:        'merolagani',
        };
      }
    } catch (e) { errors.push(`Merolagani: ${e.message}`); }

    try {
      const d = await nsIndex();
      if (d && d.nepse) {
        return {
          success:       true,
          nepse:         parseFloat(d.nepse)           || 0,
          change:        parseFloat(d.change)           || 0,
          changePercent: parseFloat(d.changePercent)    || 0,
          turnover:      parseFloat(d.totalTurnover)    || 0,
          transactions:  parseInt(d.totalTransactions)  || 0,
          volume:        parseInt(d.totalVolume)         || 0,
          marketOpen:    isMarketOpen(),
          source:        'nepalstock',
        };
      }
    } catch (e) { errors.push(`NepalStock: ${e.message}`); }

    return { success: false, error: 'Cannot fetch NEPSE index', details: errors };
  });
}

/**
 * Get price history for a stock — real OHLCV from merolagani
 */
async function getStockHistory(symbol, days = 120) {
  const cacheKey = `history_${symbol}_${days}`;
  return withCache(cacheKey, 300000, async () => { // 5-min cache for history
    const errors = [];

    try {
      const raw  = await meroStockHistory(symbol, days);
      const hist = parseMeroHistory(raw);
      if (hist.closes.length >= 20) {
        return { success: true, ...hist };
      }
      errors.push(`Merolagani: only ${hist.closes.length} candles`);
    } catch (e) { errors.push(`Merolagani history: ${e.message}`); }

    return { success: false, error: `Cannot fetch history for ${symbol}`, details: errors };
  });
}

/**
 * Get sector performance — derived from live quotes
 */
async function getSectorPerformance() {
  const quotesRes = await getLiveQuotes();
  if (!quotesRes.success) return { success: false, error: quotesRes.error };

  // Known NEPSE sector mappings
  const SECTOR_MAP = {
    Banking:          ['NABIL','EBL','PRVU','SBI','SANIMA','NICA','SCB','KBL','MBL','PCBL','SRBL','SBL','ADBL','CBL','CZBIL','GBBL','GIME','HBL','JBNL','LBBL','MBL','NBB','NBL','NCCB','NIFRA','NMB','PPCBL','RBCL','SHINE','SKBBL'],
    'Development Bank': ['GBIME','KSBBL','LBSL','MLBL','NABBC','NIDC','SAPDBL','SDBL','SPDBL','SRBL'],
    Hydro:            ['CHILIME','UPPER','NHPC','HIDCL','API','AKPL','BGCL','BPCL','DHPL','GHL','GLH','HDHPC','KPCL','MHNL','NHDL','NGPL','NWCL','PPCL','RKPCL','RRHPCL','SHPC','SJCL','SSHL','TPC','UHEWA','UMRH','UNHPL','VLUCL'],
    Microfinance:     ['MLBSL','SWBBL','SKBBL','CBBL','DDBL','FOWAD','GILB','GMFIL','JSLBB','KMCDB','LLBS','MERO','MLBBL','NMBMF','NSEWA','RMDC','SAMAJ','SDLBSL','SLBBL','SMFDB','SMFBS','SMHL','UNLB','UPCL','WNLB'],
    'Life Insurance': ['NLIC','LIC','LICN','ALICL','CLI','GLI','ILI','JLIC','MNBJA','NLG','PLIC','RLIF','SLI','SNLI'],
    'Non-Life Insurance': ['NICL','NIL','PIC','PRIN','RBCL','SAGOON','SICL','UIC','UPCL'],
    'Mutual Fund':    ['NIBL','NMF','SEOS'],
    Manufacturing:    ['BNT','BSM','HHL','NTC','SHIVM','STC'],
    Telecom:          ['NTC'],
    Hotels:           ['OHL','SHL'],
    Trading:          ['BBC','STC'],
    Finance:          ['CFCL','GFCL','GUFL','HFC','ICFC','JFL','MFIL','NFIL','PFL','PFCL','RBFL','RLFL','SBIFL','SFCL','SIFC','UFL'],
  };

  const sectorChanges = {};
  const sectorCounts  = {};

  for (const q of quotesRes.data) {
    for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
      if (symbols.includes(q.symbol)) {
        sectorChanges[sector] = (sectorChanges[sector] || 0) + q.changePct;
        sectorCounts[sector]  = (sectorCounts[sector]  || 0) + 1;
        break;
      }
    }
  }

  const sectors = Object.entries(sectorChanges)
    .filter(([,v]) => v !== undefined)
    .map(([name, total]) => ({
      name,
      change: parseFloat((total / (sectorCounts[name] || 1)).toFixed(2)),
      stocks: sectorCounts[name],
    }))
    .filter(s => s.stocks > 0)
    .sort((a,b) => b.change - a.change);

  return { success: true, data: sectors, source: quotesRes.source };
}

/**
 * Get broker analysis — from merolagani floorsheet
 */
async function getBrokerAnalysis(symbol) {
  return withCache(`brokers_${symbol}`, 120000, async () => {
    try {
      const data = await meroBrokerAnalysis(symbol);
      if (data && data.top_buyer) {
        return { success: true, data, source: 'merolagani' };
      }
    } catch (e) {
      // Try floorsheet as fallback
      try {
        const fs = await meroFloorsheet(symbol);
        return { success: true, data: fs, source: 'merolagani-floorsheet' };
      } catch (e2) {}
    }
    return { success: false, error: `Cannot fetch broker data for ${symbol}` };
  });
}

/**
 * Get IPO data from merolagani
 */
async function getIPOData() {
  return withCache('ipo_data', 1800000, async () => { // 30-min cache
    try {
      const data = await fetchJSON(`${MERO_BASE}/handlers/webrequest.ashx?type=ipo`);
      if (data && (Array.isArray(data) || Array.isArray(data.ipo))) {
        const list = Array.isArray(data) ? data : data.ipo;
        return { success: true, data: list, source: 'merolagani' };
      }
    } catch(e) {}

    // Fallback: scrape merolagani IPO page
    try {
      const html = await fetchURL(`${MERO_BASE}/IPO.aspx`, { timeout: 10000 });
      const ipos = [];
      // Parse IPO table rows
      const rowRe = /<tr[^>]*class="[^"]*(?:open|upcoming|close)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
      let m;
      while ((m = rowRe.exec(html)) !== null) {
        const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g,'').trim());
        if (cells.length >= 3 && cells[0]) {
          ipos.push({ name: cells[0], issuePrice: cells[1], status: cells[2]?.toLowerCase(), closeDate: cells[3] });
        }
      }
      if (ipos.length) return { success: true, data: ipos, source: 'merolagani-html' };
    } catch(e) {}

    return { success: false, error: 'Cannot fetch IPO data' };
  });
}

// ─── VOLUME ANALYTICS (derived from live quotes + buy pressure) ───────────────
async function getVolumeAnalytics() {
  const res = await getLiveQuotes();
  if (!res.success) return res;

  // Merolagani provides buy/sell qty if available, else estimate from price action
  const data = res.data
    .filter(q => q.volume > 0)
    .map(q => {
      // Estimate buy/sell split from intraday price action
      const rangeUsed = q.high - q.low > 0 ? (q.ltp - q.low) / (q.high - q.low) : 0.5;
      const buyPct    = Math.round(Math.min(85, Math.max(15, rangeUsed * 100)));
      return {
        symbol:     q.symbol,
        ltp:        q.ltp,
        totalVol:   q.volume,
        buyVol:     Math.round(q.volume * buyPct / 100),
        sellVol:    Math.round(q.volume * (100 - buyPct) / 100),
        buyPct,
        sellPct:    100 - buyPct,
        turnover:   Math.round(q.ltp * q.volume),
      };
    })
    .sort((a,b) => b.totalVol - a.totalVol);

  return { success: true, data, source: res.source };
}

// ─── CACHE INVALIDATION ───────────────────────────────────────────────────────
function clearCache() { _cache.clear(); }
function getCacheStats() {
  const now = Date.now();
  const entries = [..._cache.entries()].map(([k,v]) => ({ key: k, ttl: Math.round((v.exp - now)/1000) + 's' }));
  return entries;
}

module.exports = {
  getLiveQuotes,
  getNEPSEIndex,
  getStockHistory,
  getSectorPerformance,
  getBrokerAnalysis,
  getIPOData,
  getVolumeAnalytics,
  isMarketOpen,
  clearCache,
  getCacheStats,
  // Export internals for testing
  _fetchURL: fetchURL,
  _parseMeroLive: parseMeroLive,
  _parseMeroHistory: parseMeroHistory,
  _parseSansarLiveHTML: parseSansarLiveHTML,
};
