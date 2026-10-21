'use strict';
/**
 * Chrome 发现 + 启动 + 连接。
 * 用独立 user-data-dir（登录态会持久化在该目录里），
 * --remote-debugging-port=0 让 Chrome 自己挑端口，再从 DevToolsActivePort 读回来。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CDP } = require('./cdp');

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function findChrome() {
  const PF = process.env.ProgramFiles || process.env.PROGRAMFILES || 'C:\\Program Files';
  const PF86 = process.env['ProgramFiles(x86)'] || process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const LOCAL = process.env.LOCALAPPDATA || '';
  return firstExisting([
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    LOCAL ? path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 启动一个受控 Chrome。
 * @param {object} opt
 * @param {string} [opt.userDataDir] 独立 profile 目录（默认 <workspace>/.chrome-profile）
 * @param {boolean} [opt.headless]   不建议开，TikTok 会识别
 * @param {number} [opt.windowWidth]
 * @param {number} [opt.windowHeight]
 */
async function launchChrome(opt = {}) {
  const exe = opt.chromePath || findChrome();
  if (!exe) throw new Error('没找到 Chrome/Edge，请用 chromePath 指定 chrome.exe 路径');

  const userDataDir = opt.userDataDir || path.resolve(process.cwd(), '.chrome-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const disabledFeatures = [];
  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-popup-blocking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=' + (opt.windowWidth || 1440) + ',' + (opt.windowHeight || 960),
    '--lang=en-US',
  ];
  // 加载未打包扩展（ERP 助手需要扩展上下文才能当 plugin client 用）
  const extDirs = (opt.extensions || []).filter(Boolean);
  if (extDirs.length) {
    const abs = extDirs.map(d => path.resolve(d));
    for (const d of abs) {
      if (!fs.existsSync(path.join(d, 'manifest.json'))) {
        throw new Error('扩展目录里没有 manifest.json: ' + d);
      }
    }
    args.push('--load-extension=' + abs.join(','));
    args.push('--disable-extensions-except=' + abs.join(','));
    // Chrome 137+ 默认封禁 --load-extension，必须显式关掉这个 feature 才能加载未打包扩展
    disabledFeatures.push('DisableLoadExtensionCommandLineSwitch');
  }
  args.push('about:blank');
  if (disabledFeatures.length) args.push('--disable-features=' + disabledFeatures.join(','));
  if (opt.headless) args.unshift('--headless=new');

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  // 关键：DevToolsActivePort 会从上一次运行残留下来。
  // 不先删掉的话会立刻读到旧端口，然后去连一个已经不存在的调试端点。
  try { fs.rmSync(portFile, { force: true }); } catch {}

  const proc = spawn(exe, args, { detached: false, stdio: 'ignore', windowsHide: false });

  let port = null;
  const deadline = Date.now() + (opt.timeoutMs || 40000);
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(portFile, 'utf8').trim();
      if (raw) {
        const first = raw.split(/\r?\n/)[0].trim();
        const n = parseInt(first, 10);
        if (Number.isInteger(n) && n > 0) { port = n; break; }
      }
    } catch {}
    await sleep(200);
  }
  if (!port) {
    try { proc.kill(); } catch {}
    throw new Error('Chrome 启动后没读到调试端口（' + portFile + '），可能被已有实例复用或权限受限');
  }

  const versionUrl = 'http://127.0.0.1:' + port + '/json/version';
  let version = null;
  const vDeadline = Date.now() + 20000;
  while (Date.now() < vDeadline) {
    try {
      const r = await fetch(versionUrl);
      if (r.ok) { version = await r.json(); break; }
    } catch {}
    if (proc.exitCode !== null) break;   // Chrome 自己退了，没必要再等
    await sleep(200);
  }
  if (!version) {
    try { proc.kill(); } catch {}
    throw new Error('Chrome 调试端点无响应: ' + versionUrl +
      '（常见原因：同一 user-data-dir 已有 Chrome 在跑，新进程被复用了）');
  }

  return {
    proc,
    port,
    userDataDir,
    exe,
    version,
    browserWsUrl: version.webSocketDebuggerUrl,
    async connect() {
      const cdp = new CDP(version.webSocketDebuggerUrl);
      await cdp.connect();
      return cdp;
    },
    close() {
      try { proc.kill(); } catch {}
    },
  };
}

module.exports = { findChrome, launchChrome, sleep };