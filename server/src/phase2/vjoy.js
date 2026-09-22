'use strict';

/**
 * Phase 2 vJoy / gyro axis controller — interface draft only.
 * See docs/PHASE2_VJOY.md. Do NOT implement vJoy in v1.
 */

function createVjoyController(/* options */) {
  return {
    isAvailable() {
      return false;
    },
    async start() {
      // TODO(phase2): initialize vJoy device
      return { ok: false, error: 'UNSUPPORTED', message: 'vJoy not implemented in v1' };
    },
    async stop() {
      // TODO(phase2): reset axes to center and release device
      return { ok: true };
    },
    async setAxes(/* axes */) {
      // TODO(phase2): map steer/throttle/brake to vJoy axes
      return { ok: false, error: 'UNSUPPORTED', message: 'vJoy not implemented in v1' };
    },
  };
}

module.exports = { createVjoyController };
