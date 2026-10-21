#!/usr/bin/env node
'use strict';
/**
 * tkpipe —— TikTok 采集 → 跨境ERP 采集箱 命令行。
 *
 * 用法：
 *   node src/cli.js check                    检查 ERP 登录态（不需要浏览器）
 *   node src/cli.js collect <url...>         采集（列表/详情自动判断），导出 CSV
 *   node src/cli.js collect --mode shop <店铺URL...>      店铺全店采集（商品列表 + 商家信息）
 *   node src/cli.js keyword <关键词...>                   关键词搜索采集
 *   node src/cli.js collect --mode detail <详情URL...>    商品详情（18 字段）
 *   node src/cli.js push <url...>            采集 + 直接推送到 ERP 采集箱
 *   node src/cli.js collect --mode category <类目URL...>  类目采集
 *   node src/cli.js cats                     列出全部类目（一级 + 二级，带 ID）
 *   node src/cli.js cats --level 1           只看一级类目
 *   node src/cli.js cats --search 女装        按名字搜类目
 *   node src/cli.js collect --mode category 839944 --pages 3   按类目 ID 采集，翻 3 次
 *   node src/cli.js push --file out.json     用已有 JSON 推送
 *   node src/cli.js login                    打开浏览器登录 ERP 并提取 cookie
 *   node src/cli.js doctor                   环境自检
 *
 * 常用参数：
 *   --cookie "a=b; c=d"          直接给 cookie 字符串
 *   --cookie-file <path>         从 JSON 文件读 cookie（默认自动找 ./cookies.json）
 *   --mode list|detail|auto|shop|category  采集模式（默认 auto；keyword 命令隐含 keyword 模式）
 *   --site us                    站点（关键词/类目用，默认 us）
 *   --pages N                    列表最多翻几页 / 类目页最多点几次「View more」（默认 1）
 *   --with-detail                列表里每条再抓详情
 *   --where "条件表达式"          任意过滤条件，见下方「条件表达式」小节
 *   --sales-min N --sales-max N  启用销量区间过滤（解析不出销量的商品会被跳过）
 *   --price-min N --price-max N  启用价格区间过滤
 *   --brand-filter               过滤有品牌商品（仅详情模式生效）
 *
 * 条件表达式（--where，比 --sales-min 等更自由，两者可同时用）：
 *   --where "销量 100-1000"                       销量区间
 *   --where "销量 between 100 and 1000"           同上，显式写法
 *   --where "销量 >= 100 and 价格 < 20"           组合
 *   --where "价格 < 20 or 评分 >= 4.8"            或
 *   --where "标题 ~ hoodie"                       标题包含（不区分大小写）
 *   --where "标题 !~ case"                        不包含
 *   --where "品牌 = 无"                           无品牌商品
 *   --where "not (品牌 = GAP)"                    取反
 *   --where "(价格 < 20 or 评分 >= 4.8) and 销量 > 500"   括号分组
 *
 *   可用字段：销量 / 价格 / 划线价 / 评分 / 评论数 / 粉丝数 / 已售出 / 视频数 /
 *             标题 / 店铺 / 品牌 / 链接 / 类目 / 运费 / 关键词 / itemId / 站点 / 描述
 *   运算符：= != > >= < <= ~（包含） !~（不包含） between A and B  区间 A-B / A~B / A至B
 *   数值支持 1.2K / 3M / 1,234+ / $27.00 这类写法；裸数字按 >= 处理（销量 100 == 销量 >= 100）
 *   --slider manual|auto         滑块模式（默认 manual）
 *   --chaojiying user:pass:softid  超级鹰账号（auto 模式用）
 *   --out <dir>                  输出目录（默认 ./output）
 *   --json                       额外导出 JSON
 *   --no-push                    只采集不推送
 *   --keep                       结束后不关浏览器
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pipeline } = require('./pipeline');
const { log } = require('./util');
const { ErpClient } = require('./erp');
const { findChrome } = require('./chrome');
const where = require('./where');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

function usage() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) console.log(m[1].replace(/^\s*\* ?/gm, ''));
}

/** 读 --where 条件串（同时校验语法，写错立刻报错而不是静默 0 条） */
function buildWhere(flags) {
  const raw = flags.where;
  if (raw === undefined || raw === true) return null;
  const str = String(raw).trim();
  if (!str) return null;
  try {
    where.parseWhere(str);
  } catch (e) {
    console.error('条件表达式有误: ' + e.message);
    process.exit(2);
  }
  return str;
}

