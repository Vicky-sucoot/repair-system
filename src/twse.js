// 解析臺灣證券交易所資料（robots.txt 允許程式讀取）：個股日成交、除權息、加權指數歷史。
// 證交所提供的是「原始」價格；分割（如 0050 於 2025 年 1 拆 4）前的價格與配息需除以分割倍數才能與現價比較。

const num = value => {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 民國日期「114/06/02」或「113年01月17日」→「2025-06-02」。 */
export function rocToIso(value) {
  const m = String(value ?? '').match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 個股日成交資訊 STOCK_DAY（一個月一份）→ [[日期, 收盤價]]。無成交（「--」）的日子略過。 */
export function parseStockDay(json) {
  if (json?.stat !== 'OK' || !Array.isArray(json.data)) return [];
  const fields = json.fields || [];
  const di = fields.indexOf('日期');
  const ci = fields.indexOf('收盤價');
  if (di < 0 || ci < 0) return [];
  return json.data
    .map(row => [rocToIso(row[di]), num(row[ci])])
    .filter(([d, c]) => d && c > 0);
}

/** 除權除息計算結果表 TWT49U → 指定代號的 [[除息日, 每股現金股利]]（只取「息」）。 */
export function parseDividends(json, code) {
  if (json?.stat !== 'OK' || !Array.isArray(json.data)) return [];
  const f = json.fields || [];
  const [di, ci, vi, ki] = ['資料日期', '股票代號', '權值+息值', '權/息'].map(name => f.indexOf(name));
  if ([di, ci, vi, ki].some(i => i < 0)) return [];
  return json.data
    .filter(row => String(row[ci]).trim() === code && String(row[ki]).includes('息'))
    .map(row => [rocToIso(row[di]), num(row[vi])])
    .filter(([d, v]) => d && v > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 發行量加權股價指數歷史 MI_5MINS_HIST（一個月一份）→ [[日期, 收盤指數]]。 */
export function parseIndexHistory(json) {
  if (json?.stat !== 'OK' || !Array.isArray(json.data)) return [];
  const fields = json.fields || [];
  const di = fields.indexOf('日期');
  const ci = fields.indexOf('收盤指數');
  if (di < 0 || ci < 0) return [];
  return json.data.map(row => [rocToIso(row[di]), num(row[ci])]).filter(([d, c]) => d && c > 0);
}

/**
 * 找出股票分割：相鄰兩個交易日收盤價跌到原本的 1/2 以下、且當天不是除息日時，視為分割，倍數取整數。
 * 回傳 [{ date, factor }]（date 為分割後第一個交易日）。
 */
export function detectSplits(points, dividends = []) {
  const exDates = new Set(dividends.map(([d]) => d));
  const splits = [];
  for (let i = 1; i < points.length; i += 1) {
    const ratio = points[i][1] / points[i - 1][1];
    if (ratio < 0.5 && !exDates.has(points[i][0])) {
      const factor = Math.round(1 / ratio);
      if (factor >= 2) splits.push({ date: points[i][0], factor });
    }
  }
  return splits;
}

/** 把分割前的收盤價與配息除以分割倍數，讓整段歷史與現價可比較（與一般看盤軟體的「還原分割」相同）。 */
export function adjustForSplits(points, dividends, splits) {
  const factorAt = date => splits.filter(s => date < s.date).reduce((f, s) => f * s.factor, 1);
  const round = v => Number(v.toPrecision(8));
  return {
    points: points.map(([d, c]) => [d, round(c / factorAt(d))]),
    dividends: dividends.map(([d, v]) => [d, round(v / factorAt(d))]),
  };
}

/** 依月份列出 YYYYMM01 字串（含頭尾月份）。 */
export function monthStarts(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (y * 12 + m <= endKey) {
    out.push(`${y}${String(m).padStart(2, '0')}01`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
