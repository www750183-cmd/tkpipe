'use strict';
/**
 * Tab —— 对一个 CDP 页面 target 的封装。
 * 负责：导航、JS 求值、元素等待/点击、截图、鼠标拖拽、网络响应监听。
 */
const { sleep, waitFor } = require('./util');

class Tab {
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this._netHandlers = [];
    this._enabled = new Set();
    this._netEnabled = false;
  }

  static async create(cdp, url = 'about:blank') {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId);
    await tab.enable('Page');
    await tab.enable('Runtime');
    // 关键：带 url 时必须等真正导航到该 url 之后再返回。
    // 否则 about:blank 的 readyState 立刻是 complete，调用方会在空白页里 evaluate，
    // 相对 URL 无法解析（fetch 报 Failed to parse URL）。
    if (url && url !== 'about:blank') {
      await tab.waitForUrl(url, { timeout: 60000 }).catch(() => {});
      await tab.waitReady({ timeout: 60000 }).catch(() => {});
    }
    return tab;
  }

  static async attachExisting(cdp, targetId) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId);
    await tab.enable('Page');
    await tab.enable('Runtime');
    return tab;
  }

  async enable(domain) {
    if (this._enabled.has(domain)) return;
    await this.cdp.send(domain + '.enable', {}, this.sessionId);
    this._enabled.add(domain);
  }

  async evaluate(expression, opt = {}) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: !!opt.awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true,
    }, this.sessionId, opt.timeoutMs || 30000);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'JS 异常';
      throw new Error('页面 JS 异常: ' + String(msg).slice(0, 400));
    }
    return r.result && r.result.value;
  }

  /** 求值并返回 JSON 对象（页面里 return JSON.stringify(...) 也行，这里自动兜底） */
  async evalJson(expression, opt) {
    const v = await this.evaluate(expression, opt);
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }

  async goto(url, opt = {}) {
    await this.enable('Page');
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await this.waitForUrl(url, { timeout: opt.timeout || 60000 }).catch(() => {});
    await this.waitReady({ ...opt, urlPrefix: url });
    return this;
  }

  async url() {
    const r = await this.evaluate('location.href');
    return r;
  }

  async title() {
    return this.evaluate('document.title');
  }

  /**
   * 等待页面加载完成。
   * urlPrefix 存在时还要求 location.href 以它开头（防止在 about:blank / 跳转中间态上提前返回）。
   */
  async waitReady({ timeout = 30000, interval = 250, urlPrefix } = {}) {
    const prefix = urlPrefix ? String(urlPrefix).replace(/\/+$/, '') : null;
    await waitFor(async () => {
      const r = await this.evaluate('JSON.stringify({s:document.readyState,h:location.href})');
      let st;
      try { st = JSON.parse(r); } catch { return null; }
      if (st.s !== 'complete' && st.s !== 'interactive') return null;
      if (prefix && !String(st.h || '').startsWith(prefix)) return null;
      return true;
    }, { timeout, interval, label: '页面加载' + (prefix ? ' @ ' + prefix : '') });
    return this;
  }

  /** 等待 location.href 以 prefix 开头（用于确认已经离开 about:blank） */
  async waitForUrl(prefix, { timeout = 60000, interval = 200 } = {}) {
    const p = String(prefix).replace(/\/+$/, '');
    await waitFor(async () => {
      let h = '';
      try { h = await this.evaluate('location.href'); } catch { return null; }
      if (!h || h === 'about:blank') return null;
      return String(h).startsWith(p) ? true : null;
    }, { timeout, interval, label: '导航到 ' + p });
    return this;
  }

  /** 轮询直到 selector 出现，返回元素文本（可选） */
  async waitSelector(selector, { timeout = 20000, interval = 250 } = {}) {
    const lit = JSON.stringify(selector);
    return waitFor(async () => {
      const found = await this.evaluate('!!document.querySelector(' + lit + ')');
      return found ? true : null;
    }, { timeout, interval, label: '元素 ' + selector });
  }

  async exists(selector) {
    const lit = JSON.stringify(selector);
    return !!(await this.evaluate('!!document.querySelector(' + lit + ')'));
  }

  async textOf(selector) {
    const lit = JSON.stringify(selector);
    return this.evaluate('(function(){var e=document.querySelector(' + lit + ');return e?e.innerText:null;})()');
  }

  async click(selector) {
    const lit = JSON.stringify(selector);
    return this.evaluate('(function(){var e=document.querySelector(' + lit + ');if(!e)return false;e.click();return true;})()');
  }

  /** 在元素上派发真实鼠标事件（比 .click() 更接近人手，部分站点需要） */
  async clickReal(selector) {
    const box = await this.evaluate(
      '(function(){var e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return null;' +
      'var r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()'
    );
    if (!box) return false;
    const p = JSON.parse(box);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type, x: p.x, y: p.y, button: 'left', clickCount: 1,
      }, this.sessionId);
    }
    return true;
  }

  async screenshot(filePath) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    require('node:fs').writeFileSync(filePath, Buffer.from(r.data, 'base64'));
    return filePath;
  }

  /** 元素截图（用于超级鹰识别缺口） */
  async elementScreenshot(selector, filePath) {
    const lit = JSON.stringify(selector);
    const rectJson = await this.evaluate(
      '(function(){var e=document.querySelector(' + lit + ');if(!e)return null;var r=e.getBoundingClientRect();' +
      'return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height});})()'
    );
    if (!rectJson) throw new Error('元素不存在，无法截图: ' + selector);
    const rect = JSON.parse(rectJson);
    const r = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
    }, this.sessionId);
    require('node:fs').writeFileSync(filePath, Buffer.from(r.data, 'base64'));
    return { path: filePath, width: rect.width, height: rect.height };
  }

  /** 真实鼠标拖拽（滑块）。steps 越大越像人 */
  async mouseDrag(fromX, fromY, dx, dy = 0, steps = 12) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1 }, this.sessionId);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // 缓动：先快后慢，模拟人手
      const ease = 1 - Math.pow(1 - t, 2.2);
      const x = fromX + dx * ease;
      const y = fromY + dy * t;
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' }, this.sessionId);
      await sleep(8 + Math.random() * 14);
    }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fromX + dx, y: fromY + dy, button: 'left', clickCount: 1 }, this.sessionId);
  }

  async elementCenter(selector) {
    const lit = JSON.stringify(selector);
    const v = await this.evaluate(
      '(function(){var e=document.querySelector(' + lit + ');if(!e)return null;var r=e.getBoundingClientRect();' +
      'return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,left:r.x,top:r.y,width:r.width,height:r.height});})()'
    );
    return v ? JSON.parse(v) : null;
  }

  /** 打开网络响应监听。onResponse({url, status, body, requestId}) */
  async watchNetwork(onResponse, opt = {}) {
    await this.enable('Network');
    await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: false }, this.sessionId).catch(() => {});
    if (!this._netEnabled) {
      this.cdp.on('Network.responseReceived', (params, sessionId) => {
        if (sessionId !== this.sessionId) return;
        for (const h of this._netHandlers) h.onResponse(params);
      });
      this._netEnabled = true;
    }
    const handler = {
      onResponse: async (params) => {
        const url = params.response && params.response.url || '';
        if (opt.matchUrl && !opt.matchUrl.test(url)) return;
        try {
          const body = await this.cdp.send('Network.getResponseBody', { requestId: params.requestId }, this.sessionId, 15000);
          let text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          let json = null;
          try { json = JSON.parse(text); } catch {}
          await onResponse({ url, status: params.response.status, json, text, requestId: params.requestId });
        } catch {}
      },
    };
    this._netHandlers.push(handler);
    return () => {
      const i = this._netHandlers.indexOf(handler);
      if (i >= 0) this._netHandlers.splice(i, 1);
    };
  }

  /** 滚动到底，触发懒加载；返回滚动次数 */
  async autoScroll({ maxRounds = 30, idleRounds = 3, delay = 800 } = {}) {
    let idle = 0;
    let rounds = 0;
    let lastHeight = 0;
    while (rounds < maxRounds) {
      const h = await this.evaluate('document.body.scrollHeight');
      await this.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await sleep(delay);
      const h2 = await this.evaluate('document.body.scrollHeight');
      rounds++;
      if (h2 === lastHeight && h2 === h) {
        if (++idle >= idleRounds) break;
      } else { idle = 0; }
      lastHeight = h2;
    }
    return rounds;
  }

  async close() {
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch {}
  }
}

module.exports = { Tab };
