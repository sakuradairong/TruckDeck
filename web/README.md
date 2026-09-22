# web/（Cline 实现 · 手机横屏中文中控）

原生 HTML/CSS/JS，**无框架、无 CDN、无外部字体**。契约：[`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)（v1 冻结）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面结构：顶栏状态、灯光、仪表、雨刮、车辆功能、方向盘二期占位、日志条 |
| `styles.css` | 深灰中控主题、横屏三栏 / 竖屏单列 / 桌面宽屏、大触摸目标 |
| `app.js` | WebSocket 客户端、遥测渲染、命令下发、重连与锁定逻辑 |
| `manifest.webmanifest` | 本地 PWA 清单（图标、主题色、横屏优先） |
| `icons/favicon.svg` | 页签图标（内联 SVG 同源图形） |
| `icons/*.png` | 192 / 512 / maskable 512 / apple-touch 图标（本地生成，无网络） |

## 构建

根目录执行（脚本由 Cursor 提供，Cline 不修改）：

```bash
npm run build     # 复制 web/ → server/public/
npm start         # 先 build 再启动（默认 4000）
```

## 契约对应

| 契约要求 | 实现 |
| --- | --- |
| `ws(s)://` + `location.host` + `/ws` | `app.js` 的 `wsUrl()`，按页面协议自动选 `ws`/`wss` |
| 必须先 `hello` | `onopen` 立即发送 `{type:'hello',role:'web',version:'1'}`；6 秒无 ack 视为握手超时并重建连接 |
| 只用 `telemetry` 更新真实状态 | `renderTelemetry()` 是唯一状态源；`command_ack` 只解除「等待确认」，**不做乐观反转** |
| `command_ack` / `command_nack` / `error` | 按 `id` 关联 pending（按钮 pending 小圆点 + 中文提示），`id` 缺失时按 `action` 兜底匹配 |
| 灯光 `boolean` 目标值 | 发送 `!当前遥测值`；当前状态未知时不发送 |
| toggle 类省略 `value` | 只发送 `{type:'command',id,action}` |
| `wipers.set` 仅 `off\|auto\|1\|2\|3` | 5 档按钮，非法值本地拦截 |
| 不含 vJoy / 轴命令 | 未实现任何遥测类动作（二期见 `docs/PHASE2_VJOY.md`） |
| 断线 / 未握手 / 数据过期禁用控制 | `computeLockReason()`：未连接、连接中、未握手、无首帧遥测、遥测 >2.5 s、`connected=false` 全部锁控，横幅给出中文原因 |
| 自动重连、不重复 socket | 退避 1→10 s + 抖动；旧 socket 的 `onclose` 做身份校验；回前台立即补连；`pagehide` 主动断开 |
| 不积压命令 | 不排队（非就绪直接拒发）；同动作 300 ms 冷却；同动作仅 1 条 pending；5 s 超时清理 |
| mock 显示与切换 | `hello.mock` 为主（顶栏「模式：模拟 mock / 实时遥测」），每 15 s `GET /health` 同步；服务端后续 `hello` 更新即时反映 |
| 中文可读错误 | 错误码 → 中文映射（`NOT_MAPPED`、`UNSUPPORTED`、`INJECT_FAILED` 等），并保留服务端 `message` |

## 交互要点

- 灯光 / 雨刮 / 车辆按钮都显示 **开 ON / 关 OFF**（或档位名）文字，不单靠颜色区分，`aria-pressed` 同步。
- 顶栏：连接状态、模式（mock/实时）、遥测频率与时效、目标地址，另有「重新连接」「全屏」。
- 全屏会尝试 `requestFullscreen` + `screen.orientation.lock('landscape')`，被拒绝时温和提示，不影响操作。
- 竖屏给出可关闭的温和提示（`sessionStorage` 记住），竖屏仍保留全部按钮；`viewport` **未**禁用用户缩放。
- 添加到主屏幕：提供 manifest 与 apple meta。局域网 HTTP 非安全上下文，**Service Worker / 离线控制不可用**，也不声称可用。
- 方向盘为灰色二期占位（`aria-disabled`，不接收点击）。

## 自测钩子（仅排障 / 自动化验收）

```js
window.TruckDeck.getState()   // 连接阶段、锁控原因、mock、遥测、pending 数量
window.TruckDeck.sendRaw({ type: 'command', action: 'wipers.set', value: 'bogus' })  // 触发 nack 观察中文提示
```

