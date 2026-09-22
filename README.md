# TruckDeck

局域网电脑上的 Node 服务 + 手机浏览器横屏控制 **Euro Truck Simulator 2 / American Truck Simulator**。  
默认端口 **4000**，WebSocket 路径 **`/ws`**。仅私网使用，不提供公网隧道。

后端与契约由 Cursor Agent 实现，手机面板由 Cline Agent 实现，Astra 完成接口对齐与独立验收。前端为原生 HTML/CSS/JS，无 CDN。

契约全文：[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)（**v1 已冻结**）

---

## 环境要求

- **Node.js ≥ 22**（推荐 **24**；与 `trucksim-telemetry@1.0.0` engines 对齐）
- Windows PC 运行游戏与真实遥测/按键；Linux 可跑服务与 **全功能 mock**（演示足够）。**Windows 实体机 / 游戏尚未验收**（含 SendInput 与共享内存实机）。

安装 Node（示例）：

- 官网：https://nodejs.org/（选 22 LTS 或 24）
- 或包管理器：`winget install OpenJS.NodeJS.LTS`（Windows）

---

## 快速开始

```bash
cd TruckDeck
npm install
npm run build    # 将 web/ 复制到 server/public/；无前端时生成极简状态页
npm start        # 自动先 build，再启动
```

强制 mock：

```bash
# Windows PowerShell
$env:TRUCKDECK_MOCK="1"; npm start

# bash
TRUCKDECK_MOCK=1 npm start
```

自定义端口：

```bash
TRUCKDECK_PORT=4000 npm start
```

健康检查：打开 `http://127.0.0.1:4000/health`，模拟模式返回 `{"ok":true,"mock":true}`，真实模式返回 `{"ok":true,"mock":false}`。

---

## 手机连接

1. 电脑与手机同一局域网。
2. Windows 上 `ipconfig`，找到以太网/WLAN 的 **IPv4**。
3. 手机浏览器打开：`http://<电脑局域网IP>:4000`（替换尖括号内的内容，横屏）。
4. 前端必须用 `location.host` 连接 `ws://` + 当前主机端口 + `/ws`，不要写死 IP。

### Windows 防火墙

将网络配置为**专用网络**，并允许 Node 入站 TCP **4000**（首次运行 Windows 可能弹窗）。公共网络下可能被拦。

---

## scs-sdk-plugin（真实遥测）

