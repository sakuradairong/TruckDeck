'use strict';

/**
 * Mock input: never injects keys into the host OS.
 */
function createMockInput() {
  return {
    kind: 'mock',
    async tap() {
      return { ok: true, injected: false };
    },
    async tapTimes() {
      return { ok: true, injected: false };
    },
    async dispose() {},
  };
}

module.exports = { createMockInput };
