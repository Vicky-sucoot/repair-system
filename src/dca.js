// 定期不定額試算核心：純函式，不存取 DOM 或網路，瀏覽器與測試共用。

/** 可選的標的；currency 為該標的的交易幣別。 */
export const ASSETS = Object.freeze({
  '0050.TW': { name: '元大台灣50', short: '0050', currency: 'TWD', market: 'TW' },
  'VOO': { name: 'Vanguard S&P 500 ETF', short: 'VOO', currency: 'USD', market: 'US' }
});

/** 美元兌新台幣匯率在資料檔中的代號。 */
export const FX_SYMBOL = 'TWD=X';

/** 各市場的預設交易條件，切換標的時套用。 */
export const MARKET_DEFAULTS = Object.freeze({
  TW: { feeRate: 0.1425, minFee: 1, wholeShares: true, dividendTax: 0 },
  US: { feeRate: 0, minFee: 0, wholeShares: false, dividendTax: 30 }
});

/** 回傳第一個日期 >= date 的索引；若都早於 date 則回傳 dates.length。 */
export function indexOnOrAfter(dates, date) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (dates[mid] < date) low = mid + 1; else high = mid;
  }
  return low;
}

/** 取 date 當天或之前最近一筆收盤值；若 date 早於所有資料，則取第一筆。 */
export function valueOnOrBefore(series, date) {
  const index = indexOnOrAfter(series.dates, date);
  if (index < series.dates.length && series.dates[index] === date) return series.close[index];
  return series.close[Math.max(0, index - 1)];
}

/** 依手續費與整股設定，計算一筆買進；金額皆為標的幣別。 */
export function buyShares(budget, price, { feeRate, minFee, wholeShares }) {
  const rate = feeRate / 100;
  const feeFor = gross => (gross > 0 ? Math.max(minFee, gross * rate) : 0);
  if (!(budget > 0) || !(price > 0)) return { shares: 0, gross: 0, fee: 0 };
  if (wholeShares) {
    let shares = Math.floor(budget / (price * (1 + rate)));
    while (shares > 0 && shares * price + feeFor(shares * price) > budget + 1e-9) shares -= 1;
    const gross = shares * price;
    return { shares, gross, fee: feeFor(gross) };
  }
  const fee = Math.max(minFee, budget * rate / (1 + rate));
  const gross = budget - fee;
  if (gross <= 0) return { shares: 0, gross: 0, fee: 0 };
  return { shares: gross / price, gross, fee };
}

/** 以二分法求年化內部報酬率（XIRR）；無法求解時回傳 null。 */
export function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f.amount > 0) || !flows.some(f => f.amount < 0)) return null;
  const t0 = Date.parse(flows[0].date);
  const years = flows.map(f => (Date.parse(f.date) - t0) / (365.25 * 86400000));
  if (years[years.length - 1] < 1 / 12) return null;
  const npv = rate => flows.reduce((sum, f, i) => sum + f.amount / (1 + rate) ** years[i], 0);
  let low = -0.9999;
  let high = 10;
  let fLow = npv(low);
  if (fLow * npv(high) > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLow * fMid < 0) high = mid; else { low = mid; fLow = fMid; }
  }
  return (low + high) / 2;
}

/**
 * 模擬一個定期不定額方案：原始投入一次買進，之後每筆手動輸入的金額各自買進（累積）。
 * @param plan { symbol, startDate, initial, initialPrice（選填，原始投入的實際成交價，標的幣別）, entries: [{ id, date, amount }], feeRate(%), minFee(TWD), wholeShares, reinvest, dividendTax(%) }
 * @param series { dates, close, dividends: [[date, perShare]] } 標的的日收盤價
 * @param fx 美元兌新台幣日資料，台股可省略
 * 每筆投入以當日（遇假日順延至下一個交易日）收盤價成交；日期晚於最新股價者列為待成交。
 * 所有 *TWD 結果皆換算為新台幣。
 */
