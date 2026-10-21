'use strict';
/**
 * 离线冒烟测试：不联网、不开浏览器，验证核心纯函数。
 * 运行：node test/smoke.js
 */
const assert = require('node:assert');
const { getSourceInfoByItemUrl, matchItemId, isDetailUrl, TiktokCollector, parseSaleToInt, parsePriceToFloat, normalizeFilters, passesFilters, categoryUrl } = require('../src/tiktok');
const { qsStringify } = require('../src/erp');
const { Pipeline } = require('../src/pipeline');
const where = require('../src/where');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('\nsourceInfo 推导');
t('us pdp 带 slug', () => {
  const s = getSourceInfoByItemUrl('https://shop.tiktok.com/us/pdp/some-slug/1732569460347606004');
  assert.equal(s.itemId, '1732569460347606004');
  assert.equal(s.site, 'US');
  assert.equal(s.source, 'tiktok');
  assert.equal(s.postFee, '');
});
t('us pdp 无 slug', () => {
  const s = getSourceInfoByItemUrl('https://shop.tiktok.com/us/pdp/1731078278217437814');
  assert.equal(s.itemId, '1731078278217437814');
  assert.equal(s.site, 'US');
});
t('uk -> GB 映射', () => {
  const s = getSourceInfoByItemUrl('https://www.tiktok.com/shop/uk/pdp/1732569460347606004');
  assert.equal(s.site, 'GB');
});
t('query region 优先', () => {
  const s = getSourceInfoByItemUrl('https://shop.tiktok.com/us/pdp/1732569460347606004?region=GB');
  assert.equal(s.site, 'GB');
});
t('shop-us host', () => {
  const s = getSourceInfoByItemUrl('https://shop-us.tiktok.com/pdp/1732569460347606004');
  assert.equal(s.site, 'US');
});
t('view/product 短链也能出 itemId', () => {
  assert.equal(matchItemId('https://www.tiktok.com/view/product/1729438233542234865'), '1729438233542234865');
});
t('详情页判定', () => {
  assert.equal(isDetailUrl('https://shop.tiktok.com/us/pdp/1732569460347606004'), true);
  assert.equal(isDetailUrl('https://shop.tiktok.com/us'), false);
});

console.log('\nqsStringify（ERP 只吃 form-urlencoded）');
t('扁平对象', () => {
  assert.equal(qsStringify({ a: 1, b: 'x' }), 'a=1&b=x');
});
t('嵌套数组 → indices 风格', () => {
  assert.equal(
    qsStringify({ list: [{ itemId: '1', site: 'US' }] }),
    'list%5B0%5D%5BitemId%5D=1&list%5B0%5D%5Bsite%5D=US'
  );
});
t('JSON 字符串值被编码', () => {
  const s = qsStringify({ d: JSON.stringify({ k: 1 }) });
  assert.ok(s.startsWith('d=%7B'));
});

console.log('\n推送 payload 形态');
t('toSourceInfoList 保序去重', () => {
  const items = [
    { url: 'https://shop.tiktok.com/us/pdp/1732569460347606004', sourceInfo: { itemId: '1732569460347606004', site: 'US' } },
    { url: 'https://shop.tiktok.com/us/pdp/1732569460347606004', sourceInfo: { itemId: '1732569460347606004', site: 'US' } },
    { url: 'https://shop.tiktok.com/us/pdp/1731078278217437814', sourceInfo: { itemId: '1731078278217437814', site: 'US' } },
  ];
  const list = Pipeline.toSourceInfoList(items);
  assert.equal(list.length, 2);
  assert.equal(list[0].itemId, '1732569460347606004');
});
t('五个字段齐全', () => {
  const list = Pipeline.toSourceInfoList([
    { url: 'https://shop.tiktok.com/us/pdp/1732569460347606004', sourceInfo: { itemId: '1732569460347606004', site: 'US' } },
  ]);
  for (const k of ['itemUrl', 'itemId', 'site', 'source', 'postFee']) {
    assert.ok(k in list[0], '缺少字段 ' + k);
  }
});

console.log('\n销量/价格解析');
t('1.2K → 1200', () => assert.equal(parseSaleToInt('1.2K'), 1200));
t('7.6K → 7600', () => assert.equal(parseSaleToInt('7.6K'), 7600));
t('3M → 3000000', () => assert.equal(parseSaleToInt('3M'), 3000000));
t('1,234+ → 1234', () => assert.equal(parseSaleToInt('1,234+'), 1234));
t('576 → 576', () => assert.equal(parseSaleToInt('576'), 576));
t('无销量 → null', () => assert.equal(parseSaleToInt(''), null));
t('$27.00 → 27', () => assert.equal(parsePriceToFloat('$27.00'), 27));
t('$1,299.99 → 1299.99', () => assert.equal(parsePriceToFloat('$1,299.99'), 1299.99));
t('-- → null', () => assert.equal(parsePriceToFloat('--'), null));

