'use strict';

/**
 * 从游戏 profile 的 controls.sii 读取**玩家真实键位**，避免手抄键位或抄错。
 *
 * 数据来源（按顺序尝试）：
 *   <Documents>/Euro Truck Simulator 2/{steam_profiles,profiles}/<profile>/controls.sii
 *   <Documents>/American Truck Simulator/{steam_profiles,profiles}/<profile>/controls.sii
 * Documents 目录按 TRUCKDECK_DOCS → %USERPROFILE%\Documents → OneDrive 各变体尝试；
 * 多个 profile 时优先取 controls.sii 修改时间最新的。
 *
 * 文件格式（实测 ETS2 1.6x）：
 *   config_lines[420]: "mix flasher4way `keyboard.f?0 || modifier(...) | semantical.flasher4way?0`"
 * 只取表达式中第一个 `keyboard.<键>?0`，并映射到本项目内部键名（白名单内才可注入）。
 *
 * 注意：内部 mix 名与直觉不同——双闪是 flasher4way，手刹是 parkingbrake，
 * 差速锁是 diflock，定速是 cruiectrl。雨刮档位 0..4 只有 semantical 绑定、
 * 没有键盘绑定，因此无法从本文件推断，保持不映射。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const GAME_DIRS = ['Euro Truck Simulator 2', 'American Truck Simulator'];
const PROFILE_SUBDIRS = ['steam_profiles', 'profiles'];

/** TruckDeck 动作 → controls.sii 中的 mix 名称 */
const ACTION_TO_MIX = {
  'lights.parking': 'light',
  'lights.beamLow': 'light',
  'lights.beamHigh': 'hblight',
  'lights.blinkerLeft': 'lblinker',
  'lights.blinkerRight': 'rblinker',
  'lights.hazard': 'flasher4way',
  'wipers.cycle': 'wipers',
  'handbrake.toggle': 'parkingbrake',
  'diffLock.toggle': 'diflock',
  'liftAxle.toggle': 'liftaxle',
  'cruise.toggle': 'cruiectrl',
  'engine.toggle': 'engine',
};

/** controls.sii 键名 → 内部键名（严格限制在可注入的白名单内；小键盘/Pause/ScrollLock 不映射） */
const SCS_KEY_MAP = (() => {
  const map = {
    space: 'Space', tab: 'Tab', esc: 'Escape', enter: 'Enter', backspace: 'Backspace',
    lshift: 'ShiftLeft', rshift: 'ShiftRight', lctrl: 'ControlLeft', rctrl: 'ControlRight',
    lalt: 'AltLeft', ralt: 'AltRight',
    lbracket: 'BracketLeft', rbracket: 'BracketRight',
    semicolon: 'Semicolon', apostrophe: 'Quote', comma: 'Comma', period: 'Period',
    slash: 'Slash', backslash: 'Backslash', minus: 'Minus', equal: 'Equal', grave: 'Backquote',
    uarrow: 'ArrowUp', darrow: 'ArrowDown', larrow: 'ArrowLeft', rarrow: 'ArrowRight',
    home: 'Home', end: 'End', pgup: 'PageUp', pgdn: 'PageDown', ins: 'Insert', del: 'Delete',
  };
  for (let i = 1; i <= 12; i += 1) map['f' + i] = 'F' + i;
  for (let i = 0; i < 26; i += 1) {
    const ch = String.fromCharCode(97 + i);
    map[ch] = ch.toUpperCase();
  }
  return map;
})();

function documentCandidates(env = process.env) {
  // 显式指定时不再探测，便于测试与自定义文档目录
  if (env.TRUCKDECK_DOCS) return [env.TRUCKDECK_DOCS];
  const home = os.homedir();
  const list = [
    path.join(home, 'Documents'),
    env.OneDrive && path.join(env.OneDrive, 'Documents'),
    env.OneDriveCommercial && path.join(env.OneDriveCommercial, 'Documents'),
    env.OneDriveConsumer && path.join(env.OneDriveConsumer, 'Documents'),
  ];
  return Array.from(new Set(list.filter(Boolean)));
}

