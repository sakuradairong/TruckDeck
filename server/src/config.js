'use strict';

const path = require('path');
const fs = require('fs');
const { readGameKeybinds } = require('./keybindsGame');

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

function loadConfig(env = process.env) {
  const serverDefaults = readJson(path.join(ROOT, 'config', 'server.default.json'));
  const keybindsRaw = readJson(path.join(ROOT, 'config', 'keybinds.default.json'));

  let port = finiteInt(env.TRUCKDECK_PORT || serverDefaults.port || 4000, 4000);
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

  const forceMock = env.TRUCKDECK_MOCK === '1' || env.TRUCKDECK_MOCK === 'true';

  // 输入通道：keyboard（SendInput）| scs（scs_sdk_controller 语义输入）| auto（优先 scs，失败回退键盘）
  let inputMode = String(env.TRUCKDECK_INPUT || serverDefaults.inputMode || 'keyboard').toLowerCase();
  if (inputMode !== 'keyboard' && inputMode !== 'scs' && inputMode !== 'auto') {
    console.warn(`[config] 未知 inputMode "${inputMode}"，回退 keyboard`);
    inputMode = 'keyboard';
  }
  const scsWipersResetOnConnect =
    serverDefaults.scsWipersResetOnConnect !== false && env.TRUCKDECK_SCS_WIPERS_RESET !== '0';

  // ---- 键位来源优先级：游戏 controls.sii（auto）→ 回退 keybinds.default.json → keybinds.local.json 覆盖 ----
  const keybindsMode = String(env.TRUCKDECK_KEYBINDS || serverDefaults.keybindsMode || 'auto').toLowerCase();
  const mergedRaw = {};
  for (const [action, key] of Object.entries(keybindsRaw)) {
    if (action.startsWith('_')) continue;
    mergedRaw[action] = key === undefined ? null : key;
  }
  const sources = ['config/keybinds.default.json'];

  if (keybindsMode !== 'file' && keybindsMode !== 'off') {
    const gameKeys = readGameKeybinds({ env });
    if (gameKeys.ok) {
      for (const [action, key] of Object.entries(gameKeys.keybinds)) mergedRaw[action] = key;
      sources.length = 0;
      sources.push(`游戏 ${gameKeys.source.game} 存档 ${gameKeys.source.profile} 的 controls.sii`);
      if (gameKeys.unsupported.length > 0) {
        console.warn(
          '[config] 游戏中以下动作绑定了不可注入的键，已忽略：' +
            gameKeys.unsupported.map((u) => `${u.action}=${u.scsKey}`).join(', '),
        );
      }
    } else {
      sources[0] = `config/keybinds.default.json（未读取到游戏键位：${gameKeys.reason}）`;
    }
  }

  const localKeyPath = path.join(ROOT, 'config', 'keybinds.local.json');
  if (fs.existsSync(localKeyPath)) {
    try {
      const localRaw = readJson(localKeyPath);
      let applied = 0;
      for (const [action, key] of Object.entries(localRaw)) {
        if (action.startsWith('_')) continue;
        mergedRaw[action] = key === undefined ? null : key;
        applied += 1;
      }
      if (applied > 0) sources.push(`config/keybinds.local.json（${applied} 项覆盖）`);
    } catch (err) {
      console.warn('[config] keybinds.local.json 解析失败，已忽略：' + err.message);
    }
  }

  const keybinds = {};
  for (const [action, key] of Object.entries(mergedRaw)) {
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
    keybindsMode,
    keybindsSource: sources.join(' + '),
    inputMode,
    scsWipersResetOnConnect,
    publicDir: path.join(ROOT, 'server', 'public'),
    commandQueueMax: 32,
    maxPayload: 8192,
    helloTimeoutMs: 10000,
    msgRateLimit: 30,
  };
}

module.exports = { loadConfig, KEY_WHITELIST, ROOT, WS_PATH };
