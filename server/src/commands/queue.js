'use strict';

/**
 * Process-wide bounded serial queue. Captures mode generation + enqueue time;
 * stale/expired/session-invalid jobs are skipped with UNSUPPORTED.
 */

function createCommandQueue(options = {}) {
  const maxDepth = Number(options.maxDepth || 32);
  const ttlMs = Number(options.ttlMs || 1500);
  let depth = 0;
  let chain = Promise.resolve();
  let closed = false;
  let getModeGeneration = options.getModeGeneration || (() => 0);

  function size() {
    return depth;
  }

  function isClosed() {
    return closed;
  }

  /**
   * @param {() => Promise<object>} fn
   * @param {{ modeGeneration?: number, sessionOk?: () => boolean }} meta
   */
  function enqueue(fn, meta = {}) {
    if (closed) {
      return Promise.resolve({
        ok: false,
        error: 'UNSUPPORTED',
        message: 'command queue closed',
      });
    }
    if (depth >= maxDepth) {
      return Promise.resolve({
        ok: false,
        error: 'UNSUPPORTED',
        message: 'command queue full; retry later',
      });
    }
    const enqueuedAt = Date.now();
    const modeGen = meta.modeGeneration;
    const sessionOk = meta.sessionOk;
    depth += 1;
    const run = chain.then(async () => {
      if (closed) {
        return { ok: false, error: 'UNSUPPORTED', message: 'command queue closed' };
      }
      if (Date.now() - enqueuedAt > ttlMs) {
        return { ok: false, error: 'UNSUPPORTED', message: 'command expired' };
      }
      if (typeof sessionOk === 'function' && !sessionOk()) {
        return { ok: false, error: 'UNSUPPORTED', message: 'session closed' };
      }
      if (modeGen !== undefined && modeGen !== getModeGeneration()) {
        return {
          ok: false,
          error: 'UNSUPPORTED',
          message: 'telemetry mode changed; command discarded',
        };
      }
      return fn();
    });
    chain = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      depth -= 1;
    });
  }

  function close() {
    closed = true;
  }

  async function drain() {
    await chain;
  }

  return {
    enqueue,
    close,
    isClosed,
    size,
    drain,
    maxDepth,
    ttlMs,
    setGetModeGeneration(fn) {
      getModeGeneration = fn;
    },
  };
}

module.exports = { createCommandQueue };
