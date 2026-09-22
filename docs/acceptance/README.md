# 验收证据（TruckDeck 一期）

本目录保存一期实现的**可复核证据**：截图、原始验收输出、以及委派给 `cursor-agent` / `cline` 时的派单与回传原文。
面向审阅者的问题是「这些代码真的被端到端验证过吗、验证结论怎么来的」，本目录即是答案。

需要先读的结论文档是同级的 [`../ACCEPTANCE.md`](../ACCEPTANCE.md) 与 [`../INTEGRATION_PATCH.md`](../INTEGRATION_PATCH.md)。

---

## 目录结构

```
docs/acceptance/
├── verify-ws.cjs                     # 端到端复验脚本（HTTP + WS，含负面路径）
├── landscape-844x390.png             # 手机横屏主视口
├── landscape-667x375.png             # 小屏横屏
├── portrait-390x844.png              # 竖屏（可滚动）
├── landscape-844x390-before-fix.png  # 布局缺陷的修复前留档（提示栏占位、仪表重叠）
├── evidence/
│   ├── verify-4000.json / .log           # 复验：默认端口（npm start）
│   ├── verify-4013.json / .log           # 复验：非默认端口（TRUCKDECK_PORT=4013）
│   ├── accept-4000-astra.json            # 首轮验收原始输出（4000）
│   ├── accept-4012-astra.json            # 首轮验收原始输出（4012）
│   ├── npm-test-astra.log                # 首轮 npm test 原始输出（23/23）
│   ├── contract-sha256.txt               # 派单给前端时的契约指纹（§8 合入前）
│   └── agent-logs/*.log.gz               # cursor-agent / cline 的真实运行日志（见文末说明）
└── orchestration/
    ├── cursor-task.txt               # 派给 Cursor 的原始任务书
    ├── cursor-review.txt             # Astra 初审返修清单
    ├── cursor-fix-task.txt           # 返修任务书
    ├── cursor-final-fix.txt          # 最后一批对接修正任务书
    ├── cline-task.txt                # 派给 Cline 的原始任务书（含冻结契约全文）
    ├── cline-brief.txt               # 交接摘要
    ├── cline-web-report.md           # Cline 前端实测回传
    └── tooling/                      # 当轮使用的检查脚本（保留原始形态）
        ├── acceptance-astra.cjs      # 首轮验收脚本（只覆盖正向路径）
        ├── layout-check.js           # 浏览器内按钮边界/重叠断言
        ├── reconnect-check.js        # 断线重连与旧消息隔离断言
        └── status.py                 # 轮询子代理日志的进度探针
```

---

## 两轮验收

### 第一轮：Astra（2026-09-22 上午，Codex 会话 `01a0c7d9-63da-7bf3-a39c-7d40ae2562e0`）

实际调用已安装的 `cursor-agent` 与 `cline` CLI 接力实现：先由 Cursor 交付可运行服务与冻结契约，再由 Cline 只实现 `web/`。
产出 `accept-4000-astra.json`（10 Hz / 22 次操作 / 12 类 action）、`accept-4012-astra.json`（9.17 Hz，验证非默认端口）与 `npm-test-astra.log`（23/23）。
该轮**只覆盖正向路径**，且会话在上游 429 报错中结束，未输出最终交付摘要。

### 第二轮：Cline（同日接手后独立复验）

用本目录的 `verify-ws.cjs` 重新验证**当前工作区**（而非沿用上轮结论），并补齐首轮缺失的负面路径：

| 覆盖项 | 断言 |
| --- | --- |
| `GET /health` | 精确 `{"ok":true,"mock":true}`，字段集恰为 `ok,mock` |
| `GET /` | 200、含中文、**外链资源数 = 0** |
| PWA | manifest 可解析且声明的图标全部 200 |
| WS 升级拒绝 | 外域 Origin / `Origin: null` / Origin 端口不符 / 非本机 Host 头 → 403；非 `/ws` 路径 → 404 |
| 握手 | `hello` ack 字段（`role=server`、`version=1`、`mock`、`telemetryHz`、`ts`）；未 hello 发命令 → `HELLO_REQUIRED`；版本不符 → `ok:false` |
| 遥测 | 频率 ≥ 契约下限 5 Hz |
| 命令 | 12 类 action、22 次操作：每次 ack + 后续遥测回显与目标一致 |
| 错误枚举 | 非 JSON → `INVALID_JSON`（连接不断开）；未知 type → `UNKNOWN_TYPE`；未知 action → `UNKNOWN_ACTION`；缺/非法 value（灯光缺 value、雨刮 `"9"`、toggle 带 value）→ `INVALID_VALUE` |
| 资源上限 | 超过 8 KiB 单帧 → 连接关闭（1009） |

