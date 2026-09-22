'use strict';

/**
 * 动态键位（读取玩家 controls.sii）测试。
 *
 * 目的：让键位以玩家真实配置为准，而不是靠手抄；同时守住"双闪不能落在喇叭键 H 上"。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseKeyboardMix,
  mapToActions,
  readGameKeybinds,
  SCS_KEY_MAP,
} = require('../server/src/keybindsGame');
const { loadConfig } = require('../server/src/config');

/** 摘自真实 ETS2 1.6x controls.sii 的片段 */
const SAMPLE = [
  'SiiNunit',
  '{',
  'input_config : _nameless.1 {',
  ' config_lines[346]: "mix engine `keyboard.e?0 || long_press(joy.pov1_right?0) | semantical.engine?0`"',
  ' config_lines[358]: "mix horn `keyboard.h?0 | joy.b9?0 | semantical.horn?0`"',
  ' config_lines[375]: "mix liftaxle `keyboard.u?0 | semantical.liftaxle?0`"',
  ' config_lines[382]: "mix diflock `keyboard.v?0 | semantical.diflock?0`"',
  ' config_lines[396]: "mix parkingbrake `keyboard.space?0 || long_press(joy.pov1_down?0) | semantical.parkingbrake?0`"',
  ' config_lines[398]: "mix wipers `keyboard.p?0 | semantical.wipers?0`"',
  ' config_lines[405]: "mix cruiectrl `keyboard.c?0 || long_press(joy.b2?0) | semantical.cruiectrl?0`"',
  ' config_lines[411]: "mix light `keyboard.l?0 || short_press(joy.b3?0) | semantical.light?0`"',
  ' config_lines[415]: "mix hblight `keyboard.k?0 || long_press(joy.b3?0) | semantical.hblight?0`"',
  ' config_lines[416]: "mix lblinker `keyboard.lbracket?0 || short_press(joy.pov1_left?0) | semantical.lblinker?0`"',
  ' config_lines[418]: "mix rblinker `keyboard.rbracket?0 || short_press(joy.pov1_right?0) | semantical.rblinker?0`"',
  ' config_lines[420]: "mix flasher4way `keyboard.f?0 || modifier(no_cstm_mod?0, long_press(joy.b11?0)) | semantical.flasher4way?0`"',
  '}',
  '}',
  '',
].join('\n');

function tempDocs(sample, sub, profile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-docs-'));
  const dir = path.join(tmp, 'Euro Truck Simulator 2', sub || 'profiles', profile || 'PROFILE_A');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'controls.sii'), sample, 'utf8');
  return tmp;
}

test('解析 controls.sii 的键盘绑定（含真实 mix 名）', () => {
  const mix = parseKeyboardMix(SAMPLE);
  assert.equal(mix.flasher4way, 'f', '双闪的 mix 名是 flasher4way');
  assert.equal(mix.horn, 'h', '喇叭是 horn');
  assert.equal(mix.light, 'l');
  assert.equal(mix.hblight, 'k');
  assert.equal(mix.lblinker, 'lbracket');
  assert.equal(mix.rblinker, 'rbracket');
  assert.equal(mix.wipers, 'p');
  assert.equal(mix.parkingbrake, 'space');
  assert.equal(mix.diflock, 'v');
  assert.equal(mix.cruiectrl, 'c');
  assert.equal(mix.engine, 'e');
  assert.equal(mix.liftaxle, 'u');
});

test('映射到内部键名：双闪=F，且不是喇叭键 H', () => {
  const mapped = mapToActions(parseKeyboardMix(SAMPLE));
  const k = mapped.keybinds;
  assert.equal(k['lights.hazard'], 'F');
  assert.notEqual(k['lights.hazard'], 'H');
  assert.equal(k['lights.parking'], 'L');
  assert.equal(k['lights.beamLow'], 'L');
  assert.equal(k['lights.beamHigh'], 'K');
  assert.equal(k['lights.blinkerLeft'], 'BracketLeft');
  assert.equal(k['lights.blinkerRight'], 'BracketRight');
  assert.equal(k['wipers.cycle'], 'P');
  assert.equal(k['handbrake.toggle'], 'Space');
  assert.equal(k['diffLock.toggle'], 'V');
  assert.equal(k['liftAxle.toggle'], 'U');
  assert.equal(k['cruise.toggle'], 'C');
  assert.equal(k['engine.toggle'], 'E');
});

