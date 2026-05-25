// Vercel Serverless Function — api/quote.js
// Proxies Yahoo Finance API server-side — no browser CORS issues
//
// Endpoints:
//   Batch quotes:   GET /api/quote?symbols=MRVL,CRM,SNOW
//   Stock summary:  GET /api/quote?symbols=MRVL&type=summary
//
// © trade2swing

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbols, type } = req.query;

  if (!symbols) {
    return res.status(400).json({ error: 'Missing required parameter: symbols' });
  }

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };

  try {
    let url;

    if (type === 'summary') {
      url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbols)}?modules=incomeStatementHistoryQuarterly,earningsTrend`;
    } else {
      url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,fiftyTwoWeekHigh,averageDailyVolume50Day,regularMarketVolume`;
    }

    const response = await fetch(url, { headers: HEADERS });

    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `Yahoo Finance responded with ${response.status}`,
        detail: body.substring(0, 300),
      });
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
