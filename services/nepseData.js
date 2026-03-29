/**
 * NEPSE Data Service — zero external dependencies
 * Uses Node built-in https module only.
 * Primary source: nepalstock.com official public API
 * Fallback: Deterministic realistic NEPSE data generator
 */

'use strict';
const https = require('https');
const http  = require('http');

// ─── LIGHTWEIGHT HTTP FETCH ───────────────────────────────────────────────────
function httpGet(url, ms = 5000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'NeptradePro/1.0 (education)' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(ms, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const _cache = {};
const getCache = k => { const c = _cache[k]; return c && Date.now() < c.exp ? c.data : null; };
const setCache = (k, d, ttl = 30000) => { _cache[k] = { data: d, exp: Date.now() + ttl }; };

// ─── STOCK UNIVERSE ───────────────────────────────────────────────────────────
const NEPSE_STOCKS = [
  { symbol:'NABIL',   name:'Nabil Bank',             sector:'Banking'           },
  { symbol:'PRVU',    name:'Prabhu Bank',             sector:'Banking'           },
  { symbol:'EBL',     name:'Everest Bank',            sector:'Banking'           },
  { symbol:'SBI',     name:'Nepal SBI Bank',          sector:'Banking'           },
  { symbol:'SANIMA',  name:'Sanima Bank',             sector:'Banking'           },
  { symbol:'GBIME',   name:'Global IME Bank',         sector:'Development Bank'  },
  { symbol:'NICA',    name:'NIC Asia Bank',           sector:'Banking'           },
  { symbol:'SCB',     name:'Standard Chartered',      sector:'Banking'           },
  { symbol:'NTC',     name:'Nepal Telecom',           sector:'Telecom'           },
  { symbol:'CHILIME', name:'Chilime Hydro',           sector:'Hydro'             },
  { symbol:'UPPER',   name:'Upper Tamakoshi',         sector:'Hydro'             },
  { symbol:'NHPC',    name:'Nepal Hydro',             sector:'Hydro'             },
  { symbol:'HIDCL',   name:'HIDCL',                   sector:'Hydro'             },
  { symbol:'API',     name:'API Power',               sector:'Hydro'             },
  { symbol:'MLBSL',   name:'Manaslu Laghubitta',      sector:'Microfinance'      },
  { symbol:'NIFRA',   name:'Nepal Infratech',         sector:'Investment'        },
  { symbol:'NIL',     name:'Nepal Investment Trust',  sector:'Mutual Fund'       },
  { symbol:'NLIC',    name:'Nepal Life Insurance',    sector:'Life Insurance'    },
  { symbol:'LICN',    name:'Life Insurance Corp',     sector:'Life Insurance'    },
  { symbol:'SPDBL',   name:'Sipf Dev Bank',           sector:'Development Bank'  },
];

const BASE_PRICES = {
  NABIL:1182, PRVU:428,  EBL:1020, SBI:320,   SANIMA:290,
  GBIME:314,  NICA:840,  SCB:6800, NTC:768,   CHILIME:695,
  UPPER:450,  NHPC:52,   HIDCL:298,API:38,    MLBSL:1840,
  NIFRA:24,   NIL:18,    NLIC:1540,LICN:680,  SPDBL:195,
};

// ─── SEEDED PRICE HISTORY GENERATOR ──────────────────────────────────────────
// Produces realistic OHLCV — same seed = same data (deterministic per symbol)
function generatePriceHistory(symbol, days = 160) {
  const base = BASE_PRICES[symbol] || 500;
  let   st   = symbol.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 1);

  const rand = () => {
    st = Math.imul(st ^ (st >>> 15), st | 1);
    st ^= st + Math.imul(st ^ (st >>> 7), st | 61);
    return ((st ^ (st >>> 14)) >>> 0) / 0x100000000;
  };

  const opens=[], highs=[], lows=[], closes=[], volumes=[], dates=[];
  let price     = base * (0.80 + rand() * 0.40);
  let trendMom  = 0;
  let volC      = 1;

  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    dates.push(d.toISOString().split('T')[0]);

    trendMom  = trendMom * 0.87 + (rand() - 0.46) * 0.045;
    const mr  = (base - price) / base * 0.015;
    const ret = trendMom + mr + (rand() - 0.5) * 0.016;  // tighter noise
    volC      = volC * 0.88 + Math.abs(ret) * 7;

    const open  = price;
    price       = Math.max(0.01, price * (1 + ret));
    const close = price;

    // Clamp price to realistic band around base
    price = Math.max(base * 0.55, Math.min(base * 1.65, price));
    const clampedClose = price;
    const rngAdj = clampedClose * (0.007 + rand() * 0.018) * (1 + volC * 0.35);
    opens.push( +open.toFixed(2));
    highs.push( +(Math.max(open, clampedClose) + rand() * rngAdj).toFixed(2));
    lows.push(  +(Math.min(open, clampedClose) - rand() * rngAdj).toFixed(2));
    closes.push(+clampedClose.toFixed(2));
    volumes.push(Math.round((55000 + rand() * 380000) * (1 + volC * 0.45)));
  }

  return { symbol, opens, highs, lows, closes, volumes, dates };
}

