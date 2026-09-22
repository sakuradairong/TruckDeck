'use strict';

const { WIPER_ORDER } = require('../telemetry/mock');
const { planSharedLightCycle, planToggleTap } = require('./lightCycle');

const LIGHT_ACTIONS = new Set([
  'lights.parking',
  'lights.beamLow',
  'lights.beamHigh',
  'lights.blinkerLeft',
  'lights.blinkerRight',
  'lights.hazard',
]);

const SHARED_CYCLE_LIGHTS = new Set(['lights.parking', 'lights.beamLow']);

const TOGGLE_ACTIONS = new Set([
  'handbrake.toggle',
  'diffLock.toggle',
  'liftAxle.toggle',
  'cruise.toggle',
  'engine.toggle',
]);

const LIGHT_STATE_KEY = {
  'lights.parking': 'parking',
  'lights.beamLow': 'beamLow',
  'lights.beamHigh': 'beamHigh',
  'lights.blinkerLeft': 'blinkerLeft',
  'lights.blinkerRight': 'blinkerRight',
  'lights.hazard': 'hazard',
};

const TELEMETRY_WAIT_MS = 600;
const TAP_SETTLE_MS = 80;

function validateCommand(msg) {
  if (!msg || typeof msg.action !== 'string') {
    return { ok: false, error: 'UNKNOWN_ACTION', message: 'action required' };
  }
  const { action } = msg;
  const hasValue = Object.prototype.hasOwnProperty.call(msg, 'value');

  if (LIGHT_ACTIONS.has(action)) {
    if (!hasValue || typeof msg.value !== 'boolean') {
      return { ok: false, error: 'INVALID_VALUE', message: `${action} requires boolean value` };
    }
    return { ok: true, action, value: msg.value };
  }

  if (action === 'wipers.set') {
    if (!hasValue || typeof msg.value !== 'string' || !WIPER_ORDER.includes(msg.value)) {
      return {
        ok: false,
        error: 'INVALID_VALUE',
        message: 'wipers.set value must be off|auto|1|2|3',
      };
    }
    return { ok: true, action, value: msg.value };
  }

  if (TOGGLE_ACTIONS.has(action)) {
    if (hasValue && msg.value !== null && msg.value !== undefined) {
      return {
        ok: false,
        error: 'INVALID_VALUE',
        message: `${action} must omit value or use null`,
      };
    }
    return { ok: true, action, value: undefined };
  }

  return { ok: false, error: 'UNKNOWN_ACTION', message: `unknown action ${action}` };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function liveTap(input, key) {
  return input.tap(key, { requireLive: true });
}

async function waitLiveMatch(telemetry, pred, timeoutMs = TELEMETRY_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const g = telemetry.requireLive();
    if (!g.ok) return g;
    const snap = telemetry.snapshot();
    const g2 = telemetry.requireLive();
    if (!g2.ok) return g2;
    if (pred(snap)) return { ok: true, snap };
    await sleep(40);
  }
  const g = telemetry.requireLive();
  if (!g.ok) return g;
  return { ok: false, error: 'INJECT_FAILED', message: 'telemetry did not reach target in time' };
}

async function executeLiveWipers(ctx, value) {
  const { config, telemetry, input } = ctx;
  const binds = config.keybinds;

  const dedicated = {
    off: binds['wipers.off'],
    auto: binds['wipers.auto'],
    1: binds['wipers.1'],
    2: binds['wipers.2'],
    3: binds['wipers.3'],
  };

  let g = telemetry.requireLive();
  if (!g.ok) return g;

  if (dedicated[value]) {
    const r = await liveTap(input, dedicated[value]);
    if (!r.ok) return r;
    g = telemetry.requireLive();
    if (!g.ok) return g;
    return { ok: true };
  }

  if (value === 'auto') {
    return {
      ok: false,
      error: 'UNSUPPORTED',
      message: 'wipers AUTO has no keybind mapping',
    };
  }

  if (value === '2' || value === '3') {
    return {
      ok: false,
      error: 'UNSUPPORTED',
      message:
        'game SDK only reports wipers on/off; discrete level 2/3 cannot be verified without dedicated keybind',
    };
  }

  const cycleKey = binds['wipers.cycle'];
  const snap = telemetry.snapshot();
  g = telemetry.requireLive();
  if (!g.ok) return g;

  if (value === 'off') {
    if (snap.wipers === 'off') return { ok: true };
    if (!cycleKey) {
      return { ok: false, error: 'NOT_MAPPED', message: 'no keybind for wipers.cycle' };
    }
    for (let i = 0; i < 5; i += 1) {
      g = telemetry.requireLive();
      if (!g.ok) return g;
      const r = await liveTap(input, cycleKey);
      if (!r.ok) return r;
      const matched = await waitLiveMatch(telemetry, (s) => s.wipers === 'off');
      if (matched.ok) return { ok: true };
      if (matched.error === 'UNSUPPORTED') return matched;
    }
    return {
      ok: false,
      error: 'INJECT_FAILED',
      message: 'could not reach wipers off per telemetry',
    };
  }

  if (value === '1') {
    if (snap.wipers !== 'off') return { ok: true };
    if (!cycleKey) {
      return { ok: false, error: 'NOT_MAPPED', message: 'no keybind for wipers.cycle' };
    }
    const r = await liveTap(input, cycleKey);
    if (!r.ok) return r;
    const matched = await waitLiveMatch(telemetry, (s) => s.wipers !== 'off');
    if (!matched.ok) {
      return matched.error
        ? matched
        : { ok: false, error: 'INJECT_FAILED', message: 'wipers still off after cycle tap' };
    }
    return { ok: true };
  }

  return { ok: false, error: 'UNSUPPORTED', message: `unsupported wiper target ${value}` };
}

