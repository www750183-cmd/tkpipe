#!/usr/bin/env node
'use strict';
/**
 * 本地 Web UI —— tkpipe 的图形界面。
 *
 *   node src/server.js [--port 7788] [--cookie-file cookies.json]
 *
 * 打开 http://127.0.0.1:7788 即可：
 *   1. 检查 ERP 登录态
 *   2. 填 TikTok 列表页/详情页 URL，一键采集
 *   3. 勾选要推送的商品，一键推到妙手 ERP 采集箱
 *   4. 查看采集箱最新条目，确认是否真的进去了
 *
 * 零依赖（只用 node 内置 http），页面在 public/index.html。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pipeline } = require('./pipeline');
const { log } = require('./util');
const where = require('./where');

const PUBLIC = path.join(__dirname, '..', 'public');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(String(args.port || '7788'), 10);

/** 全局流水线实例（浏览器常驻，避免每次操作重启 Chrome） */
const pipe = new Pipeline({
  outDir: path.resolve('output'),
  headless: false,
  slider: { mode: 'manual', manualTimeout: 180000 },
  cookieFile: args['cookie-file'],
  onEvent: (e) => { sseBroadcast(e); },
});

/* ---------------- SSE：把进度实时推到页面 ---------------- */
const sseClients = new Set();
function sseBroadcast(evt) {
  const data = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch (e) { sseClients.delete(res); }
  }
}

/* ---------------- 工具 ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, urlPath) {
  // 1) ERP 登录态
  if (urlPath === '/api/check') {
    const erp = await pipe.getErp();
    const r = await erp.checkLogin();
    let account = null;
    if (r.loggedIn) account = await erp.getAccountVersionInfo().catch(() => null);
    return sendJson(res, 200, {
      ok: r.loggedIn,
      mode: erp.mode,
      shopInfo: r.shopInfo,
      account: account,
      raw: r.raw,
    });
  }

  // 2) 采集
  if (urlPath === '/api/collect') {
    const body = await readBody(req);
    const mode = body.mode || 'auto';
    // keyword 模式 urls 是关键词；category 模式可以是类目 URL 或纯类目 ID；其余必须是 URL
    let urls;
    if (mode === 'keyword') {
      urls = (body.urls || []).map(s => String(s).trim()).filter(Boolean);
    } else if (mode === 'category') {
      urls = (body.urls || []).map(s => String(s).trim()).filter(s => /^https?:\/\//.test(s) || /^\d+$/.test(s));
    } else {
      urls = (body.urls || []).filter(u => /^https?:\/\//.test(u));
    }
    if (!urls.length) {
      const hint = mode === 'keyword' ? '请至少给一个关键词'
        : mode === 'category' ? '请至少选一个类目或给一个类目 URL'
        : '请至少给一个 http(s) URL';
      return sendJson(res, 400, { ok: false, error: hint });
    }
    // 条件表达式：语法错直接 400，避免静默返回 0 条
    let whereStr = null;
    if (body.where !== undefined && body.where !== null && String(body.where).trim()) {
      whereStr = String(body.where).trim();
      try { where.parseWhere(whereStr); }
      catch (e) { return sendJson(res, 400, { ok: false, error: '条件表达式有误: ' + e.message }); }
    }
    const items = await pipe.collect(urls, {
      mode: mode,
      site: body.site || 'us',
      maxPages: body.maxPages || 1,
      scrollRounds: body.scrollRounds || 5,
      withDetail: !!body.withDetail,
      filters: body.filters || null,
      where: whereStr,
    });
    let csv = null;
    try { csv = pipe.exportCsv(items); } catch (e) {}
    return sendJson(res, 200, { ok: true, count: items.length, items, csv });
  }

  // 2.5) 类目树（给 UI 的下拉/级联用）
  if (urlPath === '/api/categories') {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const site = body.site || 'us';
    const collector = pipe.getCollector();
    const cats = await collector.collectCategories(site, {});
    // 组装成两级树
    const tops = cats.filter(c => c.level === 1 || !c.parentId);
    const tree = tops.map(t => ({
      id: t.categoryId,
      name: t.name,
      children: cats.filter(c => c.parentId === t.categoryId).map(c => ({ id: c.categoryId, name: c.name })),
    }));
    return sendJson(res, 200, { ok: true, site, total: cats.length, count: tree.length, tree });
  }

  // 3) 推送
  if (urlPath === '/api/push') {
    const body = await readBody(req);
    const items = body.items || [];
    if (!items.length) return sendJson(res, 400, { ok: false, error: '没有要推送的商品' });
    const login = await pipe.getErp().then(e => e.checkLogin());
    if (!login.loggedIn) return sendJson(res, 401, { ok: false, error: 'ERP 未登录，请先填 cookie', raw: login.raw });
    const r = await pipe.pushToErp(items, { batchSize: body.batchSize || 50 });
    return sendJson(res, 200, { ok: r.failed === 0, ...r });
  }

  // 4) 采集箱列表
  if (urlPath === '/api/box') {
    const body = await readBody(req);
    const erp = await pipe.getErp();
    const r = await erp.getCollectBoxList({ pageNo: body.pageNo || 1, pageSize: body.pageSize || 20 });
    return sendJson(res, 200, { ok: true, ...r });
  }

  // 5) 采集箱单条详情（确认标题/图片是否被服务端解析出来）
  if (urlPath === '/api/box-detail') {
    const body = await readBody(req);
    const erp = await pipe.getErp();
    const json = await erp.request('/api/move/common_collect_box/getDetail', {
      method: 'POST', body: { id: body.id },
    }).catch(e => ({ error: String(e.message) }));
    return sendJson(res, 200, { ok: true, raw: json });
  }

  // 6) 导出 CSV
  if (urlPath === '/api/export') {
    const body = await readBody(req);
    const file = pipe.exportCsv(body.items || []);
    return sendJson(res, 200, { ok: true, file });
  }

  return sendJson(res, 404, { ok: false, error: '未知接口 ' + urlPath });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // SSE
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (p.startsWith('/api/')) {
    try {
      return await handleApi(req, res, p);
    } catch (e) {
      log('err', p + ' → ' + (e && e.message));
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }

  // 静态文件
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + p); }
    const ext = path.extname(full).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  tkpipe Web UI 已启动');
  console.log('  →  http://127.0.0.1:' + PORT);
  console.log('');
  const ck = pipe.resolveCookies();
  console.log('  ERP cookie: ' + (ck ? Object.keys(ck).join(', ') : '未找到（请把 cookies.json 放到项目根目录）'));
  console.log('');
});

async function shutdown() {
  console.log('\n正在关闭…');
  try { await pipe.stop(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
