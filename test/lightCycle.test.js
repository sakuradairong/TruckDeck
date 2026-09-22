'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planSharedLightCycle, classifyLightPos } = require('../server/src/commands/lightCycle');

test('classify light positions', () => {
  assert.equal(classifyLightPos({ parking: false, beamLow: false }), 0);
  assert.equal(classifyLightPos({ parking: true, beamLow: false }), 1);
  assert.equal(classifyLightPos({ parking: true, beamLow: true }), 2);
});

test('parking/beamLow shared cycle planning', () => {
  const off = { parking: false, beamLow: false };
  const park = { parking: true, beamLow: false };
  const low = { parking: true, beamLow: true };

  assert.deepEqual(planSharedLightCycle(off, 'lights.parking', true).taps, 1);
  assert.equal(planSharedLightCycle(park, 'lights.parking', true).noop, true);
  assert.equal(planSharedLightCycle(low, 'lights.parking', true).noop, true);

  assert.equal(planSharedLightCycle(off, 'lights.parking', false).noop, true);
  assert.equal(planSharedLightCycle(park, 'lights.parking', false).taps, 2);
  assert.equal(planSharedLightCycle(low, 'lights.parking', false).taps, 1);
  assert.match(planSharedLightCycle(low, 'lights.parking', false).note || '', /coupling|clears/i);

  assert.equal(planSharedLightCycle(off, 'lights.beamLow', true).taps, 2);
  assert.equal(planSharedLightCycle(park, 'lights.beamLow', true).taps, 1);
  assert.equal(planSharedLightCycle(low, 'lights.beamLow', true).noop, true);

  assert.equal(planSharedLightCycle(low, 'lights.beamLow', false).taps, 1);
  assert.match(planSharedLightCycle(low, 'lights.beamLow', false).note || '', /full off/i);
  assert.equal(planSharedLightCycle(park, 'lights.beamLow', false).noop, true);
});
