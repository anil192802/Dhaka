require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const path       = require('path');
const cron       = require('node-cron');
const apiRouter  = require('./routes/api');
const { fetchNEPSEIndex, fetchLiveQuotes, isMarketOpen } = require('./services/nepseData');
const { generateSignal, calcRSI } = require('./services/signalEngine');
const { NEPSE_STOCKS, generatePriceHistory } = require('./services/nepseData');

const app  = express();
const server = http.createServer(app);
const wss  = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // Disabled for inline scripts
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WEBSOCKET LIVE FEED ──────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected. Total: ${clients.size}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe') {
        ws.subscriptions = msg.symbols || [];
      }
    } catch(_) {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  });

  // Send initial snapshot
  sendSnapshot(ws);
});

async function sendSnapshot(ws) {
  try {
    const [index, quotes] = await Promise.all([fetchNEPSEIndex(), fetchLiveQuotes()]);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'snapshot', index, quotes, marketOpen: isMarketOpen(), ts: Date.now() }));
    }
  } catch (_) {}
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ─── LIVE DATA BROADCAST (every 15 seconds during market hours) ───────────────
cron.schedule('*/15 * * * * *', async () => {
  if (clients.size === 0) return;
  try {
    const index = await fetchNEPSEIndex();
    broadcast({ type: 'index_update', data: index, ts: Date.now() });
  } catch (_) {}
});

cron.schedule('*/30 * * * * *', async () => {
  if (clients.size === 0) return;
  try {
    const quotes = await fetchLiveQuotes();
    broadcast({ type: 'quotes_update', data: quotes, ts: Date.now() });
  } catch (_) {}
});

// ─── SIGNAL BROADCAST (every 5 minutes) ──────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  if (clients.size === 0) return;
  // Send fresh signals for a few random stocks
  const sample = NEPSE_STOCKS.slice().sort(() => Math.random()-0.5).slice(0,3);
  for (const stock of sample) {
    const priceData = generatePriceHistory(stock.symbol, 120);
    const signal = generateSignal(priceData);
    if (signal) broadcast({ type: 'signal_update', data: { ...signal, name: stock.name, sector: stock.sector }, ts: Date.now() });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 NepTrade Pro running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api`);
  console.log(`   Market:    ${isMarketOpen() ? '🟢 OPEN' : '🔴 CLOSED'}\n`);
});
