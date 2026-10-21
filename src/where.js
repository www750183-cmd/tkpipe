'use strict';
/**
 * 条件表达式（where）—— 零依赖的小型 DSL，用来给采集结果指定任意过滤条件。
 *
 * 支持写法（大小写不敏感，中英文都行）：
 *
 *   销量 100-1000                     销量区间（也可写 sales 100-1000 / 100~1000 / 100至1000）
 *   销量 between 100 and 1000         同上，显式写法
 *   销量 >= 100 and 销量 <= 1000      组合条件
 *   价格 < 20 or 评分 >= 4.5          或
 *   标题 ~ hoodie                     包含（子串，不区分大小写）
 *   标题 !~ "phone case"              不包含
 *   品牌 = 无                         等于（"无" 表示详情页没有品牌）
 *   店铺 ~ lumina and 粉丝数 > 500
 *   not (品牌 = GAP)                  取反
 *   (价格 < 20 or 评分 >= 4.5) and 销量 > 1000
 *
 * 字段别名见 FIELD_ALIASES。数值字段支持 K / M / 加号 / 美元符号 / 千分位：
 *   1.2K → 1200，3M → 3000000，1,234+ → 1234，$27.00 → 27
 *
 * 裸值（没写运算符）的语义：数字按 >= 处理，字符串按 = 处理。
 * 例：销量 100 等价于 销量 >= 100。
 */

/* ---------------- 数值解析 ---------------- */

/**
 * 销量/粉丝这类文本 → 整数（支持 K/M 后缀与千分位）。
 * 支持 "1.2K" / "3M" / "1,234+" / "7.6K" / "576" / "700+"。
 * @returns {number|null}
 */
function parseSaleToInt(s) {
  s = String(s === undefined || s === null ? '' : s).toLowerCase().replace(/,/g, '').replace(/\+/g, '').trim();
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
 * 价格/评分这类文本 → 浮点。
 * @returns {number|null}
 */
function parsePriceToFloat(s) {
  s = String(s === undefined || s === null ? '' : s).replace(/\$/g, '').replace(/,/g, '').trim();
  const m = /([\d.]+)/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v : null;
}

/** 通用：能解析成数字就返回数字，否则 null。带 K/M 后缀按倍数放大。 */
function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 带 K/M 的按销量规则
  if (/^[\s$]*-?[\d.,]+\s*[kKmM]?\s*\+?\s*$/.test(s)) {
    const hasSuffix = /[kKmM]\s*\+?\s*$/.test(s);
    return hasSuffix ? parseSaleToInt(s) : parsePriceToFloat(s);
  }
  return null;
}

/* ---------------- 字段定义 ---------------- */

