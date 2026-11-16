// 以 SVG 繪製「資產總值 vs 累計投入」折線圖，含十字線與提示框。
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function niceStep(range, count) {
  const raw = range / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].find(u => u * power >= raw);
  return unit * power;
}

/**
 * @param container 繪圖容器
 * @param tooltip 提示框元素
 * @param points [{ date, investedTWD, totalTWD }]
 * @param format { money(n), compact(n) }
 */
export function renderChart(container, tooltip, points, format) {
  container.replaceChildren();
  tooltip.hidden = true;
  if (points.length < 2) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '資料不足，至少需要兩個月才能繪製走勢。';
    container.append(empty);
    return;
  }
  const width = Math.max(320, container.clientWidth || 640);
  const height = width < 480 ? 240 : 300;
  const pad = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...points.map(p => Math.max(p.totalTWD, p.investedTWD)));
  const step = niceStep(max || 1, 4);
  const top = Math.ceil(max / step) * step || step;
  const x = i => pad.left + (i / (points.length - 1)) * innerW;
  const y = v => pad.top + innerH - (v / top) * innerH;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg' });
  for (let v = 0; v <= top + 1e-6; v += step) {
    svg.append(el('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'gridline' }));
    const label = el('text', { x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' });
    label.textContent = format.compact(v);
    svg.append(label);
  }
  // X 軸：最多約 6 個年份標籤。
  const years = [];
  points.forEach((p, i) => { if (i === 0 || p.date.slice(0, 4) !== points[i - 1].date.slice(0, 4)) years.push(i); });
  const every = Math.ceil(years.length / (width < 480 ? 4 : 7));
  years.filter((_, k) => k % every === 0).forEach(i => {
    const label = el('text', { x: x(i), y: height - 8, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'tick' });
    label.textContent = points[i].date.slice(0, 4);
    svg.append(label);
  });
  const path = key => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  svg.append(el('path', { d: path('investedTWD'), class: 'line line-invested' }));
  svg.append(el('path', { d: path('totalTWD'), class: 'line line-total' }));

  const cross = el('line', { y1: pad.top, y2: pad.top + innerH, class: 'crosshair', visibility: 'hidden' });
  const dotTotal = el('circle', { r: 4, class: 'dot dot-total', visibility: 'hidden' });
  const dotInvested = el('circle', { r: 4, class: 'dot dot-invested', visibility: 'hidden' });
  svg.append(cross, dotInvested, dotTotal);
  const hit = el('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent', tabindex: 0, 'aria-label': '以方向鍵查看各月份數值' });
  svg.append(hit);
  container.append(svg);

  let current = points.length - 1;
  const show = index => {
    current = Math.max(0, Math.min(points.length - 1, index));
    const p = points[current];
    for (const node of [cross, dotTotal, dotInvested]) node.setAttribute('visibility', 'visible');
    cross.setAttribute('x1', x(current)); cross.setAttribute('x2', x(current));
    dotTotal.setAttribute('cx', x(current)); dotTotal.setAttribute('cy', y(p.totalTWD));
    dotInvested.setAttribute('cx', x(current)); dotInvested.setAttribute('cy', y(p.investedTWD));
    const rows = [
      ['tip-date', p.date.slice(0, 7)],
      ['tip-total', `${format.money(p.totalTWD)}　資產總值`],
      ['tip-invested', `${format.money(p.investedTWD)}　累計投入`],
      ['tip-profit', `${p.totalTWD >= p.investedTWD ? '+' : ''}${format.money(p.totalTWD - p.investedTWD)}　損益`]
    ];
    tooltip.replaceChildren(...rows.map(([cls, text]) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }));
    tooltip.hidden = false;
    const scale = container.clientWidth / width || 1;
    const left = x(current) * scale;
    const tipW = tooltip.offsetWidth;
    tooltip.style.left = `${Math.min(Math.max(0, left - tipW / 2), container.clientWidth - tipW)}px`;
  };
  const hide = () => {
    for (const node of [cross, dotTotal, dotInvested]) node.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  hit.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect();
    const px = (event.clientX - box.left) * (width / box.width);
    show(Math.round(((px - pad.left) / innerW) * (points.length - 1)));
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(current));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { show(current - 1); event.preventDefault(); }
    if (event.key === 'ArrowRight') { show(current + 1); event.preventDefault(); }
  });
}
