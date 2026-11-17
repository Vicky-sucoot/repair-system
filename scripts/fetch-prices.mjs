// 下載行情資料，寫入 data/prices.json。由 GitHub Actions 每日執行；本機執行：node scripts/fetch-prices.mjs
//
// 資料來源：
// - 0050 收盤價與配息、加權指數：臺灣證券交易所（robots.txt 允許程式讀取）
// - 美元兌新台幣、台指期夜盤：臺灣期貨交易所（無 robots.txt 限制）
// - VOO：Yahoo Finance（使用者選擇；Yahoo 的 robots.txt 不允許程式抓取，日後可能被封鎖）
//
// 證交所與期交所的歷史資料第一次需要逐月回補（0050 約 15 分鐘），之後只抓最近一個月並與既有資料合併。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYahooChart, chartUrl } from '../src/yahoo.js';
import { parseTaifexCsv, nightSessionSeries, futDataDownBody, parseFxCsv, fxDataDownBody } from '../src/taifex.js';
import { parseStockDay, parseDividends, parseIndexHistory, detectSplits, adjustForSplits, monthStarts } from '../src/twse.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'data/prices.json');
const UA = 'Mozilla/5.0 (compatible; tw-market-intel/1.0)';
const HISTORY_START = '2009-01-01';   // 0050 回補起點
const FX_START = '2010-01-01';        // 匯率回補起點（VOO 自 2010-09 起）

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastRequest = new Map();
const todayTw = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
/** YYYYMM01 → 該月第一天與最後一天（ISO）。 */
const monthRange = yyyymm01 => {
  const y = Number(yyyymm01.slice(0, 4));
  const m = Number(yyyymm01.slice(4, 6));
  return [`${y}-${String(m).padStart(2, '0')}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
};

/** 依主機控制請求間隔（證交所約 3 秒一次），失敗時重試。 */
async function request(url, { method = 'GET', body, minInterval = 1000, as = 'json' } = {}) {
  const host = new URL(url).host;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wait = (lastRequest.get(host) || 0) + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest.set(host, Date.now());
    try {
      const response = await fetch(url, {
        method, body,
        headers: { 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (as === 'json') return await response.json();
      const buffer = await response.arrayBuffer();
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return new TextDecoder('big5').decode(buffer); }
    } catch (error) {
      lastError = error;
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`${url} 下載失敗：${lastError?.message}`);
}

const zip = s => (s?.dates || []).map((d, i) => [d, s.close[i]]);
const unzip = points => ({ dates: points.map(p => p[0]), close: points.map(p => p[1]) });
/** 合併兩段依日期排序的資料，同一天以新資料為準。 */
function merge(oldPoints, newPoints) {
  const map = new Map(oldPoints);
  for (const [d, v] of newPoints) map.set(d, v);
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------- 0050：證交所 ----------
async function fetch0050(prev) {
  const code = '0050';
  const incremental = prev?.source === 'twse';
  const stored = incremental ? zip(prev) : [];
  const from = incremental ? stored.at(-1)[0] : HISTORY_START;
  let raw = [];
  for (const month of monthStarts(from, todayTw())) {
    const json = await request(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${month}&stockNo=${code}&response=json`, { minInterval: 3000 });
    raw = raw.concat(parseStockDay(json));
  }
  // 配息：逐年查詢除權除息結果表（原始金額）；增量更新時只查最近兩年，其餘沿用已還原過的資料
  const thisYear = Number(todayTw().slice(0, 4));
  const firstYear = incremental ? thisYear - 1 : Number(HISTORY_START.slice(0, 4));
  let dividends = [];
  for (let y = firstYear; y <= thisYear; y += 1) {
    const json = await request(`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${y}0101&endDate=${y}1231&response=json`, { minInterval: 3000 });
    dividends = dividends.concat(parseDividends(json, code));
  }
  const keptDividends = incremental ? (prev.dividends || []).filter(([d]) => d < `${firstYear}-01-01`) : [];
  // 已儲存的資料已還原過分割，只需偵測這次新資料中（或接縫處）新發生的分割
  let points = merge(stored.filter(([d]) => d < from), raw);
  let splits = incremental ? [...(prev.splits || [])] : [];
  const found = detectSplits(points, dividends).filter(s => !splits.some(k => k.date === s.date));
  if (found.length) {
    points = adjustForSplits(points, [], found).points;
    splits = splits.concat(found).sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`0050 偵測到分割：${found.map(s => `${s.date} 1 拆 ${s.factor}`).join('、')}`);
  }
  const adjDividends = merge(keptDividends, adjustForSplits([], dividends, splits).dividends);
  if (points.length < 20) throw new Error('0050 資料筆數異常');
  const last = points.at(-1);
  return { ...unzip(points), dividends: adjDividends, splits, source: 'twse', last: { price: last[1], time: `${last[0]}T13:30:00+08:00` } };
}