**来源：** [RenCloud/scs-sdk-plugin](https://github.com/RenCloud/scs-sdk-plugin)  
**Node 桥：** [trucksim-telemetry](https://www.npmjs.com/package/trucksim-telemetry)（维护者文档当前支持插件 **v1.12.1**；API：`getData()`）  
**共享内存名：** `Local\SCSTelemetry`（插件 README）

### 安装路径

将插件 DLL 放到游戏目录：

- ETS2：`<Steam>/steamapps/common/Euro Truck Simulator 2/bin/win_x64/plugins/`
- ATS：`<Steam>/steamapps/common/American Truck Simulator/bin/win_x64/plugins/`

若无 `plugins` 文件夹则新建。启动游戏时应提示 SDK 已激活。

### 字段单位（一手文档，非猜测）

| 契约字段 | SDK / trucksim-telemetry | 换算 |
| --- | --- | --- |
| `speedKmh` | `speed`（m/s） | × 3.6 |
| `engineRpm` | `engineRpm` | 原样 |
| `gear` | `gearDashboard` 优先，否则 `gear` | 原样 |
| `fuelPct` | `fuel` / `fuelCapacity`（升） | 百分比 |
| `airPressure` | `airPressure` | **psi** |
| 灯光等 | `lightsParking` 等 boolean | 原样 |
| `wipers` | SDK **仅 boolean** | live 只回显 `off` / `1`（on）；**不伪造** `2`/`3`/`auto` |

**模式：** 插件不可用、共享内存无 `sdkActive`、非 Windows、或 `TRUCKDECK_MOCK=1` → mock。仅“Node 包装得上”不够；游戏未开也会 mock。模式变化会再推 hello ack 的 `mock` 字段。

### Windows 安装 / 重建 trucksim-telemetry 原生桥

1. 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 的 **Desktop development with C++**。
2. `npm install`（`trucksim-telemetry` 为 optionalDependency）。
3. 若 npm 提示 **allow-scripts** 阻止了该包的 `node-gyp rebuild`，**只批准这一包**，不要关掉全部脚本限制，例如：
   ```bash
   npm approve-scripts trucksim-telemetry
   npm rebuild trucksim-telemetry
   ```
4. 重建失败时服务仍可 mock 启动；装好插件并启动游戏后才会 live。

> **Windows 实体机 / 游戏尚未验收。** Linux CI 仅覆盖 mock 与协议 worker。

---

## 按键注入（Windows）

- 实现：`server/src/input/sendinput_worker.ps1`（`-File` 启动）+ **SendInput**；stdin 仅 JSON 行（数字 VK）；含正确 INPUT union、返回值检查、扫描码 / `KEYEVENTF_EXTENDEDKEY`（见 Microsoft INPUT / SendInput / KEYBDINPUT 文档）。
- **mock / 断线绝不注入。** 命令全进程串行有界队列。
- 游戏窗口需前台焦点；`dispose` 先 `quit` 等待 worker 释放按键，再必要时 kill。
- Node/PowerShell 与游戏应处于相同权限级别。游戏若以管理员身份运行，普通权限的 SendInput 可能被 Windows UIPI 拒绝；优先让游戏和服务都以普通权限运行。
- 修改映射：`config/keybinds.default.json`，须与游戏内一致且在白名单内。

### 灯光 / 雨刮真实性限制

- 默认 `lights.parking` 与 `lights.beamLow` 同为 **L**：按 `off→parking→low→off` 循环，依遥测算步数；同状态 no-op。**关 parking 会连带关掉 low。**
- live 雨刮：SDK 只能区分 off/on；默认 `wipers.auto` 未映射 → **`UNSUPPORTED`**；`2`/`3` 无独立键位时同样拒绝，不假装成功。
- **mock** 仍可使用 `off|auto|1|2|3` 全五档。

---

## Mock ↔ 真实

| 条件 | 模式 |
| --- | --- |
| `TRUCKDECK_MOCK=1` | 强制 mock |
| Linux / 无原生桥 | mock |
| Windows + 桥可用但游戏未连（无 sdkActive） | mock |
| Windows + sdkActive + 未强制 mock | live |

Mock 下有效 command 会改模拟仪表并打 `[mock]` 日志。

---

## 开发与测试

```bash
npm test                 # test/*.test.js（默认测端口 4011，不占用 4000）
```

编辑 `web/` 后运行 `npm run build`，刷新手机即可加载静态更新；修改后端或 JSON 配置后需重启服务。实际验证结果见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。

### 重启服务

在运行服务的终端按 Ctrl+C，完成修改后重新启动：

```bash
cd TruckDeck
npm start
```

测试始终使用独立端口：`TRUCKDECK_TEST_PORT=4011 npm test`。

Windows 上退出强制模拟：PowerShell 执行 `Remove-Item Env:TRUCKDECK_MOCK -ErrorAction SilentlyContinue`，然后 `npm start`。

---

## 已知限制

- **Windows 实体机 / 游戏尚未验收**（SendInput / 共享内存）。Linux 上全功能 mock 可演示；另有协议 worker 测。
- SDK 雨刮仅为开关；live 不伪造多档/AUTO。
- 提供 manifest 与本地图标，可通过浏览器菜单添加主屏幕快捷方式；局域网 HTTP 下安装、全屏、方向锁定能力依浏览器而定。无 Service Worker，不支持离线控制。
- 灯光循环与个别车型可能不完全一致。
- 不做公网访问、账号、云同步。
- 二期 vJoy：[`docs/PHASE2_VJOY.md`](docs/PHASE2_VJOY.md)。

---

## 故障排除

| 现象 | 处理 |
| --- | --- |
| 手机打不开页面 | IP、防火墙专用网络、端口 4000、同网段 |
| 一直 mock | 游戏是否运行、插件路径、`sdkActive`、是否 `TRUCKDECK_MOCK`、原生桥是否 rebuild 成功 |
| 按键无反应 | 焦点、键位、是否 mock/断线 |
| WS 立刻断开 | Origin 必须与本机 Host 一致（localhost 或 PC LAN IP） |

---

## 文档

- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — 冻结契约
- [`docs/INTEGRATION_PATCH.md`](docs/INTEGRATION_PATCH.md) — 对接补丁说明
- [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) — 实测结果、分工与限制
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 结构
- [`docs/PHASE2_VJOY.md`](docs/PHASE2_VJOY.md) — 二期入口