/** 字段定义：type 决定比较方式（num 先转数字，str 按字符串） */
const FIELDS = {
  sales:       { type: 'num', get: r => pick(r, ['saleCount', '销量', '销售量', 'soldCount']) },
  price:       { type: 'num', get: r => pick(r, ['price', '价格', '售价']) },
  deleteprice: { type: 'num', get: r => pick(r, ['deletePrice', '划线价']) },
  score:       { type: 'num', get: r => pick(r, ['score', '评分']) },
  reviews:     { type: 'num', get: r => pick(r, ['reviews', '评论', '评论数']) },
  followers:   { type: 'num', get: r => pick(r, ['粉丝数', 'followers']) },
  sold:        { type: 'num', get: r => pick(r, ['已售出', 'sold']) },
  videos:      { type: 'num', get: r => pick(r, ['视频数', 'videos']) },
  title:       { type: 'str', get: r => pick(r, ['title', '商品标题']) },
  shop:        { type: 'str', get: r => pick(r, ['店铺名称', 'shopName']) },
  brand:       { type: 'str', get: r => pick(r, ['brand', '品牌']) },
  url:         { type: 'str', get: r => pick(r, ['url', '商品url', '商品链接']) },
  category:    { type: 'str', get: r => pick(r, ['商品类目', 'category']) },
  carriage:    { type: 'str', get: r => pick(r, ['carriage', '运费']) },
  keyword:     { type: 'str', get: r => pick(r, ['_keyword', 'keyword']) },
  itemid:      { type: 'str', get: r => pick(r, ['itemId']) || (r && r.sourceInfo && r.sourceInfo.itemId) },
  site:        { type: 'str', get: r => pick(r, ['site']) || (r && r.sourceInfo && r.sourceInfo.site) },
  description: { type: 'str', get: r => pick(r, ['description', '商品描述', 'desc']) },
};

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 中文/英文别名 → 规范字段名 */
const FIELD_ALIASES = {
  销量: 'sales', 销售量: 'sales', 已售: 'sales', 售出: 'sales', sale: 'sales', soldcount: 'sales', salescount: 'sales',
  价格: 'price', 售价: 'price', 现价: 'price',
  划线价: 'deleteprice', 原价: 'deleteprice', delete_price: 'deleteprice',
  评分: 'score', 星级: 'score', rating: 'score',
  评论: 'reviews', 评论数: 'reviews', 评价数: 'reviews',
  粉丝: 'followers', 粉丝数: 'followers', follower: 'followers', fans: 'followers',
  已售出: 'sold', soldnum: 'sold',
  视频: 'videos', 视频数: 'videos', video: 'videos',
  标题: 'title', 商品标题: 'title', name: 'title',
  店铺: 'shop', 店铺名称: 'shop', 商家: 'shop', store: 'shop', shopname: 'shop',
  品牌: 'brand',
  链接: 'url', 商品链接: 'url', 商品url: 'url', link: 'url',
  类目: 'category', 商品类目: 'category', 分类: 'category',
  运费: 'carriage', 邮费: 'carriage', shipping: 'carriage',
  关键词: 'keyword',
  itemid: 'itemid', 商品id: 'itemid', id: 'itemid',
  站点: 'site', 国家: 'site', region: 'site',
  描述: 'description', 商品描述: 'description', desc: 'description',
};

/** 把用户写的字段名解析成规范字段名；不认识返回 null */
function normalizeField(raw) {
  const key = String(raw || '').trim();
  if (!key) return null;
  const lower = key.toLowerCase().replace(/[\s_-]/g, '');
  if (FIELDS[lower]) return lower;
  if (FIELDS[key]) return key;
  const alias = FIELD_ALIASES[key] || FIELD_ALIASES[lower];
  if (alias && FIELDS[alias]) return alias;
  return null;
}

/* ---------------- 词法 / 语法 ---------------- */

/** 顶层切分：返回 [{t:'atom',v}] 与 {t:'and'|'or'} 交错的 token 数组 */
function tokenize(input) {
  const s = String(input);
  const tokens = [];
  let depth = 0, quote = null, buf = '';
  const flush = () => { const t = buf.trim(); if (t) tokens.push({ t: 'atom', v: t }); buf = ''; };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) { buf += ch; if (ch === quote) quote = null; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; i++; continue; }
    if (ch === '(') { depth++; buf += ch; i++; continue; }
    if (ch === ')') { depth--; buf += ch; i++; continue; }

    if (depth === 0) {
      const rest = s.slice(i);
      const m = /^(&&|\|\||\band\b|\bor\b|并且|而且|且|或者|或)/i.exec(rest);
      if (m) {
        const kw = m[1].toLowerCase();
        const isOr = kw === '||' || kw === 'or' || kw === '或' || kw === '或者';
        // 「between A and B」里的 and 属于比较项，不能当连接词切开
        if (!isOr && /\bbetween\b/i.test(buf) && !/\bbetween\s+\S+\s+and\b/i.test(buf)) {
          buf += m[1];
          i += m[1].length;
          continue;
        }
        flush();
        tokens.push({ t: isOr ? 'or' : 'and' });
        i += m[1].length;
        continue;
      }
    }
    buf += ch; i++;
  }
  flush();
  return tokens;
}

