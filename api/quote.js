// api/quote.js — Vercel Serverless Function
// Yahoo Finance proxy with cookie + crumb authentication
// © trade2swing

'use strict';

const https = require('https');

// ── tiny HTTPS helper ──────────────────────────────────────────────────────
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
      ...options,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── obtain Yahoo Finance crumb (cached for the lifetime of the function) ──
let _crumbCache = null; // { cookie, crumb, fetchedAt }
const CRUMB_TTL_MS = 25 * 60 * 1000; // re-fetch every 25 minutes

async function getYahooCrumb() {
  const now = Date.now();
  if (_crumbCache && now - _crumbCache.fetchedAt < CRUMB_TTL_MS) {
    return _crumbCache;
  }

  // Step 1 – hit the consent endpoint to get a session cookie
  const consentRes = await request('https://fc.yahoo.com/');
  let cookie = '';

  const rawCookies = consentRes.headers['set-cookie'];
  if (Array.isArray(rawCookies) && rawCookies.length) {
    cookie = rawCookies
      .map((line) => line.split(';')[0].trim())
      .join('; ');
  }

  // Step 2 – exchange cookie for a crumb token
  const crumbRes = await request(
    'https://query2.finance.yahoo.com/v1/test/getcrumb',
    {
      headers: {
        Cookie: cookie,
        Referer: 'https://finance.yahoo.com',
      },
    }
  );

  let crumb = crumbRes.body.trim();

  // Retry on alternate host if response looks like HTML or JSON error
  if (!crumb || crumb.startsWith('{') || crumb.startsWith('<')) {
    const retry = await request(
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      { headers: { Cookie: cookie, Referer: 'https://finance.yahoo.com' } }
    );
    crumb = retry.body.trim();
  }

  if (!crumb || crumb.length > 20) {
    throw new Error('Failed to obtain Yahoo Finance crumb');
  }

  _crumbCache = { cookie, crumb, fetchedAt: now };
  return _crumbCache;
}

// ── build quote URL ────────────────────────────────────────────────────────
function quoteUrl(symbols, crumb) {
  const syms = encodeURIComponent(symbols.join(','));
  return (
    `https://query1.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${syms}` +
    `&fields=regularMarketPrice,regularMarketChangePercent,` +
    `fiftyTwoWeekHigh,regularMarketVolume,averageDailyVolume10Day,` +
    `averageDailyVolume3Month,fiftyDayAverageVolume,` +
    `trailingPE,forwardPE,marketCap,shortName,longName` +
    `&crumb=${encodeURIComponent(crumb)}`
  );
}

// ── build summary/financials URL ───────────────────────────────────────────
function summaryUrl(symbol, crumb) {
  return (
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=incomeStatementHistory,earningsTrend,defaultKeyStatistics` +
    `&crumb=${encodeURIComponent(crumb)}`
  );
}

// ── parse quarterly revenue & EPS from quoteSummary ───────────────────────
function parseSummary(json) {
  try {
    const qs = json.quoteSummary;
    if (!qs || qs.error) return null;
    const result = qs.result && qs.result[0];
    if (!result) return null;

    const stmts = result.incomeStatementHistory?.incomeStatementHistory || [];
    const quarters = stmts.slice(0, 4).map((s) => ({
      date: s.endDate?.fmt || '',
      revenue: s.totalRevenue?.raw || null,
      netIncome: s.netIncome?.raw || null,
    }));

    const trend = result.earningsTrend?.trend || [];
    const nqTrend = trend.find((t) => t.period === '+1q');
    const nqRevEst = nqTrend?.revenueEstimate?.avg?.raw || null;
    const nqEpsEst = nqTrend?.earningsEstimate?.avg?.raw || null;

    return { quarters, nqRevEst, nqEpsEst };
  } catch {
    return null;
  }
}

// ── CORS headers ───────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
};

// ── main handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const { symbols: rawSymbols = '', type = 'quote' } = req.query || {};
  const symbols = rawSymbols
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!symbols.length) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'symbols query param required' }));
    return;
  }

  try {
    const { cookie, crumb } = await getYahooCrumb();

    // ── Batch quote ────────────────────────────────────────────────────────
    if (type === 'quote') {
      const url = quoteUrl(symbols, crumb);
      const yfRes = await request(url, {
        headers: { Cookie: cookie, Referer: 'https://finance.yahoo.com' },
      });

      if (yfRes.status !== 200) {
        _crumbCache = null; // bust stale crumb
        res.writeHead(yfRes.status, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({
          error: `Yahoo Finance responded with ${yfRes.status}`,
          detail: yfRes.body.slice(0, 400),
        }));
        return;
      }

      const data = JSON.parse(yfRes.body);
      const quotes = (data.quoteResponse?.result || []).map((q) => ({
        symbol: q.symbol,
        price: q.regularMarketPrice,
        changePercent: q.regularMarketChangePercent,
        high52w: q.fiftyTwoWeekHigh,
        volume: q.regularMarketVolume,
        avgVol10d: q.averageDailyVolume10Day,
        avgVol3m: q.averageDailyVolume3Month,
        avgVol50d: q.fiftyDayAverageVolume,
        pe: q.trailingPE,
        forwardPe: q.forwardPE,
        marketCap: q.marketCap,
        name: q.shortName || q.longName,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ quotes }));
      return;
    }

    // ── Per-ticker financials + estimates ──────────────────────────────────
    if (type === 'summary') {
      const symbol = symbols[0];
      const url = summaryUrl(symbol, crumb);
      const yfRes = await request(url, {
        headers: { Cookie: cookie, Referer: 'https://finance.yahoo.com' },
      });

      if (yfRes.status !== 200) {
        _crumbCache = null;
        res.writeHead(yfRes.status, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({
          error: `Yahoo Finance responded with ${yfRes.status}`,
          detail: yfRes.body.slice(0, 400),
        }));
        return;
      }

      const data = JSON.parse(yfRes.body);
      const summary = parseSummary(data);

      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ symbol, summary }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: `Unknown type: ${type}` }));

  } catch (err) {
    console.error('[api/quote] Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: err.message }));
  }
};
