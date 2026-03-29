# NepTrade Pro 🚀
**Free, open NEPSE intelligence platform** — all features unlocked, no subscription.

## Features
- ✅ Live NEPSE index + sector performance
- ✅ Algorithmic Buy/Hold/Sell signals (RSI + MACD + Bollinger + EMA + SuperTrend + Candlestick)
- ✅ Advanced multi-criteria scanner
- ✅ Full technical charts with overlays
- ✅ Volume analytics + Accumulation/Distribution
- ✅ Broker analytics + block trade detection
- ✅ Support & Resistance (auto-detected)
- ✅ Fundamental + technical combined filters
- ✅ Backtesting engine
- ✅ IPO / Rights / Mutual Fund tracker
- ✅ Portfolio tracker with live P&L
- ✅ Alerts (SMS, Push, Email configuration)
- ✅ WebSocket live data feed
- ✅ 100% FREE — no paywalls

## Quick Start

```bash
git clone <repo>
cd neptrade
npm install
cp .env.example .env
npm start
# → http://localhost:3000
```

## Deploy Options

### 1. Render.com (Free)
1. Push to GitHub
2. Go to render.com → New Web Service
3. Connect repo → Build: `npm install` → Start: `node server.js`
4. Free tier works perfectly

### 2. Railway.app (Free tier)
```bash
npm install -g @railway/cli
railway login
railway new
railway up
```

### 3. Fly.io (Free)
```bash
brew install flyctl
fly auth login
fly launch
fly deploy
```

### 4. VPS / DigitalOcean (Rs 600/month)
```bash
# On your server:
git clone <repo>
cd neptrade
npm install --production
# With PM2:
npm install -g pm2
pm2 start server.js --name neptrade
pm2 startup && pm2 save
# With Nginx reverse proxy:
# server { listen 80; location / { proxy_pass http://localhost:3000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection 'upgrade'; } }
```

### 5. Docker
```bash
docker-compose up -d
# or
docker build -t neptrade . && docker run -p 3000:3000 neptrade
```

### 6. Heroku
```bash
heroku create neptrade-pro
git push heroku main
```

## Signal Algorithm

The composite signal engine mimics Chukul's approach:

| Indicator | Weight | Bullish Condition |
|-----------|--------|-------------------|
| RSI (14) | 20 | < 35 oversold |
| MACD (12,26,9) | 20 | MACD > Signal + histogram rising |
| Bollinger Bands | 15 | Price near lower band |
| EMA Cross (20/50) | 15 | EMA20 > EMA50 (golden cross) |
| SuperTrend (10,3) | 10 | Price above SuperTrend line |
| Candlestick Patterns | 10 | Hammer, Engulfing, Morning Star... |
| Volume / OBV | 10 | High volume + rising OBV |

**Score > +20 → BUY | Score < -20 → SELL | Between → HOLD**

## API Endpoints

```
GET  /api/index          — NEPSE index data
GET  /api/sectors         — Sector performance
GET  /api/quotes          — Live stock quotes
GET  /api/signals         — All signals (batch)
GET  /api/signal/:symbol  — Single stock signal
GET  /api/indicators/:sym — Technical indicators series
GET  /api/history/:symbol — Price history OHLCV
GET  /api/volume          — Buy/sell volume data
GET  /api/accumdist       — Accumulation/Distribution
GET  /api/blocktrades     — Block & bulk trades
GET  /api/brokers/:symbol — Broker analytics
GET  /api/sr/:symbol      — Support & Resistance levels
GET  /api/ipo             — IPO/Rights/MF data
POST /api/scan            — Run scanner with filters
POST /api/backtest        — Backtest a strategy
```

## Live Data

By default, data is fetched from `nepalstock.com` official API with a realistic fallback generator when:
- Market is closed (outside 11 AM - 3 PM NST, Sun–Fri)
- API is temporarily unavailable

For production live data, apply for NEPSE's official API access at nepalstock.com.

## License
MIT — free to use, modify, deploy.
