// api/quote.js — Vercel Serverless Function
// Finnhub API proxy (replaces Yahoo Finance — blocked on all cloud IPs)
// Free tier: 60 API calls/minute  |  Needs env var: FINNHUB_API_KEY
// © trade2swing

'use strict';

const https = require('https');

const KEY = process.env.FINNHUB_API_KEY || '';

// ── Tiny HTTPS GET helper ──────────────────────────────────────────────────
function get(path) {
  const url = `https://finnhub.io${path}${path.includes('?') ? '&' : '?'}token=${KEY}`;
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'trade2swing-earnings/2.0',
        Accept: 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      );
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ── Rate-limit-aware batch executor ───────────────────────────────────────
async function throttledMap(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) await sleep(1100);
  }
  return results;
}

// ── CORS headers ───────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
};

// ── Revenue extractor from SEC filings ─────────────────────────────────────
function extractRevenue(report) {
  const ic = report?.report?.ic || [];
  const candidates = [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'NetRevenues',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
    'RevenueNet',
    'Revenues1',
  ];
  for (const c of candidates) {
    const line = ic.find((x) => x.concept === c);
    if (line?.value != null) return line.value;
  }
  const nums = ic.map((x) => x.value).filter((v) => typeof v === 'number' && v > 0);
  return nums.length ? Math.max(...nums) : null;
}

// ── Main handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (!KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({
      error: 'FINNHUB_API_KEY is not set. Add it in Vercel → Settings → Environment Variables.',
    }));
    return;
  }

  const { symbols: raw = '', type = 'quote' } = req.query || {};
  const symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (!symbols.length) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'symbols query param required (e.g. ?symbols=MRVL,ZS)' }));
    return;
  }

  try {
    if (type === 'quote') {
      const quotes = await throttledMap(symbols, 5, async (sym) => {
        try {
          const [qRes, mRes] = await Promise.all([
            get(`/api/v1/quote?symbol=${encodeURIComponent(sym)}`),
            get(`/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`),
          ]);
          const q = safeJson(qRes.body) || {};
          const metric = (safeJson(mRes.body) || {}).metric || {};
          const vol10d = metric['10DayAverageTradingVolume'];
          const vol3m  = metric['3MonthAverageTradingVolume'];
          const vol50d = vol10d != null
            ? Math.round(vol10d * 1_000_000)
            : vol3m != null ? Math.round(vol3m * 1_000_000) : null;
          return {
            symbol:        sym,
            price:         q.c   ?? null,
            changePercent: q.dp  ?? null,
            hi52w:         metric['52WeekHigh'] ?? null,
            vol50d,
          };
        } catch {
          return { symbol: sym, price: null, changePercent: null, hi52w: null, vol50d: null };
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ quotes }));
      return;
    }

    if (type === 'summary') {
      const sym = symbols[0];
      const [epsHistRes, epsEstRes, revEstRes, finRes] = await Promise.all([
        get(`/api/v1/stock/earnings?symbol=${encodeURIComponent(sym)}&limit=4`),
        get(`/api/v1/stock/eps-estimate?symbol=${encodeURIComponent(sym)}&freq=quarterly`),
        get(`/api/v1/stock/revenue-estimate?symbol=${encodeURIComponent(sym)}&freq=quarterly`),
        get(`/api/v1/financials-reported?symbol=${encodeURIComponent(sym)}&freq=quarterly`),
      ]);
      const epsHist = safeJson(epsHistRes.body) || [];
      const q1eps = epsHist[0]?.actual ?? null;
      const q2eps = epsHist[1]?.actual ?? null;
      const epsEstData = (safeJson(epsEstRes.body) || {}).data || [];
      const now = Date.now();
      const nqEpsRow = epsEstData.find((e) => e.period && new Date(e.period).getTime() > now) || epsEstData[0];
      const nqEpsEst = nqEpsRow?.epsAvg ?? null;
      const revEstData = (safeJson(revEstRes.body) || {}).data || [];
      const nqRevRow = revEstData.find((e) => e.period && new Date(e.period).getTime() > now) || revEstData[0];
      const nqRevEst = nqRevRow?.revenueAvg ?? null;
      const finData  = safeJson(finRes.body) || {};
      const reports  = (finData.data || []).filter((r) =>
        ['10-Q', '20-F', '6-K', '10-K'].includes(r.form)
      );
      const q1rev = reports[0] ? extractRevenue(reports[0]) : null;
      const q2rev = reports[1] ? extractRevenue(reports[1]) : null;
      const qtrs = reports.slice(0, 4).map(extractRevenue).filter((v) => v != null);
      const annrev = qtrs.length > 0 ? qtrs.reduce((a, b) => a + b, 0) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ symbol: sym, summary: { q1rev, q2rev, annrev, q1eps, q2eps, nqRevEst, nqEpsEst } }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: `Unknown type: "${type}". Use type=quote or type=summary.` }));

  } catch (err) {
    console.error('[api/quote] Unhandled error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: err.message }));
  }
};
