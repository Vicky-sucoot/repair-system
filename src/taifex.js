// 解析期交所（TAIFEX）期貨每日交易行情 CSV，取出台指期（TX）夜盤（盤後交易時段）與美元黃金期貨（GDF）結算價。
// CSV 來源：https://www.taifex.com.tw/cht/3/futDataDown（Big5 編碼，下載端先轉成文字）

const num = value => {
  const n = Number(String(value).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 將 CSV 文字解析為列資料；無法辨識時拋出錯誤。 */
export function parseTaifexCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || !lines[0].includes('交易日期')) throw new Error('期交所回應不是行情 CSV');
  const header = lines[0].split(',').map(h => h.trim());
  const col = name => header.indexOf(name);
  const idx = {
    date: col('交易日期'), contract: col('契約'), month: col('到期月份(週別)'), open: col('開盤價'), high: col('最高價'),
    low: col('最低價'), close: col('收盤價'), change: col('漲跌價'), changePct: col('漲跌%'), volume: col('成交量'), session: col('交易時段')
  };
  const settleCol = col('結算價'); // 選用欄位
  if (Object.values(idx).some(i => i < 0)) throw new Error('期交所 CSV 欄位不符');
  return lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim());
    return {
      date: cells[idx.date].replaceAll('/', '-'),
      contract: cells[idx.contract],
      month: cells[idx.month],
      open: num(cells[idx.open]),
      high: num(cells[idx.high]),
      low: num(cells[idx.low]),
      close: num(cells[idx.close]),
      change: num(cells[idx.change]),
      changePct: num(cells[idx.changePct]),
      volume: num(cells[idx.volume]),
      session: cells[idx.session],
      ...(settleCol >= 0 ? { settle: num(cells[settleCol]) } : {})
    };
  }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

/**
 * 取出每個交易日的台指期近月夜盤（盤後）收盤，依日期由舊到新。
 * 期交所把前一日 15:00 至當日 05:00 的夜盤歸在「當日」交易日。
 */
export function nightSessionSeries(rows, contract = 'TX') {
  const byDate = new Map();
  for (const r of rows) {
    // 只取單一月份契約（排除價差組合如 202611/202612）。
    if (r.contract !== contract || r.session !== '盤後' || !/^\d{6}$/.test(r.month) || r.close == null) continue;
    const current = byDate.get(r.date);
    if (!current || r.month < current.month) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map(r => ({
    date: r.date, month: r.month, close: r.close, change: r.change, changePct: r.changePct, high: r.high, low: r.low, volume: r.volume
  }));
}

export function futDataDownBody(start, end, commodity = 'TX') {
  const fmt = d => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return new URLSearchParams({ down_type: '1', commodity_id: commodity, queryStartDate: fmt(start), queryEndDate: fmt(end) }).toString();
}

/**
 * 每個交易日一般交易時段近月契約的結算價（例如 GDF 美元黃金期貨，美元／盎司），依日期由舊到新。
 * 成交稀少時收盤價可能停留在舊價，結算價每天都有，因此以結算價為準；漲跌與前一交易日同一月份的結算價相比。
 */
export function settlementSeries(rows, contract) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.contract !== contract || r.session !== '一般' || !/^\d{6}$/.test(r.month) || r.settle == null) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date).set(r.month, r.settle);
  }
  const dates = [...byDate.keys()].sort();
  return dates.map((date, i) => {
    const months = byDate.get(date);
    const month = [...months.keys()].sort()[0];
    const close = months.get(month);
    const prev = i > 0 ? byDate.get(dates[i - 1]).get(month) : undefined;
    const change = prev == null ? null : Math.round((close - prev) * 100) / 100;
    return { date, month, close, change, changePct: prev ? Math.round((close / prev - 1) * 10000) / 100 : null };
  });
}

/** 期交所每日外幣參考匯率 CSV（dailyFXRateDown）→ [[日期, 美元兌新台幣]]。 */
export function parseFxCsv(text, column = '美元／新台幣') {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || !lines[0].includes('日期')) throw new Error('期交所回應不是匯率 CSV');
  const header = lines[0].split(',').map(h => h.trim());
  const ci = header.indexOf(column);
  if (ci < 0) throw new Error(`匯率 CSV 沒有「${column}」欄位`);
  return lines.slice(1).map(line => line.split(',')).map(cells => [cells[0].trim().replaceAll('/', '-'), Number(cells[ci])])
    .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0);
}

export function fxDataDownBody(start, end) {
  return new URLSearchParams({ queryStartDate: start.replaceAll('-', '/'), queryEndDate: end.replaceAll('-', '/') }).toString();
}
