'use strict';
/**
 * TikTok Shop 采集器。
 *
 * 采集能力覆盖：
 *   店铺商品列表（含商家信息）
 *   关键词搜索列表
 *   商品详情（18 字段）
 *   类目采集
 *
 * sourceInfo 推导遵循同一套字段契约（见 getSourceInfoByItemUrl），
 * 因为 push_collect_box 需要的正是这个结构。
 *
 * 实现方式：用本项目的 Tab（原生 CDP）驱动浏览器，不依赖任何第三方自动化库。
 * 详情页优先读页面内嵌的 SSR 数据（#RENDER_DATA / #__MODERN_ROUTER_DATA__ / __INITIAL_PROPS__），
 * 拿不到才回落到 DOM 解析。
 */
const { sleep, log, waitFor } = require('./util');
const where = require('./where');

/* ---------- 1. URL → sourceInfo（与 ERP 扩展 utils 完全一致） ---------- */

const TIKTOK_SOURCE = 'tiktok';
const MATCH_SOURCE_INFO_PATTERN = '//(.*?)\\.(?:tiktok|tokopedia|tiktokglobalshop|tiktokw)\\.(?:com|eu)/(?:view|pdp|shop/pdp|shop/\\w+/pdp|\\w+/pdp)(.*)|(?://vt\\.tiktok\\.com/.*?/)';
const MATCH_REDIRECT_PATTERN = '//vt\\.tiktok\\.com/.*?/';
const MATCH_DETAIL_PATTERN = '//(.*?)\\.(?:tiktok|tokopedia|tiktokw)\\.(?:com|eu)/(?:view|(?:[a-z]{2}/)?pdp|shop(?:/[a-z]{2})?/pdp)(.*)';

const reSourceInfo = new RegExp(MATCH_SOURCE_INFO_PATTERN);
const reRedirect = new RegExp(MATCH_REDIRECT_PATTERN);
const reDetail = new RegExp(MATCH_DETAIL_PATTERN);

/** 从任意 TikTok 商品 URL 里抠 itemId（移植 oT） */
function matchItemId(url) {
  let id = '';
  let m = /\/view\/product\/(\d+)(?:\?.*)?/.exec(url);
  if (m) id = m[1];
  if (id === '') {
    m = /pdp\/(?:[^/]+\/)*?(\d{10,})/.exec(url);
    if (m) id = m[1];
  }
  return id;
}

/** URL 是否商品详情页 */
function isDetailUrl(url) {
  return reDetail.test(url || '');
}

/** 是否短链（需要先跳转） */
function isRedirectLink(url) {
  return reRedirect.test(url || '');
}

const SITE_MAP = { uk: 'GB', sg: 'SG', id: 'ID', vn: 'VN', th: 'TH', my: 'MY', ph: 'PH', us: 'US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', ie: 'IE', jp: 'JP', br: 'BR', mx: 'MX' };

/**
 * URL → {itemUrl,itemId,site,source,postFee}（移植 sT，并补了 shop.tiktok.com/<region>/pdp 这种新路径）
 *
 * 站点推导顺序（与扩展一致，最后两条是本项目补的）：
 *   1. query 里的 region=xx
 *   2. host 里的 shop-xx
 *   3. 路径 shop/<xx>/pdp/
 *   4. 路径 <xx>/pdp/            ← shop.tiktok.com/us/pdp/... 走这条
 *   5. host 是 shop.tiktok.com 且路径首段是两位地区码
 */
