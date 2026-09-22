'use strict';

/**
 * SCS 语义输入客户端：通过 scs_sdk_controller 的共享内存（Local\SCSControls）
 * 直接向游戏投递语义输入事件（flasher4way / lightoff / lightpark / lighton /
 * wipersN / diflock / liftaxle / parkingbrake / cruiectrl / ignition*），
 * 完全不经过键盘注入，因此与玩家键位无关。
 *
 * 前置：游戏目录 plugins/ 下有 scs_sdk_controller.dll，且游戏正在运行
 * （共享内存由该插件创建）。找不到共享内存时 probe() 返回失败，由上层回退键盘注入。
 *
 * 注意：实测该通道同样需要游戏窗口在前台；wipers 相关控制见 README 的复位说明。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKER_SCRIPT = path.join(__dirname, 'scscontrols_worker.ps1');
const OFFSETS_JSON = path.join(__dirname, 'scsControlOffsets.json');
const DEFAULT_TIMEOUT_MS = 5000;
const DISPOSE_WAIT_MS = 3000;

/** 偏移表中的可用控制名（用于入参校验，避免把任意字符串写进共享内存） */
function loadControlNames() {
  try {
    const raw = JSON.parse(fs.readFileSync(OFFSETS_JSON, 'utf8'));
    return new Set(Object.keys(raw.controls || {}));
  } catch (err) {
    return new Set();
  }
}

function defaultSpawn() {
  return spawn(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WORKER_SCRIPT,
      '-OffsetsJson', OFFSETS_JSON,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
}

function createScsInput(options = {}) {
  const responseTimeoutMs = Number(options.responseTimeoutMs || DEFAULT_TIMEOUT_MS);
  const defaultHoldMs = Number(options.holdMs || options.keyTapMs || 120);
  const spawnWorker = options.spawnWorker || defaultSpawn;
  const knownControls = options.knownControls || loadControlNames();

  let child = null;
  let childToken = 0;
  let buffer = '';
  let disposed = false;
  let startPromise = null;
  let startResult = null;
  let nextId = 1;
  /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
  const pending = new Map();

  function failAllPending(err) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function settleStart(result) {
    if (startResult) return;
    startResult = result;
  }

  function onStdout(chunk, token) {
    if (token !== childToken) return;
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          msg = null;
        }
        if (msg) {
          if (msg.id === 0 && msg.ready !== undefined) {
            // 启动行：插件/共享内存是否可用
            settleStart(msg.ready
              ? { ok: true, bytes: msg.bytes }
              : { ok: false, error: msg.error || 'not-ready' });
          } else if (msg.id !== undefined && msg.id !== null && pending.has(Number(msg.id))) {
            const entry = pending.get(Number(msg.id));
            pending.delete(Number(msg.id));
            clearTimeout(entry.timer);
            if (msg.ok) entry.resolve({ ok: true, raw: msg });
            else entry.reject(new Error(msg.error || 'scs-write-failed'));
          }
        }
      }
      nl = buffer.indexOf('\n');
    }
  }

  function attachChild(c) {
    childToken += 1;
    const token = childToken;
    child = c;
    buffer = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => onStdout(chunk, token));
    c.stderr.on('data', (d) => {
      if (token !== childToken) return;
      console.warn('[input:scs] stderr:', String(d).slice(0, 300));
    });
    c.on('error', (err) => {
      if (token !== childToken) return;
      settleStart({ ok: false, error: err.message });
      failAllPending(err);
      if (child === c) child = null;
    });
    if (c.stdin) {
      c.stdin.on('error', (err) => {
        if (token !== childToken) return;
        failAllPending(err);
      });
    }
    c.on('exit', (code) => {
      if (token !== childToken) return;
      if (!startResult) settleStart({ ok: false, error: 'worker exited before ready (code ' + code + ')' });
      failAllPending(new Error('scs worker exited'));
      if (child === c) child = null;
    });
  }

  function ensureStarted() {
    if (disposed) return Promise.resolve({ ok: false, error: 'disposed' });
    if (startResult) return Promise.resolve(startResult);
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      try {
        attachChild(spawnWorker());
      } catch (err) {
        settleStart({ ok: false, error: String(err.message || err) });
        done(startResult);
        return;
      }
      const timer = setTimeout(() => {
        settleStart({ ok: false, error: 'worker start timeout' });
        if (child) {
          try { child.kill(); } catch (err) { /* ignore */ }
        }
        done(startResult || { ok: false, error: 'start failed' });
      }, responseTimeoutMs * 3);
      const poll = setInterval(() => {
        if (startResult) {
          clearInterval(poll);
          clearTimeout(timer);
          done(startResult);
        }
      }, 50);
    });
    return startPromise;
  }

  function send(op, payload, waitMs) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin) {
        reject(new Error('scs worker not running'));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('scs worker timeout'));
      }, waitMs || responseTimeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        child.stdin.write(JSON.stringify(Object.assign({ op: op, id: id }, payload)) + '\n');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  async function probe() {
    return ensureStarted();
  }

  /** 语义输入是"按钮"：写入 true → 保持 holdMs → 写回 false */
  async function pulse(name, holdMs) {
    const started = await ensureStarted();
    if (!started.ok) return { ok: false, error: 'SCS_UNAVAILABLE', message: started.error };
    if (knownControls.size > 0 && !knownControls.has(name)) {
      return { ok: false, error: 'UNSUPPORTED', message: 'unknown scs control ' + name };
    }
    const hold = Math.max(20, Math.min(2000, Number(holdMs) || defaultHoldMs));
    try {
      await send('pulse', { name: name, holdMs: hold }, hold + responseTimeoutMs);
      return { ok: true, injected: true, via: 'scs', name: name };
    } catch (err) {
      return { ok: false, error: 'INJECT_FAILED', message: String(err.message || err) };
    }
  }

  /** 直接写值（用于需要保持的电平型输入，目前命令层都用 pulse） */
  async function set(name, value) {
    const started = await ensureStarted();
    if (!started.ok) return { ok: false, error: 'SCS_UNAVAILABLE', message: started.error };
    if (knownControls.size > 0 && !knownControls.has(name)) {
      return { ok: false, error: 'UNSUPPORTED', message: 'unknown scs control ' + name };
    }
    try {
      await send('set', { name: name, value: Boolean(value) });
      return { ok: true, injected: true, via: 'scs', name: name, value: Boolean(value) };
    } catch (err) {
      return { ok: false, error: 'INJECT_FAILED', message: String(err.message || err) };
    }
  }

  async function dispose() {
    disposed = true;
    failAllPending(new Error('disposed'));
    const c = child;
    if (!c) return;
    try {
      c.stdin.write(JSON.stringify({ op: 'quit', id: nextId++ }) + '\n');
    } catch (err) { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { c.kill(); } catch (err) { /* ignore */ }
        resolve();
      }, DISPOSE_WAIT_MS);
      c.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child = null;
  }

  return {
    kind: 'scs',
    probe: probe,
    pulse: pulse,
    set: set,
    dispose: dispose,
    controlCount: knownControls.size,
    _ensureStarted: ensureStarted,
  };
}

module.exports = {
  createScsInput: createScsInput,
  loadControlNames: loadControlNames,
  WORKER_SCRIPT: WORKER_SCRIPT,
  OFFSETS_JSON: OFFSETS_JSON,
};
