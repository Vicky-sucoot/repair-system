// 解析鉅亨網（ws.api.cnyes.com）行情走勢 API，用於費城半導體指數。
// 來源：https://ws.api.cnyes.com/ws/api/v1/charting/history?symbol=GI:SOX:INDEX&resolution=D&from=<新>&to=<舊>

/** 走勢 API 回應 → [[日期, 收盤]]，依日期由舊到新。t 為該交易日 00:00 UTC 的秒數。 */
export function parseCnyesHistory(json) {
  const data = json?.data;
  if (json?.statusCode !== 200 || !Array.isArray(data?.t) || !Array.isArray(data?.c)) throw new Error('鉅亨網回應格式不符');
  const points = new Map();
  data.t.forEach((t, i) => {
    const close = data.c[i];
    if (Number.isFinite(t) && Number.isFinite(close)) points.set(new Date(t * 1000).toISOString().slice(0, 10), close);
  });
  return [...points.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 走勢 API 網址：from 是較新的時間、to 是較舊的時間（秒）。 */
export function cnyesHistoryUrl(symbol, days, now = Date.now()) {
  const from = Math.floor(now / 1000);
  const to = from - days * 86400;
  return `https://ws.api.cnyes.com/ws/api/v1/charting/history?symbol=${encodeURIComponent(symbol)}&resolution=D&quote=1&from=${from}&to=${to}`;
}
