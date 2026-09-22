# TruckDeck API Contract — v1（冻结）

**状态：** Frozen v1  
**日期：** 2026-09-22  
**变更规则：** 端口、路径、事件名、字段名未经 Astra 批准不得变更。若实现发现必须改动，先回报 Astra，再由 Astra 通知 Cline。

---

## 1. 传输与端点

| 项 | 冻结值 |
| --- | --- |
| HTTP 基址 | `http://<PC-LAN-IP>:4000` |
| 默认端口 | `4000`（可用环境变量 `TRUCKDECK_PORT` 覆盖；配置文件默认同此） |
| WebSocket | `ws://<PC-LAN-IP>:4000/ws`（路径必须为 `/ws`） |
| 前端连接 | **必须**使用 `location.host` 连接当前页面的主机与端口，禁止写死 IP/端口 |

### HTTP

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| `GET /health` | 精确 JSON | `{"ok":true,"mock":true}` 或 `{"ok":true,"mock":false}` |
| `GET /` | 静态托管 | `server/public/`（`npm run build` 自 `web/` 复制）；无前端时提供极简状态页 |

`mock` 含义：当前进程是否处于 **mock 模式**（不向宿主 OS 注入按键、遥测由模拟器生成或强制模拟）。`TRUCKDECK_MOCK=1` 强制 `mock:true`。插件不可用、非 Windows、或共享内存无数据时自动进入 mock，且 **不得静默假装真实连接**。

---

## 2. 安全（局域网）

- 仅供局域网使用。服务端拒绝非本机/非私网来源的 HTTP 与 WS 升级。
- 私网判定：`127.0.0.0/8`、`::1`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、链路本地等。
- WebSocket **必须校验 Origin**（若存在）：Origin 的 host 须为本机或私网地址，且端口与当前服务端口一致（或 Origin 为 `null` 的非浏览器工具可按实现策略拒绝——浏览器手机控制页必须带合法 Origin）。
- 目的：避免任意网页跨站打开 WebSocket 触发键盘注入。
- 不提供公网隧道、账号、密钥上传。

---

## 3. WebSocket 消息约定

- 编码：UTF-8 JSON 文本帧。
- 未知 `type`：回复 `{"type":"error","error":"UNKNOWN_TYPE","message":"..."}`，不断开（除非安全拒绝）。
- 非法 JSON：回复 `{"type":"error","error":"INVALID_JSON","message":"..."}`。

### 3.1 握手顺序（必须先 hello）

1. 客户端连接 `ws://…/ws`。
2. 客户端 **必须先**发送：

```json
{"type":"hello","role":"web","version":"1"}
```

3. 服务端回复 **hello ack**（同一 `type:"hello"`，带 `ok`）：

