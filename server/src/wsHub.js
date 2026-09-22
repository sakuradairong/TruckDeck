'use strict';

const { WebSocketServer } = require('ws');
const { assertLanRequest, getClientIp } = require('./lan');
const { validateCommand, executeCommand } = require('./commands/handler');
const { createCommandQueue } = require('./commands/queue');

const BUFFERED_AMOUNT_LIMIT = 256 * 1024;

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {
      /* ignore */
    }
  }
}

function helloAckPayload(telemetry, config) {
  return {
    type: 'hello',
    ok: true,
    role: 'server',
    version: '1',
    mock: telemetry.isMock(),
    telemetryHz: config.telemetryHz,
    ts: Date.now(),
  };
}

function createWsHub({ server, config, telemetry, input, queue }) {
  const commandQueue =
    queue ||
    createCommandQueue({
      maxDepth: config.commandQueueMax || 32,
      ttlMs: config.commandTtlMs || 1500,
      getModeGeneration: () => telemetry.getModeGeneration(),
    });
  commandQueue.setGetModeGeneration(() => telemetry.getModeGeneration());

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayload || 8192,
  });
  /** @type {Map<import('ws').WebSocket, object>} */
  const meta = new Map();

  function broadcastHelloUpdate() {
    const payload = JSON.stringify(helloAckPayload(telemetry, config));
    for (const [ws, state] of meta) {
      if (ws.readyState === 1 && state.helloOk) {
        try {
          if (ws.bufferedAmount > BUFFERED_AMOUNT_LIMIT) {
            ws.close();
            continue;
          }
          ws.send(payload);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  telemetry.onModeChange(() => {
    console.log('[ws] telemetry mode generation bumped; stale queued commands will nack');
    broadcastHelloUpdate();
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const host = req.headers.host || '127.0.0.1';
      let url;
      try {
        url = new URL(req.url || '/', `http://${host}`);
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname !== config.wsPath) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const check = assertLanRequest(req, config.port);
      if (!check.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      console.warn('[ws] upgrade error', err.message);
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
  });

  wss.on('connection', (ws, req) => {
    const ip = getClientIp(req);
    const state = {
      helloOk: false,
      ip,
      msgWindowStart: Date.now(),
      msgCount: 0,
      helloTimer: null,
      alive: true,
    };
    meta.set(ws, state);
    console.log(`[ws] open from ${ip}`);

    state.helloTimer = setTimeout(() => {
      if (!state.helloOk) {
        try {
          sendJson(ws, {
            type: 'error',
            error: 'HELLO_REQUIRED',
            message: 'hello timeout',
          });
          ws.close();
        } catch (_) {
          /* ignore */
        }
      }
    }, config.helloTimeoutMs || 10000);

    ws.on('error', (err) => {
      console.warn('[ws] socket error', err.message);
    });

    ws.on('message', (raw) => {
      const st = meta.get(ws);
      if (!st) return;

      const now = Date.now();
      if (now - st.msgWindowStart > 1000) {
        st.msgWindowStart = now;
        st.msgCount = 0;
      }
      st.msgCount += 1;
      if (st.msgCount > (config.msgRateLimit || 30)) {
        sendJson(ws, {
          type: 'error',
          error: 'UNSUPPORTED',
          message: 'rate limited',
        });
        return;
      }

      let msg;
      try {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        msg = JSON.parse(text);
      } catch {
        sendJson(ws, { type: 'error', error: 'INVALID_JSON', message: 'body must be JSON' });
        return;
      }

      if (Array.isArray(msg) || msg === null || typeof msg !== 'object') {
        sendJson(ws, { type: 'error', error: 'INVALID_JSON', message: 'body must be a JSON object' });
        return;
      }

      if (typeof msg.type !== 'string') {
        sendJson(ws, { type: 'error', error: 'UNKNOWN_TYPE', message: 'missing type' });
        return;
      }

      if (msg.type === 'hello') {
        if (msg.role !== 'web' || msg.version !== '1') {
          st.helloOk = false;
          sendJson(ws, {
            type: 'hello',
            ok: false,
            error: 'UNSUPPORTED_VERSION',
            message: 'role must be "web" and version "1"',
          });
          return;
        }
        st.helloOk = true;
        if (st.helloTimer) {
          clearTimeout(st.helloTimer);
          st.helloTimer = null;
        }
        telemetry.snapshot();
        sendJson(ws, helloAckPayload(telemetry, config));
        return;
      }

      if (!st.helloOk) {
        sendJson(ws, {
          type: 'error',
          error: 'HELLO_REQUIRED',
          message: 'send hello before other messages',
        });
        return;
      }

      if (msg.type === 'command') {
        const v = validateCommand(msg);
        if (!v.ok) {
          const nack = {
            type: 'command_nack',
            ok: false,
            action: msg.action,
            error: v.error,
            message: v.message,
            ts: Date.now(),
          };
          if (typeof msg.id === 'string') nack.id = msg.id;
          sendJson(ws, nack);
          return;
        }

        const modeGeneration = telemetry.getModeGeneration();
        commandQueue
          .enqueue(
            () => executeCommand({ config, telemetry, input, expectedModeGeneration: modeGeneration }, v.action, v.value),
            {
              modeGeneration,
              sessionOk: () => st.alive && st.helloOk,
            },
          )
          .then((result) => {
            if (!result) {
              result = { ok: false, error: 'INJECT_FAILED', message: 'empty result' };
            }
            if (result.ok) {
              const ack = {
                type: 'command_ack',
                ok: true,
                action: v.action,
                ts: Date.now(),
              };
              if (typeof msg.id === 'string') ack.id = msg.id;
              sendJson(ws, ack);
            } else {
              const nack = {
                type: 'command_nack',
                ok: false,
                action: v.action,
                error: result.error || 'INJECT_FAILED',
                message: result.message || 'command failed',
                ts: Date.now(),
              };
              if (typeof msg.id === 'string') nack.id = msg.id;
              sendJson(ws, nack);
            }
          })
          .catch((err) => {
            console.warn('[ws] command error', err.message);
            const nack = {
              type: 'command_nack',
              ok: false,
              action: v.action,
              error: 'INJECT_FAILED',
              message: String(err.message || err),
              ts: Date.now(),
            };
            if (typeof msg.id === 'string') nack.id = msg.id;
            sendJson(ws, nack);
          });
        return;
      }

      sendJson(ws, {
        type: 'error',
        error: 'UNKNOWN_TYPE',
        message: `unknown type ${msg.type}`,
      });
    });

    ws.on('close', () => {
      state.alive = false;
      if (state.helloTimer) clearTimeout(state.helloTimer);
      meta.delete(ws);
      console.log(`[ws] close from ${ip}`);
    });
  });

  // Match configured Hz (e.g. 30 → ~33ms). Floor at 16ms for timer sanity.
  const intervalMs = Math.max(16, Math.round(1000 / config.telemetryHz));
  const broadcastTimer = setInterval(() => {
    try {
      const data = telemetry.snapshot();
      const payload = JSON.stringify({ type: 'telemetry', ts: Date.now(), data });
      for (const [ws, state] of meta) {
        if (ws.readyState !== 1 || !state.helloOk) continue;
        if (ws.bufferedAmount > BUFFERED_AMOUNT_LIMIT) {
          try {
            ws.close();
          } catch (_) {
            /* ignore */
          }
          continue;
        }
        try {
          ws.send(payload);
        } catch (_) {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn('[ws] telemetry tick error', err.message);
    }
  }, intervalMs);

  return {
    wss,
    commandQueue,
    async dispose() {
      clearInterval(broadcastTimer);
      commandQueue.close();
      await commandQueue.drain();
      for (const [ws, state] of meta) {
        state.alive = false;
        if (state.helloTimer) clearTimeout(state.helloTimer);
        try {
          ws.close();
        } catch (_) {
          /* ignore */
        }
      }
      meta.clear();
    },
  };
}

module.exports = { createWsHub, helloAckPayload };