function getSourceInfoByItemUrl(url) {
  const u = url || '';
  const itemId = matchItemId(u);
  let site = '';

  // 1. query 里的 region=xx
  let m = /[?&]region=([A-Za-z]{2})/.exec(u);
  if (m) site = m[1];

  if (!site) {
    let host = '';
    let pathname = '';
    try {
      const parsed = new URL(u);
      host = parsed.hostname || '';
      pathname = parsed.pathname || '';
    } catch (e) {
      // 短链 / 非法 URL：退回正则
      const mm = /^https?:\/\/([^/]+)(\/[^?#]*)?/.exec(u);
      host = (mm && mm[1]) || '';
      pathname = (mm && mm[2]) || '';
    }

    // 2. host 里的 shop-xx（如 shop-us.tiktok.com）
    m = /(?:^|\.)shop-([a-z]{2})\./i.exec(host);
    if (m) site = m[1];

    // 3. 路径里的 shop/<xx>/pdp/
    if (!site) {
      m = /\/shop\/([a-z]{2})\/pdp\//i.exec(pathname);
      if (m) site = m[1];
    }
    // 4. 路径里的 <xx>/pdp/（shop.tiktok.com/us/pdp/...）
    if (!site) {
      m = /\/([a-z]{2})\/pdp\//i.exec(pathname);
      if (m) site = m[1];
    }
    // 5. host 是 shop.tiktok.com 且路径首段是地区码
    if (!site) {
      m = /^shop\.tiktok\.com$/i.test(host) ? /^\/([a-z]{2})(?:\/|$)/i.exec(pathname) : null;
      if (m) site = m[1];
    }
  }

  site = SITE_MAP[String(site).toLowerCase()] || site;
  if (site) site = String(site).toUpperCase();
  return { itemUrl: u, itemId: itemId, site: site, source: TIKTOK_SOURCE, postFee: '' };
}

/* ---------- 1.5 过滤与解析 ---------- */

/**
 * 销量文本 → 整数（支持 K/M 后缀与千分位）。
 * 支持 "1.2K" / "3M" / "1,234+" / "7.6K" / "576"。
 * @returns {number|null}
 */
function parseSaleToInt(s) {
  s = String(s || '').toLowerCase().replace(/,/g, '').replace(/\+/g, '');
  const m = /([\d.]+)\s*([km]?)/.exec(s);
  if (!m) return null;
  let num = parseFloat(m[1]);
  if (!isFinite(num)) return null;
  const suf = m[2];
  if (suf === 'k') num *= 1000;
  else if (suf === 'm') num *= 1000000;
  return Math.round(num);
}

/**
 * 价格文本 → 浮点。
 * @returns {number|null}
 */
function parsePriceToFloat(s) {
  s = String(s || '').replace(/\$/g, '').replace(/,/g, '').trim();
  const m = /([\d.]+)/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v : null;
}

/** 归一化过滤配置：{ sales:{enabled,min,max}, price:{enabled,min,max}, brandFilter:boolean } */
function normalizeFilters(f) {
  f = f || {};
  const sales = f.sales || {};
  const price = f.price || {};
  return {
    sales: {
      enabled: !!sales.enabled,
      min: Number(sales.min || 0),
      max: Number(sales.max === undefined ? 999999 : sales.max),
    },
    price: {
      enabled: !!price.enabled,
      min: Number(price.min || 0),
      max: Number(price.max === undefined ? 99999.99 : price.max),
    },
    // 品牌过滤（仅详情模式）：勾选后「有品牌」的商品不采
    brandFilter: !!f.brandFilter,
  };
}

/**
 * 判断一条记录是否通过过滤。返回 {pass, reason}。
 * 过滤语义：
 *   - 销量过滤启用时，解析不出销量 → 直接跳过（不是保留）
 *   - 价格过滤启用时，价格为 "--" 或解析失败 → 放行（不因解析失败误杀）
 *   - 品牌过滤只作用于详情（brand 字段），brand 为 "无" 视为无品牌 → 保留
 */
function passesFilters(rec, filters) {
  const f = normalizeFilters(filters);
  if (f.sales.enabled) {
    const n = parseSaleToInt(rec.saleCount !== undefined ? rec.saleCount : rec['销量']);
    if (n === null) return { pass: false, reason: '销量无法解析' };
    if (n < f.sales.min || n > f.sales.max) return { pass: false, reason: '销量 ' + n + ' 不在 [' + f.sales.min + ',' + f.sales.max + ']' };
  }
  if (f.price.enabled) {
    const p = parsePriceToFloat(rec.price !== undefined ? rec.price : rec['价格']);
    if (p !== null && (p < f.price.min || p > f.price.max)) {
      return { pass: false, reason: '价格 ' + p + ' 不在 [' + f.price.min + ',' + f.price.max + ']' };
    }
  }
  if (f.brandFilter) {
    const b = rec.brand !== undefined ? rec.brand : rec['品牌'];
    if (b && String(b).trim() !== '' && String(b).trim() !== '无') {
      return { pass: false, reason: '有品牌: ' + b };
    }
  }
  return { pass: true };
}

/* ---------- 2. 页面内采集脚本（用真函数 + toString，避免模板字符串嵌套） ---------- */

/** 页面里执行的：从 DOM 抓商品列表卡片 */
function pageExtractList() {
  const out = [];
  const seen = new Set();

  let cards = Array.from(document.querySelectorAll('div.relative.w-full.cursor-pointer, div.w-full.cursor-pointer'));
  if (!cards.length) {
    const links = Array.from(document.querySelectorAll('a[href*="pdp"], a[href*="/view/product/"]'));
    const set = new Set();
    for (const a of links) {
      let n = a;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement;
        if (n && n.querySelectorAll('a[href]').length <= 2) { set.add(n); break; }
      }
    }
    cards = Array.from(set);
  }

  const txt = (el) => (el ? (el.textContent || '').trim() : '');
  const firstText = (el, sel) => { const n = el && el.querySelector(sel); return n ? txt(n) : ''; };

  for (const card of cards) {
    const a = card.querySelector('a[href*="pdp"], a[href*="/view/product/"]');
    if (!a) continue;
    const href = a.href;
    if (seen.has(href)) continue;
    seen.add(href);

    let title = firstText(card, 'h3.P2-Regular') || firstText(card, 'a.P2-Regular') || firstText(card, 'h3') || '';
    if (!title) { const img = card.querySelector('img[alt]'); title = img ? img.alt : ''; }

    const score = firstText(card, 'span.P3-Semibold.mr-2') || '';

    let saleRaw = '';
    const saleEl = card.querySelector('span.P3-Regular.text-ellipsis') ||
                   Array.from(card.querySelectorAll('span')).find(s => /sold/i.test(s.textContent || ''));
    if (saleEl) saleRaw = txt(saleEl);
    const sm = /([\d.,]+(?:[kKmM])?)/.exec(saleRaw);
    const saleCount = sm ? sm[1] : '';

    let price = '';
    const priceSpans = card.querySelectorAll('span.SmallText1-Semibold');
    if (priceSpans.length) price = Array.from(priceSpans).map(s => txt(s)).join('');
    if (!price) {
      const pe = Array.from(card.querySelectorAll('span,div')).find(s => /^\s*\$\s*[\d.,]+/.test(s.textContent || '') && s.children.length === 0);
      if (pe) price = txt(pe);
    }
    price = price.replace(/\$/g, '');

    let deletePrice = '';
    const delEl = card.querySelector('span.line-through');
    if (delEl) deletePrice = txt(delEl).replace(/\$/g, '');

    let carriage = '';
    const carEl = card.querySelector('div:nth-child(2) div span span') || card.querySelector('span.P3-Semibold.font-semibold');
    if (carEl) carriage = txt(carEl);
    if (!carriage) carriage = '--';

    const img = card.querySelector('img[src]');
    const imgUrl = img ? img.src : '';

    out.push({ url: href, title, score, saleCount, price, deletePrice, carriage, imgUrl });
  }
  return JSON.stringify(out);
}

/**
 * 页面里执行的：从 DOM 抓商品详情
 *
 * 2026-10 实测的 shop.tiktok.com 详情页结构：
 *   - 面包屑   ol[class*="breadcrumb"] > li，最后一项是商品标题
 *   - 标题     h1 > span.H2-Semibold
 *   - 价格     span.Headline-Semibold（整数） + 兄弟 span（小数），父级 textContent 拼起来是 "$11.69"
 *   - 划线价   span.line-through
 *   - 折扣     span.text-color-UITextPrimary（"-55%"）
 *   - 运费     价格行下方 div.text-color-ECCyanText 所在行（"Free shipping"）
 *   - 评分/评论/销量  同一行：star icon + "4.7" + "(778)" + "7.6K sold"
 *   - 店铺卡   a[href*="/store/"] + span.H2-Bold（店名）+ span.P2-Semibold（评分）
 *   - 服务指标 div.flex.flex-row.justify-center.items-start 内，每个子块是 <值><标签>
 *   - 主图     img[src*=ttcdn] 且 naturalWidth>=200 的第一张
 *   - 品牌     详情表里 "Brand" 行（多数美国店没有 → 记 "无"）
 */
function pageExtractDetailDom() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const txt = (el) => (el ? clean(el.innerText || el.textContent) : '');
  const own = (el) => {
    // 只取元素自身直接文本（跳过子元素里的数字），用于把 "$" + "11" + ".69" 拼回价格
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return s;
  };

  const out = {};

  /* ---------- 面包屑 / 类目 ---------- */
  const ol = q('ol[class*="breadcrumb"]') || qa('ol').find(o => /breadcrumb/i.test(o.className || ''));
  const crumbs = ol ? Array.from(ol.querySelectorAll('li')).map(li => clean(li.textContent)).filter(Boolean) : [];
  // 最后一项是商品名，前面是 "TikTok Shop / 一级 / 二级 ..."
  out.crumbs = crumbs;
  out.category = crumbs.slice(1, Math.max(1, crumbs.length - 1)).join(' > ');

  /* ---------- 标题 ---------- */
  out.title = txt(q('h1 span')) || txt(q('h1')) || (document.title || '').split('|')[0].trim();

  /* ---------- 价格 ---------- */
  // 现价结构：<span flex-row><span>$</span><span Headline-Semibold>11</span><span>.<!-- -->69</span></span>
  // 注意：不能直接找 span.Headline-Semibold —— 左侧类目导航里也全是这个 class。
  // 可靠锚点 = 自身文本恰好是 "$" 的那个 span，它的父节点 textContent 就是完整现价。
  out.price = ''; out.deletePrice = ''; out.discount = '';
  const dollar = qa('span').find(s => clean(s.textContent) === '$');
  if (dollar) {
    const wrap = dollar.parentElement;
    out.price = clean(wrap ? wrap.textContent : '').replace(/\$/g, '').replace(/\s+/g, '');
    // 划线价 / 折扣在往上几层的价格行里
    let row = dollar;
    for (let i = 0; i < 5 && row && row.parentElement; i++) {
      row = row.parentElement;
      if (!out.deletePrice) {
        const del = Array.from(row.querySelectorAll('span.line-through')).find(s => /^\$/.test(clean(s.textContent)));
        if (del) out.deletePrice = clean(del.textContent).replace(/\$/g, '').trim();
      }
      if (!out.discount) {
        const disc = Array.from(row.querySelectorAll('span')).find(s => /^-\d+%$/.test(clean(s.textContent)));
        if (disc) out.discount = clean(disc.textContent);
      }
      if (out.deletePrice && out.discount) break;
    }
  }
  if (!out.price) {
    // 兜底：og 里没有价格，只能从 body 里找第一个 $xx.xx
    const m = /\$\s*([\d,]+(?:\.\d{2})?)/.exec(document.body.innerText || '');
    if (m) out.price = m[1].replace(/,/g, '');
  }

  /* ---------- 运费 ---------- */
  const shipIcon = q('div.text-color-ECCyanText');
  let shipping = '';
  if (shipIcon) {
    const row = shipIcon.parentElement;
    shipping = clean(row ? row.textContent : '');
  }
  if (!shipping) {
    const s2 = qa('div,span').find(e => /free shipping|shipping on this order/i.test(e.textContent || '') && e.children.length === 0);
    shipping = s2 ? clean(s2.textContent) : '';
  }
  out.shipping = shipping.replace(/^.*?(?=Free shipping)/i, '').replace(/shipping on this order/i, '').trim() || shipping;

  /* ---------- 评分 / 评论数 / 销量（价格下方那一行） ---------- */
  out.score = ''; out.reviews = ''; out.sold = '';
  // 评论数：唯一形态 "(778)"
  const revParen = qa('span,div').find(e => /^\(\s*[\d.,]+[KkMm]?\s*\)$/.test(clean(e.textContent)) && e.children.length === 0);
  if (revParen) out.reviews = clean(revParen.textContent).replace(/[()\s]/g, '');
  // 评分：同一行里 star svg 前面的 4.7
  const soldSpan = qa('span').find(e => /^[\d.,]+[KkMm]?\s*sold$/i.test(clean(e.textContent)) && e.children.length === 0);
  if (soldSpan) {
    out.sold = clean(soldSpan.textContent).replace(/\s*sold$/i, '');
    // 从销量往上找整行容器，再在行内找 x.x 形式的评分
    let row = soldSpan;
    for (let i = 0; i < 4 && row && row.parentElement; i++) {
      row = row.parentElement;
      if (row && row.querySelector('svg') && /^[\d.]+\s*[\(\d]/.test(clean(row.textContent))) break;
    }
    if (row) {
      const m = /(?:^|\s)(\d\.\d)(?:\s|$)/.exec(clean(row.textContent));
      if (m) out.score = m[1];
    }
  }
  if (!out.score) {
    // 兜底：页面顶部第一个 4.x（商品评分通常比店铺评分先出现）
    const cand = qa('div,span').filter(e => e.children.length === 0 && /^\d\.\d$/.test(clean(e.textContent)));
    if (cand.length) out.score = clean(cand[0].textContent);
  }

  /* ---------- 品牌（详情表） ---------- */
  let brand = '无';
  for (const tr of qa('table tbody tr, table tr')) {
    const tds = tr.querySelectorAll('td, th');
    if (tds.length >= 2 && /^\s*Brand\s*$/i.test(clean(tds[0].textContent))) { brand = clean(tds[1].textContent); break; }
  }
  out.brand = brand;

  /* ---------- 店铺 ---------- */
  const storeA = q('a[href*="/store/"]');
  out.shopLink = storeA ? storeA.href : '';
  out.shopName = '无'; out.shopLevel = '无';
  out.shopRating = ''; out.shopTotalSales = ''; out.shopFollowers = '';

  // 店铺卡：包含 "Followers" 的那个 flex-col
  const folSpan = qa('span').find(e => /^\s*Followers\s*$/i.test(clean(e.textContent)) && e.children.length === 0);
  let card = null;
  if (folSpan) {
    let n = folSpan;
    for (let i = 0; i < 5 && n && n.parentElement; i++) {
      n = n.parentElement;
      if (n && /H2-Bold/.test(String(n.querySelector('span') && n.querySelector('span').className || ''))) { card = n; break; }
    }
    if (!card) card = folSpan.closest('div.flex.flex-col') || folSpan.parentElement;
  }
  if (card) {
    const nameEl = card.querySelector('span.H2-Bold') || card.querySelector('span[class*="H2-Bold"]');
    if (nameEl) out.shopName = clean(nameEl.textContent);
    // 数字都是「值 span + 标签 span」成对出现，不能用 textContent 正则（会拼成 "4.630.5K"）
    const pair = (labelRe) => {
      const lab = Array.from(card.querySelectorAll('span')).find(s => labelRe.test(clean(s.textContent)) && s.children.length === 0);
      if (!lab) return '';
      const holder = lab.parentElement;
      const valEl = holder && Array.from(holder.querySelectorAll('span')).find(s => s !== lab && s.children.length === 0 && /[\d]/.test(s.textContent || ''));
      return valEl ? clean(valEl.textContent) : '';
    };
    out.shopTotalSales = pair(/^\s*Sold\s*$/i);
    out.shopFollowers = pair(/^\s*Followers\s*$/i);
    // 评分：卡里第一个 4.6 形态
    const ratingEl = Array.from(card.querySelectorAll('span')).find(s => s.children.length === 0 && /^\d\.\d$/.test(clean(s.textContent)));
    if (ratingEl) out.shopRating = clean(ratingEl.textContent);
    // 等级：TikTok 现在不给店铺等级徽章了，留空
    const lvl = card.querySelector('[class*="Badge"], [class*="badge"]');
    if (lvl) out.shopLevel = clean(lvl.textContent);
  }
  if (out.shopName === '无' && storeA) {
    // 从 "Sold by xxx" 兜底
    const soldBy = qa('a[href*="/store/"]').find(a => /sold by/i.test(a.textContent || ''));
    if (soldBy) out.shopName = clean(soldBy.textContent).replace(/sold by/i, '').trim();
  }

  /* ---------- 服务指标 ---------- */
  out.responseRate = ''; out.shipsWithin = ''; out.positiveFeedback = '';
  const svc = qa('div').find(d => /flex flex-row justify-center items-start/.test(String(d.className || '')) && /positive feedback|on-time|issue resolution/i.test(d.textContent || ''));
  if (svc) {
    // 每个子块 = <值><标签>，例如 "84%" + "Positive feedback"
    const blocks = Array.from(svc.querySelectorAll('div.flex.flex-col'));
    for (const b of blocks) {
      const spans = Array.from(b.querySelectorAll('span')).map(s => clean(s.textContent)).filter(Boolean);
      if (spans.length < 2) continue;
      const val = spans[0];
      const label = spans.slice(1).join(' ');
      if (/positive feedback/i.test(label)) out.positiveFeedback = val;
      else if (/on-time delivery/i.test(label)) out.shipsWithin = val;
      else if (/issue resolution/i.test(label)) out.responseRate = val;
    }
  }

  /* ---------- 主图 ---------- */
  const imgs = qa('img')
    .map(i => ({ src: i.currentSrc || i.src || '', w: i.naturalWidth || 0 }))
    .filter(x => x.src && x.src.indexOf('ttcdn') > 0 && x.w >= 200);
  out.images = imgs.map(x => x.src).slice(0, 8);
  out.mainImage = out.images[0] || '';

  /* ---------- 描述 ---------- */
  // 结构：div.sectionHeader-xxx（文本 "Product description"）紧跟 div.sectionContent-xxx
  out.description = '';
  const descHeader = qa('div').find(d => /^\s*Product description\s*$/i.test(clean(d.textContent)) && d.querySelector('span'));
  if (descHeader && descHeader.nextElementSibling) {
    out.description = clean(descHeader.nextElementSibling.textContent).replace(/View more$/i, '').trim().slice(0, 3000);
  }
  if (!out.description) {
    const m = /Product description([\s\S]{40,3000}?)(?:View more|Safety & compliance|Seller information)/.exec(document.body.innerText || '');
    if (m) out.description = clean(m[1]).slice(0, 3000);
  }

  /* ---------- og 兜底 ---------- */
  const og = (k) => { const m = document.querySelector('meta[property="' + k + '"]'); return m ? (m.getAttribute('content') || '') : ''; };
  if (!out.title) out.title = og('og:title');
  if (!out.mainImage) { out.mainImage = og('og:image'); out.images = out.mainImage ? [out.mainImage] : []; }
  if (!out.description) out.description = og('og:description');

  return JSON.stringify(out);
}

/** 页面里执行的：从 SSR 内嵌数据里抠商品详情（比 DOM 稳） */
function pageExtractDetailSsr() {
  const out = {};
  try {
    const rd = document.querySelector('#RENDER_DATA');
    if (rd) { try { out._renderData = JSON.parse(decodeURIComponent(rd.textContent)); } catch (e) {} }
    const mr = document.querySelector('#__MODERN_ROUTER_DATA__');
    if (mr) { try { out._modernRouter = JSON.parse(mr.textContent); } catch (e) {} }
    if (window.__INITIAL_PROPS__) out._initialProps = window.__INITIAL_PROPS__;
    if (window.__NUXT__) out._nuxt = window.__NUXT__;
  } catch (e) { out._err = String(e); }

  const findKey = (obj, keys, depth) => {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    for (const k of keys) if (obj[k] && typeof obj[k] === 'object') return obj[k];
    for (const k of Object.keys(obj)) {
      const r = findKey(obj[k], keys, depth + 1);
      if (r) return r;
    }
    return null;
  };

  const pi = findKey(out._initialProps, ['productInfo']) ||
             findKey(out._modernRouter, ['productInfo']) ||
             findKey(out._renderData, ['productInfo']);
  if (pi) {
    out.ssr = {
      id: pi.id || pi.product_id || '',
      title: pi.title || '',
      desc: String(pi.description || '').slice(0, 500),
      price: (pi.price && (pi.price.sale_price || pi.price.price_val || pi.price.original_price)) || '',
      currency: (pi.price && pi.price.currency) || '',
      sold: pi.sold_count || pi.sold || '',
      rating: pi.rating || (pi.review && pi.review.rating) || '',
      reviews: pi.review_count || (pi.review && pi.review.count) || '',
      shop: (pi.shop && (pi.shop.name || pi.shop.shop_name)) || (pi.seller && pi.seller.name) || '',
      shopId: (pi.shop && pi.shop.id) || '',
      images: (pi.images || []).map(i => (typeof i === 'string' ? i : (i.url || i.thumb_url))).filter(Boolean).slice(0, 8),
    };
  }
  delete out._renderData; delete out._modernRouter; delete out._initialProps; delete out._nuxt;
  return JSON.stringify(out);
}

/** 页面里执行的：点「下一页 / 查看更多」 */
function pageClickNext() {
  const cands = Array.from(document.querySelectorAll('button, a, div[role="button"], [class*="pagination"] button'));
  for (const b of cands) {
    const t = (b.innerText || '').trim();
    const disabled = b.disabled || /disabled/i.test(b.className || '') || b.getAttribute('aria-disabled') === 'true';
    if (disabled) continue;
    if (/^(Next|下一页|Next page|查看更多|Load more|Show more)$/i.test(t)) { b.click(); return t; }
  }
  const nums = Array.from(document.querySelectorAll('[class*="pagination"] li, [class*="pager"] li'))
    .filter(e => /^\d+$/.test((e.innerText || '').trim()));
  if (nums.length) {
    const last = nums[nums.length - 1].nextElementSibling;
    if (last) { last.click(); return 'pager'; }
  }
  return '';
}

/**
 * 页面里执行的：抓类目导航
 *
 * 2026-10 实测：shop.tiktok.com 的真实类目链接形如
 *   https://shop.tiktok.com/us/c/beauty-personal-care/601450
 * 老的 a[href*="category"] / a[href*="/shop/"] 选择器全部失效（命中 0 条），
 * 必须匹配路径里的 /c/<slug>/<数字ID>。
 */
function pageExtractCategories() {
  const out = [];
  const push = (id, name, parentId, level, href) => {
    if (!id || !name) return;
    out.push({
      categoryId: String(id),
      name: String(name),
      parentId: parentId ? String(parentId) : '',
      level: level || 0,
      href: href || '',
    });
  };

  // 1) 优先用 SSR 里的 category_hierarchy（完整两级树，最可靠）
  try {
    const mr = document.querySelector('#__MODERN_ROUTER_DATA__');
    if (mr) {
      const j = JSON.parse(mr.textContent);
      const ld = j.loaderData || {};
      const key = Object.keys(ld).find(k => k.indexOf('c/') >= 0)
        || Object.keys(ld).find(k => ld[k] && ld[k].category_hierarchy);
      const hier = key && ld[key] && ld[key].category_hierarchy;
      if (Array.isArray(hier) && hier.length) {
        const walk = (node, parentId, level) => {
          const self = node && node.self;
          if (!self) return;
          const lv = level || self.category_level || 1;
          push(self.category_id, self.category_name, parentId || self.parent_category_id, lv, '');
          for (const c of (node.children || [])) walk(c, self.category_id, lv + 1);
        };
        for (const h of hier) walk(h, '', 1);
        if (out.length) return JSON.stringify(out);
      }
    }
  } catch (e) {}

  // 2) 兜底：DOM 链接（parentId/level 未知）
  const seen = new Set();
  const isCat = (h) => /\/c\/[a-z0-9-]+\/\d+/i.test(h || '') || /[?&]category/i.test(h || '');
  const anchors = Array.from(document.querySelectorAll('a[href*="/c/"], [class*="category"] a, nav a[href]'));
  for (const a of anchors) {
    const href = a.href;
    if (!isCat(href)) continue;
    const name = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) continue;
    const m = /\/c\/([a-z0-9-]+)\/(\d+)/i.exec(href);
    if (!m) continue;
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    push(id, name, '', 0, href);
  }
  return JSON.stringify(out);
}

