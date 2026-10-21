'use strict';
/**
 * TikTok / 通用滑块验证处理。
 * 流程：检测滑块 → 截图验证码 → 打码取缺口距离 → 拖拽 → 复查。
 *
 * 两种模式：
 *   manual  —— 弹窗提示人工拖动（默认，最稳）
 *   chaojiying —— 调超级鹰打码（需 user/pass/softid）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sleep, waitFor, log } = require('./util');

/** 与 Python 版一致的 4 个判定条件 */
const SLIDER_SELECTORS = [
  '.sc-jWBwVP VHvDR',
  '.sc-gZMcBi jzVByM captcha_verify_img--wrapper',
  '.style__CaptchaWrapper-k9ey6s-0 ZZGhc captcha_verify_container',
];
const SLIDER_TEXT = 'Verify to continue:';
const CAPTCHA_IMG = '#captcha-verify-image';
const DRAG_ICON = '.sc-kEYyzF fiQtnm secsdk-captcha-drag-icon';

/** 页面里是否出现滑块验证 */
async function hasSliderVerify(tab) {
  const has = await tab.evaluate(
    '(function(){' +
    'var sels=' + JSON.stringify(SLIDER_SELECTORS) + ';' +
    'for (var i=0;i<sels.length;i++){ try{ if(document.querySelector(sels[i])) return true; }catch(e){} }' +
    'if (document.body && document.body.innerText.indexOf(' + JSON.stringify(SLIDER_TEXT) + ') >= 0) return true;' +
    'return false;' +
    '})()'
  );
  return !!has;
}

/** 等待滑块出现（可能一开始就有，也可能跳转后才出现） */
async function waitSliderAppear(tab, { timeout = 6000, interval = 400 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await hasSliderVerify(tab)) return true;
    await sleep(interval);
  }
  return false;
}

/** 等待滑块消失 */
async function waitSliderGone(tab, { timeout = 120000, interval = 700 } = {}) {
  return waitFor(async () => (await hasSliderVerify(tab)) ? null : true,
    { timeout, interval, label: '滑块消失' });
}

/** 超级鹰打码：返回缺口距离(px) */
async function solveByChaojiying(tab, cfg, opt = {}) {
  const { user, pass, softid, codetype = 9900 } = cfg;
  if (!user || !pass) throw new Error('超级鹰账号未配置');

  const tmpDir = opt.tmpDir || path.resolve(process.cwd(), '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const shotPath = path.join(tmpDir, 'captcha-' + Date.now() + '.png');

  const shot = await tab.elementScreenshot(CAPTCHA_IMG, shotPath);
  log('info', '验证码截图: ' + shotPath + ' (' + Math.round(shot.width) + 'x' + Math.round(shot.height) + ')');

  const buf = fs.readFileSync(shotPath);
  const boundary = '----tkpipe' + crypto.randomBytes(8).toString('hex');
  const pass2 = crypto.createHash('md5').update(String(pass)).digest('hex');
  const parts = [];
  const field = (name, value) => {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  };
  field('user', user);
  field('pass2', pass2);
  field('softid', String(softid || ''));
  field('codetype', String(codetype));
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="userfile"; filename="ccc.jpg"\r\nContent-Type: image/png\r\n\r\n'));
  parts.push(buf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);

  const r = await fetch('http://upload.chaojiying.net/Upload/Processing.php', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': String(body.length) },
    body,
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('超级鹰返回非 JSON: ' + r.status);
  if (j.err_no !== 0) throw new Error('超级鹰识别失败: err_no=' + j.err_no + ' ' + (j.err_str || ''));

  const picStr = String(j.pic_str || '');
  const pts = picStr.split('|').map(s => s.split(',').map(Number)).filter(a => a.length >= 2 && isFinite(a[0]));
  if (pts.length < 2) throw new Error('超级鹰返回坐标异常: ' + picStr);
  const distance = Math.abs(pts[0][0] - pts[1][0]);
  log('info', '超级鹰识别: ' + picStr + ' → 距离 ' + distance + 'px');
  return distance;
}

/**
 * 过滑块。
 * @returns {Promise<'solved'|'manual'|'timeout'>}
 */
async function handleSlider(tab, opt = {}) {
  const mode = opt.mode || 'manual';
  const maxRounds = opt.maxRounds || 3;
  const waitAfter = opt.waitAfter || 2500;

  for (let round = 1; round <= maxRounds; round++) {
    if (!(await hasSliderVerify(tab))) return 'solved';
    log('warn', '检测到滑块验证（第 ' + round + ' 轮），模式=' + mode);

    if (mode === 'manual') {
      if (opt.onManual) opt.onManual(tab);
      log('warn', '请在浏览器里手动完成滑块，最多等 ' + Math.round((opt.manualTimeout || 180000) / 1000) + ' 秒...');
      try {
        await waitSliderGone(tab, { timeout: opt.manualTimeout || 180000 });
        log('ok', '滑块已通过（手动）');
        return 'solved';
      } catch {
        return 'timeout';
      }
    }

    // 自动打码
    try {
      const distance = await solveByChaojiying(tab, opt.chaojiying || {}, opt);
      const icon = await tab.elementCenter(DRAG_ICON);
      if (!icon) throw new Error('找不到拖拽图标 ' + DRAG_ICON);
      // 缺口距离是图片像素，页面可能与截图有缩放差；用图片宽度/元素宽度修正
      const img = await tab.elementCenter(CAPTCHA_IMG);
      let scale = 1;
      if (img && img.width > 0) {
        const shotW = opt.lastShotWidth;
        if (shotW) scale = img.width / shotW;
      }
      const dx = distance * scale;
      log('info', '拖拽 ' + dx.toFixed(1) + 'px');
      await tab.mouseDrag(icon.x, icon.y, dx, 0, opt.steps || 18);
      await sleep(waitAfter);
      if (!(await hasSliderVerify(tab))) {
        log('ok', '滑块已通过（超级鹰）');
        return 'solved';
      }
      log('warn', '本轮未通过，重试');
    } catch (e) {
      log('err', '自动过滑块失败: ' + e.message);
      if (mode === 'auto') throw e;
      // 降级为手动
      if (opt.onManual) opt.onManual(tab);
      try {
        await waitSliderGone(tab, { timeout: opt.manualTimeout || 180000 });
        return 'solved';
      } catch { return 'timeout'; }
    }
  }
  return 'timeout';
}

module.exports = {
  SLIDER_SELECTORS, SLIDER_TEXT, CAPTCHA_IMG, DRAG_ICON,
  hasSliderVerify, waitSliderAppear, waitSliderGone, handleSlider, solveByChaojiying,
};
