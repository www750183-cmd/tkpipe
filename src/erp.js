'use strict';
/**
 * 跨境ERP（妙手 ERP）客户端。
 *
  * 基于对 ERP 前端请求的观察：
  *   - 前端所有请求都走同一套 HTTP 封装。
 *   - 采集提交的真实入口：
 *       const y = hf(d, w => w.itemId || w.itemUrl)      // 按 itemId/itemUrl 去重
 *       const b = { isAutoPublish: 0, itemSimpleDetails: JSON.stringify(y) }
 *       await woe(b)                                     // POST /api/open/niu/push_collect_box
 *   - 认证只靠 cookie（accountId / mserp_sst / autoLoginToken / tfstk），没有 Authorization 头。
 *
 * 因此支持两种模式：
 *   A. direct（默认，推荐）：Node 侧带 Cookie 头直接 fetch，不用开浏览器。
 *   B. page：在 erp.91miaoshou.com 页面上下文里 fetch（同源自动带 cookie），适合没有 cookie 时
 *      先用真浏览器登录一次。
 */
const { log } = require('./util');

const ERP_BASE = 'https://erp.91miaoshou.com';
const ERP_ORIGIN = ERP_BASE;

/** 页面上下文里的通用 POST/GET（同源 fetch，自动带 cookie）。必须是自包含函数，靠 toString() 注入。 */
async function pageFetch(opts) {
  const { url: rawUrl, method, body, query } = opts;
  let url = rawUrl;
  if (query) {
    const qs = new URLSearchParams();
    for (const k of Object.keys(query)) {
      const v = query[k];
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.indexOf('?') >= 0 ? '&' : '?') + s;
  }
  const headers = { Accept: 'application/json, text/plain, */*' };
  const init = { method: method || 'POST', credentials: 'include', headers: headers };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    const b = body === undefined ? {} : body;
    const parts = [];
    const walk = (val, key) => {
      if (val === undefined || val === null) return;
      if (Array.isArray(val)) { val.forEach((v, i) => walk(v, key + '[' + i + ']')); return; }
      if (typeof val === 'object') { for (const k of Object.keys(val)) walk(val[k], key + '[' + k + ']'); return; }
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
    };
    for (const k of Object.keys(b)) walk(b[k], k);
    init.body = parts.join('&');
  }
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('URL 必须是绝对地址: ' + url);
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return JSON.stringify({
      ok: r.ok,
      status: r.status,
      json: json,
      text: json ? undefined : String(text).slice(0, 2000),
    });
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, error: String((e && e.message) || e) });
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

/**
 * 复刻扩展里 qs.stringify（默认 indices 格式）的行为。
 *
 * 【协议要点】妙手 ERP 的 /api/open/** 接口全部吃
 *   Content-Type: application/x-www-form-urlencoded
 * 而不是 JSON。扩展的 plwFetch 实现（background.js 里 Ap=Ml({...})）写死：
 *   serializeBody: qs.stringify,
 *   contentType: "application/x-www-form-urlencoded; charset=UTF-8",
 *   isSuccess: e => e.result === "success"
 * 用 JSON 提交会返回 {"result":"fail","reason":"获取搬家数据为空，请检查来源是否合法!"}。
 */
function qsStringify(obj, prefix) {
  const parts = [];
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  };
  const walk = (val, key) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(v, key + '[' + i + ']'));
      return;
    }
    if (typeof val === 'object' && !(val instanceof Date)) {
      for (const k of Object.keys(val)) walk(val[k], key + '[' + k + ']');
      return;
    }
    add(key, val);
  };
  for (const k of Object.keys(obj)) walk(obj[k], prefix ? prefix + '[' + k + ']' : k);
  return parts.join('&');
}

class ErpClient {
  /**
   * @param {object} opt
   * @param {import('./page').Tab} [opt.tab]   已打开的 erp.91miaoshou.com 页面（page 模式用）
   * @param {object|string} [opt.cookies]      cookie 对象或 "a=b; c=d" 字符串（direct 模式用）
   * @param {string} [opt.base]
   */
  constructor(opt = {}) {
    this.tab = opt.tab || null;
    this.base = opt.base || ERP_BASE;
    this.cookies = ErpClient.normalizeCookies(opt.cookies);
    this._loggedIn = null;
  }

  static get BASE() { return ERP_BASE; }

