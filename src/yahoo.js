// 解析 Yahoo Finance chart API（v8）回應，轉成網站使用的精簡格式。

function localDate(timestamp, offsetSeconds) {
  return new Date((timestamp + offsetSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * @returns {{ dates: string[], close: number[], dividends: [string, number][], last: { price: number, time: string } }}
 */
export function parseYahooChart(json) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'Yahoo 回應沒有資料');
  const offset = Number(result.meta?.gmtoffset) || 0;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const byDate = new Map();
  timestamps.forEach((t, i) => {
    const value = closes[i];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      byDate.set(localDate(t, offset), Number(value.toPrecision(8)));
    }
  });
  const dates = [...byDate.keys()].sort();
  if (!dates.length) throw new Error('Yahoo 回應沒有收盤價');
  const dividends = Object.values(result.events?.dividends || {})
    .filter(d => Number(d.amount) > 0)
    .map(d => [localDate(Number(d.date), offset), Number(Number(d.amount).toPrecision(8))])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const meta = result.meta || {};
  const lastPrice = Number(meta.regularMarketPrice);
  return {
    dates,
    close: dates.map(d => byDate.get(d)),
    dividends,
    last: Number.isFinite(lastPrice) && lastPrice > 0 && meta.regularMarketTime
      ? { price: lastPrice, time: new Date(meta.regularMarketTime * 1000).toISOString() }
      : { price: byDate.get(dates[dates.length - 1]), time: `${dates[dates.length - 1]}T00:00:00Z` }
  };
}

export function chartUrl(symbol, host = 'query1.finance.yahoo.com') {
  const now = Math.floor(Date.now() / 1000);
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${now}&interval=1d&events=div&includeAdjustedClose=false`;
}