// ─── LIVE INDEX ───────────────────────────────────────────────────────────────
async function fetchNEPSEIndex() {
  const k = 'nepse_idx';
  const cached = getCache(k);
  if (cached) return cached;

  try {
    const data = await httpGet('https://nepalstock.com/api/nots/nepseIndex');
    if (data && (data.nepse || data.index)) {
      const d = {
        nepse:         data.nepse || data.index || 2134,
        sensitive:     data.sensitive || 456,
        float:         data.float || 189,
        change:        data.change || 0,
        changePercent: data.changePercent || 0,
        turnover:      data.totalTurnover || 480000000,
        transactions:  data.totalTransactions || 48000,
        isMarketOpen:  isMarketOpen(),
      };
      setCache(k, d, 30000);
      return d;
    }
  } catch (_) {}

  // Smooth simulated index — cycles slowly
  const t     = Date.now() / 300000;
  const delta = Math.sin(t) * 13 + Math.cos(t * 0.37) * 7;
  const base  = 2134.82;
  const d     = {
    nepse:         +(base + delta).toFixed(2),
    sensitive:     +(456.22 + delta * 0.11).toFixed(2),
    float:         +(189.44 + delta * 0.05).toFixed(2),
    change:        +delta.toFixed(2),
    changePercent: +(delta / base * 100).toFixed(2),
    turnover:      Math.round(480000000 + Math.sin(t * 0.7) * 38000000),
    transactions:  Math.round(47800 + Math.sin(t * 0.5) * 3800),
    isMarketOpen:  isMarketOpen(),
  };
  setCache(k, d, 15000);
  return d;
}

// ─── LIVE QUOTES ─────────────────────────────────────────────────────────────
async function fetchLiveQuotes() {
  const k = 'live_quotes';
  const cached = getCache(k);
  if (cached) return cached;

  try {
    const data = await httpGet('https://nepalstock.com/api/nots/securityDailyTradeStat/58');
    if (Array.isArray(data) && data.length > 2) {
      const quotes = data.slice(0, 20).map(s => ({
        symbol: s.symbol, name: s.securityName, sector: 'N/A',
        ltp: s.lastTradedPrice, change: s.percentageChange || 0,
        volume: s.totalTradedQuantity || 0, turnover: s.totalTradedValue || 0,
        high: s.highPrice, low: s.lowPrice, open: s.openPrice,
        buyPercent: 50 + Math.random() * 20 - 10,
        sellPercent: 50 - Math.random() * 20 + 10,
      }));
      setCache(k, quotes, 30000);
      return quotes;
    }
  } catch (_) {}

  // Smooth simulation that changes every 5 minutes
  const slot = Math.floor(Date.now() / 300000);
  const quotes = NEPSE_STOCKS.map(stock => {
    const base = BASE_PRICES[stock.symbol] || 500;
    const seed = slot * 137 + stock.symbol.charCodeAt(0) * 31;
    const sn   = Math.sin(seed * 0.0037) * 0.6 + Math.cos(seed * 0.0071) * 0.4;
    const chg  = +(sn * 2.2).toFixed(2);
    const ltp  = +(base * (1 + chg / 100)).toFixed(2);
    const buyP = +(45 + Math.abs(Math.sin(seed * 0.013)) * 30).toFixed(1);
    return {
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      ltp, change: chg,
      volume:   Math.round(50000 + Math.abs(Math.sin(seed * 0.019)) * 310000),
      turnover: Math.round(ltp * (50000 + Math.abs(Math.cos(seed * 0.023)) * 260000)),
      high:     +(ltp * (1 + Math.abs(Math.sin(seed * 0.031)) * 0.015)).toFixed(2),
      low:      +(ltp * (1 - Math.abs(Math.cos(seed * 0.029)) * 0.015)).toFixed(2),
      open:     +(ltp * (1 + Math.sin(seed * 0.041) * 0.007)).toFixed(2),
      buyPercent:  buyP,
      sellPercent: +(100 - buyP).toFixed(1),
    };
  });
  setCache(k, quotes, 15000);
  return quotes;
}

// ─── SECTOR DATA ─────────────────────────────────────────────────────────────
async function fetchSectorData() {
  const sectors = [
    'Banking','Development Bank','Finance','Microfinance',
    'Hydro','Non-Life Insurance','Life Insurance',
    'Mutual Fund','Manufacturing','Telecom','Hotels','Trading',
  ];
  const t = Date.now() / 600000;
  return sectors.map((name, i) => ({
    name,
    change: +(Math.sin(t + i * 1.13) * 2.4 + Math.cos(t * 0.79 + i * 0.8) * 0.9).toFixed(2),
  }));
}