结果：**默认端口 4000 与非默认端口 4013 均 18/18 通过**，两次均 `22 次操作 / 12 类 action`、实测频率 9.33 / 9.98 Hz。

---

## 如何复现

```bash
cd TruckDeck
npm install
npm run build

# 正向 + 负面全量复验（默认端口）
npm start &
node docs/acceptance/verify-ws.cjs 4000 \
  > docs/acceptance/evidence/verify-4000.json \
  2> docs/acceptance/evidence/verify-4000.log

# 或指定任意端口，验证前端 location.host 自适配
TRUCKDECK_PORT=4013 TRUCKDECK_MOCK=1 node server/index.js &
node docs/acceptance/verify-ws.cjs 4013
```

脚本 stdout 为机器可读 JSON，stderr 为人类可读 `PASS/FAIL`；退出码 0 表示全通过。
它需要一个已启动的实例，因此**不**纳入 `npm test`（`npm test` 只跑不依赖端口的进程内测试）。

---

## 契约指纹

| 指纹 | 含义 |
| --- | --- |
| `30c5c5a4c3c78991e8b4837d390bd8021c18a037966ce8bcf6287452c5919523` | `contract-sha256.txt`：派单给前端**之前**记录的 v1 契约（尚无 §8）。用于说明前端实现期间端口、路径、事件名未被改动。 |
| `9bfec9be8d745c36442536ec5aba3c0b2d886f4fd463031790301e7cf035d76c` | 当前 `docs/API_CONTRACT.md`：追加 §8「一期对接验收澄清」后的冻结版本。§8 只补充行为澄清，未改端口、路径、事件名与 action 枚举。 |

重新核对：`sha256sum docs/API_CONTRACT.md`

## agent-logs 是什么、能不能删

`evidence/agent-logs/*.log.gz` 是编排放当时通过 `subprocess` 调用真实 `cursor-agent` / `cline` CLI 产生的原始 JSON 流日志（合计约 2.3 MB）。
用途是证明「后端与前端确实由两个独立代理完成，而不是把内部子代理改名冒充」。

公开发布前做过一次全文扫描（解压后逐文件匹配 Google / OpenAI / GitHub / AWS / Slack 密钥格式、JWT、私钥块、`secret|token|password` 赋值、邮箱，以及全部 URL 与 IP），结论：

- **无凭据**：0 处 API key / token / 私钥 / 密码赋值；邮箱只有 `user@example.com`、`user@test.com` 这类占位符。
- 两处「形似密钥」的命中经解码排除：`AIza…` 位于一段 179 KB 的 base64 内，解码后是 PNG 图标（生成图标被日志内联，字符串是图像字节的偶然巧合）；另一处是 CLI 帮助文本里的 `Authorization` 字样。
- `192.168.1.8` 是代理写入早期 README 的 RFC1918 **示例**地址（非真实地址）。
- 日志中的开发机网卡地址已按隐私要求替换为**文档保留地址** `198.51.100.7`（RFC 5737 TEST-NET-2）：`cline-act.log.gz` 里由 `hostname -I` stdout 产生的 1733 处引用全部改为该占位值，并重写历史后重新发布——本仓库任何提交中都不再包含原地址。
- 其余域名为 github.com、learn.microsoft.com、nodejs.org、npmjs.com、kniffen.dev 等文档与依赖来源。

若需要给仓库瘦身，删除该目录不影响任何复现步骤——其余证据都是可重新生成的输出。

## 尚未验收（需实体机）

- Windows `SendInput` 键盘注入的真实行为：本仓库所有注入测试都在 Linux 上以 worker 协议替身完成，**不能替代** Windows 实机验证。
- `scs-sdk-plugin` 共享内存读取与 `sdkActive` 判定；游戏内实际响应（含默认 `L` 灯循环与各车型键位差异）。
- 移动端「添加到主屏幕」与屏幕方向锁定由浏览器策略决定，桌面 Chromium 无法判定。

## 环境

两轮验收均在：Linux、Node `v24.18.0`、npm `11.16.0`、Chromium（桌面，模拟设备视口）；无 Windows 游戏实体机。