/**
 * 页面里执行的：点「View more」把类目页商品再加载一批。
 * 实测类目页 10 条/批，View more 可反复点（10 → 20 → 25 → 30 → 34 → 44 → 54 → 64 → 69…）。
 * @returns 点击结果：'clicked' | 'nobtn'
 */
function pageClickViewMore() {
  const cands = Array.from(document.querySelectorAll('button, [role="button"], a'));
  for (const b of cands) {
    const t = (b.innerText || '').trim();
    if (!/^(View more|Load more|Show more|查看更多|加载更多|更多)$/i.test(t)) continue;
    const disabled = b.disabled || /disabled/i.test(String(b.className || '')) || b.getAttribute('aria-disabled') === 'true';
    if (disabled) continue;
    b.click();
    return 'clicked';
  }
  return 'nobtn';
}

/**
 * 页面里执行的：抓店铺头部的商家信息
 *
 * 2026-10 实测 shop.tiktok.com/us/store/<slug>/<id> 的真实结构：
 *   <div class="shopHeading-xxx">
 *     <h1 class="shopName-xxx">Lumina Beauty</h1>
 *     <div class="stats-xxx">
 *       <div class="stat-xxx"><div class="font-semibold">700+</div><div>Follower</div></div>
 *       <div class="stat-xxx"><div class="font-semibold">30.5K</div><div>Sold</div></div>
 *       <div class="stat-xxx"><div class="font-semibold">465</div><div>Videos</div></div>
 *     </div>
 *   </div>
 * 注意：不要用固定 xpath 定位，页面改版会失效，按语义匹配更稳。
 * 商家星级在当前站点已不再展示（店铺头部只有 Follower/Sold/Videos），拿不到就留空。
 */
