'use strict';

/**
 * 默认键位回归测试。
 *
 * 曾经的问题：lights.hazard 被写成 "H"，而 ETS2/ATS 里 H 是喇叭（Sound Signal），
 * 于是手机点「双闪」会按喇叭。危险警示灯（Hazard Lights）的出厂键是 F。
 *
 * 参考：Truck Simulator Wiki — Controls: Euro Truck Simulator 2
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { KEY_WHITELIST } = require('../server/src/config');

const ROOT = path.join(__dirname, '..');
const keybinds = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'keybinds.default.json'), 'utf8'),
);

/** ETS2/ATS 出厂默认键位（本项目的默认映射必须与之相符） */
const ETS2_DEFAULTS = {
  'lights.parking': 'L',
  'lights.beamLow': 'L',
  'lights.beamHigh': 'K',
  'lights.blinkerLeft': 'BracketLeft',
  'lights.blinkerRight': 'BracketRight',
  'lights.hazard': 'F',
  'wipers.cycle': 'P',
  'handbrake.toggle': 'Space',
  'diffLock.toggle': 'V',
  'liftAxle.toggle': 'U',
  'cruise.toggle': 'C',
  'engine.toggle': 'E',
};

const HORN_KEY = 'H';   // 喇叭 Sound Signal —— TruckDeck 不提供喇叭，绝不能映射到它
const BEACON_KEY = 'O'; // 旋转警示灯 Warning Lights —— 与「双闪」不是同一功能

test('默认键位与 ETS2/ATS 出厂键位一致', () => {
  for (const [action, expected] of Object.entries(ETS2_DEFAULTS)) {
    assert.equal(keybinds[action], expected, `${action} 应为 ${expected}`);
  }
});

test('双闪映射到 F，且不落在喇叭/旋转警示灯键上', () => {
  assert.equal(keybinds['lights.hazard'], 'F', '双闪应为 F（危险警示灯）');
  assert.notEqual(keybinds['lights.hazard'], HORN_KEY, 'H 是喇叭，不能用于双闪');
  assert.notEqual(keybinds['lights.hazard'], BEACON_KEY, 'O 是旋转警示灯，不是双闪');
});

test('任何动作都不得映射到喇叭键', () => {
  for (const [action, key] of Object.entries(keybinds)) {
    if (action.startsWith('_') || key === null) continue;
    assert.notEqual(key, HORN_KEY, `${action} 不应映射到喇叭键 H`);
  }
});

test('所有已映射键名都在白名单内（防注入）', () => {
  for (const [action, key] of Object.entries(keybinds)) {
    if (action.startsWith('_') || key === null) continue;
    assert.ok(KEY_WHITELIST.has(key), `${action} 的键 "${key}" 不在白名单`);
  }
});

test('未配置的雨刮档位保持 null（live 不伪造档位）', () => {
  for (const action of ['wipers.off', 'wipers.auto', 'wipers.1', 'wipers.2', 'wipers.3']) {
    assert.equal(keybinds[action], null, `${action} 应为 null`);
  }
});
