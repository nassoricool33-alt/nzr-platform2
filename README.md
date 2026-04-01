# NZR — AI Trading Intelligence Platform

A professional AI-powered stock analysis platform built for deployment on Vercel.

## Features
- **AI Stock Analyzer** — Multi-timeframe analysis with NZR Confidence Score
- **Live Market Dashboard** — Indices, heat map, session calendar
- **Trading Guides** — 6 in-depth strategy guides
- **Futuristic UI** — Dark theme with animated backgrounds

## Deploy to Vercel in 3 Steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "NZR platform"
git remote add origin https://github.com/YOUR_USERNAME/nzr-platform.git
git push -u origin main
```

### 2. Import to Vercel
1. Go to [vercel.com](https://vercel.com) → New Project
2. Import your GitHub repository
3. Click **Deploy** (no build settings needed — it's static + serverless)

### 3. Add Your API Key
1. In Vercel dashboard → your project → **Settings** → **Environment Variables**
2. Add: `ANTHROPIC_API_KEY` = `sk-ant-your-key-here`
3. Redeploy: **Deployments** → **Redeploy**

## Project Structure
```
nzr-platform/
├── index.html          # Full single-page application
├── api/
│   └── analyze.js      # Serverless API proxy (keeps key secure)
├── vercel.json         # Routing config
└── README.md
```

## How the API Key Works
Your API key is stored securely as a Vercel environment variable.
The `api/analyze.js` serverless function acts as a proxy — the browser
never sees your key. All requests go: Browser → /api/analyze → Anthropic API.

## Local Development
```bash
npm install -g vercel
vercel dev
```
Then open http://localhost:3000
