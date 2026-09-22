'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { createMockProtocolInput, createWorkerClient } = require('../server/src/input/windows');

const clients = [];

after(async () => {
  for (const c of clients) {
    try {
      await c.dispose();
    } catch (_) {
      /* ignore */
    }
  }
});

test('mock protocol worker ready/tap/quit on Linux', async () => {
  const input = createMockProtocolInput({ keyTapMs: 20, responseTimeoutMs: 2000 });
  clients.push(input);
  const r = await input.tap('L');
  assert.equal(r.ok, true);
  assert.equal(r.injected, true);
  await input.dispose();
});

test('late reply with wrong id does not confirm newer tap', async () => {
  let workers = 0;
  const input = createWorkerClient({
    keyTapMs: 10,
    responseTimeoutMs: 80,
    spawnWorker: () => {
      workers += 1;
      const delay = workers === 1 ? 500 : 0;
      const code = `
const readline = require('readline');
const delay = ${delay};
process.stdout.write(JSON.stringify({ ok: true, ready: true, inputSize: 40 }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.op === 'quit') { process.exit(0); return; }
  if (msg.op === 'tap') {
    const id = msg.id;
    const reply = () => process.stdout.write(JSON.stringify({ ok: true, id }) + '\\n');
    if (delay > 0) setTimeout(reply, delay);
    else reply();
  }
});
`;
      return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
  clients.push(input);

  const firstResult = await input.tap('A');
  assert.equal(firstResult.ok, false);
  assert.match(firstResult.message || '', /timeout/i);

  const second = await input.tap('B');
  assert.equal(second.ok, true);
  assert.ok(workers >= 2);

  await input.dispose();
});
test('mock protocol rejects bad key name', async () => {
  const input = createMockProtocolInput({ keyTapMs: 20 });
  clients.push(input);
  const r = await input.tap('NotAKey!!!');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NOT_MAPPED');
  await input.dispose();
});
