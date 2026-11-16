import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, monthlyDebitDates, buyShares, xirr, combineTimelines, indexOnOrAfter } from '../src/dca.js';
import { parseYahooChart } from '../src/yahoo.js';

const series = {
  dates: ['2024-01-02', '2024-01-08', '2024-01-31', '2024-02-07', '2024-02-29', '2024-03-06', '2024-03-29'],
  close: [100, 100, 110, 120, 125, 150, 160],
  dividends: []
};
const twPlan = { symbol: '0050.TW', startDate: '2024-01-01', initial: 10000, monthly: 1000, day: 6, feeRate: 0, minFee: 0, wholeShares: true, reinvest: false, dividendTax: 0 };

test('扣款日遇假日順延到下一個交易日，未來月份不計入', () => {
  assert.deepEqual(monthlyDebitDates(series.dates, '2024-01-01', 6), ['2024-01-08', '2024-02-07', '2024-03-06']);
  assert.deepEqual(monthlyDebitDates(series.dates, '2024-01-10', 6), ['2024-02-07', '2024-03-06']);
  assert.equal(indexOnOrAfter(series.dates, '2025-01-01'), series.dates.length);
});

test('31 日扣款在小月改為月底', () => {
  const dates = ['2024-02-28', '2024-02-29', '2024-03-01'];
  assert.deepEqual(monthlyDebitDates(dates, '2024-02-01', 31), ['2024-02-29']);
});

test('整股買進含手續費與最低手續費', () => {
  const whole = buyShares(1000, 100, { feeRate: 0.1425, minFee: 1, wholeShares: true });
  assert.equal(whole.shares, 9);
  assert.ok(Math.abs(whole.fee - 1.2825) < 1e-9);
  assert.equal(buyShares(1000, 100, { feeRate: 0.1425, minFee: 20, wholeShares: true }).shares, 9);
  assert.equal(buyShares(50, 100, { feeRate: 0, minFee: 0, wholeShares: true }).shares, 0);
  const frac = buyShares(1000, 100, { feeRate: 0, minFee: 0, wholeShares: false });
  assert.equal(frac.shares, 10);
});

test('單筆加每月定期定額：庫存、投入與損益', () => {
  const r = simulate(twPlan, series);
  // 單筆 10000/100=100 股；1/8 1000/100=10；2/7 1000/120=8；3/6 1000/150=6
  assert.equal(r.shares, 124);
  assert.equal(r.investedTWD, 10000 + 1000 + 960 + 900);
  assert.equal(r.marketValueTWD, 124 * 160);
  assert.equal(r.profitTWD, 124 * 160 - 12860);
  assert.equal(r.transactions.length, 4);
  assert.equal(r.timeline.at(-1).date, '2024-03-29');
  assert.ok(r.annualized > 0);
});

test('配息：除息日當天買進不參與，可選擇再投入', () => {
  const withDiv = { ...series, dividends: [['2024-02-07', 2]] };
  const cash = simulate(twPlan, withDiv);
  assert.equal(cash.dividendsTWD, 110 * 2);
  assert.equal(cash.cashTWD, 220);
  assert.equal(cash.totalTWD, cash.marketValueTWD + 220);
  const reinvest = simulate({ ...twPlan, reinvest: true }, withDiv);
  assert.equal(reinvest.shares, 124 + 1); // 220/120 = 1 股，餘 100 元現金
  assert.equal(reinvest.cashTWD, 100);
  assert.equal(reinvest.investedTWD, cash.investedTWD);
});

test('美元標的依當日匯率換算並扣股息預扣稅', () => {
  const fx = { dates: ['2024-01-01', '2024-03-01'], close: [30, 32] };
  const plan = { ...twPlan, symbol: 'VOO', initial: 30000, monthly: 0, wholeShares: false, dividendTax: 30 };
  const r = simulate(plan, { ...series, dividends: [['2024-03-06', 1]] }, fx);
  assert.equal(r.shares, 10); // 30000/30=1000 美元 / 100
  assert.equal(r.rate, 32);
  assert.equal(r.marketValueTWD, 10 * 160 * 32);
  assert.ok(Math.abs(r.dividendsTWD - 10 * 0.7 * 32) < 1e-9);
  assert.throws(() => simulate(plan, series), /匯率/);
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