/** 列出找到的所有 controls.sii（含修改时间），按时间倒序 */
function findControlsFiles(env = process.env) {
  const found = [];
  for (const docs of documentCandidates(env)) {
    for (const game of GAME_DIRS) {
      const gameRoot = path.join(docs, game);
      if (!fs.existsSync(gameRoot)) continue;
      for (const sub of PROFILE_SUBDIRS) {
        const pdir = path.join(gameRoot, sub);
        if (!fs.existsSync(pdir)) continue;
        let entries = [];
        try {
          entries = fs.readdirSync(pdir);
        } catch (err) {
          continue;
        }
        for (const name of entries) {
          const file = path.join(pdir, name, 'controls.sii');
          try {
            const st = fs.statSync(file);
            if (st.isFile()) found.push({ game: game, sub: sub, profile: name, file: file, mtimeMs: st.mtimeMs });
          } catch (err) { /* 不是文件则跳过 */ }
        }
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 解析 controls.sii 文本 → { mix 名: SCS 键名 }（每个 mix 只保留第一个键盘键） */
function parseKeyboardMix(siiText) {
  const out = {};
  const lineRe = /"mix\s+([a-z0-9_]+)\s*`([^`]*)`/gi;
  let m = lineRe.exec(String(siiText));
  while (m) {
    const mixName = m[1].toLowerCase();
    const expr = m[2];
    const keyM = /keyboard\.([a-z0-9_]+)\?/i.exec(expr);
    if (keyM && !(mixName in out)) out[mixName] = keyM[1].toLowerCase();
    m = lineRe.exec(String(siiText));
  }
  return out;
}

/** 合并多份 controls.sii 的 mix（前面的优先，用于 profiles/ 与 steam_profiles/ 都读） */
function parseKeyboardMixAll(texts) {
  const merged = {};
  for (const text of texts) {
    const one = parseKeyboardMix(text);
    for (const [mix, key] of Object.entries(one)) {
      if (!(mix in merged)) merged[mix] = key;
    }
  }
  return merged;
}

/** mix → TruckDeck 动作（多个动作可共用同一 mix，如 light） */
function mapToActions(mixKeys) {
  const keybinds = {};
  const unsupported = [];
  for (const [action, mix] of Object.entries(ACTION_TO_MIX)) {
    if (!mix) continue;
    const scsKey = mixKeys[mix];
    if (!scsKey) continue;
    const internal = SCS_KEY_MAP[scsKey];
    if (!internal) {
      unsupported.push({ action: action, scsKey: scsKey });
      continue;
    }
    keybinds[action] = internal;
  }
  return { keybinds: keybinds, unsupported: unsupported };
}

/**
 * 读取玩家真实键位（自动定位 controls.sii）。
 * @param {{env?: object}} [opts]
 * @returns {{ok:boolean, reason:string, source?:object, keybinds?:object, unsupported?:Array}}
 */
function readGameKeybinds(opts = {}) {
  const env = opts.env || process.env;
  const files = findControlsFiles(env);
  if (files.length === 0) {
    return { ok: false, reason: '未找到 controls.sii（游戏可能未运行过，或文档目录不在默认位置）' };
  }
  const texts = [];
  for (const f of files.slice(0, 4)) {
    try {
      texts.push(fs.readFileSync(f.file, 'utf8'));
    } catch (err) { /* 读不到就跳过 */ }
  }
  if (texts.length === 0) {
    return { ok: false, reason: 'controls.sii 不可读：' + files[0].file };
  }
  const mixKeys = parseKeyboardMixAll(texts);
  const mapped = mapToActions(mixKeys);
  if (Object.keys(mapped.keybinds).length === 0) {
    return { ok: false, reason: 'controls.sii 已解析，但没有任何可用键盘绑定' };
  }
  return {
    ok: true,
    reason: 'ok',
    source: { game: files[0].game, profile: files[0].profile, file: files[0].file },
    keybinds: mapped.keybinds,
    unsupported: mapped.unsupported,
  };
}

module.exports = {
  readGameKeybinds,
  findControlsFiles,
  parseKeyboardMix,
  parseKeyboardMixAll,
  mapToActions,
  documentCandidates,
  ACTION_TO_MIX,
  SCS_KEY_MAP,
};
