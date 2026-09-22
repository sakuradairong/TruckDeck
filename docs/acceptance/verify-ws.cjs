'use strict';
/**
 * TruckDeck 一期端到端复验（HTTP + WebSocket），需要先启动一个实例。
 *
 * 用法（mock 模式，非默认端口）：
 *   npm run build
 *   TRUCKDECK_PORT=4013 TRUCKDECK_MOCK=1 node server/index.js &
 *   node docs/acceptance/verify-ws.cjs 4013 \
 *     > docs/acceptance/evidence/verify-4013.json \
 *     2> docs/acceptance/evidence/verify-4013.log
 *
 * stdout = 机器可读 JSON 摘要；stderr = 人类可读 PASS/FAIL 日志。
 * 退出码：0 = 全部通过；1 = 存在失败项。
 *
 * 覆盖：契约 §1 /health、§2 Origin/Host 与路径拒绝、§3 hello 与 telemetry 与 command
 * 及错误枚举、§5 静态托管、§8 帧上限。**不覆盖** Windows 实机按键注入与 SCS 共享内存。
 */
const http = require('node:http');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const { WebSocket } = require(path.join(REPO, 'node_modules', 'ws'));

const port = Number(process.argv[2] || 4000);
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const WS_PATH = '/ws';
const TELEMETRY_HZ_MIN = 5; // 契约 §3.2
const MAX_PAYLOAD = 8192; // 契约 §8

const rows = [];
let failed = 0;

function record(name, ok, detail) {
  rows.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.error(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + detail : ''}`);
}

async function check(name, fn) {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, String((err && err.message) || err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function open(originOverride) {
  const opts = originOverride === undefined ? { origin } : { origin: originOverride };
  const ws = new WebSocket(`ws://${host}${WS_PATH}`, opts);
  const inbox = [];
  ws.on('message', (raw) => {
    const text = String(raw);
    try {
      inbox.push(JSON.parse(text));
    } catch (_) {
      inbox.push({ __unparsable: text });
    }
  });
  return { ws, inbox };
}

function waitFor(inbox, pred, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const i = inbox.findIndex(pred);
      if (i >= 0) {
        clearInterval(timer);
        resolve(inbox.splice(i, 1)[0]);
        return;
      }
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`超时等待 ${label}`));
      }
    }, 10);
  });
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) {
      resolve();
      return;
    }
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitClose(ws, timeout = 4000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 3) {
      resolve({ code: ws._closeCode || null });
      return;
    }
    const timer = setTimeout(() => reject(new Error('连接未在预期时间内关闭')), timeout);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