/** 括号内子表达式：独立跑一遍递归下降 */
function parseExpr(str) {
  const tokens = tokenize(str);
  if (!tokens.length) throw new Error('括号里是空的');
  const state = { pos: 0 };
  const ast = buildTree(tokens, state);
  if (state.pos < tokens.length) throw new Error('括号里有多余内容: ' + str);
  return ast;
}

/** 递归下降：or 优先级最低 */
function buildTree(tokens, state) {
  const node = parseAnd(tokens, state);
  while (state.pos < tokens.length && tokens[state.pos].t === 'or') {
    state.pos++;
    const right = parseAnd(tokens, state);
    return { op: 'or', left: node, right: right };
  }
  return node;
}

function parseAnd(tokens, state) {
  let node = parsePrimary(tokens, state);
  while (state.pos < tokens.length && tokens[state.pos].t === 'and') {
    state.pos++;
    const right = parsePrimary(tokens, state);
    node = { op: 'and', left: node, right: right };
  }
  return node;
}

function parsePrimary(tokens, state) {
  const tk = tokens[state.pos];
  if (!tk) throw new Error('条件表达式不完整');
  if (tk.t !== 'atom') throw new Error('条件表达式里缺少比较项');
  state.pos++;
  return parseAtom(tk.v);
}

function parseAtom(text) {
  let s = String(text).trim();
  let neg = false;
  // 取反前缀：not / ! / 非（注意 !~ 只在字段后面出现，不会在开头）
  while (/^(?:not\b|!|非)\s*/i.test(s)) {
    neg = true;
    s = s.replace(/^(?:not\b|!|非)\s*/i, '');
  }
  let node;
  if (s.startsWith('(') && s.endsWith(')')) {
    node = parseExpr(s.slice(1, -1));
  } else {
    node = parseComparison(s);
  }
  return neg ? { op: 'not', child: node } : node;
}

const OP_MAP = {
  '=': 'eq', '==': 'eq', '!=': 'ne', '<>': 'ne',
  '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
  '~': 'contains', '!~': 'ncontains',
};

function parseComparison(s) {
  // 字段名：英文标识符 或 纯中文
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fa5]+)\s*([\s\S]*)$/.exec(s.trim());
  if (!m) throw new Error('无法识别的条件: ' + s);
  const rawField = m[1];
  const field = normalizeField(rawField);
  if (!field) throw new Error('未知字段「' + rawField + '」');
  let rest = (m[2] || '').trim();
  if (!rest) throw new Error('条件「' + rawField + '」缺少比较值');

  // between a and b
  let mm = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(rest);
  if (mm) return { op: 'between', field, min: parseValue(mm[1]), max: parseValue(mm[2]) };

  // 区间：100-1000 / 100~1000 / 100至1000
  mm = /^(-?[\d.,]+\s*[kKmM]?\s*\+?)\s*(?:-|~|至|到)\s*(-?[\d.,]+\s*[kKmM]?\s*\+?)$/.exec(rest);
  if (mm) return { op: 'between', field, min: parseValue(mm[1]), max: parseValue(mm[2]) };

  // 运算符
  mm = /^(>=|<=|!=|<>|==|=|!~|~|>|<)\s*([\s\S]+)$/.exec(rest);
  if (mm) return { op: OP_MAP[mm[1]], field, value: parseValue(mm[2]) };

  // 裸值：数字 → >=，字符串 → =
  const v = parseValue(rest);
  return { op: typeof v === 'number' ? 'gte' : 'eq', field, value: v };
}

function parseValue(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1);
  }
  const n = toNumber(s);
  return n === null ? s : n;
}