export function simulate(plan, series, fx = null, asset = ASSETS[plan.symbol]) {
  // asset：內建標的（0050、VOO）或使用者自行加入的台股（{ short, name, currency: 'TWD' }）
  if (!asset) throw new Error(`不支援的標的：${plan.symbol}`);
  if (!series?.dates?.length) throw new Error(`缺少 ${asset.short} 的股價資料`);
  const needsFx = asset.currency !== 'TWD';
  if (needsFx && !fx?.dates?.length) throw new Error('缺少美元兌新台幣匯率資料');
  const { dates, close } = series;
  const rateAt = date => (needsFx ? valueOnOrBefore(fx, date) : 1);
  const lastDate = dates[dates.length - 1];

  // 建立依日期排序的事件；同一天先除息（當天買進不參與配息），再買進，最後記錄走勢。
  const contributions = [];
  if (plan.initial > 0 && plan.startDate) contributions.push({ id: 'initial', date: plan.startDate, amount: plan.initial, type: '原始投入', price: plan.initialPrice > 0 ? Number(plan.initialPrice) : null });
  for (const entry of plan.entries || []) {
    if (entry.amount > 0 && entry.date) contributions.push({ ...entry, type: '每月投入' });
  }
  const pending = contributions.filter(c => indexOnOrAfter(dates, c.date) >= dates.length);
  const events = [];
  for (const c of contributions) {
    const index = indexOnOrAfter(dates, c.date);
    if (index < dates.length) events.push({ date: dates[index], order: 1, kind: 'buy', contribution: c });
  }
  const firstDate = events.reduce((min, e) => (e.date < min ? e.date : min), '9999-12-31');
  for (const [exDate, perShare] of series.dividends || []) {
    if (exDate < firstDate || exDate > lastDate || !(perShare > 0)) continue;
    const index = indexOnOrAfter(dates, exDate);
    if (index < dates.length) events.push({ date: dates[index], order: 0, kind: 'dividend', perShare });
  }
  // 每月最後一個交易日記錄一次資產走勢，最後一天一定記錄。
  for (let i = indexOnOrAfter(dates, firstDate); i < dates.length; i += 1) {
    const isMonthEnd = i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);
    if (isMonthEnd) events.push({ date: dates[i], order: 2, kind: 'snapshot', index: i });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  const fee = { feeRate: plan.feeRate, wholeShares: plan.wholeShares };
  const transactions = [];
  const timeline = [];
  const flows = [];
  let shares = 0;
  let investedTWD = 0;
  let feesTWD = 0;
  let cashTWD = 0;
  let dividendsTWD = 0;

  // manualPrice：使用者輸入的實際成交價；未輸入時以當日收盤價換算股數。
  const execute = (date, budgetTWD, type, id = null, manualPrice = null) => {
    const index = indexOnOrAfter(dates, date);
    const price = manualPrice > 0 ? manualPrice : close[index];
    const rate = rateAt(date);
    const result = buyShares(budgetTWD / rate, price, { ...fee, minFee: plan.minFee / rate });
    const costTWD = (result.gross + result.fee) * rate;
    shares += result.shares;
    feesTWD += result.fee * rate;
    const tx = { id, date, type, amountTWD: budgetTWD, price, manualPrice: manualPrice > 0, rate, shares: result.shares, feeTWD: result.fee * rate, costTWD, sharesAfter: shares };
    transactions.push(tx);
    return tx;
  };

  for (const event of events) {
    if (event.kind === 'buy') {
      const c = event.contribution;
      const tx = execute(event.date, c.amount, c.type, c.id, c.price);
      investedTWD += tx.costTWD;
      tx.investedAfter = investedTWD;
      tx.requestedDate = c.date;
      if (tx.costTWD > 0) flows.push({ date: event.date, amount: -tx.costTWD });
    } else if (event.kind === 'dividend') {
      if (shares <= 0) continue;
      const net = shares * event.perShare * (1 - plan.dividendTax / 100);
      const netTWD = net * rateAt(event.date);
      dividendsTWD += netTWD;
      transactions.push({ id: null, date: event.date, type: '配息', amountTWD: netTWD, price: event.perShare, rate: rateAt(event.date), shares: 0, feeTWD: 0, costTWD: -netTWD, sharesAfter: shares });
      if (plan.reinvest) {
        const tx = execute(event.date, netTWD, '股息再投入');
        cashTWD += netTWD - tx.costTWD;
      } else {
        cashTWD += netTWD;
      }
    } else if (investedTWD > 0) {
      const valueTWD = shares * close[event.index] * rateAt(event.date);
      timeline.push({ date: event.date, investedTWD, valueTWD, totalTWD: valueTWD + cashTWD });
    }
  }

  const price = close[close.length - 1];
  const rateNow = rateAt(lastDate);
  const marketValueTWD = shares * price * rateNow;
  const totalTWD = marketValueTWD + cashTWD;
  const profitTWD = totalTWD - investedTWD;
  if (totalTWD > 0) flows.push({ date: lastDate, amount: totalTWD });
  return {
    symbol: plan.symbol,
    asOf: lastDate,
    shares,
    price,
    rate: rateNow,
    currency: asset.currency,
    investedTWD,
    pendingTWD: pending.reduce((sum, c) => sum + c.amount, 0),
    pending,
    feesTWD,
    marketValueTWD,
    cashTWD,
    dividendsTWD,
    totalTWD,
    profitTWD,
    returnRate: investedTWD > 0 ? profitTWD / investedTWD : 0,
    annualized: xirr(flows),
    averageCost: shares > 0 ? (investedTWD / shares) : 0,
    transactions,
    timeline
  };
}

/** 將多個方案的月走勢依日期加總（缺月份時沿用該方案前一筆）。 */
export function combineTimelines(timelines) {
  const months = [...new Set(timelines.flat().map(p => p.date.slice(0, 7)))].sort();
  const cursors = timelines.map(() => 0);
  const last = timelines.map(() => null);
  return months.map(month => {
    let investedTWD = 0;
    let totalTWD = 0;
    let date = '';
    timelines.forEach((points, i) => {
      while (cursors[i] < points.length && points[cursors[i]].date.slice(0, 7) <= month) last[i] = points[cursors[i]++];
      if (last[i]) {
        investedTWD += last[i].investedTWD;
        totalTWD += last[i].totalTWD;
        if (last[i].date > date && last[i].date.slice(0, 7) === month) date = last[i].date;
      }
    });
    return { date: date || `${month}-01`, investedTWD, totalTWD };
  });
}


/**
 * 使用者自行加入的台股沒有完整歷史價格：以各筆投入的成交價與最新收盤價組成簡易價格序列。
 * contributions：[{ date, price }]（原始投入與每月投入）；latest：{ date, close }（最新收盤，可省略）。
 * 未計入配息與分割。
 */
export function syntheticSeries(contributions, latest = null) {
  const map = new Map();
  for (const c of contributions) if (c.date && c.price > 0) map.set(c.date, c.price);
  if (latest?.date && latest.close > 0 && (!map.size || latest.date >= [...map.keys()].sort().at(-1))) map.set(latest.date, latest.close);
  const dates = [...map.keys()].sort();
  return { dates, close: dates.map(d => map.get(d)), dividends: [] };
}
