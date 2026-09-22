'use strict';

const { createMockInput } = require('./mock');
const { createWindowsInput } = require('./windows');
const { createScsInput } = require('./scs');

/**
 * 输入门面。三种来源：
 *   keyboard — Windows SendInput 按键注入（无额外依赖）
 *   scs      — scs_sdk_controller 语义输入（Local\SCSControls），与键位无关、可直达档位
 *   auto     — 优先 scs，不可用或注入失败时回退 keyboard
 * requireLive 的 tap 绝不降级为"mock 成功"。
 */
function createInputService(config, telemetry, deps = {}) {
  const mockInput = createMockInput();
  const createWin = deps.createWindowsInput || createWindowsInput;
  const createScs = deps.createScsInput || createScsInput;
  const tapLog = deps.tapLog || null;
  const inputMode = String((config && config.inputMode) || 'keyboard').toLowerCase();
  const scsProbeRetryMs = Number((config && config.scsProbeRetryMs) || 15000);

  let winInput = null;
  let scsInput = null;
  let scsProbeResult = null;
  let scsProbeAt = 0;

  function scsEnabled() {
    if (!config || config.forceMock) return false;
    if (inputMode !== 'scs' && inputMode !== 'auto') return false;
    if (process.platform !== 'win32' && !deps.createScsInput) return false;
    return true;
  }

  function ensureScsInput() {
    if (!scsInput) scsInput = createScs({ holdMs: config.keyTapMs });
    return scsInput;
  }

  /** 探测共享内存是否可用（结果缓存；失败后按 scsProbeRetryMs 重试） */
  async function scsAvailable() {
    if (!scsEnabled()) return { ok: false, error: 'scs-disabled' };
    if (scsProbeResult && scsProbeResult.ok) return scsProbeResult;
    const now = Date.now();
    if (scsProbeResult && !scsProbeResult.ok && now - scsProbeAt < scsProbeRetryMs) {
      return scsProbeResult;
    }
    scsProbeAt = now;
    let r;
    try {
      r = await ensureScsInput().probe();
    } catch (err) {
      r = { ok: false, error: String(err.message || err) };
    }
    if (r.ok) {
      scsProbeResult = { ok: true, bytes: r.bytes };
      console.log(
        '[input] SCS 语义输入可用（共享内存 ' + r.bytes + ' 字节 / ' +
          ensureScsInput().controlCount + ' 项控制），命令将不经键盘',
      );
      if (config.scsWipersResetOnConnect !== false) {
        // scs_sdk_controller 的已知副作用：插件加载后雨刮会停在最大档，
        // 其 README 指明唯一复位方式就是发送 wipers0。
        try {
          const reset = await ensureScsInput().pulse('wipers0', config.keyTapMs);
          if (reset.ok) {
            console.log('[input] 已发送 wipers0 复位雨刮（可用 scsWipersResetOnConnect=false 关闭）');
          }
        } catch (err) { /* 复位失败不影响命令通道 */ }
      }
    } else {
      scsProbeResult = { ok: false, error: r.error || 'unavailable' };
      console.warn('[input] SCS 语义输入不可用：' + scsProbeResult.error + '（回退键盘注入）');
    }
    return scsProbeResult;
  }

  /** 发送一个语义输入脉冲；不可用时返回 SCS_UNAVAILABLE 供上层回退 */
  async function scsPulse(name, holdMs) {
    const av = await scsAvailable();
    if (!av.ok) return { ok: false, error: 'SCS_UNAVAILABLE', message: av.error };
    return ensureScsInput().pulse(name, holdMs);
  }

  function ensureLiveBackend() {
    if (telemetry.isMock() || !telemetry.canInject()) return null;
    const allow =
      deps.createWindowsInput || (process.platform === 'win32' && !config.forceMock);
    if (!allow) return null;
    if (!winInput) {
      console.log('[input] starting live key worker');
      winInput = createWin({
        keyTapMs: config.keyTapMs,
        beforeSend: () => {
          telemetry.snapshot();
          if (telemetry.isMock() || !telemetry.canInject()) {
            return {
              ok: false,
              error: 'UNSUPPORTED',
              message: 'mode lost before SendInput write',
            };
          }
          return { ok: true };
        },
      });
    }
    return winInput;
  }

  return {
    kind: 'facade',
    inputMode: inputMode,
    async tap(keyName, opts = {}) {
      if (opts.requireLive) {
        telemetry.snapshot();
        const backend = ensureLiveBackend();
        if (!backend) {
          return {
            ok: false,
            error: 'UNSUPPORTED',
            message: 'live inject unavailable',
          };
        }
        if (tapLog) tapLog('live', keyName);
        return backend.tap(keyName);
      }
      if (tapLog) tapLog('mock', keyName);
      return mockInput.tap(keyName);
    },
    async tapTimes(keyName, times, opts = {}) {
      const n = Math.max(0, Math.min(10, Number(times) || 0));
      for (let i = 0; i < n; i += 1) {
        const r = await this.tap(keyName, opts);
        if (!r.ok) return r;
      }
      return { ok: true, injected: Boolean(opts.requireLive) };
    },
    /** scs 语义输入可用性（带缓存/重试），供命令层判断是否走该通道 */
    scsAvailable: scsAvailable,
    /** 发送语义输入脉冲（如 flasher4way / lightpark / wipers2） */
    scsPulse: scsPulse,
    async dispose() {
      if (winInput) {
        await winInput.dispose();
        winInput = null;
      }
      if (scsInput) {
        await scsInput.dispose();
        scsInput = null;
      }
      await mockInput.dispose();
    },
  };
}

module.exports = { createInputService };