test('不可注入的键（小键盘 / Pause / ScrollLock）被忽略并记录', () => {
  const text = [
    'config_lines[1]: "mix light `keyboard.pause?0`"',
    'config_lines[2]: "mix engine `keyboard.num1?0`"',
    'config_lines[3]: "mix wipers `keyboard.scrollock?0`"',
  ].join('\n');
  const mapped = mapToActions(parseKeyboardMix(text));
  assert.equal(mapped.keybinds['lights.parking'], undefined);
  assert.equal(mapped.keybinds['engine.toggle'], undefined);
  assert.equal(mapped.keybinds['wipers.cycle'], undefined);
  // light 同时服务 lights.parking 与 lights.beamLow，因此这两条各产生一条记录
  assert.deepEqual(mapped.unsupported.map((u) => u.action).sort(), [
    'engine.toggle',
    'lights.beamLow',
    'lights.parking',
    'wipers.cycle',
  ]);
  assert.deepEqual(mapped.unsupported.map((u) => u.scsKey).sort(), ['num1', 'pause', 'pause', 'scrollock']);
});

test('readGameKeybinds 从指定文档目录读取最近修改的 profile', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-docs-'));
  const older = path.join(tmp, 'Euro Truck Simulator 2', 'profiles', 'OLD');
  const newer = path.join(tmp, 'Euro Truck Simulator 2', 'steam_profiles', 'NEW');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  const oldFile = path.join(older, 'controls.sii');
  const newFile = path.join(newer, 'controls.sii');
  fs.writeFileSync(oldFile, SAMPLE, 'utf8');
  fs.writeFileSync(newFile, SAMPLE.replace('keyboard.f?0', 'keyboard.j?0'), 'utf8');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(oldFile, past, past);

  const res = readGameKeybinds({ env: { TRUCKDECK_DOCS: tmp } });
  assert.equal(res.ok, true);
  assert.equal(res.source.profile, 'NEW', '应选最近修改的 profile');
  assert.equal(res.keybinds['lights.hazard'], 'J');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('loadConfig(auto) 用玩家真实键位覆盖默认文件', () => {
  const tmp = tempDocs(SAMPLE);
  const cfg = loadConfig({ TRUCKDECK_DOCS: tmp });
  assert.equal(cfg.keybindsMode, 'auto');
  assert.match(cfg.keybindsSource, /controls\.sii/);
  assert.equal(cfg.keybinds['lights.hazard'], 'F');
  assert.equal(cfg.keybinds['handbrake.toggle'], 'Space');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('loadConfig(file) 忽略游戏文件，使用默认键位表', () => {
  const tmp = tempDocs(SAMPLE);
  const cfg = loadConfig({ TRUCKDECK_DOCS: tmp, TRUCKDECK_KEYBINDS: 'file' });
  assert.equal(cfg.keybindsMode, 'file');
  assert.match(cfg.keybindsSource, /keybinds\.default\.json/);
  assert.equal(cfg.keybinds['lights.hazard'], 'F');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('读不到游戏文件时回退默认并说明原因', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-empty-'));
  const cfg = loadConfig({ TRUCKDECK_DOCS: tmp });
  assert.match(cfg.keybindsSource, /未读取到游戏键位/);
  assert.equal(cfg.keybinds['lights.hazard'], 'F');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SCS 键名映射覆盖常用键且不含不可注入键', () => {
  assert.equal(SCS_KEY_MAP.f, 'F');
  assert.equal(SCS_KEY_MAP.space, 'Space');
  assert.equal(SCS_KEY_MAP.lbracket, 'BracketLeft');
  assert.equal(SCS_KEY_MAP.grave, 'Backquote');
  assert.equal(SCS_KEY_MAP.pgdn, 'PageDown');
  assert.equal(SCS_KEY_MAP.num1, undefined, '小键盘数字不映射（避免按成主键盘数字）');
  assert.equal(SCS_KEY_MAP.pause, undefined);
  assert.equal(SCS_KEY_MAP.scrollock, undefined);
});
