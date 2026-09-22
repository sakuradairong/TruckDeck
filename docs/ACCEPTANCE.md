# TruckDeck 一期验收（2026-09-22）

本次使用已安装的实际 `cursor-agent`、`cline` CLI 接力实现。先由 Cursor 提供可运行服务与冻结契约，后由 Cline 只实现 `web/`；Astra 复核并负责跨模块补丁和最终验收。没有将内部代理简单重命名为这两个工具。

## 交付分工

| 负责人 | 最终改动 |
| --- | --- |
| Cursor Agent | 根工程脚本、Express/WS、config、SCS/mock、Windows PowerShell SendInput、命令校验/队列、中文 README、架构/契约/二期文档、后端回归测试 |
| Cline Agent | web/ HTML/CSS/JS、中文深色横屏面板、同源 WS 客户端、重连/锁定/错误反馈、manifest、本地图标、前端说明 |
| Astra | 契约交接、后端复核与返修指派、客户端新连接隔离、模式切换执行边界、雨刮显示语义、对接补丁说明、独立 HTTP/WS/浏览器验收 |

## 实测通过

环境：Linux、Node 24.18.0、npm 11.16.0、Chromium；无 Windows 游戏实体机。

- `npm install` 成功；`npm start` 自动构建、在默认 4000 提供页面。
- 最终 `npm test`：**23/23** 通过。覆盖 HTTP/WS、hello、全部 mock action、输入拒绝、遥测频率、真实源切换、灯光循环、worker 通信及迟到响应、执行瞬间模式变化隔离。
- Astra 独立 WS 验收：默认 4000 上 `/health` 为 `{ "ok": true, "mock": true }`；短窗采样 **10 Hz**；12 类 action、22 次操作全部 ack 且匹配后续遥测（6 灯光分别开/关、5 雨刮档、5 车辆切换）。
- `TRUCKDECK_PORT=4012 TRUCKDECK_MOCK=1` 临时实例：同样 22 次操作通过，短窗采样 **9.17 Hz**；浏览器实际连接 `ws://127.0.0.1:4012/ws`。测后关闭该临时实例；默认端口仍为 4000。
- 浏览器 844×390 / 667×375：16 个控制按钮均可见、无重叠或横向溢出。667×375 最小控制高度 **45 px**。
- 浏览器 390×844：纵向滚动可达全部控件，无横向溢出、无控件重叠，最小控制高度 **60 px**。
- Cline 实测按钮发送形状、快速点击去重、错误中文反馈、断线/数据过期禁用与恢复、后续 hello 切模式、本地资源无外链；Astra 实际重启服务后确认客户端恢复。
- Astra 浏览器断言：新连接只有 hello 时仍锁定；新遥测后解锁；旧 socket 的迟到消息被忽略。

截图：[横屏面板](acceptance/landscape-844x390.png)、[小屏横屏](acceptance/landscape-667x375.png)、[竖屏](acceptance/portrait-390x844.png)、[修复前留档](acceptance/landscape-844x390-before-fix.png)。证据目录说明与复现命令见 [`acceptance/README.md`](acceptance/README.md)。

## 限制与真实模式验收项

- Windows SendInput、插件共享内存接入、游戏实际响应尚待实体机验收。Linux worker 协议测试不能替代 Windows 键盘注入测试。
- 无桥、无插件、无游戏或强制模拟时自动 mock，所有模拟命令都不会向 OS 注入按键。
- SDK 只回读雨刮开关；live 的 `1` 显示“开启，档位未知”。默认 AUTO/2/3 没有独立映射会返回 UNSUPPORTED；mock 五档均可使用。
- 默认灯光共用 L 循环键，游戏绑定与配置需一致；实际车型差异需在游戏中验证。
- LAN HTTP 主屏幕安装/全屏/方向锁定由浏览器决定；无 Service Worker 或离线控制。
- 服务需游戏前台焦点、匹配权限级别；防火墙允许私有网络访问。
- vJoy/陀螺仪未实现。入口为 `docs/PHASE2_VJOY.md` 与 `server/src/phase2/vjoy.js`。

## 协议与工程状态

默认 4000、`/ws`、hello/telemetry/command/ack/nack 及 12 类 action 不变。行为澄清见 `API_CONTRACT.md` 第 8 节，对接修正见 `INTEGRATION_PATCH.md`。

## 接手后的独立复验（Cline，同日）

本记录由 Codex/Astra 会话产出，该会话在上游 429 报错中结束、未输出最终交付摘要，且首轮验收只覆盖正向路径。接手后补做：

- 新增 `docs/acceptance/verify-ws.cjs`，把契约中的**负面路径**变成断言：外域 Origin / `Origin: null` / Origin 端口不符 / 非本机 Host 头 / 非 `/ws` 路径的拒绝，`HELLO_REQUIRED`、`UNSUPPORTED_VERSION`、`INVALID_JSON`、`UNKNOWN_TYPE`、`UNKNOWN_ACTION`、三类 `INVALID_VALUE`，以及超过 8 KiB 单帧导致的断开。
- 对**当前工作区**重跑（不沿用上轮结论）：默认端口 `npm start` 与 `TRUCKDECK_PORT=4013 TRUCKDECK_MOCK=1` 两种方式均 **18/18 通过**，两次均为 22 次操作 / 12 类 action，实测 9.33 / 9.98 Hz。
- 首轮遗留在 `/tmp` 的截图、验收输出与两个下游代理的原始日志已归档进 `docs/acceptance/`（`/tmp` 会被清空，归档前无法保证留存）。

原始输出：[`acceptance/evidence/verify-4000.json`](acceptance/evidence/verify-4000.json)、[`acceptance/evidence/verify-4013.json`](acceptance/evidence/verify-4013.json)。

## 仓库状态与提交切分

交付当时工作区不是 Git 仓库，Astra 未创建虚假提交。接手后已 `git init`（分支 `main`）并提交，按**组件边界**切分：

1. `feat(server): ...` — 工程脚本、Express/WS、config、遥测与输入、回归测试
2. `feat(web): ...` — 手机端中控面板与 PWA 资源
3. `docs(acceptance): ...` — 契约、架构、二期、验收记录与证据

原建议中的 `fix(integration)` 未单列：重连隔离与模式代次修正同时落在 `server/` 与 `web/`，无法在不拆散运行单元的前提下干净独立成一次提交，故随各自组件提交并在此说明。