  static normalizeCookies(c) {
    if (!c) return null;
    if (typeof c === 'string') {
      const out = {};
      for (const part of c.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return Object.keys(out).length ? out : null;
    }
    if (typeof c === 'object') {
      const out = {};
      for (const k of Object.keys(c)) if (c[k] !== undefined && c[k] !== null) out[k] = String(c[k]);
      return Object.keys(out).length ? out : null;
    }
    return null;
  }

  get mode() { return this.cookies ? 'direct' : (this.tab ? 'page' : 'none'); }

  /** 打开/复用 erp 页面（page 模式用） */
  async ensureTab(openTab) {
    if (this.tab) return this.tab;
    this.tab = await openTab(this.base + '/');
    await this.tab.waitReady({ timeout: 45000, urlPrefix: this.base }).catch(() => {});
    return this.tab;
  }

  /** 从浏览器里把当前 cookie 抓出来（page 模式 → direct 模式迁移用） */
  async grabCookies() {
    if (!this.tab) throw new Error('没有绑定页面，无法读取 cookie');
    const raw = await this.tab.evaluate('JSON.stringify(document.cookie)');
    const docCookies = ErpClient.normalizeCookies(String(raw).replace(/^"|"$/g, '')) || {};
    // document.cookie 读不到 httpOnly（mserp_sst / autoLoginToken 就是），必须走 CDP
    let all = docCookies;
    try {
      const r = await this.tab.cdp.send('Network.getCookies', { urls: [this.base + '/'] }, this.tab.sessionId);
      const cookies = (r && r.cookies) || [];
      if (cookies.length) {
        all = {};
        for (const c of cookies) all[c.name] = c.value;
      }
    } catch (e) {}
    this.cookies = all;
    return all;
  }

  async _call(path, { method = 'POST', body, query, timeoutMs = 30000 } = {}) {
    // 绝对地址：about:blank 之类的文档 base URL 为 null，相对路径会直接抛 TypeError
    const url = /^https?:\/\//i.test(path) ? path : this.base + path;

    if (this.cookies) {
      // ---- direct 模式：Node 侧带 Cookie 头 ----
      let full = url;
      if (query) {
        const qs = new URLSearchParams();
        for (const k of Object.keys(query)) {
          const v = query[k];
          if (v !== undefined && v !== null) qs.set(k, String(v));
        }
        const s = qs.toString();
        if (s) full += (full.indexOf('?') >= 0 ? '&' : '?') + s;
      }
      const headers = {
        Accept: 'application/json, text/plain, */*',
        Cookie: Object.keys(this.cookies).map(k => k + '=' + this.cookies[k]).join('; '),
        Origin: this.base,
        Referer: this.base + '/',
        'User-Agent': UA,
      };
      const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
      if (method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        init.body = qsStringify(body === undefined ? {} : body);
      }
      let r, text;
      try {
        r = await fetch(full, init);
        text = await r.text();
      } catch (e) {
        throw new Error('ERP 请求失败 ' + path + ': ' + ((e && e.message) || e));
      }
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      if (!r.ok && !json) throw new Error('ERP 请求失败 ' + path + ' HTTP ' + r.status);
      return { status: r.status, json, text: json ? undefined : String(text).slice(0, 2000) };
    }

    // ---- page 模式 ----
    if (!this.tab) throw new Error('ErpClient 既没有 cookie 也没有绑定页面');
    const payload = JSON.stringify({ url, method, body, query });
    const raw = await this.tab.evaluate('(' + pageFetch.toString() + ')(' + payload + ')', {
      awaitPromise: true, timeoutMs,
    });
    let res;
    try { res = JSON.parse(raw); } catch (e) { throw new Error('ERP 响应无法解析: ' + String(raw).slice(0, 300)); }
    if (!res.ok && res.status !== 200) {
      throw new Error('ERP 请求失败 ' + path + ' HTTP ' + res.status + (res.error ? ' ' + res.error : ''));
    }
    return { status: res.status, json: res.json, text: res.text };
  }

  /** 通用请求：返回 json 或抛错 */
  async request(path, opt = {}) {
    const { status, json, text } = await this._call(path, opt);
    if (!json) throw new Error('ERP 返回非 JSON (' + path + ', HTTP ' + status + '): ' + String(text || '').slice(0, 200));
    return json;
  }

  /** 检查登录态。返回 {loggedIn, shopInfo, raw} */
  async checkLogin() {
    const json = await this.request('/api/open/niu/check_login', { method: 'POST', body: {} });
    this._loggedIn = json.result === 'success';
    return { loggedIn: this._loggedIn, shopInfo: json.shopInfo || null, raw: json };
  }

  /** 账号版本（isFreeAccount 决定采集额度） */
  async getAccountVersionInfo() {
    return this.request('/api/open/niu/getAccountVersionInfo', { method: 'POST', body: {} });
  }

  /** 插件配置（含 autoCollectConfig / buildSourceUrlRules） */
  async getPluginConfig() {
    return this.request('/api/open/plugin/getPluginConfig', { method: 'GET' });
  }

  /** 采集箱设置 */
  async getCollectBoxSetting() {
    return this.request('/api/open/niu/getCollectBoxSetting', { method: 'GET' });
  }

  /** TikTok 店铺授权状态 */
  async checkTiktokShopAuth(params = {}) {
    return this.request('/api/open/niu/checkTiktokShopAuth', { method: 'GET', query: params });
  }

  /** 批量查询这些商品是否已在采集箱里采过 */
  async batchCheckHasFetch(sourceInfoList) {
    const json = await this.request('/api/open/niu/batch_check_item_has_fetch', {
      method: 'POST', body: { sourceInfoList },
    });
    return json.sourceInfoList || [];
  }

  /**
   * 提交采集任务 —— 「组合工具」的核心动作。
   *
   * 【关键格式 · 实测】
   * itemSimpleDetails 必须是 **以 itemId 为 key 的对象 map**，不是数组：
   *   {"1732569460347606004":{"itemUrl":"...","itemId":"...","site":"US","source":"tiktok","postFee":""}}
   * 传数组虽然也返回 {"result":"success"}，但服务端拿不到 itemId，采集箱里会落成
   *   sourceItemId="0"、title=null、status=processing 的空任务。
   * 传对象 map 才会落成真实 sourceItemId + 解析出的 title。
   *
   * 该格式来自对实际请求的观察：
   *   isAutoPublish=0&itemSimpleDetails={"<itemId>":{itemUrl,itemId,site,source,postFee}}
   */
  async pushCollectBox(sourceInfoList, opt = {}) {
    const seen = new Set();
    const map = {};
    let count = 0;
    for (const it of sourceInfoList) {
      const key = it.itemId || it.itemUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      map[key] = it;
      count += 1;
    }
    if (!count) throw new Error('没有可提交的商品（sourceInfoList 为空）');

    const body = {
      isAutoPublish: opt.isAutoPublish || 0,
      itemSimpleDetails: JSON.stringify(map),
    };
    try {
      const json = await this.request('/api/open/niu/push_collect_box', { method: 'POST', body });
      if (json.result === 'success' || json.success === true) return { ok: true, raw: json, count };
      return { ok: false, raw: json, count };
    } catch (e) {
      if (e.erp) return { ok: false, raw: e.erp, count };
      throw e;
    }
  }

  /**
   * 读采集箱列表。
   * 注意：这个接口不在 /api/open/** 下，而是 ERP 网页自用的
   *   POST /api/move/common_collect_box/searchDetailList  (form-urlencoded: pageNo/pageSize)
   * 返回 {result:'success', detailList:[...], total:N}
   */
  async getCollectBoxList(opt = {}) {
    const json = await this.request('/api/move/common_collect_box/searchDetailList', {
      method: 'POST',
      body: { pageNo: opt.pageNo || 1, pageSize: opt.pageSize || 20 },
    });
    return {
      total: json.total || 0,
      list: (json.detailList || []).map(d => ({
        id: d.id,
        itemId: d.sourceItemId,
        itemUrl: d.sourceItemUrl,
        title: d.title,
        status: d.status,
        source: d.source,
        createTime: d.createTime,
      })),
      raw: json,
    };
  }

  /** 快速采集（单条） */
  async createCollectBoxFastItem(payload) {
    return this.request('/api/open/niu/createCollectBoxFastItem', { method: 'POST', body: payload });
  }

  /** 把 ERP 的错误码翻译成人话 */
  static explainError(raw) {
    if (!raw) return '未知错误';
    const code = raw.code || '';
    if (code === 'userNoLogin' || (raw.result === 'fail' && /登录/.test(raw.reason || ''))) {
      return 'ERP 未登录 / cookie 已失效：请重新从浏览器复制 cookie（--cookie 或 --cookie-file）';
    }
    if (code === 'notAuthResellerAccount') {
      return '当前店铺未授权 ERP（notAuthResellerAccount）' + (raw.redirectUrl ? '，授权地址：' + raw.redirectUrl : '');
    }
    if (raw.type === 'collectNumUnpaid') {
      return '采集额度不足：免费账号上限 ' + raw.freeNum + '，剩余 ' + raw.balanceNum +
        (raw.accountPaymentUrl ? '，升级：' + raw.accountPaymentUrl : '');
    }
    if (code === 'platformCollectBoxNumOverLimit') {
      return '采集箱数量超限（platformCollectBoxNumOverLimit），请先清理采集箱';
    }
    return raw.reason || raw.message || JSON.stringify(raw).slice(0, 300);
  }
}

module.exports = { ErpClient, ERP_BASE, ERP_ORIGIN, qsStringify };
