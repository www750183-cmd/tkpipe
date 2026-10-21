'use strict';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 250, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error('等待超时(' + timeout + 'ms): ' + label + (lastErr ? ' / ' + lastErr.message : ''));
}

const LOG_COLORS = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m' };
function log(level, msg) {
  const c = LOG_COLORS[level] || '';
  const t = new Date().toTimeString().slice(0, 8);
  process.stdout.write(c + '[' + t + '] ' + msg + '\x1b[0m\n');
}

module.exports = { sleep, waitFor, log };
