'use strict';

/**
 * Integration tests — uses TRUCKDECK_TEST_PORT (default 4011), not production 4000.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocket } = require('ws');

const { loadConfig, KEY_WHITELIST } = require('../server/src/config');
const { createApp } = require('../server/src/app');
const { createTelemetryService } = require('../server/src/telemetry');
const { createInputService } = require('../server/src/input');
const { createWsHub } = require('../server/src/wsHub');

process.env.TRUCKDECK_MOCK = '1';

const PORT = Number(process.env.TRUCKDECK_TEST_PORT || 4011);
let server;
let hub;
let input;
let telemetry;

before(async () => {
  process.env.TRUCKDECK_PORT = String(PORT);
  const config = loadConfig();
  config.port = PORT;
  config.forceMock = true;
  telemetry = createTelemetryService(config);
  input = createInputService(config, telemetry);
  const app = createApp(config, telemetry);
  server = http.createServer(app);
  hub = createWsHub({ server, config, telemetry, input });
  await new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
});

after(async () => {
  if (hub) await hub.dispose();
  if (input) await input.dispose();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

function httpGet(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { hostname: '127.0.0.1', port: PORT, path: pathname, headers },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        },
      )
      .on('error', reject);
  });
}

function openWs(origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      origin: origin || `http://127.0.0.1:${PORT}`,
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error('unexpected-response'), { statusCode: res.statusCode }));
    });
    ws.once('error', reject);
  });
}

function onceMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

test('GET /health exact shape', async () => {
  const res = await httpGet('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, mock: true });
});

test('GET / serves page', async () => {
  const res = await httpGet('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /TruckDeck/i);
});

test('WS hello required before command', async () => {
  const ws = await openWs();
  const wait = onceMessage(ws, (m) => m.type === 'error' && m.error === 'HELLO_REQUIRED');
  ws.send(JSON.stringify({ type: 'command', action: 'engine.toggle' }));
  await wait;
  ws.close();
});

test('WS hello ack includes mock', async () => {
  const ws = await openWs();
  const wait = onceMessage(ws, (m) => m.type === 'hello');
  ws.send(JSON.stringify({ type: 'hello', role: 'web', version: '1' }));
  const ack = await wait;
  assert.equal(ack.ok, true);
  assert.equal(ack.mock, true);
  assert.ok(ack.telemetryHz >= 5);
  ws.close();
});

test('telemetry frequency >= 5Hz', async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ type: 'hello', role: 'web', version: '1' }));
  await onceMessage(ws, (m) => m.type === 'hello' && m.ok);

  const stamps = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('not enough telemetry')), 3000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'telemetry') return;
      stamps.push(Date.now());
      if (stamps.length >= 8) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const dt = [];
  for (let i = 1; i < stamps.length; i += 1) dt.push(stamps[i] - stamps[i - 1]);
  const avg = dt.reduce((a, b) => a + b, 0) / dt.length;
  assert.ok(avg <= 220, `avg interval ${avg}ms too slow`);
  ws.close();
});

test('all mock commands echo via telemetry', async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ type: 'hello', role: 'web', version: '1' }));
  await onceMessage(ws, (m) => m.type === 'hello' && m.ok);

  async function cmd(action, value) {
    const id = `t-${action}-${value}`;
    const waitAck = onceMessage(
      ws,
      (m) => (m.type === 'command_ack' || m.type === 'command_nack') && m.id === id,
    );
    const payload = { type: 'command', id, action };
    if (value !== undefined) payload.value = value;
    ws.send(JSON.stringify(payload));
    return waitAck;
  }

  async function waitTelemetry(pred) {
    return onceMessage(ws, (m) => m.type === 'telemetry' && pred(m.data), 4000);
  }

  for (const [action, value] of [
    ['lights.beamLow', true],
    ['lights.parking', true],
    ['lights.beamHigh', true],
    ['lights.blinkerLeft', true],
    ['lights.blinkerRight', true],
    ['lights.hazard', true],
    ['wipers.set', '2'],
    ['wipers.set', 'auto'],
    ['wipers.set', '3'],
    ['wipers.set', 'off'],
  ]) {
    const r = await cmd(action, value);
    assert.equal(r.ok, true, `${action} ${value}`);
  }
  await waitTelemetry((d) => d.wipers === 'off');

  assert.equal((await cmd('handbrake.toggle')).ok, true);
  assert.equal((await cmd('diffLock.toggle')).ok, true);
  await waitTelemetry((d) => d.diffLock === true);
  assert.equal((await cmd('liftAxle.toggle')).ok, true);
  assert.equal((await cmd('cruise.toggle')).ok, true);
  assert.equal((await cmd('engine.toggle')).ok, true);

  ws.close();
});

test('invalid command / bad JSON / array body', async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ type: 'hello', role: 'web', version: '1' }));
  await onceMessage(ws, (m) => m.type === 'hello' && m.ok);

  ws.send(JSON.stringify({ type: 'command', action: 'nope.x', id: 'bad1' }));
  await onceMessage(ws, (m) => m.type === 'command_nack' && m.error === 'UNKNOWN_ACTION');

  ws.send('not-json');
  await onceMessage(ws, (m) => m.type === 'error' && m.error === 'INVALID_JSON');

  ws.send(JSON.stringify([1, 2, 3]));
  await onceMessage(ws, (m) => m.type === 'error' && m.error === 'INVALID_JSON');

  ws.close();
});

test('forbidden origin rejected', async () => {
  const opened = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      origin: 'http://example.com:4000',
    });
    const t = setTimeout(() => {
      try {
        ws.terminate();
      } catch (_) {
        /* ignore */
      }
      resolve(false);
    }, 800);
    ws.once('open', () => {
      clearTimeout(t);
      ws.close();
      resolve(true);
    });
    ws.once('unexpected-response', () => {
      clearTimeout(t);
      resolve(false);
    });
    ws.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  assert.equal(opened, false);
});

test('foreign private Origin rejected even with local Host', async () => {
  let opened = false;
  try {
    await openWs('http://192.168.99.1:' + PORT);
    opened = true;
  } catch {
    opened = false;
  }
  assert.equal(opened, false);
});

test('oversized frame does not kill server', async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ type: 'hello', role: 'web', version: '1' }));
  await onceMessage(ws, (m) => m.type === 'hello' && m.ok);
  const big = 'x'.repeat(20000);
  try {
    ws.send(JSON.stringify({ type: 'command', action: 'engine.toggle', id: big }));
  } catch (_) {
    /* may throw locally */
  }
  await new Promise((r) => setTimeout(r, 200));
  const health = await httpGet('/health');
  assert.deepEqual(JSON.parse(health.body), { ok: true, mock: true });
  try {
    ws.close();
  } catch (_) {
    /* ignore */
  }
});

test('bad Host header rejected on HTTP', async () => {
  const res = await httpGet('/health', { Host: 'evil.example:4011' });
  assert.equal(res.status, 403);
});

test('keybind whitelist', () => {
  assert.equal(KEY_WHITELIST.has('L'), true);
  assert.equal(KEY_WHITELIST.has('$(calc)'), false);
});

test('server survives after malformed upgrade Host', async () => {
  await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/ws',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Host: '::::bad',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('error', () => resolve());
    req.on('response', () => resolve());
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve();
    });
    req.end();
  });
  const health = await httpGet('/health');
  assert.equal(JSON.parse(health.body).ok, true);
});
