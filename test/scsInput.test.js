'use strict';

/**
 * SCS 语义输入（scs_sdk_controller / Local\SCSControls）测试：
 *  1) 偏移表与插件 inputs.h 一致且布局自洽
 *  2) 命令 → 语义输入计划（含"直达档位"与幂等 noop）
 *  3) 客户端协议（用假 worker，不依赖 PowerShell 与游戏）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawn } = require('child_process');

const { planScsAction } = require('../server/src/commands/scsPlan');
const { createScsInput, OFFSETS_JSON } = require('../server/src/input/scs');

const OFFSETS = JSON.parse(fs.readFileSync(OFFSETS_JSON, 'utf8'));
const CONTROLS = OFFSETS.controls;

function snap(overrides) {
  const base = {
    lights: {
      parking: false, beamLow: false, beamHigh: false,
      blinkerLeft: false, blinkerRight: false, hazard: false,
    },
    wipers: 'off',
    handbrake: false,
    diffLock: false,
    liftAxle: false,
    cruise: false,
    engineOn: false,
  };
  return Object.assign(base, overrides || {});
}

test('偏移表：关键控制存在且类型为 bool', () => {
  for (const name of ['flasher4way', 'lightoff', 'lightpark', 'lighton', 'hblight',
    'lblinker', 'rblinker', 'wipers0', 'wipers1', 'wipers2', 'wipers3', 'wipers4',
    'diflock', 'liftaxle', 'parkingbrake', 'cruiectrl', 'ignitionon', 'ignitionoff', 'ignitionstrt']) {
    assert.ok(CONTROLS[name], `缺少控制 ${name}`);
    assert.equal(CONTROLS[name].type, 'bool', `${name} 应为 bool`);
  }
  assert.equal(CONTROLS.flasher4way.offset, 200);
  assert.equal(CONTROLS.wipers0.offset, 180);
});

test('偏移表：布局按 bool=1/float=4 紧凑排列且总长一致', () => {
  let cursor = 0;
  for (const [name, meta] of Object.entries(CONTROLS)) {
    assert.equal(meta.offset, cursor, `${name} 偏移应为 ${cursor}`);
    cursor += meta.type === 'float' ? 4 : 1;
  }
  assert.equal(cursor, OFFSETS._totalBytes);
  assert.equal(OFFSETS._totalBytes, 342);
});

test('toggle 类：目标与当前不同才发一次，相同则 noop', () => {
  const on = planScsAction('lights.hazard', true, snap());
  assert.deepEqual(on.pulses, ['flasher4way']);
  assert.deepEqual(on.confirm, [{ path: ['lights', 'hazard'], value: true }]);

  const same = planScsAction('lights.hazard', true, snap({ lights: { hazard: true } }));
  assert.equal(same.noop, true);

  const unknown = planScsAction('diffLock.toggle', true, { lights: {} });
  assert.equal(unknown.noop, true, '状态未知时不盲发');
});

test('灯光：直达三档（off/park/on），关示廓连带关近光', () => {
  const toPark = planScsAction('lights.parking', true, snap());
  assert.deepEqual(toPark.pulses, ['lightpark']);

  const toOn = planScsAction('lights.beamLow', true, snap());
  assert.deepEqual(toOn.pulses, ['lighton']);

  const parkToOff = planScsAction('lights.parking', false, snap({ lights: { parking: true, beamLow: true } }));
  assert.deepEqual(parkToOff.pulses, ['lightoff']);
  assert.deepEqual(parkToOff.confirm, [
    { path: ['lights', 'parking'], value: false },
    { path: ['lights', 'beamLow'], value: false },
  ]);

  const lowOff = planScsAction('lights.beamLow', false, snap({ lights: { parking: true, beamLow: true } }));
  assert.deepEqual(lowOff.pulses, ['lightpark']);

  const noop = planScsAction('lights.beamLow', true, snap({ lights: { parking: true, beamLow: true } }));
  assert.equal(noop.noop, true);
});

test('雨刮：off→wipers0，档位直达；SDK 只能回读开/关时用 notValue 确认', () => {
  assert.deepEqual(planScsAction('wipers.set', 'off', snap({ wipers: '1' })).pulses, ['wipers0']);
  assert.deepEqual(planScsAction('wipers.set', '2', snap()).pulses, ['wipers2']);
  assert.deepEqual(planScsAction('wipers.set', 'auto', snap()).pulses, ['wipers1']);
  assert.equal(planScsAction('wipers.set', 'off', snap()).noop, true);
  assert.deepEqual(planScsAction('wipers.set', '3', snap()).confirm, [{ path: ['wipers'], notValue: 'off' }]);
  assert.equal(planScsAction('wipers.set', '9', snap()).error, 'UNSUPPORTED');
});

test('引擎：该插件没有 engine 输入，按状态选择 ignitionstrt / ignitionoff', () => {
  assert.deepEqual(planScsAction('engine.toggle', undefined, snap()).pulses, ['ignitionstrt']);
  assert.deepEqual(planScsAction('engine.toggle', undefined, snap({ engineOn: true })).pulses, ['ignitionoff']);
});

test('无映射动作返回 UNSUPPORTED（交给键盘回退）', () => {
  const r = planScsAction('vjoy.steer', 0.5, snap());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNSUPPORTED');
});

test('客户端：假 worker 走通 probe / pulse / 未知控制名', async () => {
  const code = `
    const readline = require('readline');
    process.stdout.write(JSON.stringify({ ok: true, ready: true, bytes: 342, id: 0 }) + '\\n');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.op === 'quit') { process.stdout.write(JSON.stringify({ ok: true, id: msg.id }) + '\\n'); process.exit(0); }
      if (msg.op === 'probe') { process.stdout.write(JSON.stringify({ ok: true, ready: true, bytes: 342, id: msg.id }) + '\\n'); return; }
      if (msg.op === 'pulse') { process.stdout.write(JSON.stringify({ ok: true, name: msg.name, id: msg.id }) + '\\n'); return; }
      process.stdout.write(JSON.stringify({ ok: false, error: 'unknown-op', id: msg.id }) + '\\n');
    });
  `;
  const client = createScsInput({
    spawnWorker: () => spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  const probed = await client.probe();
  assert.equal(probed.ok, true);
  assert.equal(probed.bytes, 342);
  const pulsed = await client.pulse('flasher4way', 60);
  assert.equal(pulsed.ok, true);
  assert.equal(pulsed.via, 'scs');
  const bad = await client.pulse('__not_a_control__', 60);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'UNSUPPORTED');
  await client.dispose();
});

test('客户端：共享内存不可用时 probe 失败而非抛错', async () => {
  const code = `
    process.stdout.write(JSON.stringify({ ok: false, ready: false, error: 'shared-memory-not-found', id: 0 }) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const client = createScsInput({
    spawnWorker: () => spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  const probed = await client.probe();
  assert.equal(probed.ok, false);
  assert.equal(probed.error, 'shared-memory-not-found');
  const pulsed = await client.pulse('flasher4way', 60);
  assert.equal(pulsed.ok, false);
  assert.equal(pulsed.error, 'SCS_UNAVAILABLE');
  await client.dispose();
});