```json
{
  "type": "hello",
  "ok": true,
  "role": "server",
  "version": "1",
  "mock": true,
  "telemetryHz": 10,
  "ts": 1710000000000
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 握手是否成功 |
| `role` | string | 固定 `"server"` |
| `version` | string | 契约主版本，当前 `"1"` |
| `mock` | boolean | 与 `/health` 的 `mock` 一致，供前端显示 mock 状态 |
| `telemetryHz` | number | 实际推送频率（推荐 10，最低保证 ≥5） |
| `ts` | number | 服务端 Unix 毫秒时间戳 |

握手失败示例：

```json
{"type":"hello","ok":false,"error":"UNSUPPORTED_VERSION","message":"version must be \"1\""}
```

4. **hello 成功之前**：除 `hello` 外的任何消息一律拒绝：

```json
{"type":"error","error":"HELLO_REQUIRED","message":"send hello before other messages"}
```

5. hello 成功后开始推送 `telemetry`；客户端可发送 `command`。

### 3.2 遥测 `telemetry`

频率：≥ **5 Hz**，推荐 **10 Hz**。

```json
{
  "type": "telemetry",
  "ts": 1710000000000,
  "data": {
    "connected": true,
    "speedKmh": 0,
    "engineRpm": 0,
    "gear": 0,
    "fuelPct": 0,
    "airPressure": 0,
    "lights": {
      "parking": false,
      "beamLow": false,
      "beamHigh": false,
      "blinkerLeft": false,
      "blinkerRight": false,
      "hazard": false
    },
    "wipers": "off",
    "handbrake": false,
    "diffLock": false,
    "liftAxle": false,
    "cruise": false,
    "engineOn": false
  }
}
```

| 字段 | 单位 / 语义 |
| --- | --- |
| `ts` | Unix 毫秒 |
| `connected` | **mock 模式**：`true` 表示模拟器在线（始终可驱动 UI）。**真实模式**：`true` 表示 scs-sdk-plugin 共享内存可读且 `sdkActive`；游戏未开/插件缺失为 `false`。模式切换必须反映在后续 `telemetry` 与 `/health`/`hello.mock`，不得静默误报。 |
| `speedKmh` | km/h（真实源：SDK `speed` 为 m/s，×3.6） |
| `engineRpm` | RPM |
| `gear` | 整数档位（真实源：优先 `gearDashboard`，否则 `gear`；负数为倒档） |
| `fuelPct` | 0–100，油量百分比（真实：`fuel/fuelCapacity*100`） |
| `airPressure` | 气泵压力；真实源 SDK 单位为 **psi**（与 TruckSim-Telemetry / 插件文档一致） |
| `lights.*` | boolean 当前状态 |
| `wipers` | 枚举字符串：`off` \| `auto` \| `1` \| `2` \| `3` |
| `handbrake` / `diffLock` / `liftAxle` / `cruise` / `engineOn` | boolean |

**重要：** `command_ack` **不能**代替真实/模拟遥测回显。UI 必须以后续 `telemetry` 为准。

### 3.3 命令 `command`

```json
{"type":"command","action":"lights.beamLow","value":true}
```

可选 `id`（string）：若提供，ack/nack 原样回传。

```json
{"type":"command","id":"c1","action":"handbrake.toggle"}
```

#### 动作枚举（v1 冻结）

| action | value | 说明 |
| --- | --- | --- |
| `lights.parking` | **必需** `boolean` | 目标状态 |
| `lights.beamLow` | **必需** `boolean` | 目标状态 |
| `lights.beamHigh` | **必需** `boolean` | 目标状态 |
| `lights.blinkerLeft` | **必需** `boolean` | 目标状态 |
| `lights.blinkerRight` | **必需** `boolean` | 目标状态 |
| `lights.hazard` | **必需** `boolean` | 目标状态 |
| `wipers.set` | **必需** string：`off`\|`auto`\|`1`\|`2`\|`3` | 对应游戏常见 0/AUTO/1/2/3；无 AUTO 键位映射时 **拒绝**，禁止假装成功 |
| `handbrake.toggle` | **可选**；若出现须为 `null` 或省略 | 切换手刹 |
| `diffLock.toggle` | 同上 | 差速锁 |
| `liftAxle.toggle` | 同上 | 抬轴 |
| `cruise.toggle` | 同上 | 巡航 |
| `engine.toggle` | 同上 | 发动机点火/熄火 |

#### 成功确认

```json
{"type":"command_ack","ok":true,"action":"lights.beamLow","id":"c1","ts":1710000000000}
```

`id` 仅在请求带 `id` 时出现。

#### 失败

```json
{
  "type": "command_nack",
  "ok": false,
  "action": "wipers.set",
  "id": "c1",
  "error": "UNSUPPORTED",
  "message": "wipers AUTO has no keybind mapping",
  "ts": 1710000000000
}
```

#### 错误枚举 `error`

| 代码 | 含义 |
| --- | --- |
| `HELLO_REQUIRED` | 未 hello |
| `INVALID_JSON` | 非 JSON |
| `UNKNOWN_TYPE` | 未知消息类型 |
| `UNKNOWN_ACTION` | 未知 action |
| `INVALID_VALUE` | value 类型/枚举非法 |
| `NOT_MAPPED` | keybinds 中无该动作映射 |
| `UNSUPPORTED` | 当前环境不支持（如 AUTO 无绑定、Linux 真实注入） |
| `INJECT_FAILED` | 按键注入失败 |
| `FORBIDDEN` | 来源/Origin 拒绝（通常在握手前直接关闭） |
| `UNSUPPORTED_VERSION` | hello.version 不支持 |

---

## 4. Mock 与真实模式

| 条件 | 行为 |
| --- | --- |
| `TRUCKDECK_MOCK=1` | 强制 mock；**绝不**向 OS 注入按键 |
| 插件/共享内存不可用 | 自动 mock，日志明确说明 |
| Windows + 插件可用 + 未强制 mock | 真实遥测；命令走按键注入 |
| Linux | 可运行服务与 mock；真实游戏/注入不在此环境验证 |

Mock 下所有有效 command 必须改变相应遥测状态并打日志。

---

## 5. 配置

- `config/server.default.json`：`port` 默认 4000，`telemetryHz` 默认 10。
- `config/keybinds.default.json`：`action → 键名` 白名单映射；可本地改 JSON，须与游戏内键位一致。
- 键名仅接受服务端白名单（如 `KeyL`、`KeyK`、`Digit1`、`Space`…），禁止任意字符串拼进 PowerShell。

---

## 6. 二期（非 v1）

陀螺仪 / vJoy：仅见 `docs/PHASE2_VJOY.md` 与 server 内 TODO 接口草稿，**不实现**。

---

## 7. 给前端（Cline）的要点

1. `ws://` + `location.host` + 路径 `/ws`。
2. 先 `hello`，读 ack 的 `mock` 显示状态。
3. 订阅 `telemetry` 更新仪表；不要用 `command_ack` 当状态源。
4. 灯光类带 boolean `value`；toggle 类不要乱传 value。
5. `wipers.set` 的 value 只能是 `off|auto|1|2|3`。
6. 横屏中文 UI 在 `web/`；构建由根目录 `npm run build` 复制到 `server/public/`（Cline **不要**改根 `package.json` scripts）。