// ─── BROKER DATA ─────────────────────────────────────────────────────────────
async function fetchBrokerData(symbol) {
  const names = [
    'Kumari Securities','Mega Securities','NIBL Ace Capital',
    'Sunrise Securities','Global IME Capital','Nabil Invest.',
    'Sanima Capital','Prabhu Capital','NIC Asia Capital','Laxmi Securities',
  ];
  const seed = symbol.split('').reduce((a,c) => a + c.charCodeAt(0), 0) + Math.floor(Date.now()/300000);
  const lcg  = n => (n * 1664525 + 1013904223) & 0xffffffff;
  let   st   = seed;
  return names.map((name, i) => {
    st = lcg(st + i);
    const buy  = Math.round(15000 + ((st >>> 0) % 260000));
    st = lcg(st);
    const sell = Math.round(10000 + ((st >>> 0) % 210000));
    return { id:`B${10+i}`, name, buy, sell, net: buy - sell };
  }).sort((a,b) => b.buy - a.buy);
}

// ─── FLOORSHEET ───────────────────────────────────────────────────────────────
async function fetchFloorsheet(symbol) {
  const base = BASE_PRICES[symbol] || 500;
  return Array.from({ length: 20 }, (_, i) => {
    const price = +(base * (1 + (Math.random() - 0.5) * 0.014)).toFixed(2);
    const qty   = Math.round(10 + Math.random() * 490) * 10;
    return {
      id: 1000 + i,
      buyer:    `B${Math.round(10 + Math.random() * 50)}`,
      seller:   `B${Math.round(10 + Math.random() * 50)}`,
      quantity: qty, price,
      amount:   Math.round(qty * price),
      time:     new Date(Date.now() - i * 17 * 60000).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }),
    };
  });
}

// ─── IPO DATA ─────────────────────────────────────────────────────────────────
async function fetchIPOData() {
  return [
    { name:'Summit Laghubitta',     symbol:'SMLBSL', sector:'Microfinance', issuePrice:100, status:'open',     openDate:'2025-07-20', closeDate:'2025-07-28', totalShares:500000,  issuer:'NIBL Ace Capital' },
    { name:'Himalayan Hydro Power', symbol:'HHP',    sector:'Hydro',        issuePrice:100, status:'upcoming', openDate:'2025-08-10', closeDate:'2025-08-14', totalShares:2000000, issuer:'Kumari Capital'   },
    { name:'Nepal Growth Fund',     symbol:'NGF',    sector:'Mutual Fund',  issuePrice:10,  status:'open',     openDate:'2025-07-18', closeDate:'2025-07-25', totalShares:5000000, issuer:'NMB Capital'      },
    { name:'Sunrise Bank FPO',      symbol:'SRBL',   sector:'Banking',      issuePrice:820, status:'rights',   openDate:'2025-08-01', closeDate:'2025-08-05', totalShares:3000000, issuer:'Sunrise Capital'  },
    { name:'Prabhu Finance',        symbol:'PFL',    sector:'Finance',      issuePrice:100, status:'upcoming', openDate:'2025-09-01', closeDate:'2025-09-05', totalShares:1000000, issuer:'Prabhu Capital'   },
    { name:'NIC Asia FPO',          symbol:'NICA',   sector:'Banking',      issuePrice:100, status:'closed',   openDate:'2025-07-05', closeDate:'2025-07-10', totalShares:8000000, issuer:'NIBL Ace Capital' },
    { name:'Hydropower Nepal MF',   symbol:'HNMF',   sector:'Mutual Fund',  issuePrice:10,  status:'upcoming', openDate:'2025-08-20', closeDate:'2025-08-25', totalShares:3000000, issuer:'NMB Capital'      },
    { name:'Saptakoshi Laghubitta', symbol:'SKBBL',  sector:'Microfinance', issuePrice:100, status:'upcoming', openDate:'2025-09-15', closeDate:'2025-09-19', totalShares:600000,  issuer:'Mega Capital'     },
  ];
}

// ─── MARKET HOURS (NST = UTC+5:45) ────────────────────────────────────────────
function isMarketOpen() {
  const now   = new Date();
  const nstMs = now.getTime() + now.getTimezoneOffset() * 60000 + (5 * 3600 + 45 * 60) * 1000;
  const nst   = new Date(nstMs);
  const day   = nst.getDay();
  if (day === 0 || day === 6) return false;
  const mins  = nst.getHours() * 60 + nst.getMinutes();
  return mins >= 660 && mins <= 900; // 11:00–15:00 NST
}

module.exports = {
  NEPSE_STOCKS, BASE_PRICES,
  generatePriceHistory,
  fetchNEPSEIndex, fetchLiveQuotes, fetchSectorData,
  fetchBrokerData, fetchFloorsheet, fetchIPOData,
  isMarketOpen,
};
