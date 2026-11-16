import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, buyShares, xirr, combineTimelines, indexOnOrAfter } from '../src/dca.js';
import { parseYahooChart } from '../src/yahoo.js';

const series = {
  dates: ['2024-01-02', '2024-01-08', '2024-01-31', '2024-02-07', '2024-02-29', '2024-03-06', '2024-03-29'],
  close: [100, 100, 110, 120, 125, 150, 160],
  dividends: []
};
const twPlan = {
  symbol: '0050.TW', startDate: '2024-01-01', initial: 10000,
  entries: [
    { id: 'a', date: '2024-01-06', amount: 1000 },
    { id: 'b', date: '2024-02-06', amount: 3000 },
    { id: 'c', date: '2024-03-06', amount: 1500 }
  ],
  feeRate: 0, minFee: 0, wholeShares: true, reinvest: false, dividendTax: 0
};

test('indexOnOrAfter 找到當日或下一個交易日', () => {
  assert.equal(indexOnOrAfter(series.dates, '2024-01-06'), 1);
  assert.equal(indexOnOrAfter(series.dates, '2024-03-06'), 5);
  assert.equal(indexOnOrAfter(series.dates, '2025-01-01'), series.dates.length);
});

test('整股買進含手續費與最低手續費', () => {
  const whole = buyShares(1000, 100, { feeRate: 0.1425, minFee: 1, wholeShares: true });
  assert.equal(whole.shares, 9);
  assert.ok(Math.abs(whole.fee - 1.2825) < 1e-9);
  assert.equal(buyShares(1000, 100, { feeRate: 0.1425, minFee: 20, wholeShares: true }).shares, 9);
  assert.equal(buyShares(50, 100, { feeRate: 0, minFee: 0, wholeShares: true }).shares, 0);
  assert.equal(buyShares(1000, 100, { feeRate: 0, minFee: 0, wholeShares: false }).shares, 10);
});

test('原始投入加每月不同金額：累積庫存、投入與損益', () => {
  const r = simulate(twPlan, series);
  // 原始 10000/100=100 股；1/6→1/8 1000/100=10；2/6→2/7 3000/120=25；3/6 1500/150=10
  assert.equal(r.shares, 145);
  assert.equal(r.investedTWD, 10000 + 1000 + 3000 + 1500);
  assert.equal(r.marketValueTWD, 145 * 160);
  assert.equal(r.profitTWD, 145 * 160 - 15500);
  const b = r.transactions.find(t => t.id === 'b');
  assert.equal(b.date, '2024-02-07');
  assert.equal(b.requestedDate, '2024-02-06');
  assert.equal(b.investedAfter, 14000);
  assert.equal(r.timeline.at(-1).date, '2024-03-29');
  assert.ok(r.annualized > 0);
});

test('紀錄可不依日期順序輸入，計算時依日期排序', () => {
  const shuffled = { ...twPlan, entries: [...twPlan.entries].reverse() };
  assert.equal(simulate(shuffled, series).shares, 145);
});

test('日期晚於最新股價的投入列為待成交，不計入投入', () => {
  const plan = { ...twPlan, entries: [...twPlan.entries, { id: 'd', date: '2024-04-06', amount: 5000 }] };
  const r = simulate(plan, series);
  assert.equal(r.investedTWD, 15500);
  assert.equal(r.pendingTWD, 5000);
  assert.deepEqual(r.pending.map(p => p.id), ['d']);
});

test('沒有原始投入也可以只用每月紀錄', () => {
  const r = simulate({ ...twPlan, initial: 0 }, series);
  assert.equal(r.shares, 45);
  assert.equal(r.investedTWD, 5500);
  const empty = simulate({ ...twPlan, initial: 0, entries: [] }, series);
  assert.equal(empty.investedTWD, 0);
  assert.equal(empty.timeline.length, 0);
});

test('配息：除息日當天買進不參與，可選擇再投入', () => {
  const withDiv = { ...series, dividends: [['2024-02-07', 2]] };
  const cash = simulate(twPlan, withDiv);
  assert.equal(cash.dividendsTWD, 110 * 2);
  assert.equal(cash.cashTWD, 220);
  assert.equal(cash.totalTWD, cash.marketValueTWD + 220);
  const reinvest = simulate({ ...twPlan, reinvest: true }, withDiv);
  assert.equal(reinvest.shares, 145 + 1); // 220/120 = 1 股，餘 100 元現金
  assert.equal(reinvest.cashTWD, 100);
  assert.equal(reinvest.investedTWD, cash.investedTWD);
});

test('美元標的依當日匯率換算並扣股息預扣稅', () => {
  const fx = { dates: ['2024-01-01', '2024-03-01'], close: [30, 32] };
  const plan = { ...twPlan, symbol: 'VOO', initial: 30000, entries: [], wholeShares: false, dividendTax: 30 };
  const r = simulate(plan, { ...series, dividends: [['2024-03-06', 1]] }, fx);
  assert.equal(r.shares, 10); // 30000/30=1000 美元 / 100
  assert.equal(r.rate, 32);
  assert.equal(r.marketValueTWD, 10 * 160 * 32);
  assert.ok(Math.abs(r.dividendsTWD - 10 * 0.7 * 32) < 1e-9);
  assert.throws(() => simulate(plan, series), /匯率/);
});

test('缺少股價資料或不支援的標的會報錯', () => {
  assert.throws(() => simulate(twPlan, { dates: [], close: [] }), /股價資料/);
  assert.throws(() => simulate({ ...twPlan, symbol: 'XYZ' }, series), /不支援/);
});

test('XIRR：一年翻倍約 100%', () => {
  const rate = xirr([{ date: '2023-01-01', amount: -100 }, { date: '2024-01-01', amount: 200 }]);
  assert.ok(Math.abs(rate - 1) < 0.01);
  assert.equal(xirr([{ date: '2023-01-01', amount: -100 }]), null);
});

test('合併多個方案的月走勢', () => {
  const a = [{ date: '2024-01-31', investedTWD: 1, totalTWD: 2 }, { date: '2024-02-29', investedTWD: 2, totalTWD: 3 }];
  const b = [{ date: '2024-02-28', investedTWD: 10, totalTWD: 20 }];
  assert.deepEqual(combineTimelines([a, b]), [
    { date: '2024-01-31', investedTWD: 1, totalTWD: 2 },
    { date: '2024-02-29', investedTWD: 12, totalTWD: 23 }
  ]);
});

test('解析 Yahoo chart 回應', () => {
  const json = { chart: { result: [{
    meta: { gmtoffset: 28800, regularMarketPrice: 61.5, regularMarketTime: 1763000000 },
    timestamp: [1704157200, 1704243600, 1704330000],
    indicators: { quote: [{ close: [60.1, null, 61.2] }] },
    events: { dividends: { 1704243600: { amount: 0.5, date: 1704243600 } } }
  }] } };
  const parsed = parseYahooChart(json);
  assert.deepEqual(parsed.dates, ['2024-01-02', '2024-01-04']);
  assert.deepEqual(parsed.close, [60.1, 61.2]);
  assert.deepEqual(parsed.dividends, [['2024-01-03', 0.5]]);
  assert.equal(parsed.last.price, 61.5);
  assert.throws(() => parseYahooChart({ chart: { result: null, error: { description: 'No data' } } }), /No data/);
});