function pageExtractShopInfo() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = { shopName: '', followers: '', sold: '', videos: '', rating: '', link: location.href };

  const h1 = document.querySelector('h1[class*="shopName"], div[class*="shopHeading"] h1, h1');
  if (h1) out.shopName = clean(h1.textContent);

  // 指标块：每个 stat 里两个子 div = <值><标签>
  const stats = Array.from(document.querySelectorAll('[class*="stat-"]'));
  for (const s of stats) {
    const kids = Array.from(s.children).filter(c => !/^SPAN$/i.test(c.tagName) || clean(c.textContent));
    if (kids.length < 2) continue;
    const value = clean(kids[0].textContent);
    const label = clean(kids[1].textContent);
    if (/^(follower|followers|粉丝)$/i.test(label)) out.followers = value;
    else if (/^(sold|已售出|已售)$/i.test(label)) out.sold = value;
    else if (/^(video|videos|视频)$/i.test(label)) out.videos = value;
  }
  // 兜底：整体文本正则（"700+ Follower"）
  if (!out.followers) {
    const m = /([\d.,]+[KkMm]?\+?)\s*Followers?/i.exec(document.body.innerText || '');
    if (m) out.followers = m[1];
  }
  if (!out.sold) {
    const m = /([\d.,]+[KkMm]?\+?)\s*Sold/i.exec(document.body.innerText || '');
    if (m) out.sold = m[1];
  }

  // 商家星级：店铺头部若有 star svg 紧跟数字则取之（当前站点通常没有）
  const hero = document.querySelector('[class*="hero-"], [class*="shopHeading"]');
  if (hero) {
    for (const svg of hero.querySelectorAll('svg')) {
      const p = svg.parentElement;
      if (!p) continue;
      const t = clean(p.textContent);
      const m = /(\d\.\d)/.exec(t);
      if (m && t.length <= 20) { out.rating = m[1]; break; }
    }
  }
  return JSON.stringify(out);
}

