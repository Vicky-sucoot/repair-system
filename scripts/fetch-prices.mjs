// 從 Yahoo Finance 下載日收盤價與配息、加權指數，並從期交所下載台指期夜盤，寫入 data/prices.json。
// 由 GitHub Actions 每日執行；本機執行：node scripts/fetch-prices.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, FX_SYMBOL } from '../src/dca.js';
import { parseYahooChart, chartUrl } from '../src/yahoo.js';
import { parseTaifexCsv, nightSessionSeries, futDataDownBody } from '../src/taifex.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'data/prices.json');
const symbols = [...Object.keys(ASSETS), FX_SYMBOL];
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

async function fetchSymbol(symbol, days = null) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const url = chartUrl(symbol, HOSTS[attempt % HOSTS.length], days);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dca-tracker price updater)', Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseYahooChart(await response.json());
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error(`${symbol} 下載失敗：${lastError?.message}`);
}

let previous = { symbols: {} };
try { previous = JSON.parse(await readFile(output, 'utf8')); } catch { /* 第一次執行 */ }

const data = { updatedAt: new Date().toISOString(), source: 'Yahoo Finance', symbols: {} };
const failures = [];
for (const symbol of symbols) {
  try {
    data.symbols[symbol] = await fetchSymbol(symbol);
    console.log(`${symbol}: ${data.symbols[symbol].dates.length} 筆，最新 ${data.symbols[symbol].dates.at(-1)}`);
  } catch (error) {
    failures.push(error.message);
    console.error(error.message);
    // 下載失敗時保留上一版資料，避免網站整個無法試算。
    if (previous.symbols?.[symbol]) data.symbols[symbol] = previous.symbols[symbol];
  }
}
// ---------- 指數 ----------
async function fetchTwii() {
  const s = await fetchSymbol('^TWII', 45);
  return { name: '加權指數', source: 'Yahoo Finance', dates: s.dates, close: s.close };
}
async function fetchNightSession() {
  const end = new Date(Date.now() + 8 * 3600000); // 台灣日期
  const start = new Date(end.getTime() - 30 * 86400000);
  // 週末執行時，週五夜盤歸在下週一，因此結束日往後延；期交所不接受時再改用今天。
  const endDates = [new Date(end.getTime() + 4 * 86400000), end];
  let lastError;
  for (const endDate of endDates) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch('https://www.taifex.com.tw/cht/3/futDataDown', {
          method: 'POST',
          headers: { 'User-Agent': 'Mozilla/5.0 (dca-tracker price updater)', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: futDataDownBody(start, endDate)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = new TextDecoder('big5').decode(await response.arrayBuffer());
        const series = nightSessionSeries(parseTaifexCsv(text));
        if (!series.length) throw new Error('沒有夜盤資料');
        return { name: '台指期夜盤（近月）', source: '臺灣期貨交易所', series };
      } catch (error) {
        lastError = error;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw new Error(`台指期夜盤下載失敗：${lastError?.message}`);
}
data.indices = {};
for (const [key, loader] of [['TWII', fetchTwii], ['TX_NIGHT', fetchNightSession]]) {
  try {
    data.indices[key] = await loader();
    console.log(`${key}: 更新完成`);
  } catch (error) {
    console.error(`${key}: ${error.message}`);
    if (previous.indices?.[key]) data.indices[key] = previous.indices[key];
  }
}

if (failures.length === symbols.length) {
  console.error('全部標的下載失敗，不更新資料檔。');
  process.exit(1);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(data)}\n`);
console.log(`已寫入 ${output}${failures.length ? `（${failures.length} 檔沿用舊資料）` : ''}`);