/** 从 flags 里拼过滤配置；没给任何过滤参数则返回 null */
function buildFilters(flags) {
  const hasSales = flags['sales-min'] !== undefined || flags['sales-max'] !== undefined;
  const hasPrice = flags['price-min'] !== undefined || flags['price-max'] !== undefined;
  if (!hasSales && !hasPrice && !flags['brand-filter']) return null;
  return {
    sales: {
      enabled: hasSales,
      min: parseInt(String(flags['sales-min'] || '0'), 10),
      max: parseInt(String(flags['sales-max'] || '999999'), 10),
    },
    price: {
      enabled: hasPrice,
      min: parseFloat(String(flags['price-min'] || '0')),
      max: parseFloat(String(flags['price-max'] || '99999.99')),
    },
    brandFilter: !!flags['brand-filter'],
  };
}

function buildSliderCfg(flags) {
  const mode = flags.slider || 'manual';
  const cfg = { mode: mode, manualTimeout: 180000 };
  if (flags.chaojiying) {
    const parts = String(flags.chaojiying).split(':');
    cfg.chaojiying = { user: parts[0], pass: parts[1], softid: parts[2] };
  }
  return cfg;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const flags = args.flags;
  const urls = args._.slice(1).filter(u => /^https?:\/\//.test(u));

  if (!cmd || flags.help || cmd === 'help') { usage(); return 0; }

  const pipe = new Pipeline({
    outDir: flags.out ? path.resolve(String(flags.out)) : path.resolve('output'),
    headless: false,
    slider: buildSliderCfg(flags),
    chromePath: flags.chrome,
    cookies: flags.cookie,
    cookieFile: flags['cookie-file'],
    onEvent: (e) => {
      if (e.type === 'needLogin') log('warn', '需要登录 ERP: ' + e.url);
    },
  });

  try {
    // cats：列出类目树（一级 + 二级），可 --level / --search 过滤，可 --json 输出
    if (cmd === 'cats' || cmd === 'categories') {
      const site = flags.site || 'us';
      log('info', '抓类目树（站点 ' + site + '）…');
      const cats = await pipe.getCollector().collectCategories(site, {});
      const level = flags.level ? parseInt(String(flags.level), 10) : 0;
      const kw = flags.search ? String(flags.search).toLowerCase() : '';
      let list = cats;
      if (level) list = list.filter(c => c.level === level);
      if (kw) list = list.filter(c => c.name.toLowerCase().includes(kw));

      if (flags.json) {
        const file = pipe.exportJson(list, 'categories-' + site + '.json');
        console.log(JSON.stringify({ total: cats.length, filtered: list.length, file }, null, 2));
        return 0;
      }
      // 按层级打印：一级下面缩进二级
      const tops = list.filter(c => c.level === 1 || !c.parentId);
      const childrenOf = (id) => list.filter(c => c.parentId === id);
      let shown = 0;
      for (const t of tops) {
        const kids = childrenOf(t.categoryId);
        console.log(t.categoryId.padEnd(9) + t.name);
        shown++;
        for (const k of kids) { console.log('         └ ' + k.categoryId.padEnd(9) + k.name); shown++; }
      }
      console.log('');
      console.log('共 ' + cats.length + ' 个节点，' + cats.filter(c => c.level === 1).length + ' 个一级类目' +
        (level || kw ? '；本次筛选出 ' + shown + ' 个' : ''));
      return 0;
    }

    if (cmd === 'doctor') {
      const c = findChrome();
      console.log('Chrome: ' + (c || '未找到'));
      const ck = pipe.resolveCookies();
      console.log('Cookie: ' + (ck ? Object.keys(ck).join(', ') : '未找到'));
      if (ck) {
        const erp = await pipe.getErp();
        const r = await erp.checkLogin();
        console.log('ERP 登录: ' + (r.loggedIn ? '是（店铺 ' + ((r.shopInfo && r.shopInfo.shopName) || '?') + '）' : '否'));
      }
      return 0;
    }

    if (cmd === 'login') {
      await pipe.getErp();
      log('info', '浏览器已打开 ERP，请登录。');
      const ok = await pipe.ensureErpLogin({ timeout: 600000 });
      if (ok) {
        const erp = await pipe.getErp();
        const ck = erp.cookies || {};
        const file = path.resolve('cookies.json');
        fs.writeFileSync(file, JSON.stringify(ck, null, 2), 'utf8');
        log('ok', 'cookie 已保存到 ' + file);
      }
      return ok ? 0 : 1;
    }

    if (cmd === 'check') {
      const erp = await pipe.getErp();
      const r = await erp.checkLogin();
      console.log(JSON.stringify(r.raw, null, 2));
      if (r.loggedIn) {
        const v = await erp.getAccountVersionInfo().catch(() => null);
        console.log('账号: ' + JSON.stringify(v));
      }
      return r.loggedIn ? 0 : 1;
    }

    let items = [];

    if (cmd === 'push' && flags.file) {
      const raw = fs.readFileSync(path.resolve(String(flags.file)), 'utf8');
      items = JSON.parse(raw);
      log('info', '从 ' + flags.file + ' 读入 ' + items.length + ' 条');
    } else if (cmd === 'keyword') {
      // ② 关键词自动找同行/爆款：位置参数是关键词，不是 URL
      const words = args._.slice(1).filter(k => !/^--/.test(k));
      if (!words.length) { log('err', '请至少给一个关键词'); usage(); return 1; }
      items = await pipe.collect(words, {
        mode: 'keyword',
        site: flags.site || 'us',
        maxPages: parseInt(String(flags.pages || '1'), 10),
        filters: buildFilters(flags),
        where: buildWhere(flags),
      });
      log('ok', '关键词采集完成，共 ' + items.length + ' 条');
      const csv0 = pipe.exportCsv(items);
      if (flags.json) log('ok', 'JSON: ' + pipe.exportJson(items));
      console.log('CSV: ' + csv0);
    } else if (cmd === 'collect' || cmd === 'push') {
      const collectMode = flags.mode || 'auto';
      // category 模式除了 URL，也接受纯数字类目 ID（如 839944）
      const targets = collectMode === 'category'
        ? args._.slice(1).filter(s => /^https?:\/\//.test(s) || /^\d+$/.test(s))
        : urls;
      if (!targets.length) {
        const hint = collectMode === 'category'
          ? '请至少给一个类目 ID 或类目 URL（先用 node src/cli.js cats 查）'
          : '请至少给一个 URL';
        log('err', hint); usage(); return 1;
      }
      items = await pipe.collect(targets, {
        mode: collectMode,
        site: flags.site || 'us',
        maxPages: parseInt(String(flags.pages || '1'), 10),
        withDetail: !!flags['with-detail'],
        filters: buildFilters(flags),
        where: buildWhere(flags),
      });
      log('ok', '采集完成，共 ' + items.length + ' 条');
      const csv = pipe.exportCsv(items);
      if (flags.json) log('ok', 'JSON: ' + pipe.exportJson(items));
      console.log('CSV: ' + csv);
    } else {
      log('err', '未知命令: ' + cmd);
      usage();
      return 1;
    }

    if (cmd === 'push' && !flags['no-push']) {
      if (!items.length) { log('warn', '没有商品可推送'); return 0; }
      const ok = await pipe.ensureErpLogin({ timeout: 300000 });
      if (!ok) { log('err', 'ERP 未登录，无法推送'); return 1; }
      const r = await pipe.pushToErp(items, { batchSize: parseInt(String(flags.batch || '50'), 10) });
      console.log('\n=== 推送结果 ===');
      console.log('总计: ' + r.total + '  成功: ' + r.pushed + '  失败: ' + r.failed);
      for (const d of r.details) console.log(' - ' + d.reason);
      return r.failed === 0 ? 0 : 2;
    }

    return 0;
  } finally {
    if (!flags.keep) await pipe.stop();
    else log('info', '浏览器保持打开（--keep）');
  }
}

main().then(code => {
  if (!process.argv.includes('--keep')) process.exit(code);
}).catch(e => {
  console.error('FATAL', (e && e.stack) || e);
  process.exit(1);
});