/** 把页面函数包成可在 evaluate 里执行的表达式 */
const callPageFn = (fn) => '(' + fn.toString() + ')()';

/* ---------- 3. 采集器 ---------- */

class TiktokCollector {
  /**
   * @param {object} opt
   * @param {(url:string)=>Promise<import('./page').Tab>} opt.openTab  打开新标签页
   * @param {import('./page').Tab} [opt.tab]  复用标签页
   * @param {object} [opt.slider]  {mode:'manual'|'auto', chaojiying:{...}, onManual}
   */
  constructor(opt = {}) {
    this.openTab = opt.openTab;
    this.tab = opt.tab || null;
    this.slider = opt.slider || { mode: 'manual' };
    this.onProgress = opt.onProgress || (() => {});
    this._ownsTab = !opt.tab;
  }

  _p(msg) { this.onProgress(msg); log('dim', msg); }

  /** 当前 tab 底下的 CDP 连接是否还活着（Chrome 退出后 closed 会变 true） */
  _tabAlive() {
    if (!this.tab) return false;
    try { return !(this.tab.cdp && this.tab.cdp.closed); } catch (e) { return false; }
  }

  /** 丢弃失效的 tab，下次重新开一个 */
  _dropTab() {
    if (this.tab && this._ownsTab) { try { this.tab.close(); } catch (e) {} }
    this.tab = null;
  }

