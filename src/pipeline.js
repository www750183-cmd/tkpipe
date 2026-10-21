'use strict';
/**
 * 组合流水线：TikTok 采集 → 跨境ERP 采集箱。
 *
 * 把两个软件合成一个：
  *   - 采集端负责：开浏览器、翻列表/详情、过滑块、抓字段、导 CSV
  *   - 推送端负责：把商品推进 ERP 的采集箱（push_collect_box）
 *
  * 早期做法是点页面里注入的 DOM 按钮、由扩展开关去发请求；本项目不采用。
 * 这里直接发同一个请求（跳过 DOM 按钮）。认证只靠 cookie，所以两种模式都支持：
 *   - direct：Node 侧带 Cookie 头直接发（默认，最省事，不用开浏览器）
 *   - page：在 ERP 页面上下文里发（cookie 缺失时先用浏览器登录一次）
 */
const fs = require('node:fs');
const path = require('node:path');
const { sleep, log } = require('./util');
const { launchChrome } = require('./chrome');
const { Tab } = require('./page');
const { TiktokCollector, getSourceInfoByItemUrl, matchItemId, isDetailUrl } = require('./tiktok');
const { ErpClient } = require('./erp');

const DEFAULT_CFG = {
  userDataDir: path.resolve(process.cwd(), '.chrome-profile'),
  headless: false,
  slider: { mode: 'manual', manualTimeout: 180000 },
  erpBase: 'https://erp.91miaoshou.com',
  outDir: path.resolve(process.cwd(), 'output'),
  cookies: null,       // {name:value} 或 "a=b; c=d"
  cookieFile: null,    // JSON 文件（浏览器导出格式或简单对象都行）
};

