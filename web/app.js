'use strict';

/**
 * TruckDeck 手机中控 — 原生 JS，无框架、无外部依赖、无 CDN。
 *
 * 契约 docs/API_CONTRACT.md v1（冻结）要点：
 *  - 连接 ws(s)://<location.host>/ws，必须先发 {type:'hello',role:'web',version:'1'}
 *  - 只用 telemetry 更新真实状态；command_ack 不能代替遥测回读（不做乐观反转）
 *  - 连接断开 / 握手未完成 / 遥测过期 / 游戏未连接 → 禁用全部控制
 *  - 灯光传 boolean 目标值；toggle 类省略 value；wipers.set 只传 off|auto|1|2|3
 *  - 不发送任何 vJoy / 轴类命令
 */
(function () {
  const CONTRACT_VERSION = '1';

  const TELEMETRY_STALE_MS = 2500;          // 遥测过期阈值 → 锁定控制
  const HANDSHAKE_TIMEOUT_MS = 6000;        // hello ack 超时
  const WATCHDOG_INTERVAL_MS = 1000;
  const FORCE_RECONNECT_SILENCE_MS = 9000;  // 长时间无遥测 → 强制重建连接
  const MIN_FORCE_RECONNECT_GAP_MS = 6000;
  const PENDING_TIMEOUT_MS = 5000;          // 单条命令等待确认上限
  const ACTION_COOLDOWN_MS = 300;           // 同动作最小发送间隔（防连点）
  const HEALTH_POLL_MS = 15000;             // /health 轮询，同步 mock 标志
  const MAX_LOG_ITEMS = 4;
  const RECONNECT_STEPS_MS = [1000, 2000, 3000, 5000, 8000, 10000];

  // iOS 上 Safari 与「Chrome/Firefox/Edge」共用 WebKit：iPhone 没有任意元素全屏 API，
  // 也无法锁定屏幕方向；iPad 仅提供 webkit 前缀版本。这里做能力探测 + 中文引导，不静默失败。
  const UA = navigator.userAgent || '';
  const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_IOS_CHROME = /CriOS/.test(UA);

  const LIGHT_ACTIONS = {
    'lights.parking': { label: '示廓灯', key: 'parking' },
    'lights.beamLow': { label: '近光灯', key: 'beamLow' },
    'lights.beamHigh': { label: '远光灯', key: 'beamHigh' },
    'lights.blinkerLeft': { label: '左转向', key: 'blinkerLeft' },
    'lights.blinkerRight': { label: '右转向', key: 'blinkerRight' },
    'lights.hazard': { label: '双闪', key: 'hazard' }
  };

  const ACTION_LABELS = {
    'lights.parking': '示廓灯',
    'lights.beamLow': '近光灯',
    'lights.beamHigh': '远光灯',
    'lights.blinkerLeft': '左转向',
    'lights.blinkerRight': '右转向',
    'lights.hazard': '双闪',
    'wipers.set': '雨刮',
    'handbrake.toggle': '手刹',
    'diffLock.toggle': '差速锁',
    'liftAxle.toggle': '提升桥',
    'cruise.toggle': '定速巡航',
    'engine.toggle': '发动机起停'
  };

  const TOGGLE_KEYS = {
    'handbrake.toggle': 'handbrake',
    'diffLock.toggle': 'diffLock',
    'liftAxle.toggle': 'liftAxle',
    'cruise.toggle': 'cruise',
    'engine.toggle': 'engineOn'
  };

  const WIPER_LABELS = { off: '关闭', auto: 'AUTO', '1': '一档', '2': '二档', '3': '三档' };

  const ERROR_TEXT = {
    HELLO_REQUIRED: '未完成握手（服务端要求先 hello），正在重新握手…',
    INVALID_JSON: '命令格式错误，服务端无法解析',
    UNKNOWN_TYPE: '服务端不支持该消息类型',
    UNKNOWN_ACTION: '服务端不支持该动作',
    INVALID_VALUE: '参数不合法（超出允许范围）',
    NOT_MAPPED: '游戏键位未映射该动作，请检查 config/keybinds',
    UNSUPPORTED: '当前环境不支持该操作',
    INJECT_FAILED: '按键注入失败（游戏窗口可能未聚焦）',
    FORBIDDEN: '请求来源被拒绝（仅限局域网/同端口页面）',
    UNSUPPORTED_VERSION: '前后端版本不一致（需要 version 1）'
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const els = {
    connPill: $('pill-conn'),
    connText: $('pill-conn-text'),
    modePill: $('pill-mode'),
    modeText: $('pill-mode-text'),
    teleText: $('pill-tele-text'),
    telePill: $('pill-tele'),
    hostText: $('pill-host-text'),
    hostCode: $('log-host'),
    modeInline: $('mode-inline'),
    lockBanner: $('lock-banner'),
    lockBannerText: $('lock-banner-text'),
    orientHint: $('orient-hint'),
    orientDismiss: $('btn-orient-dismiss'),
    reconnectBtn: $('btn-reconnect'),
    fullscreenBtn: $('btn-fullscreen'),
    fsHint: $('fs-hint'),
    fsHintText: $('fs-hint-text'),
    fsDismiss: $('btn-fs-hint-dismiss'),
    logbar: $('logbar'),
    speed: $('tele-speed'),
    rpm: $('tele-rpm'),
    gear: $('tele-gear'),
    fuel: $('tele-fuel'),
    fuelBar: $('tele-fuel-bar'),
    air: $('tele-air'),
    airBar: $('tele-air-bar'),
    stamp: $('tele-stamp'),
    warn: $('tele-warn'),
    wiperCurrent: $('wiper-current'),
    lightButtons: Array.prototype.slice.call(document.querySelectorAll('[data-action][data-state-key]')),
    wiperButtons: Array.prototype.slice.call(document.querySelectorAll('[data-wiper-value]')),
    toggleButtons: Array.prototype.slice.call(document.querySelectorAll('[data-action][data-state-key].ctl--toggle'))
  };

  const lightButtons = els.lightButtons.filter((btn) => btn.dataset.action in LIGHT_ACTIONS);
  const toggleButtons = els.toggleButtons.filter((btn) => btn.dataset.action in TOGGLE_KEYS);

  // ---- 状态 ----
  const state = {
    socket: null,
    phase: 'idle',            // idle | connecting | handshaking | ready | closed
    helloOk: false,
    mock: null,               // 来自 hello.mock / health.mock
    mockFromHealth: null,
    telemetryHz: null,
    telemetry: null,
    lastTelemetryAt: 0,
    telemetryCount: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    nextRetryAt: 0,
    lockReason: '正在连接控制服务…',
    locked: true,
    pending: new Map(),        // id -> { action, timer, button }
    lastSentAt: new Map(),     // action -> ts
    lastForceReconnectAt: 0,
    seq: 0,
    intentionalClose: false,
    goneQuiet: false,
    debugRaw: false
  };

  const wsUrl = () =>
    (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

  const now = () => Date.now();
  const hhmmss = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  // ---- 日志条 ----
  function pushLog(kind, text) {
    if (!els.logbar) return;
    const item = document.createElement('span');
    item.className = 'logbar__item';
    item.dataset.kind = kind;
    const time = document.createElement('span');
    time.className = 'logbar__time';
    time.textContent = hhmmss();
    const msg = document.createElement('span');
    msg.textContent = text;
    item.appendChild(time);
    item.appendChild(msg);
    els.logbar.insertBefore(item, els.logbar.firstChild);
    const items = els.logbar.querySelectorAll('.logbar__item');
    for (let i = 0; i < items.length; i += 1) {
      items[i].classList.toggle('logbar__item--old', i >= MAX_LOG_ITEMS - 2);
      if (i >= MAX_LOG_ITEMS) items[i].remove();
    }
  }

  // ---- 顶栏/仪表渲染 ----
  function setConnPill(tone, text) {
    if (els.connPill) els.connPill.dataset.tone = tone;
    if (els.connText) els.connText.textContent = text;
  }

  function renderMode() {
    const known = typeof state.mock === 'boolean';
    if (!known) {
      if (els.modePill) els.modePill.dataset.tone = 'idle';
      if (els.modeText) els.modeText.textContent = '模式未知';
      if (els.modeInline) els.modeInline.textContent = '正在连接电脑…';
      return;
    }
    const mock = state.mock === true;
    if (els.modePill) els.modePill.dataset.tone = mock ? 'warn' : 'ok';
    if (els.modeText) els.modeText.textContent = mock ? '模式：模拟 mock' : '模式：实时遥测';
    if (els.modeInline) els.modeInline.textContent = mock ? '模拟演示 · 不操作游戏' : '游戏已连接';
  }

  function fmtNum(value, digits) {
    const n = Number(value);
    if (!isFinite(n)) return '--';
    return digits === 0 ? String(Math.round(n)) : n.toFixed(digits);
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function setAlert(which, on) {
    const row = which === 'fuel' ? (els.fuel && els.fuel.parentElement) : (els.air && els.air.parentElement);
    if (row) row.dataset.alert = on ? 'true' : 'false';
  }

  function renderLights(lights) {
    const src = lights && typeof lights === 'object' ? lights : null;
    lightButtons.forEach((btn) => {
      const meta = LIGHT_ACTIONS[btn.dataset.action];
      const value = src && typeof src[meta.key] === 'boolean' ? src[meta.key] : null;
      const stateEl = btn.querySelector('[data-role="state"]');
      if (value === null) {
        if (stateEl) stateEl.textContent = '—';
        btn.setAttribute('aria-pressed', 'false');
      } else {
        if (stateEl) stateEl.textContent = value ? '开 ON' : '关 OFF';
        btn.setAttribute('aria-pressed', value ? 'true' : 'false');
      }
    });
  }

  function renderWipers(value) {
    const known = typeof value === 'string' && value in WIPER_LABELS;
    const liveOn = state.mock === false && value === '1';
    if (els.wiperCurrent) {
      els.wiperCurrent.textContent = liveOn ? '当前：开启 · 档位未知' : known ? '当前：' + WIPER_LABELS[value] : '当前：未知（等待游戏回报）';
    }
    els.wiperButtons.forEach((btn) => {
      const active = known && !liveOn && btn.dataset.wiperValue === value;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderToggles(t) {
    toggleButtons.forEach((btn) => {
      const key = TOGGLE_KEYS[btn.dataset.action];
      const value = typeof t[key] === 'boolean' ? t[key] : null;
      const stateEl = btn.querySelector('[data-role="state"]');
      if (value === null) {
        if (stateEl) stateEl.textContent = '—';
        btn.setAttribute('aria-pressed', 'false');
      } else {
        if (stateEl) stateEl.textContent = value ? '开 ON' : '关 OFF';
        btn.setAttribute('aria-pressed', value ? 'true' : 'false');
      }
    });
  }

  function renderWarnings(t) {
    if (!els.warn) return;
    const notes = [];
    if (typeof t.fuelPct === 'number' && t.fuelPct < 15) notes.push('⚠ 燃油偏低 ' + t.fuelPct.toFixed(0) + '%');
    if (typeof t.airPressure === 'number' && t.airPressure < 85) notes.push('⚠ 气压偏低 ' + t.airPressure.toFixed(0) + ' psi');
    if (typeof t.engineRpm === 'number' && t.engineRpm > 2100) notes.push('⚠ 转速偏高 ' + Math.round(t.engineRpm) + ' RPM');
    if (notes.length) { els.warn.textContent = notes.join(' · '); els.warn.hidden = false; }
    else { els.warn.textContent = ''; els.warn.hidden = true; }
  }



  function renderTelemetry() {
    const t = state.telemetry;
    if (!t) return;

    if (els.speed) els.speed.textContent = fmtNum(t.speedKmh, 0);
    if (els.rpm) els.rpm.textContent = fmtNum(t.engineRpm, 0);

    if (els.gear) {
      const g = Number(t.gear);
      if (!isFinite(g)) els.gear.textContent = '--';
      else if (g === 0) els.gear.textContent = 'N';
      else if (g < 0) els.gear.textContent = 'R' + Math.abs(g);
      else els.gear.textContent = String(g);
    }

    if (typeof t.fuelPct === 'number' && isFinite(t.fuelPct)) {
      const fuel = clamp(t.fuelPct, 0, 100);
      if (els.fuel) els.fuel.textContent = fuel.toFixed(0) + ' %';
      if (els.fuelBar) els.fuelBar.style.width = fuel + '%';
      setAlert('fuel', fuel < 15);
    }

    if (typeof t.airPressure === 'number' && isFinite(t.airPressure)) {
      const air = Math.max(0, t.airPressure);
      const airPct = clamp((air / 130) * 100, 0, 100);
      if (els.air) els.air.textContent = air.toFixed(0) + ' psi';
      if (els.airBar) els.airBar.style.width = airPct + '%';
      setAlert('air', air < 85);
    }

    renderLights(t.lights);
    renderWipers(t.wipers);
    renderToggles(t);
    renderWarnings(t);
    updateLock();
    updateStamp();
  }

  function updateStamp() {
    if (!els.stamp) return;
    if (!state.lastTelemetryAt) {
      els.stamp.textContent = '等待遥测数据…';
      els.stamp.dataset.stale = 'false';
      setTelePill('idle', '遥测：等待数据');
      return;
    }
    const age = now() - state.lastTelemetryAt;
    const stale = age > TELEMETRY_STALE_MS;
    const hz = state.telemetryHz ? ' · ' + state.telemetryHz + ' Hz' : '';
    const gameOff = state.telemetry && state.telemetry.connected === false;
    const text = (stale ? '遥测过期 ' : '遥测 ') + (age / 1000).toFixed(1) + ' 秒前' + hz + (gameOff ? ' · 游戏未连接' : '');
    els.stamp.textContent = text;
    els.stamp.dataset.stale = stale ? 'true' : 'false';
    setTelePill(stale || gameOff ? 'warn' : 'ok', text);
    // 顶栏连接状态同步时效：半死连接不应继续显示「已连接」
    if (state.helloOk && state.socket && state.socket.readyState === WebSocket.OPEN) {
      if (stale) setConnPill('warn', '已连接 · 遥测中断');
      else if (state.connOkText) setConnPill('ok', state.connOkText);
    }
  }

  function setTelePill(tone, text) {
    if (els.telePill) els.telePill.dataset.tone = tone;
    if (els.teleText) els.teleText.textContent = text;
  }

  // ---- 锁定判定：断开 / 未握手 / 遥测过期 / 游戏未连接 都禁用控制 ----
  function computeLockReason() {
    if (!state.socket || state.phase === 'closed') {
      if (state.reconnectTimer && state.nextRetryAt) {
        const secs = Math.max(0, Math.ceil((state.nextRetryAt - now()) / 1000));
        return '连接已断开，' + secs + ' 秒后自动重连';
      }
      return '未连接控制服务';
    }
    if (state.phase === 'connecting') return '正在连接控制服务…';
    if (!state.helloOk) return '正在确认连接…';
    if (!state.telemetry) return '等待第一帧遥测数据…';
    const age = now() - state.lastTelemetryAt;
    if (age > TELEMETRY_STALE_MS) return '遥测数据过期（' + (age / 1000).toFixed(1) + ' 秒无更新）';
    if (state.telemetry.connected === false) return '游戏未连接';
    return '';
  }

  function updateLock() {
    const reason = computeLockReason();
    const locked = reason !== '';
    const changed = locked !== state.locked || reason !== state.lockReason;
    state.locked = locked;
    state.lockReason = reason;

    if (els.lockBanner) {
      if (locked) {
        if (els.lockBannerText) els.lockBannerText.textContent = '控制已锁定：' + reason;
        els.lockBanner.hidden = false;
      } else {
        els.lockBanner.hidden = true;
      }
    }

    lightButtons.concat(toggleButtons, els.wiperButtons).forEach((btn) => {
      btn.disabled = locked || btn.dataset.pendingAction === 'true';
    });

    if (changed && locked && !state.goneQuiet && state.helloOk) {
      state.goneQuiet = true;
      pushLog('warn', '已锁定控制：' + reason);
    }
    if (!locked && state.goneQuiet) {
      state.goneQuiet = false;
      pushLog('ok', '控制已解锁：遥测正常');
    }
  }

  // ---- 连接生命周期 ----
  function connect(trigger) {
    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; state.nextRetryAt = 0; }
    state.intentionalClose = false;
    state.phase = 'connecting';
    state.helloOk = false;
    state.telemetry = null;
    state.lastTelemetryAt = 0;
    clearPending('连接已重新建立');

    let socket;
    try {
      socket = new WebSocket(wsUrl());
    } catch (err) {
      scheduleReconnect('无法创建 WebSocket 连接');
      return;
    }
    state.socket = socket;
    setConnPill('busy', state.reconnectAttempt > 0 ? '重连中…' : '连接中…');
    updateLock();

    const handshakeTimer = setTimeout(() => {
      if (state.socket === socket && !state.helloOk) {
        pushLog('warn', '握手超时：未收到 hello ack，重建连接');
        try { socket.close(); } catch (err) { /* ignore */ }
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.onopen = () => {
      if (state.socket !== socket) return;
      state.phase = 'handshaking';
      setConnPill('busy', '握手中…');
      try {
        // 契约要求：连接后必须先 hello
        socket.send(JSON.stringify({ type: 'hello', role: 'web', version: CONTRACT_VERSION }));
      } catch (err) {
        pushLog('error', 'hello 发送失败，将重试');
      }
      updateLock();
    };

    socket.onmessage = (event) => {
      if (state.socket === socket) handleMessage(event.data);
    };
    socket.onerror = () => { /* 统一由 onclose 处理重连 */ };

    socket.onclose = () => {
      clearTimeout(handshakeTimer);
      if (state.socket !== socket) return; // 旧连接的回调：忽略，避免覆盖新连接状态（防重复 socket）
      state.socket = null;
      const wasReady = state.helloOk;
      state.helloOk = false;
      state.phase = 'closed';
      state.telemetry = null;
      state.lastTelemetryAt = 0;
      clearPending('连接已断开');
      if (state.intentionalClose) {
        setConnPill('idle', '已主动断开');
      } else {
        scheduleReconnect(wasReady ? '连接已断开' : '连接建立失败');
      }
      updateLock();
    };
  }

  function scheduleReconnect(reason) {
    if (state.reconnectTimer) return;
    const step = RECONNECT_STEPS_MS[Math.min(state.reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
    const delay = step + Math.floor(Math.random() * 250);
    state.reconnectAttempt += 1;
    state.nextRetryAt = now() + delay;
    setConnPill('error', '已断开 · ' + Math.ceil(delay / 1000) + ' 秒后重连');
    pushLog('warn', reason + '：' + Math.ceil(delay / 1000) + ' 秒后重试（第 ' + state.reconnectAttempt + ' 次）');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.nextRetryAt = 0;
      connect('auto-retry');
    }, delay);
    updateLock();
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { pushLog('warn', '收到无法解析的服务端消息'); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') { pushLog('warn', '服务端消息缺少 type 字段'); return; }

    switch (msg.type) {
      case 'hello': handleHello(msg); break;
      case 'telemetry': handleTelemetry(msg); break;
      case 'command_ack': handleAck(msg); break;
      case 'command_nack': handleNack(msg); break;
      case 'error': handleError(msg); break;
      default: pushLog('warn', '收到未知消息类型：' + msg.type); break;
    }
  }

  function handleHello(msg) {
    if (msg.ok !== true) {
      const code = msg.error || 'UNSUPPORTED_VERSION';
      pushLog('error', '握手失败：' + (ERROR_TEXT[code] || code) + (msg.message ? '（' + msg.message + '）' : ''));
      state.helloOk = false;
      try { if (state.socket) state.socket.close(); } catch (err) { /* ignore */ }
      return;
    }
    const firstReady = !state.helloOk;
    const prevMock = state.mock;
    state.helloOk = true;
    state.phase = 'ready';
    state.reconnectAttempt = 0;
    state.nextRetryAt = 0;
    if (typeof msg.mock === 'boolean') state.mock = msg.mock;
    if (typeof msg.telemetryHz === 'number' && isFinite(msg.telemetryHz)) state.telemetryHz = msg.telemetryHz;
    if (firstReady || prevMock !== state.mock) {
      state.telemetry = null;
      state.lastTelemetryAt = 0;
      clearPending('连接或模式已变化');
    }

    state.connOkText = '已连接';
    setConnPill('ok', state.connOkText);
    if (firstReady) {
      pushLog('ok', '已连接控制服务' + (state.telemetryHz ? '（遥测 ' + state.telemetryHz + ' Hz）' : ''));
    } else if (typeof prevMock === 'boolean' && prevMock !== state.mock) {
      pushLog('pending', '服务端模式已切换：' + (state.mock ? '模拟 mock' : '实时遥测'));
    }
    renderMode();
    updateLock();
  }

  function handleTelemetry(msg) {
    const data = msg && msg.data;
    if (!data || typeof data !== 'object') return;
    const wasStale = state.lastTelemetryAt > 0 && now() - state.lastTelemetryAt > TELEMETRY_STALE_MS;
    state.telemetry = data;
    state.lastTelemetryAt = now();
    state.telemetryCount += 1;
    if (state.telemetryCount === 1) {
      pushLog('ok', '遥测已就绪' + (state.telemetryHz ? ' · ' + state.telemetryHz + ' Hz' : ''));
    } else if (wasStale) {
      pushLog('ok', '遥测已恢复');
    }
    matchPendingFromTelemetry(data);
    renderTelemetry();
  }


  // ---- 命令下发：有界、去重、绝不乐观反转状态 ----
  function findPending(id, action) {
    if (id != null && state.pending.has(String(id))) return state.pending.get(String(id));
    let found = null;
    state.pending.forEach((entry) => {
      if (!found && action && entry.action === action) found = entry;
    });
    return found;
  }

  function hasPendingForAction(action) {
    let found = false;
    state.pending.forEach((entry) => { if (entry.action === action) found = true; });
    return found;
  }

  function resolvePending(id, outcome) {
    const key = id == null ? '' : String(id);
    const entry = state.pending.get(key);
    if (!entry) return null;
    clearTimeout(entry.timer);
    state.pending.delete(key);
    if (entry.button) {
      delete entry.button.dataset.pendingAction;
      entry.button.disabled = state.locked;
    }
    const label = ACTION_LABELS[entry.action] || entry.action;
    if (outcome === 'timeout') pushLog('warn', label + ' 未收到服务端确认（可能未送达）');
    else if (outcome === 'echo-timeout') pushLog('warn', label + ' 已被接受，但遥测未变化（可能受车型键位映射限制）');
    else if (outcome === 'nack') { /* 已在 handleNack 提示 */ }
    else if (outcome === 'confirmed') pushLog('ok', label + ' 状态已由遥测确认');
    return entry;
  }

  function matchPendingFromTelemetry(data) {
    if (!state.pending.size) return;
    const done = [];
    state.pending.forEach((entry, id) => {
      const e = entry.expect || {};
      let matched = false;
      if (e.kind === 'light' && data.lights && typeof data.lights[e.key] === 'boolean') {
        matched = data.lights[e.key] === e.value;
      } else if (e.kind === 'wiper' && typeof data.wipers === 'string') {
        matched = data.wipers === e.value;
      } else if (e.kind === 'toggle' && typeof e.value === 'boolean' && typeof data[e.key] === 'boolean') {
        matched = data[e.key] === e.value;
      }
      if (matched) done.push(id);
    });
    done.forEach((id) => { resolvePending(id, 'confirmed'); });
  }

  /**
   * 发送命令。
   * @param {string} action 契约冻结的 action
   * @param {boolean|string|undefined} value 灯光=boolean；wipers.set=off|auto|1|2|3；toggle 类不传
   * @param {HTMLElement} button 触发的按钮（用于 pending 态）
   */
  function sendCommand(action, value, button) {
    updateLock();
    const label = ACTION_LABELS[action] || action;
    if (state.locked) { pushLog('warn', '控制已锁定，未发送：' + label + '（' + state.lockReason + '）'); return; }
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.helloOk) {
      pushLog('warn', '连接未就绪，未发送：' + label);
      return;
    }
    if (now() - (state.lastSentAt.get(action) || 0) < ACTION_COOLDOWN_MS) return; // 防连点，静默忽略
    if (hasPendingForAction(action)) { pushLog('warn', label + ' 上一条命令仍在等待确认，请稍候'); return; }

    state.seq += 1;
    const id = 'c' + state.seq;
    const payload = { type: 'command', id, action };
    const expect = { kind: null, key: null, value: null };

    if (action in LIGHT_ACTIONS) {
      if (typeof value !== 'boolean') { pushLog('error', label + ' 需要 boolean 目标值，已取消'); return; }
      payload.value = value;
      expect.kind = 'light';
      expect.key = LIGHT_ACTIONS[action].key;
      expect.value = value;
    } else if (action === 'wipers.set') {
      if (typeof value !== 'string' || !(value in WIPER_LABELS)) { pushLog('error', '雨刮档位不合法，已取消'); return; }
      payload.value = value;
      expect.kind = 'wiper';
      expect.value = value;
    } else if (action in TOGGLE_KEYS) {
      // 契约：toggle 类省略 value
      expect.kind = 'toggle';
      expect.key = TOGGLE_KEYS[action];
      const current = state.telemetry ? state.telemetry[expect.key] : null;
      expect.value = typeof current === 'boolean' ? !current : null;
    } else {
      pushLog('error', '未知动作，已取消：' + action);
      return;
    }

    try {
      state.socket.send(JSON.stringify(payload));
    } catch (err) {
      pushLog('error', '发送失败：' + label);
      return;
    }

    state.lastSentAt.set(action, now());
    const entry = {
      id: id,
      action: action,
      expect: expect,
      button: button || null,
      acked: false,
      timer: null
    };
    entry.timer = setTimeout(() => { resolvePending(id, entry.acked ? 'echo-timeout' : 'timeout'); }, PENDING_TIMEOUT_MS);
    state.pending.set(id, entry);

    if (button) { button.dataset.pendingAction = 'true'; button.disabled = true; }
    pushLog('pending', '已发送：' + label + '（等待确认）');
  }

  function handleAck(msg) {
    const entry = findPending(msg.id, msg.action);
    const action = msg.action || (entry && entry.action) || '';
    if (entry) {
      entry.acked = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { resolvePending(entry.id, 'echo-timeout'); }, PENDING_TIMEOUT_MS);
    }
    pushLog('pending', (ACTION_LABELS[action] || action || '命令') + ' 服务端已接受（等待遥测回读）');
  }

  function handleNack(msg) {
    const entry = findPending(msg.id, msg.action);
    const action = msg.action || (entry && entry.action) || '';
    if (entry) resolvePending(entry.id, 'nack');
    const label = ACTION_LABELS[action] || action || '命令';
    const code = msg.error || '';
    let text = ERROR_TEXT[code] || ('服务端拒绝：' + (code || '未知原因'));
    if (msg.message) text += '（' + msg.message + '）';
    pushLog('error', label + ' 失败：' + text);
  }

  function handleError(msg) {
    const code = msg.error || '';
    let text = ERROR_TEXT[code] || ('服务端错误：' + (code || 'unknown'));
    if (msg.message) text += '（' + msg.message + '）';
    pushLog('error', text);
    if (code === 'HELLO_REQUIRED') {
      state.helloOk = false;
      try { if (state.socket) state.socket.close(); } catch (err) { /* ignore */ }
    }
  }


  // ---- /health 轮询：同步 mock 标志（WS 仍是主通道） ----
  function pollHealth() {
    if (document.hidden || typeof fetch !== 'function') return;
    fetch('/health', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!json || typeof json.mock !== 'boolean') return;
        state.mockFromHealth = json.mock;
        if (!state.helloOk && typeof state.mock !== 'boolean') {
          state.mock = json.mock;
          renderMode();
          return;
        }
        if (state.helloOk && json.mock !== state.mock) {
          state.mock = json.mock;
          renderMode();
          pushLog('pending', '模式已按 /health 同步：' + (state.mock ? '模拟 mock' : '实时遥测'));
        }
      })
      .catch(() => { /* 轮询失败静默处理，不影响 WS 主通道 */ });
  }

  // ---- 看门狗：刷新时效、重连倒计时；长时间无遥测则重建连接（含半死连接升级处理） ----
  function watchdog() {
    updateStamp();
    if (!state.socket || state.phase === 'closed') {
      if (state.reconnectTimer && state.nextRetryAt) {
        const secs = Math.max(0, Math.ceil((state.nextRetryAt - now()) / 1000));
        setConnPill('error', '已断开 · ' + secs + ' 秒后重连');
      }
      updateLock();
      return;
    }
    if (state.helloOk && state.lastTelemetryAt > 0 && now() - state.lastTelemetryAt > FORCE_RECONNECT_SILENCE_MS) {
      const socket = state.socket;
      const closing = socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED;
      const graceElapsed = state.lastForceReconnectAt > 0 && now() - state.lastForceReconnectAt > 3000;
      if (closing || graceElapsed) {
        // 半死连接（网络切换/NAT 超时/标签页冻结）：丢弃并重连
        state.socket = null;
        state.phase = 'closed';
        state.helloOk = false;
        try { socket.close(); } catch (err) { /* ignore */ }
        scheduleReconnect('连接无响应（遥测长时间中断）');
        return;
      }
      if (now() - state.lastForceReconnectAt > MIN_FORCE_RECONNECT_GAP_MS) {
        state.lastForceReconnectAt = now();
        setConnPill('error', '遥测中断 · 尝试重建连接');
        pushLog('warn', '长时间无遥测，尝试重建连接');
        try { socket.close(); } catch (err) { /* ignore */ }
      }
      updateLock();
      return;
    }
    updateLock();
  }

  // ---- 手动重连（清空 pending，避免积压命令） ----
  function clearPending(text) {
    if (!state.pending.size) return;
    const ids = [];
    state.pending.forEach((entry, id) => ids.push(id));
    ids.forEach((id) => {
      const entry = state.pending.get(id);
      if (entry && entry.button) { delete entry.button.dataset.pendingAction; }
      resolvePending(id, 'nack');
    });
    if (text) pushLog('warn', text + '：已丢弃 ' + ids.length + ' 条未确认命令');
  }

  function manualReconnect() {
    pushLog('pending', '手动重新连接…');
    state.reconnectAttempt = 0;
    clearPending('');
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    state.nextRetryAt = 0;
    if (state.socket) {
      state.intentionalClose = true;
      try { state.socket.close(); } catch (err) { /* ignore */ }
    }
    connect('manual');
  }

  // ---- 全屏（iOS/WebKit 有限制：能力探测 + 中文引导，不静默失败） ----
  const standaloneQuery = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;

  function isStandaloneMode() {
    if (window.navigator && window.navigator.standalone === true) return true;
    return !!(standaloneQuery && standaloneQuery.matches);
  }

  function fullscreenActive() {
    return document.fullscreenElement != null || document.webkitFullscreenElement != null;
  }

  function fullscreenTarget() {
    const el = document.documentElement;
    if (typeof el.requestFullscreen === 'function') return { el: el, fn: el.requestFullscreen };
    if (typeof el.webkitRequestFullscreen === 'function') return { el: el, fn: el.webkitRequestFullscreen };
    return null;
  }

  function updateFullscreenBtn() {
    if (!els.fullscreenBtn) return;
    const active = fullscreenActive();
    els.fullscreenBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    els.fullscreenBtn.textContent = active ? '退出全屏' : '全屏';
  }

  function lockLandscape() {
    const so = window.screen && window.screen.orientation;
    if (!so || typeof so.lock !== 'function') {
      if (IS_IOS) pushLog('warn', 'iOS 不支持锁定屏幕方向，请关闭系统方向锁后手动横屏');
      return;
    }
    try {
      const p = so.lock('landscape');
      if (p && typeof p.catch === 'function') {
        p.catch(() => { pushLog('warn', '系统不允许锁定横屏，请手动旋转设备'); });
      }
    } catch (err) { /* 不支持：忽略 */ }
  }

  function showFullscreenHint(text, shortLog) {
    if (els.fsHint && els.fsHintText) {
      els.fsHintText.textContent = text;
      els.fsHint.hidden = false;
    }
    pushLog('warn', shortLog || text);
  }

  function fullscreenHintText() {
    if (isStandaloneMode()) {
      return '已以「主屏幕应用」方式运行：界面本身就没有浏览器工具栏，无需再全屏。iOS 无法用网页锁定方向，请关闭系统「方向锁定」后横屏握持。';
    }
    const prefix = IS_IOS_CHROME
      ? 'iOS 上的 Chrome 与 Safari 使用同一 WebKit 内核，同样没有「整页全屏」接口。'
      : '这是 iOS 的系统限制：iPhone / iPad 的浏览器不提供「整页全屏」接口，网页无法绕过。';
    return prefix + '替代做法：用 Safari 打开本页 → 轻触底部「分享」按钮 → 选择「添加到主屏幕」→ 再从主屏幕上的 TruckDeck 图标启动，即可获得无地址栏的全屏界面。';
  }

  function toggleFullscreen() {
    const target = fullscreenTarget();
    if (!target) {
      showFullscreenHint(
        IS_IOS ? fullscreenHintText() : '当前浏览器不支持全屏 API，可手动横屏使用。',
        IS_IOS
          ? (isStandaloneMode()
            ? '已在主屏幕模式运行；iOS 无法锁定方向，请手动横屏'
            : 'iOS 不支持整页全屏：请用 Safari「添加到主屏幕」后从图标启动')
          : '当前浏览器不支持全屏 API'
      );
      return;
    }

    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      const promise = fullscreenActive()
        ? (typeof exit === 'function' ? exit.call(document) : null)
        : target.fn.call(target.el);
      if (promise && typeof promise.then === 'function') {
        promise.then(() => { lockLandscape(); updateFullscreenBtn(); })
          .catch(() => { pushLog('warn', '全屏请求被浏览器拒绝（需用户手势或权限），可手动横屏'); });
      } else {
        updateFullscreenBtn();
      }
    } catch (err) {
      pushLog('warn', '全屏调用失败，可手动横屏使用');
    }
  }


  // ---- 竖屏温和提示（仍可操作） ----
  const portraitQuery = window.matchMedia ? window.matchMedia('(orientation: portrait)') : null;

  function orientationDismissed() {
    try { return sessionStorage.getItem('truckdeck-orient-dismissed') === '1'; } catch (err) { return false; }
  }

  function updateOrientationHint() {
    if (!els.orientHint) return;
    // 以实际视口比例为准（模拟器/分屏下 matchMedia 可能滞后），再叠加竖屏媒体查询
    const portrait = window.innerHeight > window.innerWidth || !!(portraitQuery && portraitQuery.matches);
    const show = portrait && !orientationDismissed();
    els.orientHint.hidden = !show;
  }

  // ---- 按钮绑定 ----
  function bindControls() {
    lightButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const meta = LIGHT_ACTIONS[btn.dataset.action];
        const lights = state.telemetry && state.telemetry.lights ? state.telemetry.lights : null;
        const current = lights && typeof lights[meta.key] === 'boolean' ? lights[meta.key] : null;
        if (current === null) { pushLog('warn', meta.label + '：当前状态未知，等待遥测后再操作'); return; }
        sendCommand(btn.dataset.action, !current, btn);
      });
    });

    els.wiperButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.wiperValue;
        if (state.telemetry && state.telemetry.wipers === value) {
          pushLog('info', '雨刮已是「' + (WIPER_LABELS[value] || value) + '」，未重复发送');
          return;
        }
        sendCommand('wipers.set', value, btn);
      });
    });

    toggleButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        // 契约：toggle 类不传 value
        sendCommand(btn.dataset.action, undefined, btn);
      });
    });
  }

  // ---- 初始化 ----
  function init() {
    const host = location.host;
    if (els.hostText) els.hostText.textContent = host + ' /ws';
    if (els.hostCode) els.hostCode.textContent = wsUrl();

    renderMode();
    updateLock();
    bindControls();

    if (els.reconnectBtn) els.reconnectBtn.addEventListener('click', manualReconnect);
    if (els.fullscreenBtn) els.fullscreenBtn.addEventListener('click', toggleFullscreen);
    if (els.orientDismiss) {
      els.orientDismiss.addEventListener('click', () => {
        try { sessionStorage.setItem('truckdeck-orient-dismissed', '1'); } catch (err) { /* ignore */ }
        updateOrientationHint();
      });
    }
    if (els.fsDismiss) {
      els.fsDismiss.addEventListener('click', () => { if (els.fsHint) els.fsHint.hidden = true; });
    }

    document.addEventListener('fullscreenchange', updateFullscreenBtn);
    document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);
    updateFullscreenBtn();

    updateOrientationHint();
    if (portraitQuery) {
      if (portraitQuery.addEventListener) portraitQuery.addEventListener('change', updateOrientationHint);
      else if (portraitQuery.addListener) portraitQuery.addListener(updateOrientationHint);
    }
    window.addEventListener('resize', () => { updateOrientationHint(); updateStamp(); });

    // 页面恢复可见：立即补一次连接与状态同步，避免手机后台冻结后假死
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      updateStamp();
      updateLock();
      if (!state.socket || state.socket.readyState > WebSocket.OPEN) {
        if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
        state.nextRetryAt = 0;
        state.reconnectAttempt = 0;
        pushLog('pending', '页面恢复可见，立即重连');
        connect('visible');
      }
      pollHealth();
    });

    // 网络恢复（手机切换 Wi-Fi/蜂窝数据）：立即重连，不等退避计时
    window.addEventListener('online', () => {
      updateStamp();
      updateLock();
      if (!state.socket || state.socket.readyState > WebSocket.OPEN || (state.lastTelemetryAt && now() - state.lastTelemetryAt > TELEMETRY_STALE_MS)) {
        if (state.socket) { state.intentionalClose = true; try { state.socket.close(); } catch (err) { /* ignore */ } }
        state.socket = null;
        state.phase = 'closed';
        state.helloOk = false;
        if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
        state.nextRetryAt = 0;
        state.reconnectAttempt = 0;
        pushLog('pending', '网络已恢复，立即重连');
        connect('online');
      }
    });

    // 离开页面主动关闭，避免遗留 socket 被服务端反复重试用
    window.addEventListener('pagehide', () => {
      state.intentionalClose = true;
      if (state.socket) { try { state.socket.close(); } catch (err) { /* ignore */ } }
    });

    setInterval(watchdog, WATCHDOG_INTERVAL_MS);
    setInterval(pollHealth, HEALTH_POLL_MS);
    pollHealth();
    connect('init');
    pushLog('info', '页面就绪 · 目标 ' + wsUrl());
  }

  // ---- 诊断钩子（供自动化验收/排障使用，不参与常规操作） ----
  window.TruckDeck = {
    version: CONTRACT_VERSION,
    wsUrl: wsUrl,
    getState: () => ({
      phase: state.phase,
      helloOk: state.helloOk,
      mock: state.mock,
      locked: state.locked,
      lockReason: state.lockReason,
      pending: state.pending.size,
      telemetryHz: state.telemetryHz,
      telemetryCount: state.telemetryCount,
      telemetry: state.telemetry,
      lastTelemetryAt: state.lastTelemetryAt,
      nextRetryAt: state.nextRetryAt
    }),
    sendRaw: (obj) => {
      try { state.socket.send(JSON.stringify(obj)); return true; } catch (err) { return false; }
    },
    // 仅用于验收/排障：模拟一条来自服务端的消息（不发送任何数据）
    simulateIncoming: (obj) => { handleMessage(JSON.stringify(obj)); return true; },
    log: (kind, text) => pushLog(kind, text)
  };

  try {
    init();
  } catch (err) {
    console.error('[TruckDeck] 初始化失败', err);
    pushLog('error', '页面初始化失败：' + (err && err.message ? err.message : String(err)));
  }

  // 手机上看不到开发者控制台：把未捕获错误同步写进页面底部日志条，便于真机排障
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason ? (event.reason.message || String(event.reason)) : '未知原因';
    console.error('[TruckDeck] 未处理的 Promise 拒绝', event.reason);
    pushLog('error', '未处理的异步错误：' + reason);
  });

  window.addEventListener('error', (event) => {
    // 资源（img/script）加载失败也会触发 error 事件但没有 message，这里不当作脚本错误
    if (event && event.target && event.target !== window && !event.message) return;
    const msg = event && event.message ? event.message : '未知错误';
    const file = event && event.filename ? String(event.filename).split('/').pop() : '';
    const where = file ? '（' + file + ':' + (event.lineno || 0) + '）' : '';
    console.error('[TruckDeck] 未捕获错误', (event && event.error) || msg);
    pushLog('error', '页面脚本错误：' + msg + where);
  });
})();