/** 解析条件字符串 → AST */
function parseWhere(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const tokens = tokenize(s);
  if (!tokens.length) return null;
  const state = { pos: 0 };
  const ast = buildTree(tokens, state);
  if (state.pos < tokens.length) throw new Error('条件表达式有多余内容: ' + s);
  return ast;
}

/* ---------------- 求值 ---------------- */

function rawField(rec, field) {
  const def = FIELDS[field];
  return def ? def.get(rec) : undefined;
}

function asNum(rec, field) {
  const raw = rawField(rec, field);
  if (raw === undefined || raw === null || raw === '') return null;
  return toNumber(raw);
}

function asStr(rec, field) {
  const raw = rawField(rec, field);
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

function evalNode(node, rec) {
  if (!node) return true;
  switch (node.op) {
    case 'and': return evalNode(node.left, rec) && evalNode(node.right, rec);
    case 'or': return evalNode(node.left, rec) || evalNode(node.right, rec);
    case 'not': return !evalNode(node.child, rec);
    default: break;
  }

  const def = FIELDS[node.field];
  if (!def) return false;

  if (def.type === 'num') {
    const v = asNum(rec, node.field);
    if (node.op === 'contains' || node.op === 'ncontains') {
      const hit = asStr(rec, node.field).toLowerCase().includes(String(node.value).toLowerCase());
      return node.op === 'contains' ? hit : !hit;
    }
    // 字段取不到值：正向比较一律不通过，ne 通过
    if (v === null) return node.op === 'ne';
    switch (node.op) {
      case 'between': {
        const lo = typeof node.min === 'number' ? node.min : toNumber(node.min);
        const hi = typeof node.max === 'number' ? node.max : toNumber(node.max);
        if (lo === null || hi === null) return false;
        return v >= Math.min(lo, hi) && v <= Math.max(lo, hi);
      }
      case 'eq': return typeof node.value === 'number' ? v === node.value : false;
      case 'ne': return typeof node.value === 'number' ? v !== node.value : true;
      case 'gt': return typeof node.value === 'number' && v > node.value;
      case 'gte': return typeof node.value === 'number' && v >= node.value;
      case 'lt': return typeof node.value === 'number' && v < node.value;
      case 'lte': return typeof node.value === 'number' && v <= node.value;
      default: return false;
    }
  }

  // 字符串字段
  const s = asStr(rec, node.field);
  const target = String(node.value === undefined ? '' : node.value);
  const lower = s.toLowerCase();
  const tlower = target.toLowerCase();
  switch (node.op) {
    case 'between': {
      const lo = String(node.min === undefined ? '' : node.min).toLowerCase();
      const hi = String(node.max === undefined ? '' : node.max).toLowerCase();
      return lower >= lo && lower <= hi;
    }
    case 'eq': return lower === tlower;
    case 'ne': return lower !== tlower;
    case 'contains': return lower.includes(tlower);
    case 'ncontains': return !lower.includes(tlower);
    case 'gt': return lower > tlower;
    case 'gte': return lower >= tlower;
    case 'lt': return lower < tlower;
    case 'lte': return lower <= tlower;
    default: return false;
  }
}

/**
 * 编译条件字符串 → 判定函数 (rec) => boolean。
 * 传空串返回 null。语法错误会抛 Error。
 */
function compileWhere(str) {
  const ast = parseWhere(str);
  if (!ast) return null;
  return (rec) => {
    try { return !!evalNode(ast, rec); } catch (e) { return false; }
  };
}

/** 带缓存的编译（同一条条件串只解析一次） */
const _cache = new Map();
function getWhere(str) {
  const key = String(str || '').trim();
  if (!key) return null;
  if (_cache.has(key)) return _cache.get(key);
  const fn = compileWhere(key);
  _cache.set(key, fn);
  return fn;
}

module.exports = {
  parseSaleToInt, parsePriceToFloat, toNumber,
  normalizeField, parseWhere, compileWhere, getWhere,
  FIELDS, FIELD_ALIASES,
};