class Pipeline {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_CFG, ...cfg, slider: { ...DEFAULT_CFG.slider, ...(cfg.slider || {}) } };
    this.chrome = null;
    this.cdp = null;
    this.tabs = new Map();
    this.erp = null;
    this.collector = null;
    this.onEvent = cfg.onEvent || (() => {});
  }

  _emit(type, payload) {
    try { this.onEvent({ type: type, at: Date.now(), ...payload }); } catch (e) {}
  }

  /* ---------------- 浏览器（采集时才需要） ---------------- */

  /** 浏览器是否还活着（Chrome 退出或 CDP 断开都算死） */
  isBrowserAlive() {
    if (!this.chrome || !this.cdp) return false;
    if (this.cdp.closed) return false;
    try {
      if (this.chrome.proc && this.chrome.proc.exitCode !== null) return false;
    } catch (e) { return false; }
    return true;
  }

  /** 丢掉已经死掉的浏览器，并让采集器/ERP 重新绑定新页面 */
  resetBrowser(reason) {
    log('warn', '浏览器已失效（' + (reason || 'unknown') + '），重建中…');
    try { if (this.cdp) this.cdp.close(); } catch (e) {}
    try { if (this.chrome) this.chrome.close(); } catch (e) {}
    this.chrome = null;
    this.cdp = null;
    this.tabs.clear();
    // collector 缓存的 tab 属于旧浏览器，必须整个丢掉
    this.collector = null;
    // ERP 的 page 模式绑定在旧页面上；direct 模式（cookie）不受影响
    if (this.erp && this.erp.mode === 'page') this.erp = null;
  }

  async ensureBrowser() {
    if (this.isBrowserAlive()) return this;
    if (this.chrome) this.resetBrowser('ensureBrowser 检测到连接已关闭');
    log('info', '启动 Chrome…');
    this.chrome = await launchChrome({
      userDataDir: this.cfg.userDataDir,
      headless: this.cfg.headless,
      chromePath: this.cfg.chromePath,
      windowWidth: 1440,
      windowHeight: 960,
    });
    this.cdp = await this.chrome.connect();
    log('ok', 'Chrome 已连接 (端口 ' + this.chrome.port + ')');
    this._emit('browser', { port: this.chrome.port });
    return this;
  }

  /** 兼容旧调用名 */
  async start() { return this.ensureBrowser(); }

  async openTab(url) {
    await this.ensureBrowser();
    try {
      return await Tab.create(this.cdp, url || 'about:blank');
    } catch (e) {
      // 开页失败多半是浏览器刚挂：重建一次再试
      if (/CDP 连接已关闭|超时|closed|not.*connected/i.test(String(e && e.message))) {
        this.resetBrowser('新建标签页失败: ' + e.message);
        await this.ensureBrowser();
        return Tab.create(this.cdp, url || 'about:blank');
      }
      throw e;
    }
  }

  getCollector() {
    if (this.collector) return this.collector;
    this.collector = new TiktokCollector({
      openTab: (url) => this.openTab(url),
      slider: this.cfg.slider,
      onProgress: (msg) => { log('info', msg); this._emit('progress', { message: msg }); },
    });
    return this.collector;
  }

  /* ---------------- ERP ---------------- */

  /** 从 --cookie / --cookie-file / 环境变量 / 项目目录 cookies.json 里找 cookie */
  resolveCookies() {
    if (this.cfg.cookies) return ErpClient.normalizeCookies(this.cfg.cookies);
    const candidates = [
      this.cfg.cookieFile,
      process.env.MSERP_COOKIE,
      path.resolve(process.cwd(), 'cookies.json'),
      path.resolve(__dirname, '..', 'cookies.json'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (c === process.env.MSERP_COOKIE) {
          const n = ErpClient.normalizeCookies(c);
          if (n) return n;
          continue;
        }
        if (!fs.existsSync(c)) continue;
        const raw = fs.readFileSync(c, 'utf8');
        let data = JSON.parse(raw);
        // 兼容浏览器插件导出的 [{name,value}] 数组
        if (Array.isArray(data)) {
          const o = {};
          for (const it of data) if (it && it.name) o[it.name] = it.value;
          data = o;
        }
        const n = ErpClient.normalizeCookies(data);
        if (n && n.accountId) return n;
      } catch (e) { log('warn', '读取 cookie 文件失败 ' + c + ': ' + e.message); }
    }
    return null;
  }

  /** 拿 ERP 客户端：有 cookie 就直连，没有才开浏览器走页面模式 */
  async getErp(opt = {}) {
    if (this.erp) return this.erp;
    const cookies = this.resolveCookies();
    if (cookies) {
      this.erp = new ErpClient({ base: this.cfg.erpBase, cookies: cookies });
      log('ok', 'ERP 使用 cookie 直连模式（' + Object.keys(cookies).length + ' 个 cookie）');
      return this.erp;
    }
    log('warn', '没有 cookie，改用浏览器页面模式（需先在浏览器里登录 ERP）');
    const tab = await this.openTab(this.cfg.erpBase + '/');
    await tab.waitReady({ timeout: 45000, urlPrefix: this.cfg.erpBase }).catch(() => {});
    this.erp = new ErpClient({ tab: tab, base: this.cfg.erpBase });
    return this.erp;
  }

  /** 检查登录态；未登录时（页面模式）提示用户手动登录 */
  async ensureErpLogin(opt = {}) {
    const erp = await this.getErp();
    let r = await erp.checkLogin();
    if (r.loggedIn) { log('ok', 'ERP 已登录（店铺 ' + ((r.shopInfo && r.shopInfo.shopName) || '?') + '）'); return true; }
    if (erp.mode === 'direct') {
      log('err', 'cookie 无效或已过期：请重新从浏览器复制 cookie 到 cookies.json');
      return false;
    }

    log('warn', 'ERP 未登录 —— 请在打开的浏览器窗口里登录（最多等 ' + Math.round((opt.timeout || 300000) / 1000) + ' 秒）');
    this._emit('needLogin', { url: this.cfg.erpBase });
    if (opt.interactive === false) return false;

    const deadline = Date.now() + (opt.timeout || 300000);
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        r = await erp.checkLogin();
        if (r.loggedIn) {
          log('ok', 'ERP 登录成功');
          try { await erp.grabCookies(); log('ok', '已从浏览器提取 cookie，可写入 cookies.json 复用'); } catch (e) {}
          return true;
        }
      } catch (e) {}
    }
    log('err', '等待 ERP 登录超时');
    return false;
  }

  /* ---------------- 主流程 ---------------- */

  /**
   * 采集主流程。
   * mode:
   *   list     列表页 → 商品列表
   *   detail   详情页 → 单品全字段
   *   auto     按 URL 形态自动判断（默认）
   *   shop     店铺页 → 商品列表 + 商家信息
   *   keyword  关键词 → 搜索页列表（urls 里每项是一个关键词）
   *   category 类目页 → 商品列表
   * opt.filters = { sales:{enabled,min,max}, price:{enabled,min,max}, brandFilter }
   * opt.where   = 自定义条件表达式，如 "销量 100-1000" / "价格 < 20 and 评分 >= 4.5"
   */
  async collect(urls, opt = {}) {
    const collector = this.getCollector();
    const mode = opt.mode || 'auto';
    const filters = opt.filters || null;
    const whereStr = opt.where || null;
    const results = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const tag = '[' + (i + 1) + '/' + urls.length + ']';
      log('info', tag + ' ' + url);
      this._emit('linkStart', { url: url, index: i });

      try {
        if (mode === 'category') {
          // 每项可以是类目 URL，也可以是纯数字类目 ID（slug 随便写也能打开，实测有效）
          const catUrl = /^\d+$/.test(url)
            ? 'https://shop.tiktok.com/' + (opt.site || 'us') + '/c/c/' + url
            : url;
          const items = await collector.collectCategoryList(catUrl, { maxPages: opt.maxPages || 1, filters: filters, where: whereStr });
          for (const it of items) { it._kind = 'list'; results.push(it); this._emit('item', { item: it }); }
        } else if (mode === 'keyword') {
          const items = await collector.searchList(url, { maxPages: opt.maxPages || 1, scrollRounds: opt.scrollRounds, filters: filters, where: whereStr, site: opt.site });
          for (const it of items) { it._kind = 'list'; results.push(it); this._emit('item', { item: it }); }
        } else if (mode === 'shop') {
          const info = await collector.collectShopInfo(url, opt);
          this._emit('log', { message: '商家信息: ' + JSON.stringify(info) });
          const items = await collector.collectList(url, { maxPages: opt.maxPages || 1, scrollRounds: opt.scrollRounds, filters: filters, where: whereStr });
          for (const it of items) {
            it._kind = 'list';
            it['店铺名称'] = it['店铺名称'] || info.shopName || '';
            it['粉丝数'] = info.followers || '';
            it['已售出'] = info.sold || '';
            it['视频数'] = info.videos || '';
            it['商家星级'] = info.rating || '';
            it['店铺链接'] = it['店铺链接'] || url;
            results.push(it);
            this._emit('item', { item: it });
          }
        } else {
          const isDetail = mode === 'detail' || (mode === 'auto' && isDetailUrl(url));
          if (isDetail) {
            const rec = await collector.collectDetail(url, opt);
            if (rec._filtered) { log('info', tag + ' 详情被过滤: ' + rec._filterReason); continue; }
            rec._kind = 'detail';
            results.push(rec);
            this._emit('item', { item: rec });
          } else {
            const items = await collector.collectList(url, { maxPages: opt.maxPages || 1, scrollRounds: opt.scrollRounds, filters: filters, where: whereStr });
            for (const it of items) {
              it._kind = 'list';
              results.push(it);
              this._emit('item', { item: it });
            }
            if (opt.withDetail && items.length) {
              for (let j = 0; j < items.length; j++) {
                const d = await collector.collectDetail(items[j].url, opt);
                if (d._filtered) { log('info', '详情被过滤: ' + d._filterReason); await sleep(opt.detailInterval || 1500); continue; }
                Object.assign(items[j], d, { _kind: 'detail' });
                this._emit('item', { item: items[j] });
                await sleep(opt.detailInterval || 1500);
              }
            }
          }
        }
      } catch (e) {
        log('err', tag + ' 采集失败: ' + e.message);
        this._emit('error', { url: url, message: e.message });
      }
      await sleep(opt.interval || 1200);
    }
    return results;
  }

  /** 商品数组 → sourceInfoList（push_collect_box 入参） */
  static toSourceInfoList(items) {
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const url = it['商品链接'] || it['商品url'] || it.url || it.itemUrl;
      if (!url) continue;
      const si = it.sourceInfo || getSourceInfoByItemUrl(url);
      const itemId = si.itemId || it.itemId || matchItemId(url);
      const key = itemId || url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        itemUrl: url,
        itemId: itemId || '',
        site: si.site || it.site || '',
        source: si.source || it.source || 'tiktok',
        postFee: si.postFee || '',
      });
    }
    return out;
  }

  async pushToErp(items, opt = {}) {
    const erp = await this.getErp();
    const list = Pipeline.toSourceInfoList(items);
    if (!list.length) { log('warn', '没有可推送的商品'); return { pushed: 0, failed: 0, total: 0, details: [], sourceInfoList: [] }; }

    const batchSize = opt.batchSize || 50;
    let pushed = 0, failed = 0;
    const details = [];

    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      log('info', '推送第 ' + (Math.floor(i / batchSize) + 1) + ' 批，共 ' + batch.length + ' 条…');
      const r = await erp.pushCollectBox(batch, { isAutoPublish: opt.isAutoPublish || 0 });
      if (r.ok) {
        pushed += batch.length;
        log('ok', '本批成功 ' + batch.length + ' 条');
      } else {
        failed += batch.length;
        const why = ErpClient.explainError(r.raw);
        log('err', '本批失败: ' + why);
        details.push({ ok: false, reason: why, raw: r.raw, count: batch.length });
      }
      this._emit('push', { ok: r.ok, count: batch.length, raw: r.raw });
      await sleep(opt.interval || 800);
    }
    return { pushed: pushed, failed: failed, total: list.length, details: details, sourceInfoList: list };
  }

  /* ---------------- 导出 ---------------- */

  ensureOutDir() {
    const d = this.cfg.outDir;
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  exportCsv(items, filename) {
    const dir = this.ensureOutDir();
    const file = path.join(dir, filename || ('tiktok-' + Date.now() + '.csv'));
    const isDetail = items.some(it => it._kind === 'detail' || it['商品类目'] !== undefined);
    const fields = isDetail
      ? ['商品url', '商品标题', '商品类目', '运费', '价格', '评分', '评论', '销量', '品牌', '店铺链接', '店铺名称',
         '店铺等级', '店铺评分', '店铺总销', '店铺粉丝数', '24小时响应率', '2天内发货率', '好评率']
      : ['链接编号', '商品标题', '评分', '商品链接', '销售量', '运费', '价格', '划线价'];
    const esc = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [fields.join(',')];
    for (const it of items) {
      const row = isDetail
        ? fields.map(f => esc(it[f]))
        : [
            esc(it.linkNo || 1), esc(it.title), esc(it.score), esc(it.url), esc(it.saleCount),
            esc(it.carriage), esc(it.price), esc(it.deletePrice),
          ];
      lines.push(row.join(','));
    }
    fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
    log('ok', 'CSV 已导出: ' + file);
    return file;
  }

  exportJson(items, filename) {
    const dir = this.ensureOutDir();
    const file = path.join(dir, filename || ('tiktok-' + Date.now() + '.json'));
    fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
    return file;
  }

  async stop() {
    try { if (this.cdp) this.cdp.close(); } catch (e) {}
    try { if (this.chrome) this.chrome.close(); } catch (e) {}
    this.chrome = null; this.cdp = null;
  }
}

module.exports = { Pipeline, DEFAULT_CFG };