async function executeLiveLights(ctx, action, value) {
  const { config, telemetry, input } = ctx;
  const key = config.keybinds[action];
  if (!key) {
    return { ok: false, error: 'NOT_MAPPED', message: `no keybind for ${action}` };
  }

  let g = telemetry.requireLive();
  if (!g.ok) return g;
  const current = telemetry.snapshot();
  g = telemetry.requireLive();
  if (!g.ok) return g;

  if (
    SHARED_CYCLE_LIGHTS.has(action) &&
    config.keybinds['lights.parking'] === config.keybinds['lights.beamLow']
  ) {
    const plan = planSharedLightCycle(current.lights, action, value);
    if (plan.noop) return { ok: true };
    for (let i = 0; i < plan.taps; i += 1) {
      g = telemetry.requireLive();
      if (!g.ok) return g;
      const r = await liveTap(input, key);
      if (!r.ok) return r;
      await sleep(Math.max(TAP_SETTLE_MS, config.keyTapMs + 40));
      g = telemetry.requireLive();
      if (!g.ok) return g;
    }
    const stateKey = LIGHT_STATE_KEY[action];
    const matched = await waitLiveMatch(telemetry, (after) => {
      if (Boolean(after.lights[stateKey]) === Boolean(value)) return true;
      if (action === 'lights.parking' && value === true && after.lights.parking) return true;
      if (
        action === 'lights.parking' &&
        value === false &&
        !after.lights.parking &&
        !after.lights.beamLow
      ) {
        return true;
      }
      return false;
    });
    if (!matched.ok) {
      return matched.error
        ? matched
        : {
            ok: false,
            error: 'INJECT_FAILED',
            message: `light cycle did not reach target for ${action}`,
          };
    }
    return { ok: true };
  }

  const stateKey = LIGHT_STATE_KEY[action];
  const plan = planToggleTap(current.lights[stateKey], value);
  if (plan.noop) return { ok: true };

  // Single tap only — wait for telemetry; never blind re-tap
  const r = await liveTap(input, key);
  if (!r.ok) return r;
  const matched = await waitLiveMatch(
    telemetry,
    (after) => Boolean(after.lights[stateKey]) === Boolean(value),
  );
  if (!matched.ok) {
    return matched.error
      ? matched
      : {
          ok: false,
          error: 'INJECT_FAILED',
          message: `light state mismatch for ${action}`,
        };
  }
  return { ok: true };
}

async function executeCommand(ctx, action, value) {
  const { config, telemetry, input } = ctx;

  telemetry.snapshot();

  // The fresh read itself can discover a mode change after the queue's check.
  if (ctx.expectedModeGeneration !== undefined &&
      ctx.expectedModeGeneration !== telemetry.getModeGeneration()) {
    return { ok: false, error: 'UNSUPPORTED', message: 'telemetry mode changed; command discarded' };
  }

  // Intentional mock mode: apply mock state changes only
  if (telemetry.isMock() || !telemetry.canInject()) {
    // If caller thought they were live but we are mock: still mock path only when
    // started as mock. Mid-live loss is handled inside live* via requireLive.
    return telemetry.applyMockCommand(action, value);
  }

  if (LIGHT_ACTIONS.has(action)) {
    return executeLiveLights(ctx, action, value);
  }

  if (action === 'wipers.set') {
    return executeLiveWipers(ctx, value);
  }

  if (TOGGLE_ACTIONS.has(action)) {
    const key = config.keybinds[action];
    if (!key) {
      return { ok: false, error: 'NOT_MAPPED', message: `no keybind for ${action}` };
    }
    const g = telemetry.requireLive();
    if (!g.ok) return g;
    return liveTap(input, key);
  }

  return { ok: false, error: 'UNKNOWN_ACTION', message: `unknown action ${action}` };
}

module.exports = {
  validateCommand,
  executeCommand,
  LIGHT_ACTIONS,
  TOGGLE_ACTIONS,
  WIPER_ORDER,
  SHARED_CYCLE_LIGHTS,
};
