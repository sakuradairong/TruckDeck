'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryService } = require('../server/src/telemetry');
const { createInputService } = require('../server/src/input');
const { executeCommand } = require('../server/src/commands/handler');
const { createWorkerClient } = require('../server/src/input/windows');
const { spawn } = require('child_process');

function fakeScs(sequence) {
  let i = 0;
  return {
    available: true,
    reason: 'ok',
    read() {
      const snap = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return JSON.parse(JSON.stringify(snap));
    },
  };
}

function baseSnap(connected) {
  return {
    connected,
    speedKmh: 0,
    engineRpm: 800,
    gear: 0,
    fuelPct: 50,
    airPressure: 100,
    lights: {
      parking: false,
      beamLow: false,
      beamHigh: false,
      blinkerLeft: false,
      blinkerRight: false,
      hazard: false,
    },
    wipers: 'off',
    handbrake: false,
    diffLock: false,
    liftAxle: false,
    cruise: false,
    engineOn: true,
  };
}

test('fresh read at execution discards commands accepted in the previous mode', async () => {
  for (const wasLive of [false, true]) {
    const telemetry = createTelemetryService(
      { forceMock: false },
      { platform: 'win32', scs: fakeScs([baseSnap(wasLive), baseSnap(!wasLive)]) },
    );
    telemetry.snapshot();
    const expectedModeGeneration = telemetry.getModeGeneration();
    let taps = 0;
    const result = await executeCommand({
      config: { keybinds: { 'diffLock.toggle': 'V' } },
      telemetry,
      input: { tap: async () => { taps += 1; return { ok: true }; } },
      expectedModeGeneration,
    }, 'diffLock.toggle');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNSUPPORTED');
    assert.equal(taps, 0);
    assert.equal(telemetry.getMockState().diffLock, false);
  }
});

function fastMockWin(opts = {}) {
  return createWorkerClient({
    ...opts,
    keyTapMs: 10,
    responseTimeoutMs: 1000,
    spawnWorker: () => {
      const code = `
const readline = require('readline');
process.stdout.write(JSON.stringify({ ok: true, ready: true, inputSize: 40 }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.op === 'quit') process.exit(0);
  if (msg.op === 'tap') process.stdout.write(JSON.stringify({ ok: true, id: msg.id }) + '\\n');
});
`;
      return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
}

test('requireLive fails after live→mock; requireLive tap never mock-succeeds', async () => {
  const scs = fakeScs([
    baseSnap(true),
    baseSnap(true),
    baseSnap(true),
    baseSnap(true),
    baseSnap(true),
    baseSnap(false),
    baseSnap(false),
    baseSnap(false),
  ]);
  const taps = [];
  const telemetry = createTelemetryService({ forceMock: false }, { platform: 'win32', scs });
  const input = createInputService(
    { forceMock: false, keyTapMs: 10 },
    telemetry,
    {
      createWindowsInput: (opts) => fastMockWin(opts),
      tapLog: (kind, key) => taps.push({ kind, key }),
    },
  );

  telemetry.snapshot();
  assert.equal(telemetry.isMock(), false);
  assert.equal(telemetry.requireLive().ok, true);

  const liveTap = await input.tap('L', { requireLive: true });
  assert.equal(liveTap.ok, true, liveTap.message || '');
  assert.ok(taps.some((t) => t.kind === 'live'));

  // Drain remaining trues then hit false
  for (let i = 0; i < 5; i += 1) telemetry.snapshot();
  assert.equal(telemetry.isMock(), true);
  assert.equal(telemetry.requireLive().ok, false);

  const after = await input.tap('L', { requireLive: true });
  assert.equal(after.ok, false);
  assert.equal(after.error, 'UNSUPPORTED');

  await input.dispose();
});

test('executeCommand does not mock-apply after losing live mid-command', async () => {
  let allowLive = true;
  const scs = {
    available: true,
    reason: 'ok',
    read() {
      return baseSnap(allowLive);
    },
  };
  const telemetry = createTelemetryService({ forceMock: false }, { platform: 'win32', scs });
  const input = createInputService(
    { forceMock: false, keyTapMs: 10 },
    telemetry,
    {
      createWindowsInput: (opts) => {
        const inner = fastMockWin(opts);
        const origTap = inner.tap.bind(inner);
        inner.tap = async (key) => {
          allowLive = false; // drop live after OS tap accepted
          return origTap(key);
        };
        return inner;
      },
    },
  );
  const config = {
    keyTapMs: 10,
    keybinds: {
      'lights.hazard': 'H',
      'lights.parking': 'L',
      'lights.beamLow': 'L',
    },
  };

  telemetry.snapshot();
  assert.equal(telemetry.isMock(), false);
  const result = await executeCommand({ config, telemetry, input }, 'lights.hazard', true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNSUPPORTED');
  assert.equal(telemetry.getMockState().lights.hazard, false);
  await input.dispose();
});