  async _getTab(url) {
    if (!this._tabAlive()) this._dropTab();
    if (!this.tab) {
      this.tab = await this.openTab(url);
      return this.tab;
    }
    // 复用旧页签；导航失败说明浏览器已经挂了，丢页签重开一次
    try {
      await this.tab.goto(url, { timeout: 45000 });
      return this.tab;
    } catch (e) {
      this._p('页签导航失败（' + (e && e.message) + '），重建浏览器…');
      this._dropTab();
      this.tab = await this.openTab(url);
      return this.tab;
    }
  }

  async _guardSlider() {
    const { hasSliderVerify, handleSlider } = require('./slider');
    if (!(await hasSliderVerify(this.tab))) return 'none';
    this._p('检测到滑块验证');
    const r = await handleSlider(this.tab, this.slider);
    if (r === 'timeout') this._p('滑块超时');
    return r;
  }

  /**
   * 抓列表页（店铺商品列表 / 关键词搜索结果）。
   * @returns {Promise<Array>}
   */
  async collectList(url, opt = {}) {
    const maxPages = opt.maxPages || 1;
    const scrollRounds = opt.scrollRounds || 6;
    const filters = normalizeFilters(opt.filters);
    const cond = where.getWhere(opt.where);
    const all = [];
    const seen = new Set();
    let filtered = 0;

    await this._getTab(url);
    await this.tab.waitReady({ timeout: 45000 }).catch(() => {});
    await sleep(1500);
    await this._guardSlider();

    for (let page = 1; page <= maxPages; page++) {
      this._p('抓取第 ' + page + ' 页列表…');

      for (let i = 0; i < scrollRounds; i++) {
        await this.tab.evaluate('window.scrollBy(0, window.innerHeight * 0.9)');
        await sleep(700);
      }
      await this.tab.evaluate('window.scrollTo(0, 0)');
      await sleep(400);

      const raw = await this.tab.evaluate(callPageFn(pageExtractList));
      let items = [];
      try { items = JSON.parse(raw); } catch (e) { items = []; }

      let added = 0;
      for (const it of items) {
        if (!it.url || seen.has(it.url)) continue;
        seen.add(it.url);
        it.sourceInfo = getSourceInfoByItemUrl(it.url);
        it.linkNo = all.length + 1;
        // 销量 / 价格过滤
        const v = passesFilters(it, filters);
        if (!v.pass) { filtered++; continue; }
        // 自定义条件表达式（--where "销量 100-1000"）
        if (cond && !cond(it)) { filtered++; continue; }
        all.push(it);
        added++;
      }
      this._p('第 ' + page + ' 页新增 ' + added + ' 条（累计 ' + all.length + '，过滤掉 ' + filtered + '）');

      if (page < maxPages) {
        const ok = await this._clickNext();
        if (!ok) { this._p('没有更多页了'); break; }
        await sleep(2500);
        await this._guardSlider();
      }
    }
    return all;
  }

