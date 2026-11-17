import test from 'node:test';
import assert from 'node:assert/strict';
import { rocToIso, parseStockDay, parseDividends, parseIndexHistory, detectSplits, adjustForSplits, monthStarts } from '../src/twse.js';

test('民國日期轉換', () => {
  assert.equal(rocToIso('114/06/02'), '2025-06-02');
  assert.equal(rocToIso('113年01月17日'), '2024-01-17');
  assert.equal(rocToIso(''), null);
});

// 取自證交所實際回應（已截短）
test('個股日成交 STOCK_DAY', () => {
  const json = { stat: 'OK', fields: ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數', '註記'],
    data: [['114/06/02', '21,228,875', '3,738,759,521', '178.00', '178.05', '175.25', '175.90', '-3.85', '71,584', ''],
      ['114/06/03', '1', '1', '1', '1', '1', '--', 'X', '1', '']] };
  assert.deepEqual(parseStockDay(json), [['2025-06-02', 175.9]]);
  assert.deepEqual(parseStockDay({ stat: '很抱歉，沒有符合條件的資料!' }), []);
});

test('除權息 TWT49U 只取指定代號的現金股利', () => {
  const json = { stat: 'OK', fields: ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息'],
    data: [['114年07月21日', '0050', '元大台灣50', '51.45', '51.09', '0.360000', '息'],
      ['113年01月17日', '0050', '元大台灣50', '131.65', '128.65', '3.000000', '息'],
      ['113年08月01日', '2330', '台積電', '1', '1', '4.000000', '息'],
      ['113年09月01日', '0050', '元大台灣50', '1', '1', '0.500000', '權']] };
  assert.deepEqual(parseDividends(json, '0050'), [['2024-01-17', 3], ['2025-07-21', 0.36]]);
});

test('加權指數 MI_5MINS_HIST', () => {
  const json = { stat: 'OK', fields: ['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'],
    data: [['115/11/02', '45,034.53', '45,156.17', '44,399.10', '44,920.14']] };
  assert.deepEqual(parseIndexHistory(json), [['2026-11-02', 44920.14]]);
});

test('偵測 0050 一拆四並還原分割前價格與配息', () => {
  const points = [['2025-06-09', 188.65], ['2025-06-10', 188.65], ['2025-06-18', 47.57], ['2025-06-19', 47.1]];
  const dividends = [['2025-01-17', 2.7], ['2025-07-21', 0.36]];
  const splits = detectSplits(points, dividends);
  assert.deepEqual(splits, [{ date: '2025-06-18', factor: 4 }]);
  const adj = adjustForSplits(points, dividends, splits);
  assert.deepEqual(adj.points.map(p => p[1]), [47.1625, 47.1625, 47.57, 47.1]);
  assert.deepEqual(adj.dividends, [['2025-01-17', 0.675], ['2025-07-21', 0.36]]);
  // 一般下跌或除息不算分割
  assert.deepEqual(detectSplits([['a', 100], ['b', 70]]), []);
  assert.deepEqual(detectSplits([['a', 100], ['b', 40]], [['b', 60]]), []);
});

test('月份清單', () => {
  assert.deepEqual(monthStarts('2025-11-20', '2026-02-03'), ['20251101', '20251201', '20260101', '20260201']);
});