## 8. 一期对接验收澄清（Astra，2026-09-22）

本节明确已实现行为，不变更 v1 默认端口、路径、事件名、字段或动作枚举。

- 模式改变后，服务端会再次发送同格式的成功 `hello` 消息，更新 `mock`。客户端清除旧模式的待确认操作，等待随后新遥测再解锁。
- 无游戏或 `sdkActive=false` 时自动 mock，此时 `data.connected=true` 表示模拟器在线；必须结合 `hello.mock` 区分模拟器和游戏连接。
- 真实源只提供雨刮开关，故 live `wipers="1"` 表示“已开，档位未知”；只有 mock 可准确展示五档。真实 AUTO/2/3 没有独立映射时返回 `UNSUPPORTED`。独立映射只保证发键，不增加 SDK 的回读能力。
- 灯光默认共用 L 循环键：关闭示廓或近光可能连带关闭另一项；前端使用下一帧遥测显示最终状态。
- 命令共享有界串行队列，等待超过 1500ms、连接关闭、模式变化均会丢弃。拒绝沿用 `UNSUPPORTED`，不增加错误枚举。
- WS 浏览器 Origin 需与指向本机接口的 Host 匹配。单帧上限 8 KiB，hello 超时 10 秒，每连接每秒消息上限 30；过大帧可能直接关闭连接。
- 重连必须重新 hello，并等待该连接的新遥测；断线期间不缓存、重发控制命令。

对接修正记录见 [INTEGRATION_PATCH.md](INTEGRATION_PATCH.md)，实际验收结果见 [ACCEPTANCE.md](ACCEPTANCE.md)。
