# TruckDeck — Cline 前端（web/）交付报告

**日期：** 2026-09-22
**范围：** 仅 `web/`（未修改 `server/`、`config/`、`docs/`、根 `package.json`）
**契约校验：** `docs/API_CONTRACT.md` sha256 = `30c5c5a4c3c78991e8b4837d390bd8021c18a037966ce8bcf6287452c5919523`（与冻结值一致，未改动）

## 1. 文件清单（web/，共 4 个源文件 + manifest + 5 个图标）

| 文件 | 行数/大小 | 说明 |
| --- | --- | --- |
| `web/index.html` | 240 行 | 结构：顶栏状态、6 灯光、仪表、5 雨刮档、5 车辆按钮、方向盘二期占位、日志条、竖屏提示 |
| `web/styles.css` | 659 行 | 深灰中控主题、横屏三栏 / 竖屏单列 / 桌面居中限高、大触摸目标、`[hidden]` 兜底 |
| `web/app.js` | 938 行 | WS 客户端、遥测渲染、命令下发、锁定/重连/防连点、全屏降级、诊断钩子 |
| `web/manifest.webmanifest` | 885 B | 本地 PWA 清单（192/512/maskable512 PNG + 主题色 + landscape 优先） |
| `web/icons/favicon.svg` | 992 B | 内联 SVG 页签图标 |
| `web/icons/icon-192.png` | 2167 B | 本地生成（纯 Node zlib PNG 编码器，无依赖/无网络） |
| `web/icons/icon-512.png` | 6804 B | 同上 |
| `web/icons/icon-maskable-512.png` | 3182 B | 安全区 62% |
| `web/icons/apple-touch-icon.png` | 2209 B | 180×180 |
| `web/README.md` | 58 行 | 文件说明、构建方式、契约对应表、自测钩子（构建会跳过，不发布） |

图标生成脚本在 `/tmp/gen-truckdeck-icons.js`（一次性工具，未入仓库，不参与构建）。

## 2. 构建与运行（实测）

```
cd /root/github_projects/TruckDeck && npm run build
# → [build] 已复制 web/ → server/public/
```

- `server/public/` 与 `web/` 发布内容 `diff -r` 一致；线上 9 个资源逐一 sha256 与本地相同。
- 运行中服务 `:4000` 实测：`GET /` 200（13585 B）、`styles.css` 200、`app.js` 200、`manifest.webmanifest` 200、`icons/*` 200、`/health` = `{"ok":true,"mock":true}`。
- 网络请求清单只有 `127.0.0.1:4000` 自身资源 → **无 CDN / 无外部字体**。

## 3. 契约对应（逐条）

| 契约 | 实现与证据 |
| --- | --- |
| `ws(s)://` + `location.host` + `/ws` | `wsUrl()`；顶栏显示 `127.0.0.1:4000/ws` |
| 必须先 hello | `onopen` 发 `{type:'hello',role:'web',version:'1'}`；6 s 无 ack → 主动重建 |
| 只用 telemetry 更新真实状态 | 实测抓包命令 4 条 + 按钮状态全部由后续 telemetry 变化（日志「状态已由遥测确认」），ack 不反转 UI |
| 灯光 boolean 目标 | 抓包：`{"type":"command","id":"c1","action":"lights.blinkerLeft","value":true}` |
| toggle 省略 value | 抓包：`{"type":"command","id":"c2","action":"diffLock.toggle"}` / `engine.toggle` 同形 |
| wipers 值域 | 抓包：`"value":"auto"`；非法值本地拦截，服务端 `INVALID_VALUE` 亦可显示 |
| 无 vJoy/轴命令 | 代码无此类 action；实测发 `vjoy.steer` 被服务端 `UNKNOWN_ACTION` 拒绝并中文提示 |
| ack / nack / error + id 关联 | id `c1..cN`；ack 解除「等待确认」，nack/error 中文映射并保留服务端 message |
| 断线/未握手/过期禁控 | 三种情形实测：过期 → 16/16 禁用 + 横幅「控制已锁定：遥测数据过期（N 秒无更新）」；connected=false → 「游戏未连接」；断连 → 「连接已断开，N 秒后自动重连」 |
| 自动重连、不重复 socket | 退避 1→10 s+抖动；半死连接 9 s 无遥测先 close、再 3 s 未恢复则丢弃重建；`online`/回前台立即补连。实测断网 → 恢复后自动回到 ready、0/16 禁用、日志「网络已恢复，立即重连」 |
| 不积压命令 | 非就绪直接拒发；同动作 300 ms 冷却 + 单 pending；5 s 超时清理；手动重连清空 pending |
| mock 显示与切换 | `hello.mock` 为主，另有 /health 15 s 轮询；实测注入 `mock:false` 的 hello → 顶栏变「实时遥测」+ 日志「服务端模式已切换」 |

