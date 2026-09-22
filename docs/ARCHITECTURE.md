# TruckDeck 架构

## 目标

局域网 PC 上运行 Node（Express + WebSocket）服务，手机浏览器横屏控制 ETS2/ATS。默认端口 **4000**，WS 路径 **/ws**。

## 目录

```
TruckDeck/
  package.json          # npm install / build / start
  README.md             # 中文使用说明
  config/
    server.default.json
    keybinds.default.json
  docs/
    API_CONTRACT.md     # v1 冻结契约
    ARCHITECTURE.md
    PHASE2_VJOY.md
  web/                  # 前端源（Cline 实现）；原生 HTML/CSS/JS
  server/
    index.js            # 入口
    public/             # build 产物（由 web/ 复制）
    scripts/build.js
    src/
      app.js            # HTTP + 静态
      config.js
      lan.js            # 私网/Origin 校验
      wsHub.js
      telemetry/        # mock + SCS 桥
      input/            # mock（禁注入）+ Windows SendInput worker
      commands/
      phase2/           # vJoy TODO 草稿
  test/                 # 集成验证
```

## 数据流

1. 手机打开 `http://LAN-IP:4000` → 静态页。
2. 前端用 `location.host` 连 `ws://…/ws`，发送 `hello`。
3. 服务按 ≥5Hz（推荐 10Hz）推送 `telemetry`。
4. 手机发 `command` → mock 改状态 / 真实模式白名单按键注入 → `command_ack|nack`；状态以后续遥测为准。

## 遥测策略

- **首选：** [RenCloud/scs-sdk-plugin](https://github.com/RenCloud/scs-sdk-plugin) 写入共享内存 `Local\SCSTelemetry`；Node 侧用 [trucksim-telemetry](https://www.npmjs.com/package/trucksim-telemetry)（维护者文档支持插件 **v1.12.1**）的 `getData()`。
- **单位（一手文档）：** `speed` = m/s → ×3.6 为 km/h；`fuel`/`fuelCapacity` = 升；`airPressure` = psi；灯光/手刹/差速锁等为 boolean。
- 插件不可用或 `TRUCKDECK_MOCK=1` → mock；模式变化写日志并反映在 `/health` 与 hello.`mock`。

## 按键注入

- Windows：持久 PowerShell worker + `SendInput`，键码白名单。
- Mock / Linux：不调用 OS 注入。
- 退出时释放按下键，避免卡住。

## 构建

`npm run build`：将 `web/` 可发布文件复制到 `server/public/`。`npm start` 先 build；`web/` 未就绪时写入极简状态页并仍能启动。
