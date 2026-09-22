'use strict';

const WIPER_ORDER = ['off', 'auto', '1', '2', '3'];

function createEmptyState() {
  return {
    connected: true,
    speedKmh: 0,
    engineRpm: 800,
    gear: 0,
    fuelPct: 72,
    airPressure: 120,
    lights: {
      parking: false,
      beamLow: false,
      beamHigh: false,
      blinkerLeft: false,
      blinkerRight: false,
      hazard: false,
    },
    wipers: 'off',
    handbrake: true,
    diffLock: false,
    liftAxle: false,
    cruise: false,
    engineOn: true,
  };
}

function createMockTelemetry() {
  const state = createEmptyState();
  let t0 = Date.now();
  let driving = false;

  function tick() {
    const elapsed = (Date.now() - t0) / 1000;
    if (state.engineOn) {
      if (driving) {
        state.speedKmh = Math.max(0, 40 + Math.sin(elapsed / 3) * 25);
        state.engineRpm = 1100 + Math.sin(elapsed * 1.7) * 400 + state.speedKmh * 8;
        state.gear = state.speedKmh < 5 ? 1 : Math.min(12, 1 + Math.floor(state.speedKmh / 12));
      } else {
        state.speedKmh = Math.max(0, state.speedKmh * 0.98);
        state.engineRpm = 750 + Math.sin(elapsed * 2) * 30;
        if (state.speedKmh < 0.5) {
          state.speedKmh = 0;
          state.gear = 0;
        }
      }
      state.fuelPct = Math.max(5, state.fuelPct - 0.0005);
      state.airPressure = 100 + Math.sin(elapsed / 5) * 15;
    } else {
      state.speedKmh = 0;
      state.engineRpm = 0;
      state.gear = 0;
    }
    state.speedKmh = Math.round(state.speedKmh * 10) / 10;
    state.engineRpm = Math.round(state.engineRpm);
    state.fuelPct = Math.round(state.fuelPct * 10) / 10;
    state.airPressure = Math.round(state.airPressure * 10) / 10;
  }

  function snapshot() {
    tick();
    return JSON.parse(JSON.stringify(state));
  }

  function applyCommand(action, value) {
    switch (action) {
      case 'lights.parking':
        state.lights.parking = Boolean(value);
        break;
      case 'lights.beamLow':
        state.lights.beamLow = Boolean(value);
        break;
      case 'lights.beamHigh':
        state.lights.beamHigh = Boolean(value);
        break;
      case 'lights.blinkerLeft':
        state.lights.blinkerLeft = Boolean(value);
        if (value) state.lights.blinkerRight = false;
        break;
      case 'lights.blinkerRight':
        state.lights.blinkerRight = Boolean(value);
        if (value) state.lights.blinkerLeft = false;
        break;
      case 'lights.hazard':
        state.lights.hazard = Boolean(value);
        break;
      case 'wipers.set':
        if (!WIPER_ORDER.includes(value)) {
          return { ok: false, error: 'INVALID_VALUE', message: 'wipers value invalid' };
        }
        state.wipers = value;
        break;
      case 'handbrake.toggle':
        state.handbrake = !state.handbrake;
        driving = !state.handbrake && state.engineOn;
        break;
      case 'diffLock.toggle':
        state.diffLock = !state.diffLock;
        break;
      case 'liftAxle.toggle':
        state.liftAxle = !state.liftAxle;
        break;
      case 'cruise.toggle':
        state.cruise = !state.cruise;
        break;
      case 'engine.toggle':
        state.engineOn = !state.engineOn;
        if (!state.engineOn) {
          driving = false;
          state.cruise = false;
        } else if (!state.handbrake) {
          driving = true;
        }
        break;
      default:
        return { ok: false, error: 'UNKNOWN_ACTION', message: `unknown action ${action}` };
    }
    console.log(`[mock] command ${action}`, value === undefined ? '' : value, '→', {
      lights: state.lights,
      wipers: state.wipers,
      handbrake: state.handbrake,
      diffLock: state.diffLock,
      liftAxle: state.liftAxle,
      cruise: state.cruise,
      engineOn: state.engineOn,
    });
    return { ok: true };
  }

  return {
    mode: 'mock',
    snapshot,
    applyCommand,
    getState: () => state,
  };
}

module.exports = { createMockTelemetry, WIPER_ORDER, createEmptyState };
