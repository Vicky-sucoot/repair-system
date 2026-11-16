// 定期定額試算核心：純函式，不存取 DOM 或網路，瀏覽器與測試共用。

/** 可選的標的；currency 為該標的的交易幣別。 */
export const ASSETS = Object.freeze({
  '0050.TW': { name: '元大台灣50', short: '0050', currency: 'TWD', market: 'TW' },
  'VOO': { name: 'Vanguard S&P 500 ETF', short: 'VOO', currency: 'USD', market: 'US' },
  '00646.TW': { name: '元大S&P500', short: '00646', currency: 'TWD', market: 'TW' }
});

/** 美元兌新台幣匯率在資料檔中的代號。 */
export const FX_SYMBOL = 'TWD=X';

/** 各市場的預設交易條件，切換標的時套用。 */
export const MARKET_DEFAULTS = Object.freeze({
  TW: { feeRate: 0.1425, minFee: 1, wholeShares: true, dividendTax: 0 },
  US: { feeRate: 0, minFee: 0, wholeShares: false, dividendTax: 30 }
});

/** 'YYYY-MM-DD' 字串可直接以字典序比較。 */
export function toDateString(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

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

/**
 * 列出每月扣款日（遇假日順延至下一個交易日）。
 * 只包含開始日（含）之後、且資料範圍內已發生的扣款。
 */
export function monthlyDebitDates(dates, startDate, day) {
  if (!dates.length) return [];
  const result = [];
  const last = dates[dates.length - 1];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  for (;;) {
    const target = toDateString(year, month, Math.min(day, daysInMonth(year, month)));
    if (target > last) break;
    if (target >= startDate) {
      const index = indexOnOrAfter(dates, target);
      if (index < dates.length) result.push(dates[index]);
    }
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return result;
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
 * 模擬一個定期定額方案。
 * @param plan { symbol, startDate, initial, monthly, day, feeRate(%), minFee(TWD), wholeShares, reinvest, dividendTax(%) }
 * @param series { dates, close, dividends: [[date, perShare]] } 標的的日收盤價
 * @param fx 美元兌新台幣日資料，台股可省略
 * 所有 *TWD 結果皆換算為新台幣。
 */
export function simulate(plan, series, fx = null) {
  const asset = ASSETS[plan.symbol];
  if (!asset) throw new Error(`不支援的標的：${plan.symbol}`);
  if (!series?.dates?.length) throw new Error(`缺少 ${asset.short} 的股價資料`);
  const needsFx = asset.currency !== 'TWD';
  if (needsFx && !fx?.dates?.length) throw new Error('缺少美元兌新台幣匯率資料');
  const { dates, close } = series;
  const rateAt = date => (needsFx ? valueOnOrBefore(fx, date) : 1);
  const lastDate = dates[dates.length - 1];

  // 建立依日期排序的事件；同一天先除息（當天買進不參與配息），再買進。
  const events = [];
  const startIndex = indexOnOrAfter(dates, plan.startDate);
  if (plan.initial > 0 && startIndex < dates.length) {
    events.push({ date: dates[startIndex], order: 1, kind: 'initial', amount: plan.initial });
  }
  if (plan.monthly > 0) {
    for (const date of monthlyDebitDates(dates, plan.startDate, plan.day)) {
      events.push({ date, order: 1, kind: 'monthly', amount: plan.monthly });
    }
  }
  for (const [exDate, perShare] of series.dividends || []) {
    if (exDate < plan.startDate || exDate > lastDate || !(perShare > 0)) continue;
    const index = indexOnOrAfter(dates, exDate);
    if (index < dates.length) events.push({ date: dates[index], order: 0, kind: 'dividend', perShare });
  }
  // 每月最後一個交易日記錄一次資產走勢，最後一天一定記錄。
  for (let i = 0; i < dates.length; i += 1) {
    const isMonthEnd = i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);
    if (isMonthEnd && dates[i] >= plan.startDate) events.push({ date: dates[i], order: 2, kind: 'snapshot', index: i });
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

  const execute = (date, budgetTWD, type) => {
    const index = indexOnOrAfter(dates, date);
    const price = close[index];
    const rate = rateAt(date);
    const result = buyShares(budgetTWD / rate, price, { ...fee, minFee: plan.minFee / rate });
    const costTWD = (result.gross + result.fee) * rate;
    shares += result.shares;
    feesTWD += result.fee * rate;
    transactions.push({ date, type, price, rate, shares: result.shares, feeTWD: result.fee * rate, costTWD, sharesAfter: shares });
    return costTWD;
  };

  for (const event of events) {
    if (event.kind === 'initial' || event.kind === 'monthly') {
      const cost = execute(event.date, event.amount, event.kind === 'initial' ? '單筆投入' : '定期定額');
      investedTWD += cost;
      if (cost > 0) flows.push({ date: event.date, amount: -cost });
    } else if (event.kind === 'dividend') {
      if (shares <= 0) continue;
      const net = shares * event.perShare * (1 - plan.dividendTax / 100);
      const netTWD = net * rateAt(event.date);
      dividendsTWD += netTWD;
      transactions.push({ date: event.date, type: '配息', price: event.perShare, rate: rateAt(event.date), shares: 0, feeTWD: 0, costTWD: -netTWD, sharesAfter: shares });
      if (plan.reinvest) {
        const cost = execute(event.date, netTWD, '股息再投入');
        cashTWD += netTWD - cost;
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
