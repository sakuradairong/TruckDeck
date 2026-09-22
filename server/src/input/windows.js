'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { resolveVk } = require('./keyMap');

const WORKER_SCRIPT = path.join(__dirname, 'sendinput_worker.ps1');
const DEFAULT_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 15000;
const DISPOSE_WAIT_MS = 3000;

/**
 * Protocol client: request/response correlated by numeric id (internal, not WS).
 */
function createWorkerClient(options = {}) {
  const downMs = Number(options.keyTapMs || 50);
  const responseTimeoutMs = Number(options.responseTimeoutMs || DEFAULT_TIMEOUT_MS);
  const spawnWorker = options.spawnWorker;
  const beforeSend = options.beforeSend;
  if (typeof spawnWorker !== 'function') {
    throw new Error('spawnWorker required');
  }

  let child = null;
  let childToken = 0;
  let buffer = '';
  /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
  const pending = new Map();
  let disposed = false;
  let ready = false;
  let readyWaiters = [];
  let nextId = 1;

  function failAllPending(err) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function failReadyWaiters(err) {
    const list = readyWaiters;
    readyWaiters = [];
    for (const w of list) w.reject(err);
  }

  function onStdout(chunk, token) {
    if (token !== childToken) return;
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      if (msg.ready && msg.ok) {
        ready = true;
        const list = readyWaiters;
        readyWaiters = [];
        for (const w of list) w.resolve(msg);
        continue;
      }
      const id = msg.id;
      if (id === undefined || id === null) {
        // Uncorrelated — ignore (do not FIFO-shift)
        continue;
      }
      const entry = pending.get(Number(id));
      if (!entry) continue; // late reply after timeout
      pending.delete(Number(id));
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve({ ok: true, injected: true, raw: msg });
      else entry.reject(new Error(msg.message || msg.error || 'inject failed'));
    }
  }

  function attachChild(c) {
    childToken += 1;
    const token = childToken;
    child = c;
    buffer = '';
    ready = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => onStdout(chunk, token));
    child.stderr.on('data', (d) => {
      if (token !== childToken) return;
      console.warn('[input:worker] stderr:', String(d).slice(0, 300));
    });
    child.on('error', (err) => {
      if (token !== childToken) return;
      console.warn('[input:worker] child error', err.message);
      failAllPending(err);
      failReadyWaiters(err);
      if (child === c) {
        child = null;
        ready = false;
      }
    });
    if (child.stdin) {
      child.stdin.on('error', (err) => {
        if (token !== childToken) return;
        console.warn('[input:worker] stdin error', err.message);
        failAllPending(err);
      });
    }
    child.on('exit', (code) => {
      if (token !== childToken) return;
      console.warn('[input:worker] exited', code);
      const err = new Error(`worker exited (${code})`);
      failAllPending(err);
      failReadyWaiters(err);
      if (child === c) {
        child = null;
        ready = false;
      }
    });
  }

  function killCurrentWorker() {
    const c = child;
    childToken += 1; // isolate old events
    child = null;
    ready = false;
    buffer = '';
    if (c) {
      try {
        c.kill();
      } catch (_) {
        /* ignore */
      }
    }
  }

  async function ensureReady() {
    if (disposed) throw new Error('disposed');
    if (child && !child.killed && ready) return;

    const waitReady = () =>
      new Promise((resolve, reject) => {
        const entry = { resolve: null, reject: null };
        const t = setTimeout(() => {
          readyWaiters = readyWaiters.filter((w) => w !== entry);
          reject(new Error('worker ready timeout'));
        }, READY_TIMEOUT_MS);
        entry.resolve = (m) => {
          clearTimeout(t);
          resolve(m);
        };
        entry.reject = (e) => {
          clearTimeout(t);
          reject(e);
        };
        readyWaiters.push(entry);
      });

    if (child && !child.killed && !ready) {
      await waitReady();
      return;
    }
    const c = spawnWorker();
    attachChild(c);
    try {
      await waitReady();
    } catch (err) {
      killCurrentWorker();
      throw err;
    }
  }

  function send(opObj) {
    if (disposed) return Promise.reject(new Error('disposed'));
    return ensureReady().then(
      () =>
        new Promise((resolve, reject) => {
          if (typeof beforeSend === 'function') {
            const g = beforeSend();
            if (g && g.ok === false) {
              reject(new Error(g.message || 'beforeSend guard failed'));
              return;
            }
          }
          const id = nextId;
          nextId += 1;
          const timer = setTimeout(() => {
            pending.delete(id);
            // Isolate stale worker so late replies cannot confirm future taps
            killCurrentWorker();
            reject(new Error('worker response timeout'));
          }, responseTimeoutMs);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
            timer,
          });
          try {
            child.stdin.write(`${JSON.stringify({ ...opObj, id })}\n`);
          } catch (err) {
            pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        }),
    );
  }

  async function tap(keyName) {
    const vk = resolveVk(keyName);
    if (vk === null) {
      return { ok: false, error: 'NOT_MAPPED', message: `key not in whitelist: ${keyName}` };
    }
    try {
      await send({ op: 'tap', vk, downMs });
      return { ok: true, injected: true };
    } catch (err) {
      const msg = String(err.message || err);
      if (/mode lost|beforeSend|live/i.test(msg)) {
        return { ok: false, error: 'UNSUPPORTED', message: msg };
      }
      return { ok: false, error: 'INJECT_FAILED', message: msg };
    }
  }

  async function tapTimes(keyName, times) {
    const n = Math.max(0, Math.min(10, Number(times) || 0));
    for (let i = 0; i < n; i += 1) {
      const r = await tap(keyName);
      if (!r.ok) return r;
      await new Promise((r) => setTimeout(r, downMs + 30));
    }
    return { ok: true, injected: true };
  }

  async function dispose() {
    disposed = true;
    failAllPending(new Error('disposed'));
    failReadyWaiters(new Error('disposed'));
    if (!child) return;
    const c = child;
    try {
      c.stdin.write(`${JSON.stringify({ op: 'quit', id: nextId++ })}\n`);
    } catch (_) {
      /* ignore */
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          c.kill();
        } catch (_) {
          /* ignore */
        }
        resolve();
      }, DISPOSE_WAIT_MS);
      c.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child = null;
    ready = false;
  }

  return {
    kind: options.kind || 'worker',
    tap,
    tapTimes,
    dispose,
    _send: send,
    _ensureReady: ensureReady,
  };
}

