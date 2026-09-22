'use strict';

const { createMockTelemetry } = require('./mock');
const { createScsTelemetry } = require('./scs');

/**
 * Mode is mock unless: not forceMock AND platform win32 AND scs bridge loadable
 * AND latest shared-memory read has connected/sdkActive === true.
 *
 * @param {object} config
 * @param {object} [deps] injectable for tests: { platform, scs, mock }
 */
function createTelemetryService(config, deps = {}) {
  const platform = deps.platform || process.platform;
  const mock = deps.mock || createMockTelemetry();
  const scs = deps.scs || createScsTelemetry();

  let useMock = true;
  let reason = 'init';
  let modeGeneration = 0;
  /** @type {null|((mock:boolean, reason:string, generation:number) => void)} */
  let modeListener = null;
  let lastLoggedMock = null;

  function computeWantMock(liveSnap) {
    if (config.forceMock) {
      return { mock: true, reason: 'TRUCKDECK_MOCK=1' };
    }
    if (platform !== 'win32') {
      return {
        mock: true,
        reason: `platform ${platform} (real SCS path is Windows-first; Linux runs mock)`,
      };
    }
    if (!scs.available) {
      return { mock: true, reason: `trucksim-telemetry unavailable: ${scs.reason}` };
    }
    if (!liveSnap || !liveSnap.connected) {
      return { mock: true, reason: 'scs shared memory inactive (game/plugin not connected)' };
    }
    return { mock: false, reason: 'scs-sdk-plugin sdkActive' };
  }

  function applyMode(nextMock, nextReason) {
    const changed = lastLoggedMock === null || nextMock !== useMock;
    useMock = nextMock;
    reason = nextReason;
    if (changed) {
      modeGeneration += 1;
      console.log(`[telemetry] mode=${useMock ? 'mock' : 'live'} (${reason}) gen=${modeGeneration}`);
      lastLoggedMock = useMock;
      if (modeListener) {
        try {
          modeListener(useMock, reason, modeGeneration);
        } catch (err) {
          console.warn('[telemetry] modeListener error', err.message);
        }
      }
    }
  }

  applyMode(true, config.forceMock ? 'TRUCKDECK_MOCK=1' : 'pending first probe');

  function isMock() {
    return useMock;
  }

  function canInject() {
    return !useMock;
  }

  function getModeGeneration() {
    return modeGeneration;
  }

  /** Fresh snapshot + require live inject path. */
  function requireLive() {
    snapshot();
    if (useMock || !canInject()) {
      return {
        ok: false,
        error: 'UNSUPPORTED',
        message: 'live telemetry unavailable; refusing key inject',
      };
    }
    return { ok: true };
  }

  function snapshot() {
    let liveSnap = null;
    if (!config.forceMock && platform === 'win32' && scs.available) {
      try {
        liveSnap = scs.read();
      } catch (_) {
        liveSnap = null;
      }
    }
    const m = computeWantMock(liveSnap);
    applyMode(m.mock, m.reason);
    if (useMock) {
      return mock.snapshot();
    }
    return liveSnap;
  }

  function applyMockCommand(action, value) {
    return mock.applyCommand(action, value);
  }

  function onModeChange(fn) {
    modeListener = typeof fn === 'function' ? fn : null;
  }

  return {
    isMock,
    canInject,
    requireLive,
    getModeGeneration,
    getModeReason: () => reason,
    snapshot,
    applyMockCommand,
    getMockState: () => mock.getState(),
    onModeChange,
    scs,
  };
}

module.exports = { createTelemetryService };
