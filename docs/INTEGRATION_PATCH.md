# 对接补丁说明（Astra 验收）

Cursor 按 Astra 的复核清单修复后端，Cline 按冻结契约实现前端。Astra 完成以下对齐；行为澄清已合入 `API_CONTRACT.md` 第 8 节，端口、路径、事件与 action 枚举保持不变。

## 1. mock / live 判定

- **live** 仅当：非 `TRUCKDECK_MOCK`、平台 Windows、`trucksim-telemetry` 可加载、且最近一次共享内存读取 `connected`/`sdkActive === true`。
- 仅“包能 require”不足以维持 live；游戏未开/插件无数据 → **自动 mock**。
- 模式切换时，向已 hello 的 WS 客户端再发一条契约既有形状的 **hello ack**（`type:"hello", ok:true, mock:...`），供前端更新 mock 指示。
- 切换模式会推进代次，使旧模式下积压的命令失效；执行前的新遥测读取若再次改变模式，也会拒绝该命令。

## 2. 灯光 L 键循环

- 默认 `lights.parking` 与 `lights.beamLow` 同键 `L`，按游戏常见循环：`off → parking → low(+parking) → off`。
- 服务端用纯函数按**当前遥测**计算有限步数；已在目标则 no-op。
- **耦合：** 关闭 parking 会进入全灭，low 一并关闭；从 low 再按循环会到 off 而非 parking-only。

## 3. 雨刮 live 回显

- SDK 仅 boolean：live 遥测只回显 `off` 或 `1`（表示 on），**不伪造** `2`/`3`/`auto`。
- 默认 `wipers.auto` 未映射 → live 对 `auto` 返回既有错误码 `UNSUPPORTED`。
- live 对 `2`/`3` 无独立键位时 `UNSUPPORTED`（无法辨档）。
- **mock** 仍支持 `off|auto|1|2|3` 全五档。

## 4. Origin / Host

- Origin 须与请求 Host 指向**本机**接口地址或 localhost（含 `127.0.0.1`），且端口一致。
- 其他私网 Origin（非本机 IP 上的页面）拒绝，降低跨站键盘风险。

## 5. 命令执行

- 全进程有界串行队列（默认 32，TTL ~1500ms）；入队记录 modeGeneration / session；模式切换或断连后积压命令 nack `UNSUPPORTED`，不在新模式误执行。
- 停机：`queue.close` → drain → 再 `input.dispose`，避免停服仍发键。
- live 路径使用 `requireLive`（`!isMock && canInject`）；丢失 live **不**降级为 mock 命令成功。
- `requireLive` 的 tap **不会**成功伪装成 mock tap。
- 状态以遥测为准，不以 command_ack 自造。
- 非循环灯光：只 tap 一次，等待遥测（约 600ms），不盲二次 tap。

## 6. SendInput（Windows）

- 使用含 MOUSE/KEYBD/HARDWARE union 的 INPUT；校验 `SendInput` 返回值。
- 依据：[INPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-input)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)。
- Worker `-File`；内部 JSON 带 `id` 相关；超时隔离旧 worker；错误用 `ConvertTo-Json`。
- **Windows 实体机 / 游戏尚未验收。**

## 7. 遥测频率

- `telemetryHz` 与 `setInterval` 对齐（不再被 `max(100ms)` 锁死在 ≤10Hz）。
- 慢客户端 `bufferedAmount` 超限则跳过/断开。

## 8. 手机客户端对齐

- 新连接及模式切换清除待确认操作，必须等待新遥测才解锁，旧 socket 的迟到事件不修改新连接。
- live 雨刮 `1` 显示“开启 · 档位未知”；不假装精确回读了一档。
- 操作页面使用中文驾驶文案，协议细节保留在契约文档。
- 已验证同源静态托管及 `location.host`：默认 4000 与临时 4012 均可连接，无须 CORS 或独立开发代理。
