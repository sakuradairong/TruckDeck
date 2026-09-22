'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
/** Frozen WebSocket path — not overridable by config file. */
const WS_PATH = '/ws';

const KEY_WHITELIST = new Set([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'Space', 'Tab', 'Escape', 'Enter', 'Backspace',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash',
  'Minus', 'Equal', 'Backquote',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function finiteInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function loadConfig() {
  const serverDefaults = readJson(path.join(ROOT, 'config', 'server.default.json'));
  const keybindsRaw = readJson(path.join(ROOT, 'config', 'keybinds.default.json'));

  let port = finiteInt(process.env.TRUCKDECK_PORT || serverDefaults.port || 4000, 4000);
  if (port < 1 || port > 65535) {
    throw new Error(`invalid port ${port}; expected 1..65535`);
  }

  let telemetryHz = finiteInt(serverDefaults.telemetryHz || 10, 10);
  if (telemetryHz < 5) telemetryHz = 5;
  if (telemetryHz > 30) telemetryHz = 30;

  let keyTapMs = finiteInt(serverDefaults.keyTapMs || 50, 50);
  if (keyTapMs < 10) keyTapMs = 10;
  if (keyTapMs > 500) keyTapMs = 500;

  // Ignore any config attempt to change ws path
  if (serverDefaults.wsPath && serverDefaults.wsPath !== WS_PATH) {
    console.warn(`[config] ignoring wsPath=${serverDefaults.wsPath}; frozen at ${WS_PATH}`);
  }

  const forceMock = process.env.TRUCKDECK_MOCK === '1' || process.env.TRUCKDECK_MOCK === 'true';

  const keybinds = {};
  for (const [action, key] of Object.entries(keybindsRaw)) {
    if (action.startsWith('_')) continue;
    if (key === null || key === undefined || key === '') {
      keybinds[action] = null;
      continue;
    }
    if (typeof key !== 'string' || !KEY_WHITELIST.has(key)) {
      throw new Error(`keybinds: action "${action}" has non-whitelisted key "${key}"`);
    }
    keybinds[action] = key;
  }

  return {
    root: ROOT,
    port,
    telemetryHz,
    wsPath: WS_PATH,
    keyTapMs,
    forceMock,
    keybinds,
    publicDir: path.join(ROOT, 'server', 'public'),
    commandQueueMax: 32,
    maxPayload: 8192,
    helloTimeoutMs: 10000,
    msgRateLimit: 30,
  };
}

module.exports = { loadConfig, KEY_WHITELIST, ROOT, WS_PATH };