function send(ws, obj) {
  ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function get(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: host, ...(headers || {}) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 原始 WS 升级请求：用于读回握手前的 HTTP 状态码（403/404），101 表示升级成功。 */
function upgradeStatus(extraHeaders, urlPath = WS_PATH) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...extraHeaders,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

async function hello(conn, version = '1') {
  await waitOpen(conn.ws);
  send(conn.ws, { type: 'hello', role: 'web', version });
  return waitFor(conn.inbox, (m) => m.type === 'hello', 'hello ack');
}

async function withConnection(fn) {
  const conn = open();
  try {
    return await fn(conn);
  } finally {
    try {
      conn.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

const LIGHTS = ['parking', 'beamLow', 'beamHigh', 'blinkerLeft', 'blinkerRight', 'hazard'];
const WIPERS = ['off', 'auto', '1', '2', '3'];
const TOGGLES = [
  ['handbrake.toggle', 'handbrake'],
  ['diffLock.toggle', 'diffLock'],
  ['liftAxle.toggle', 'liftAxle'],
  ['cruise.toggle', 'cruise'],
  ['engine.toggle', 'engineOn'],
];

/** 覆盖契约 §3 的全部 action 与错误枚举；由 main() 在已 hello 的连接上调用。 */
async function verifyActionsAndErrors(conn, summary) {
  await check('12 类 action 全部可用且状态与遥测一致（22 次操作）', async () => {
    const cases = [];
    for (const name of LIGHTS) {
      for (const value of [true, false]) {
        cases.push({ action: `lights.${name}`, value, pred: (d) => d.lights[name] === value });
      }
    }
    for (const value of WIPERS) {
      cases.push({ action: 'wipers.set', value, pred: (d) => d.wipers === value });
    }
    for (const [action, field] of TOGGLES) {
      cases.push({ action, field });
    }

    let verified = 0;
    const seen = new Set();
    for (const c of cases) {
      conn.inbox.length = 0;
      const baseline = (await waitFor(conn.inbox, (m) => m.type === 'telemetry', '基线遥测')).data;
      const id = `verify-${verified + 1}`;
      const msg = { type: 'command', action: c.action, id };
      if ('value' in c) msg.value = c.value;
      send(conn.ws, msg);
      const ack = await waitFor(conn.inbox, (m) => m.id === id, `ack ${c.action}`);
      assert(ack.type === 'command_ack', `${c.action} → ${ack.type}${ack.error ? ' ' + ack.error : ''}`);
      const pred = c.pred || ((d) => d[c.field] === !baseline[c.field]);
      await waitFor(conn.inbox, (m) => m.type === 'telemetry' && pred(m.data), `${c.action} 回显`);
      verified += 1;
      seen.add(c.action);
    }
    assert(verified === 22, `仅完成 ${verified}/22`);
    summary.commandsVerified = verified;
    summary.actionsCovered = seen.size;
    return `22 次操作 / ${seen.size} 类 action 全部 ack 且回显一致`;
  });

  await check('非 JSON 载荷 → INVALID_JSON 且连接不断开', async () => {
    send(conn.ws, '{not-json');
    const msg = await waitFor(conn.inbox, (m) => m.type === 'error', 'INVALID_JSON');
    assert(msg.error === 'INVALID_JSON', `error=${msg.error}`);
    assert(conn.ws.readyState === 1, '连接被断开了');
    summary.negative.invalidJson = msg.error;
    return msg.error;
  });

  await check('未知消息类型 → UNKNOWN_TYPE', async () => {
    send(conn.ws, { type: 'definitely-not-a-type' });
    const msg = await waitFor(conn.inbox, (m) => m.type === 'error', 'UNKNOWN_TYPE');
    assert(msg.error === 'UNKNOWN_TYPE', `error=${msg.error}`);
    summary.negative.unknownType = msg.error;
    return msg.error;
  });

  await check('未知 action → command_nack UNKNOWN_ACTION', async () => {
    send(conn.ws, { type: 'command', action: 'flux.capacitor', id: 'neg-unknown' });
    const msg = await waitFor(conn.inbox, (m) => m.id === 'neg-unknown', 'UNKNOWN_ACTION');
    assert(msg.type === 'command_nack', `type=${msg.type}`);
    assert(msg.error === 'UNKNOWN_ACTION', `error=${msg.error}`);
    summary.negative.unknownAction = msg.error;
    return msg.error;
  });

  await check('value 缺失/非法 → command_nack INVALID_VALUE', async () => {
    const probes = [
      ['灯光缺 value', { type: 'command', action: 'lights.beamLow', id: 'neg-v1' }],
      ['雨刮档位非法', { type: 'command', action: 'wipers.set', value: '9', id: 'neg-v2' }],
      ['toggle 带 value', { type: 'command', action: 'handbrake.toggle', value: true, id: 'neg-v3' }],
    ];
    for (const [name, msg] of probes) {
      send(conn.ws, msg);
      const res = await waitFor(conn.inbox, (m) => m.id === msg.id, `INVALID_VALUE (${name})`);
      assert(res.type === 'command_nack', `${name} → ${res.type}`);
      assert(res.error === 'INVALID_VALUE', `${name} → ${res.error}`);
    }
    summary.negative.invalidValue = 'INVALID_VALUE x3';
    return '3 种非法 value 均被拒';
  });

  await check('帧超过 8KiB → 连接被关闭', async () => {
    const big = open();
    try {
      await waitOpen(big.ws);
      send(big.ws, { type: 'hello', role: 'web', version: '1' });
      await waitFor(big.inbox, (m) => m.type === 'hello', 'hello ack');
      big.ws.send(JSON.stringify({ type: 'command', action: 'handbrake.toggle', pad: 'x'.repeat(MAX_PAYLOAD) }));
      const closed = await waitClose(big.ws);
      summary.negative.oversizedFrame = { closed: true, code: closed.code };
      return `连接已关闭（code=${closed.code}）`;
    } finally {
      try {
        big.ws.terminate();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

async function main() {
  const summary = {
    ok: false,
    port,
    startedAt: new Date().toISOString(),
    node: process.version,
    health: null,
    hello: null,
    telemetryHz: null,
    commandsVerified: 0,
    actionsCovered: 12,
    frontend: null,
    negative: {},
  };

  // ---- §1 HTTP /health ----
  await check('/health 返回精确 {"ok":true,"mock":true}', async () => {
    const r = await get('/health');
    assert(r.status === 200, `HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    assert(j.ok === true, `ok=${j.ok}`);
    assert(j.mock === true, `mock=${j.mock}（应以 TRUCKDECK_MOCK=1 启动）`);
    assert(Object.keys(j).sort().join(',') === 'mock,ok', `字段集=${Object.keys(j).join(',')}`);
    summary.health = j;
    return r.body.trim();
  });

  // ---- §5 静态托管：中文页面 + 无外链 + PWA 资源 ----
  await check('GET / 返回中控页面且无外链资源', async () => {
    const r = await get('/');
    assert(r.status === 200, `HTTP ${r.status}`);
    const html = r.body;
    assert(/<html/i.test(html), '缺少 <html>');
    assert(/[\u4e00-\u9fa5]/.test(html), '页面缺少中文文案');
    const external = (html.match(/(?:src|href)\s*=\s*["']https?:\/\//gi) || []).length;
    assert(external === 0, `存在 ${external} 处外链资源（应全部本地）`);
    summary.frontend = { bytes: Buffer.byteLength(html), externalAssets: external };
    return `${Buffer.byteLength(html)} 字节，外链 0，含中文`;
  });

  await check('PWA 资源可达（manifest 与图标）', async () => {
    const man = await get('/manifest.webmanifest');
    assert(man.status === 200, `manifest HTTP ${man.status}`);
    const icons = [...man.body.matchAll(/"src"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert(icons.length > 0, 'manifest 未声明图标');
    for (const src of icons) {
      const r = await get(src.startsWith('/') ? src : `/${src}`);
      assert(r.status === 200, `${src} HTTP ${r.status}`);
    }
    return `manifest + ${icons.length} 个图标均 200`;
  });

  // ---- §2 拒绝路径 ----
  await check('WS 升级：外域 Origin 被拒（403）', async () => {
    const code = await upgradeStatus({ Origin: `http://evil.example.com:${port}` });
    assert(code === 403, `状态码 ${code}`);
    summary.negative.originForeign = code;
    return '403';
  });

  await check('WS 升级：Origin=null 被拒（403）', async () => {
    const code = await upgradeStatus({ Origin: 'null' });
    assert(code === 403, `状态码 ${code}`);
    summary.negative.originOpaque = code;
    return '403';
  });

  await check('WS 升级：Origin 端口与服务端口不一致被拒（403）', async () => {
    const otherPort = port === 9999 ? 9998 : 9999;
    const code = await upgradeStatus({ Origin: `http://127.0.0.1:${otherPort}` });
    assert(code === 403, `状态码 ${code}`);
    summary.negative.originPortMismatch = code;
    return '403';
  });

  await check('WS 升级：非本机 Host 头被拒（403）', async () => {
    const code = await upgradeStatus({ Host: 'evil.example.com', Origin: `http://127.0.0.1:${port}` });
    assert(code === 403, `状态码 ${code}`);
    summary.negative.hostForeign = code;
    return '403';
  });

  await check('WS 升级：非 /ws 路径被拒（404）', async () => {
    const code = await upgradeStatus({ Origin: origin }, '/nope');
    assert(code === 404, `状态码 ${code}`);
    summary.negative.wrongPath = code;
    return '404';
  });

  await check('未 hello 即发 command → HELLO_REQUIRED', async () => {
    const conn = open();
    try {
      await waitOpen(conn.ws);
      send(conn.ws, { type: 'command', action: 'handbrake.toggle' });
      const msg = await waitFor(conn.inbox, (m) => m.type === 'error', 'HELLO_REQUIRED');
      assert(msg.error === 'HELLO_REQUIRED', `error=${msg.error}`);
      summary.negative.helloRequired = msg.error;
      return msg.error;
    } finally {
      conn.ws.close();
    }
  });

  await check('hello 版本不符 → hello ack 失败', async () => {
    const conn = open();
    try {
      await waitOpen(conn.ws);
      send(conn.ws, { type: 'hello', role: 'web', version: '2' });
      const msg = await waitFor(conn.inbox, (m) => m.type === 'hello', 'hello 拒绝');
      assert(msg.ok === false, `ok=${msg.ok}`);
      summary.negative.badVersion = msg.error;
      return `ok=false error=${msg.error}`;
    } finally {
      conn.ws.close();
    }
  });

  // ---- §3 正常握手 + 遥测频率 + 全部 action + 错误枚举 ----
  await withConnection(async (conn) => {
    await check('hello 握手返回契约字段且 mock=true', async () => {
      const ack = await hello(conn);
      assert(ack.ok === true, `ok=${ack.ok}`);
      assert(ack.role === 'server', `role=${ack.role}`);
      assert(ack.version === '1', `version=${ack.version}`);
      assert(ack.mock === true, `mock=${ack.mock}`);
      assert(Number.isFinite(ack.telemetryHz) && ack.telemetryHz >= TELEMETRY_HZ_MIN, `telemetryHz=${ack.telemetryHz}`);
      assert(Number.isFinite(ack.ts), `ts=${ack.ts}`);
      summary.hello = { mock: ack.mock, telemetryHz: ack.telemetryHz, version: ack.version };
      return `mock=${ack.mock} Hz=${ack.telemetryHz}`;
    });

    await check('telemetry 频率达到契约下限（≥5Hz）', async () => {
      await waitFor(conn.inbox, (m) => m.type === 'telemetry', '首帧 telemetry');
      let frames = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        await new Promise((r) => setTimeout(r, 100));
        frames = conn.inbox.filter((m) => m.type === 'telemetry').length;
      }
      const hz = frames / ((Date.now() - t0) / 1000);
      assert(hz >= TELEMETRY_HZ_MIN, `实测 ${hz.toFixed(2)}Hz 低于 ${TELEMETRY_HZ_MIN}Hz`);
      summary.telemetryHz = Number(hz.toFixed(2));
      return `${hz.toFixed(2)} Hz（${frames} 帧 / ${((Date.now() - t0) / 1000).toFixed(2)}s）`;
    });

    await verifyActionsAndErrors(conn, summary);
  });

  summary.ok = failed === 0;
  summary.finishedAt = new Date().toISOString();
  summary.passedChecks = rows.length - failed;
  summary.totalChecks = rows.length;
  summary.failedChecks = rows.filter((r) => !r.ok).map((r) => r.name);
  summary.checks = rows;

  console.error(`\n${failed === 0 ? '复验通过' : '复验失败'}：${rows.length - failed}/${rows.length} 项通过`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('复验脚本异常：', err);
  console.log(JSON.stringify({ ok: false, port, fatal: String((err && err.message) || err), checks: rows }, null, 2));
  process.exitCode = 1;
});