  async _clickNext() {
    const clicked = await this.tab.evaluate(callPageFn(pageClickNext));
    return !!clicked;
  }

  /**
   * 抓商品详情（移植 getgooddetail）。
   * @returns {Promise<object>}
   */
  async collectDetail(url, opt = {}) {
    await this._getTab(url);
    await this.tab.waitReady({ timeout: 45000 }).catch(() => {});
    await sleep(1800);
    await this._guardSlider();

    await waitFor(async () => {
      const ok = await this.tab.evaluate('!!(document.querySelector("#__MODERN_ROUTER_DATA__")||document.querySelector("#RENDER_DATA")||document.querySelector("h1"))');
      return ok ? true : null;
    }, { timeout: 15000, interval: 500, label: '详情页数据' }).catch(() => {});

    const ssrRaw = await this.tab.evaluate(callPageFn(pageExtractDetailSsr));
    const domRaw = await this.tab.evaluate(callPageFn(pageExtractDetailDom));
    let ssr = {}, dom = {};
    try { ssr = JSON.parse(ssrRaw) || {}; } catch (e) {}
    try { dom = JSON.parse(domRaw) || {}; } catch (e) {}

    const s = ssr.ssr || {};
    const si = getSourceInfoByItemUrl(url);

    const rec = {
      '商品url': url,
      '商品标题': dom.title || s.title || '',
      '商品类目': dom.category || '',
      '运费': dom.shipping || '',
      '价格': dom.price || (s.price ? String(s.price) : ''),
      '划线价': dom.deletePrice || '',
      '折扣': dom.discount || '',
      '评分': dom.score || (s.rating ? String(s.rating) : ''),
      '评论': dom.reviews || (s.reviews ? String(s.reviews) : ''),
      '销量': dom.sold || (s.sold ? String(s.sold) : ''),
      '品牌': dom.brand || '无',
      '店铺链接': dom.shopLink || '',
      '店铺名称': dom.shopName || s.shop || '',
      '店铺等级': dom.shopLevel || '',
      '店铺评分': dom.shopRating || '',
      '店铺总销': dom.shopTotalSales || '',
      '店铺粉丝数': dom.shopFollowers || '',
      '24小时响应率': dom.responseRate || '',
      '2天内发货率': dom.shipsWithin || '',
      '好评率': dom.positiveFeedback || '',
      '主图': dom.mainImage || (s.images && s.images[0]) || '',
      '图片列表': dom.images || s.images || [],
      '描述': dom.description || s.desc || '',
      '面包屑': dom.crumbs || [],
      'itemId': si.itemId,
      'site': si.site,
      'source': si.source,
      // 与列表采集项保持同一形状，便于 toSourceInfoList / 外部脚本直接取用
      'sourceInfo': si,
    };
    this._p('详情采集完成: ' + String(rec['商品标题'] || '(无标题)').slice(0, 40));
    // 品牌过滤（仅详情模式）+ 自定义条件
    const filters = normalizeFilters(opt.filters);
    const cond = where.getWhere(opt.where);
    if (filters.brandFilter || cond) {
      const v = filters.brandFilter ? passesFilters(rec, filters) : { pass: true };
      if (!v.pass) {
        this._p('详情被品牌过滤跳过: ' + v.reason);
        rec._filtered = true;
        rec._filterReason = v.reason;
      } else if (cond && !cond(rec)) {
        this._p('详情不满足条件表达式，跳过: ' + opt.where);
        rec._filtered = true;
        rec._filterReason = '条件不满足: ' + opt.where;
      }
    }
    return rec;
  }

