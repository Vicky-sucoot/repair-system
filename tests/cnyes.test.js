import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCnyesHistory, cnyesHistoryUrl } from '../src/cnyes.js';

test('解析鉅亨網走勢：由新到舊轉為由舊到新，略過缺值', () => {
  // 取自 GI:SOX:INDEX 實際回應節錄
  const json = { statusCode: 200, message: 'OK', data: { s: 'ok', t: [1794787200, 1794528000, 1794441600], c: [9610.652, 10146.323, null] } };
  assert.deepEqual(parseCnyesHistory(json), [['2026-11-13', 10146.323], ['2026-11-16', 9610.652]]);
  assert.throws(() => parseCnyesHistory({ statusCode: 404, message: '頁面或商品不存在', data: null }), /格式不符/);
});

test('走勢網址：from 為較新時間', () => {
  const url = cnyesHistoryUrl('GI:SOX:INDEX', 10, Date.UTC(2026, 10, 17));
  assert.match(url, /symbol=GI%3ASOX%3AINDEX&resolution=D&quote=1&from=1794873600&to=1794009600$/);
});
