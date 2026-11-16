import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaifexCsv, nightSessionSeries, futDataDownBody } from '../src/taifex.js';

// 取自期交所 futDataDown 實際回應（已轉為 UTF-8）。
const CSV = `交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,是否因訊息面暫停交易,交易時段,價差對單式委託成交量
2026/11/13,TX,202611  ,43925,44824,43692,43834,706,1.64%,94919,43839,105228,43834,43839,50440,37694,,一般,,
2026/11/13,TX,202611  ,43180,44034,42371,43676,548,1.27%,79972,-,-,43654,43674,50440,37694,,盤後,,
2026/11/13,TX,202612  ,43336,44045,42422,43718,558,1.29%,1679,-,-,43691,43716,50560,27382,,盤後,,
2026/11/16,TX,202611  ,43656,43672,40714,40885,-2954,-6.74%,167772,40781,53037,40873,40887,50440,37694,,一般,,
2026/11/16,TX,202612  ,44157,44484,43032,43796,-121,-0.28%,1680,-,-,43765,43777,50560,27382,,盤後,,
2026/11/16,TX,202611  ,43921,44423,42956,43706,-133,-0.30%,56132,-,-,43700,43706,50440,37694,,盤後,,
2026/11/16,TX,202611/202612,-,-,-,-,-,-,10,-,-,-,-,-,-,,盤後,,
`;

test('解析期交所 CSV', () => {
  const rows = parseTaifexCsv(CSV);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], { date: '2026-11-13', contract: 'TX', month: '202611', open: 43180, high: 44034, low: 42371, close: 43676, change: 548, changePct: 1.27, volume: 79972, session: '盤後' });
  assert.throws(() => parseTaifexCsv('<html>error</html>'), /不是行情 CSV/);
});

test('夜盤取近月、排除一般盤與價差組合，依日期排序', () => {
  const series = nightSessionSeries(parseTaifexCsv(CSV));
  assert.deepEqual(series.map(s => [s.date, s.month, s.close, s.change, s.changePct]), [
    ['2026-11-13', '202611', 43676, 548, 1.27],
    ['2026-11-16', '202611', 43706, -133, -0.3]
  ]);
  assert.deepEqual(nightSessionSeries([]), []);
});

test('期交所查詢參數', () => {
  const body = new URLSearchParams(futDataDownBody(new Date(Date.UTC(2026, 9, 17)), new Date(Date.UTC(2026, 10, 20))));
  assert.equal(body.get('queryStartDate'), '2026/10/17');
  assert.equal(body.get('queryEndDate'), '2026/11/20');
  assert.equal(body.get('commodity_id'), 'TX');
});