console.log('\n过滤语义');
t('销量解析不出 → 跳过', () => {
  const f = normalizeFilters({ sales: { enabled: true, min: 0, max: 999999 } });
  assert.equal(passesFilters({ saleCount: '' }, f).pass, false);
});
t('销量低于下限 → 跳过', () => {
  const f = normalizeFilters({ sales: { enabled: true, min: 1000, max: 999999 } });
  assert.equal(passesFilters({ saleCount: '24.9K' }, f).pass, true);
  assert.equal(passesFilters({ saleCount: '576' }, f).pass, false);
});
t('价格超出区间 → 跳过', () => {
  const f = normalizeFilters({ price: { enabled: true, min: 10, max: 50 } });
  assert.equal(passesFilters({ price: '27.00' }, f).pass, true);
  assert.equal(passesFilters({ price: '77.45' }, f).pass, false);
});
t('价格为 -- → 放行', () => {
  const f = normalizeFilters({ price: { enabled: true, min: 10, max: 50 } });
  assert.equal(passesFilters({ price: '--' }, f).pass, true);
});
t('品牌过滤：有品牌 → 跳过，无品牌 → 保留', () => {
  const f = normalizeFilters({ brandFilter: true });
  assert.equal(passesFilters({ brand: 'GAP' }, f).pass, false);
  assert.equal(passesFilters({ brand: '无' }, f).pass, true);
  assert.equal(passesFilters({ brand: '' }, f).pass, true);
});
t('未启用过滤时全放行', () => {
  const f = normalizeFilters(null);
  assert.equal(passesFilters({ saleCount: '', price: '--', brand: 'X' }, f).pass, true);
});

console.log('\n条件表达式 --where');
const RECS = [
  { title: 'Gap Hoodie', saleCount: '24.9K', price: '27.00', score: '4.7', brand: 'GAP', '店铺名称': 'Gap' },
  { title: 'Lumina Serum', saleCount: '576', price: '11.69', score: '4.6', brand: '无', '店铺名称': 'Lumina Beauty' },
  { title: 'Phone Case', saleCount: '1.2K', price: '5.99', score: '4.2', brand: '无', '店铺名称': 'CaseShop' },
  { title: 'Mega Deal', saleCount: '3M', price: '99.99', score: '4.9', brand: 'ACME', '店铺名称': 'ACME' },
];
function hits(q) { const fn = where.getWhere(q); return RECS.filter(r => fn(r)).length; }
t('销量 100-1000', () => assert.equal(hits('销量 100-1000'), 1));
t('销量 between 100 and 1000', () => assert.equal(hits('销量 between 100 and 1000'), 1));
t('销量 100~1000', () => assert.equal(hits('销量 100~1000'), 1));
t('销量 100至1000', () => assert.equal(hits('销量 100至1000'), 1));
t('英文别名 sales 100-1000', () => assert.equal(hits('sales 100-1000'), 1));
t('带 K 的区间 1k-100k', () => assert.equal(hits('销量 1k-100k'), 2));
t('组合 and', () => assert.equal(hits('销量 >= 100 and 价格 < 20'), 2));
t('组合 or', () => assert.equal(hits('价格 < 20 or 评分 >= 4.8'), 3));
t('括号分组', () => assert.equal(hits('(价格 < 20 or 评分 >= 4.8) and 销量 > 500'), 3));
t('标题包含 ~', () => assert.equal(hits('标题 ~ hoodie'), 1));
t('标题不包含 !~', () => assert.equal(hits('标题 !~ case'), 3));
t('品牌 = 无', () => assert.equal(hits('品牌 = 无'), 2));
t('not 取反', () => assert.equal(hits('not (品牌 = GAP)'), 3));
t('裸数字按 >= 处理', () => assert.equal(hits('销量 1000'), 3));
t('中文连接词「并且」', () => assert.equal(hits('销量 > 1000 并且 评分 > 4.5'), 2));
t('取不到值的记录不通过', () => assert.equal(where.getWhere('销量 >= 0')({ title: 'x' }), false));
t('空表达式 → null', () => assert.equal(where.getWhere(''), null));
t('未知字段报错', () => assert.throws(() => where.parseWhere('不存在的字段 5'), /未知字段/));
t('缺比较值报错', () => assert.throws(() => where.parseWhere('销量'), /缺少比较值/));

console.log('\n类目');
t('categoryUrl 只给 ID', () => assert.equal(categoryUrl('us', '839944'), 'https://shop.tiktok.com/us/c/c/839944'));
t('categoryUrl 带 slug', () => assert.equal(categoryUrl('us', '839944', 'men-s-tops'), 'https://shop.tiktok.com/us/c/men-s-tops/839944'));
t('categoryUrl 默认站点', () => assert.equal(categoryUrl('', '601450'), 'https://shop.tiktok.com/us/c/c/601450'));

console.log('\n' + (fail === 0 ? '全部通过 ' + pass + ' 项' : pass + ' 通过 / ' + fail + ' 失败'));
process.exit(fail === 0 ? 0 : 1);
