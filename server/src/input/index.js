'use strict';

const { createMockInput } = require('./mock');
const { createWindowsInput } = require('./windows');

/**
 * Facade: requireLive taps never degrade to successful mock taps.
 */
function createInputService(config, telemetry, deps = {}) {
  const mockInput = createMockInput();
  const createWin = deps.createWindowsInput || createWindowsInput;
  let winInput = null;
  const tapLog = deps.tapLog || null;

  function ensureLiveBackend() {
    if (telemetry.isMock() || !telemetry.canInject()) return null;
    const allow =
      deps.createWindowsInput || (process.platform === 'win32' && !config.forceMock);
    if (!allow) return null;
    if (!winInput) {
      console.log('[input] starting live key worker');
      winInput = createWin({
        keyTapMs: config.keyTapMs,
        beforeSend: () => {
          telemetry.snapshot();
          if (telemetry.isMock() || !telemetry.canInject()) {
            return {
              ok: false,
              error: 'UNSUPPORTED',
              message: 'mode lost before SendInput write',
            };
          }
          return { ok: true };
        },
      });
    }
    return winInput;
  }

  return {
    kind: 'facade',
    async tap(keyName, opts = {}) {
      if (opts.requireLive) {
        telemetry.snapshot();
        const backend = ensureLiveBackend();
        if (!backend) {
          return {
            ok: false,
            error: 'UNSUPPORTED',
            message: 'live inject unavailable',
          };
        }
        if (tapLog) tapLog('live', keyName);
        return backend.tap(keyName);
      }
      if (tapLog) tapLog('mock', keyName);
      return mockInput.tap(keyName);
    },
    async tapTimes(keyName, times, opts = {}) {
      const n = Math.max(0, Math.min(10, Number(times) || 0));
      for (let i = 0; i < n; i += 1) {
        const r = await this.tap(keyName, opts);
        if (!r.ok) return r;
      }
      return { ok: true, injected: Boolean(opts.requireLive) };
    },
    async dispose() {
      if (winInput) {
        await winInput.dispose();
        winInput = null;
      }
      await mockInput.dispose();
    },
  };
}

module.exports = { createInputService };