  /**
   * 抓店铺头部的商家信息（粉丝数/已售出/视频数/商家星级）。
   * 返回粉丝数 / 已售出 / 视频数 / 商家星级。
   * @returns {Promise<{shopName,followers,sold,videos,rating,link}>}
   */
  async collectShopInfo(url, opt = {}) {
    await this._getTab(url);
    await this.tab.waitReady({ timeout: 45000 }).catch(() => {});
    await sleep(2000);
    await this._guardSlider();
    await waitFor(async () => {
      const ok = await this.tab.evaluate('!!document.querySelector(\'[class*="stat-"], h1\')');
      return ok ? true : null;
    }, { timeout: 12000, interval: 500, label: '店铺头部' }).catch(() => {});
    const raw = await this.tab.evaluate(callPageFn(pageExtractShopInfo));
    let info = {};
    try { info = JSON.parse(raw) || {}; } catch (e) {}
    this._p('商家信息: 粉丝=' + (info.followers || '-') + ' 已售出=' + (info.sold || '-') + ' 视频=' + (info.videos || '-'));
    return info;
  }

  /**
   * 关键词搜索采集。
   * 实测：搜索页真实路由是 /us/s?q=<关键词>，直接打开即可（/us/search 是 404）。
   * @param {string} keyword
   * @param {object} opt  {site:'us', maxPages, scrollRounds, filters}
   */
  async searchList(keyword, opt = {}) {
    const site = opt.site || 'us';
    const url = 'https://shop.tiktok.com/' + site + '/s?q=' + encodeURIComponent(keyword);
    this._p('关键词搜索: ' + keyword + ' → ' + url);
    const items = await this.collectList(url, opt);
    for (const it of items) it._keyword = keyword;
    return items;
  }

  /**
   * 抓完整类目树（两级）。
   * @param {string} [site='us']
   * @returns {Promise<Array<{categoryId,name,parentId,level}>>}
   */
  async collectCategories(site, opt = {}) {
    const s = typeof site === 'string' && site ? site : (opt.site || 'us');
    const target = 'https://shop.tiktok.com/' + s;
    await this._getTab(target);
    await this.tab.waitReady({ timeout: 45000 }).catch(() => {});
    await sleep(2000);
    await this._guardSlider();
    await waitFor(async () => {
      const ok = await this.tab.evaluate('!!document.querySelector(\'#__MODERN_ROUTER_DATA__\')');
      return ok ? true : null;
    }, { timeout: 15000, interval: 500, label: '类目数据' }).catch(() => {});
    const raw = await this.tab.evaluate(callPageFn(pageExtractCategories));
    let cats = [];
    try { cats = JSON.parse(raw) || []; } catch (e) {}
    this._p('类目树: ' + cats.filter(c => c.level === 1).length + ' 个一级 / ' + cats.length + ' 个节点');
    return cats;
  }

  /**
   * 按类目 URL 采集商品。
   * 类目页每批 10 条，靠「View more」反复加载；maxPages 语义 = 点几次 View more。
   * @param {string} catUrl 形如 https://shop.tiktok.com/us/c/men-s-tops/839944
   */
  async collectCategoryList(catUrl, opt = {}) {
    const maxMore = opt.maxPages || 1;   // 复用 maxPages 作为「View more 次数」
    const filters = normalizeFilters(opt.filters);
    const cond = where.getWhere(opt.where);

    await this._getTab(catUrl);
    await this.tab.waitReady({ timeout: 45000 }).catch(() => {});
    await sleep(1500);
    await this._guardSlider();

    const seen = new Set();
    const all = [];
    let filtered = 0;

    const harvest = async () => {
      const raw = await this.tab.evaluate(callPageFn(pageExtractList));
      let items = [];
      try { items = JSON.parse(raw) || []; } catch (e) {}
      let added = 0;
      for (const it of items) {
        if (!it.url || seen.has(it.url)) continue;
        seen.add(it.url);
        it.sourceInfo = getSourceInfoByItemUrl(it.url);
        it.linkNo = all.length + 1;
        const v = passesFilters(it, filters);
        if (!v.pass) { filtered++; continue; }
        if (cond && !cond(it)) { filtered++; continue; }
        all.push(it);
        added++;
      }
      return added;
    };

    const first = await harvest();
    this._p('类目页首批 ' + first + ' 条');

    for (let round = 1; round <= maxMore; round++) {
      // 按钮通常在页面底部，先滚到底再点（实测不滚动时点击可能不生效）
      await this.tab.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
      await sleep(700);

      let r = await this.tab.evaluate(callPageFn(pageClickViewMore));
      if (r !== 'clicked') {
        // 再滚一次重试（懒加载按钮有时晚一拍出现）
        await this.tab.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
        await sleep(1200);
        r = await this.tab.evaluate(callPageFn(pageClickViewMore));
      }
      if (r !== 'clicked') { this._p('没有更多了（第 ' + round + ' 轮）'); break; }

      // 等新数据渲染：最多等 3 次，有新增就继续
      let added = 0;
      for (let wait = 0; wait < 3; wait++) {
        await sleep(1800);
        await this._guardSlider();
        added = await harvest();
        if (added > 0) break;
      }
      this._p('View more 第 ' + round + ' 轮 +' + added + '（累计 ' + all.length + '，过滤掉 ' + filtered + '）');
      if (added === 0) { this._p('本轮无新增，停止'); break; }
    }
    return all;
  }

  async close() {
    if (this.tab && this._ownsTab) { try { await this.tab.close(); } catch (e) {} }
  }
}

/** 类目 id → 类目 URL（slug 随便写也能打开，实测 https://shop.tiktok.com/us/c/x/<id> 正常） */
function categoryUrl(site, categoryId, slug) {
  const s = site || 'us';
  return 'https://shop.tiktok.com/' + s + '/c/' + (slug || 'c') + '/' + categoryId;
}

module.exports = {
  TiktokCollector,
  getSourceInfoByItemUrl, matchItemId, isDetailUrl, isRedirectLink,
  parseSaleToInt, parsePriceToFloat, normalizeFilters, passesFilters,
  categoryUrl,
  TIKTOK_SOURCE, MATCH_SOURCE_INFO_PATTERN, MATCH_DETAIL_PATTERN, MATCH_REDIRECT_PATTERN, SITE_MAP,
};
