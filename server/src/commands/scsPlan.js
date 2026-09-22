'use strict';

/**
 * 把 TruckDeck 命令翻译成 SCS 语义输入计划（纯函数、无副作用，便于单元测试）。
 *
 * 与键盘注入的差别：语义输入是"直达动作"，例如 lightoff/lightpark/lighton 直接切到
 * 目标档位（键盘只有 L 循环键），wipers0..4 直接设档。因此这里不模拟按键序列，
 * 而是计算"目标状态 → 一个语义输入名 + 需要遥测确认的字段"。
 *
 * 实测（ETS2 1.6x + scs_sdk_controller）：灯光三档、双闪、转向灯、远光、手刹、差速锁、
 * 提升桥、定速、点火、雨刮 0..4 均可通过该通道直接触发。
 */

/** toggle 型：目标与当前不同才按一次 */
const TOGGLE_MAP = {
  'lights.hazard': { input: 'flasher4way', path: ['lights', 'hazard'] },
  'lights.blinkerLeft': { input: 'lblinker', path: ['lights', 'blinkerLeft'] },
  'lights.blinkerRight': { input: 'rblinker', path: ['lights', 'blinkerRight'] },
  'lights.beamHigh': { input: 'hblight', path: ['lights', 'beamHigh'] },
  'handbrake.toggle': { input: 'parkingbrake', path: ['handbrake'] },
  'diffLock.toggle': { input: 'diflock', path: ['diffLock'] },
  'liftAxle.toggle': { input: 'liftaxle', path: ['liftAxle'] },
  'cruise.toggle': { input: 'cruiectrl', path: ['cruise'] },
};

/** 灯光三态（游戏模型：off → park → on，on 含近光+示廓） */
const LIGHT_INPUT = { off: 'lightoff', park: 'lightpark', on: 'lighton' };
const LIGHT_STATE = {
  off: { parking: false, beamLow: false },
  park: { parking: true, beamLow: false },
  on: { parking: true, beamLow: true },
};

/** 雨刮档位 → 语义输入（游戏档位 0=关,1=间歇,2/3/4；契约里的 auto 取间歇档） */
const WIPER_INPUT = { off: 'wipers0', auto: 'wipers1', '1': 'wipers1', '2': 'wipers2', '3': 'wipers3' };

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

function lightLevelOf(lights) {
  const parking = Boolean(lights && lights.parking);
  const beamLow = Boolean(lights && lights.beamLow);
  if (parking && beamLow) return 'on';
  if (parking) return 'park';
  return 'off';
}

function noop(reason) {
  return { ok: true, noop: true, reason: reason };
}

function plan(pulses, confirm, note) {
  const out = { ok: true, pulses: pulses, confirm: confirm };
  if (note) out.note = note;
  return out;
}

/**
 * @param {string} action TruckDeck 动作
 * @param {*} value 目标值（boolean 或雨刮字符串）
 * @param {object} snap 当前遥测快照（契约 data）
 * @returns {{ok:boolean, noop?:boolean, reason?:string, pulses?:string[], confirm?:object[], note?:string, error?:string, message?:string}}
 */
function planScsAction(action, value, snap) {
  const data = snap || {};

  const toggle = TOGGLE_MAP[action];
  if (toggle) {
    const current = getPath(data, toggle.path);
    if (typeof current !== 'boolean') return noop('state unknown');
    if (current === Boolean(value)) return noop('already at target');
    return plan([toggle.input], [{ path: toggle.path, value: Boolean(value) }]);
  }

  if (action === 'lights.parking' || action === 'lights.beamLow') {
    const lights = data.lights || {};
    if (typeof lights.parking !== 'boolean' || typeof lights.beamLow !== 'boolean') {
      return noop('lights state unknown');
    }
    const currentLevel = lightLevelOf(lights);
    let targetLevel;
    if (action === 'lights.parking') {
      // 关示廓灯会连带关近光（与键盘 L 循环的行为一致）
      targetLevel = value ? (lights.beamLow ? 'on' : 'park') : 'off';
    } else {
      targetLevel = value ? 'on' : (lights.parking ? 'park' : 'off');
    }
    if (targetLevel === currentLevel) return noop('already at target');
    const state = LIGHT_STATE[targetLevel];
    return plan(
      [LIGHT_INPUT[targetLevel]],
      [
        { path: ['lights', 'parking'], value: state.parking },
        { path: ['lights', 'beamLow'], value: state.beamLow },
      ],
      'light level -> ' + targetLevel,
    );
  }

  if (action === 'wipers.set') {
    const input = WIPER_INPUT[value];
    if (!input) return { ok: false, error: 'UNSUPPORTED', message: 'unsupported wiper target ' + value };
    const current = typeof data.wipers === 'string' ? data.wipers : null;
    if (current === null) return noop('wipers state unknown');
    if (value === 'off' && current === 'off') return noop('already off');
    // SDK 只能回读开/关，档位不可回读：非 off 请求一律按目标档位重发（设置档位本身是幂等的）
    if (value !== 'off') {
      return plan([input], [{ path: ['wipers'], notValue: 'off' }], 'wipers level ' + value);
    }
    return plan([input], [{ path: ['wipers'], value: 'off' }], 'wipers off');
  }

  if (action === 'engine.toggle') {
    const on = data.engineOn;
    if (typeof on !== 'boolean') return noop('engine state unknown');
    // 该插件没有 "engine" 语义输入，只有 ignitionstrt / ignitionoff
    if (on) return plan(['ignitionoff'], [{ path: ['engineOn'], value: false }], 'ignition off');
    return plan(['ignitionstrt'], [{ path: ['engineOn'], value: true }], 'ignition start');
  }

  return { ok: false, error: 'UNSUPPORTED', message: 'no scs mapping for ' + action };
}

module.exports = {
  planScsAction: planScsAction,
  getPath: getPath,
  lightLevelOf: lightLevelOf,
  TOGGLE_MAP: TOGGLE_MAP,
  LIGHT_INPUT: LIGHT_INPUT,
  LIGHT_STATE: LIGHT_STATE,
  WIPER_INPUT: WIPER_INPUT,
};