## 4. 浏览器实测（agent-browser，独立会话 `truckdeck-cline`，未禁用用户缩放）

| 视口 | 结果 |
| --- | --- |
| 844×390 | 无滚动（scroll = viewport）、无控件越界、无重叠、最小触摸 45 px |
| 667×375 | 同上（最小触摸 45 px） |
| 390×844 竖屏 | 单列可滚动、全部按钮可达、无重叠、最小触摸 60 px、温和横屏提示出现且可关闭 |
| 1440×900 桌面 | 居中限高 620 px、无滚动/重叠、最小触摸 54 px |

- 按钮交互实测：近光灯 开↔关、手刹、雨刮 2 档/AUTO、差速锁、发动机起停 —— 均以遥测回读为准并更新「开 ON/关 OFF」「当前：X」。
- 防连点实测：3 次同步点击「双闪」只产生 1 次状态翻转，pending 归零。
- 错误提示实测：`wipers.set=bogus` → 「雨刮 失败：参数不合法（超出允许范围）（wipers.set value must be off|auto|1|2|3）」；`vjoy.steer` → 「服务端不支持该动作（unknown action vjoy.steer）」。
- 低压/低油/高转速实测：显示「⚠ 燃油偏低 8% · ⚠ 气压偏低 70 psi · ⚠ 转速偏高 2300 RPM」（文字，不只靠颜色）；档位 -2 显示 `R2`。
- 全屏实测：进入成功（按钮变「退出全屏」）；`screen.orientation.lock('landscape')` 被环境拒绝 → 温和提示「系统不允许锁定横屏，请手动旋转设备」，功能不受影响。
- 页面 console / errors：空（无报错）。
- 截图：`/tmp/td-final-844x390.png`、`/tmp/td-final-390x844.png`、`/tmp/td-final-desktop.png`、`/tmp/td-667x375.png`、`/tmp/td-warn.png`。

## 5. 修复过程中发现并已解决的真实缺陷

1. `.banner{display:flex}`（类选择器）压过 UA 的 `[hidden]` → 锁定横幅与竖屏提示永远显示；已加 `[hidden]{display:none!important}`。
2. 顶栏「遥测」胶囊从未被 JS 更新（一直显示「等待数据」）；已随看门狗与遥测刷新为「遥测 0.1 秒前 · 10 Hz」。
3. 半死连接（离线/NAT 超时）时 UI 仍显示「已连接」；已改为 stale 时显示「已连接 · 遥测中断」，并按 9 s/3 s 两段升级为丢弃重建。
4. 遮挡问题：`.bar-row__value` 在窄屏会截断（`107 psi` → `07 psi`）；已加 `white-space:nowrap` + 列宽 72 px，实测 `scrollWidth == clientWidth`。
5. 竖屏提示条里「知道了」按钮换行成竖排；已加 `white-space:nowrap; flex:0 0 auto`。

## 6. 限制（如实声明）

- 未在真实手机/平板触摸屏上验证，也未在 Windows + 游戏内验证按键注入；全部结论来自本机 Linux + Chromium（agent-browser）与 mock 后端。
- 局域网 HTTP 非安全上下文：不注册 Service Worker，不声称可离线控制；「添加到主屏幕」仅提供 manifest/图标/apple meta，实际可安装性取决于浏览器与是否 HTTPS/localhost。
- 雨刮 AUTO/2/3 与共用循环键的灯光可能被服务端 `UNSUPPORTED`/`NOT_MAPPED` 拒绝，界面已按契约显示中文原因，不做假成功。
- 方向盘为二期占位（`aria-disabled`，不接收点击）；未实现任何 vJoy/陀螺仪。
- 独立浏览器会话 `truckdeck-cline` 验收结束后保持打开，便于复核；如需释放可 `agent-browser --session truckdeck-cline close`。