function createWindowsInput(options = {}) {
  return createWorkerClient({
    ...options,
    kind: 'windows',
    spawnWorker: () =>
      spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_SCRIPT],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      ),
  });
}

function createMockProtocolInput(options = {}) {
  const downMs = Number(options.keyTapMs || 50);
  const delayMs = Number(options.replyDelayMs || 0);
  return createWorkerClient({
    ...options,
    kind: 'mock-protocol',
    keyTapMs: downMs,
    spawnWorker:
      options.spawnWorker ||
      (() => {
        const code = `
const readline = require('readline');
const delay = ${delayMs};
process.stdout.write(JSON.stringify({ ok: true, ready: true, inputSize: 40 }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad-json' }) + '\\n'); return; }
  if (msg.op === 'quit') { process.exit(0); return; }
  if (msg.op === 'tap') {
    const vk = Number(msg.vk);
    const id = msg.id;
    const reply = () => {
      if (!(vk >= 1 && vk <= 254)) {
        process.stdout.write(JSON.stringify({ ok: false, error: 'bad-vk', id }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({ ok: true, id }) + '\\n');
    };
    if (delay > 0) setTimeout(reply, delay);
    else reply();
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: 'unknown-op', id: msg.id }) + '\\n');
});
`;
        return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
      }),
  });
}

module.exports = {
  createWindowsInput,
  createWorkerClient,
  createMockProtocolInput,
  WORKER_SCRIPT,
};