// ---------- 加權指數：證交所 ----------
async function fetchTwii() {
  const today = todayTw();
  let points = [];
  for (const month of monthStarts(addDays(today, -50), today)) {
    const json = await request(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${month}&response=json`, { minInterval: 3000 });
    points = points.concat(parseIndexHistory(json));
  }
  if (!points.length) throw new Error('沒有加權指數資料');
  return { name: '加權指數', source: '臺灣證券交易所', ...unzip(points.slice(-45)) };
}

// ---------- 美元兌新台幣：期交所每日外幣參考匯率 ----------
async function fetchFx(prev) {
  const incremental = prev?.source === 'taifex';
  const stored = incremental ? zip(prev) : [];
  const from = incremental ? addDays(stored.at(-1)[0], -7) : FX_START;
  let raw = [];
  for (const month of monthStarts(from, todayTw())) {
    const [start, end] = monthRange(month);
    const text = await request('https://www.taifex.com.tw/cht/3/dailyFXRateDown', { method: 'POST', body: fxDataDownBody(start, end), minInterval: 1500, as: 'text' });
    raw = raw.concat(parseFxCsv(text));
  }
  const points = merge(stored, raw);
  if (points.length < 20) throw new Error('匯率資料筆數異常');
  const last = points.at(-1);
  return { ...unzip(points), dividends: [], source: 'taifex', last: { price: last[1], time: `${last[0]}T16:00:00+08:00` } };
}

// ---------- VOO：Yahoo Finance（使用者選擇） ----------
async function fetchYahoo(symbol, days = null) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const json = await request(chartUrl(symbol, hosts[attempt % hosts.length], days), { minInterval: 1000 });
      return { ...parseYahooChart(json), source: 'yahoo' };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${symbol} 下載失敗：${lastError?.message}`);
}

// ---------- 台指期夜盤：期交所 ----------
async function fetchNightSession() {
  const end = new Date(Date.now() + 8 * 3600000); // 台灣日期
  const start = new Date(end.getTime() - 30 * 86400000);
  // 週末執行時，週五夜盤歸在下週一，因此結束日往後延；期交所不接受時再改用今天。
  for (const endDate of [new Date(end.getTime() + 4 * 86400000), end]) {
    try {
      const text = await request('https://www.taifex.com.tw/cht/3/futDataDown', { method: 'POST', body: futDataDownBody(start, endDate), minInterval: 1500, as: 'text' });
      const series = nightSessionSeries(parseTaifexCsv(text));
      if (series.length) return { name: '台指期夜盤（近月）', source: '臺灣期貨交易所', series };
    } catch (error) {
      console.error(`夜盤（結束日 ${endDate.toISOString().slice(0, 10)}）：${error.message}`);
    }
  }
  throw new Error('台指期夜盤下載失敗');
}

let previous = { symbols: {}, indices: {} };
try { previous = JSON.parse(await readFile(output, 'utf8')); } catch { /* 第一次執行 */ }

const data = {
  updatedAt: new Date().toISOString(),
  source: '臺灣證券交易所（0050、加權指數）、臺灣期貨交易所（匯率、夜盤）、Yahoo Finance（VOO）',
  symbols: {}, indices: {},
};
const jobs = [
  ['symbols', '0050.TW', () => fetch0050(previous.symbols?.['0050.TW'])],
  ['symbols', 'VOO', () => fetchYahoo('VOO')],
  ['symbols', 'TWD=X', () => fetchFx(previous.symbols?.['TWD=X'])],
  ['indices', 'TWII', fetchTwii],
  ['indices', 'TX_NIGHT', fetchNightSession],
];
const failures = [];
for (const [group, key, job] of jobs) {
  const started = Date.now();
  try {
    data[group][key] = await job();
    const v = data[group][key];
    console.log(`${key}: 完成（${v.dates?.length ?? v.series?.length} 筆，最新 ${v.dates?.at(-1) ?? v.series?.at(-1)?.date}，${Math.round((Date.now() - started) / 1000)} 秒）`);
  } catch (error) {
    failures.push(key);
    console.error(`${key}: ${error.message}`);
    // 下載失敗時保留上一版資料，避免網站整個無法試算。
    if (previous[group]?.[key]) data[group][key] = previous[group][key];
  }
}
if (failures.length === jobs.length) {
  console.error('全部下載失敗，不更新資料檔。');
  process.exit(1);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(data)}\n`);
console.log(`已寫入 ${output}${failures.length ? `（${failures.join('、')} 沿用舊資料）` : ''}`);
