'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryService } = require('../server/src/telemetry');

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
    speedKmh: connected ? 10 : 0,
    engineRpm: connected ? 1000 : 0,
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

test('mock→live→mock follows sdkActive/connected', () => {
  const modes = [];
  const scs = fakeScs([
    baseSnap(false),
    baseSnap(true),
    baseSnap(true),
    baseSnap(false),
  ]);
  const telemetry = createTelemetryService(
    { forceMock: false },
    { platform: 'win32', scs },
  );
  telemetry.onModeChange((m) => modes.push(m));

  let s = telemetry.snapshot();
  assert.equal(telemetry.isMock(), true);
  assert.equal(s.connected, true);

  s = telemetry.snapshot();
  assert.equal(telemetry.isMock(), false);
  assert.equal(s.connected, true);
  assert.equal(telemetry.canInject(), true);

  s = telemetry.snapshot();
  assert.equal(telemetry.isMock(), false);

  s = telemetry.snapshot();
  assert.equal(telemetry.isMock(), true);
  assert.equal(telemetry.canInject(), false);

  assert.ok(modes.includes(false));
  assert.ok(modes.includes(true));
});

test('forceMock never goes live', () => {
  const scs = fakeScs([baseSnap(true), baseSnap(true)]);
  const telemetry = createTelemetryService(
    { forceMock: true },
    { platform: 'win32', scs },
  );
  telemetry.snapshot();
  assert.equal(telemetry.isMock(), true);
  assert.equal(telemetry.canInject(), false);
});
