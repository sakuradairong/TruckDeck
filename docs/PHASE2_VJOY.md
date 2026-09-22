# 二期：vJoy / 陀螺仪（草稿，不实现）

> v1 **不实现** vJoy 或手机陀螺仪转向。本文与 `server/src/phase2/vjoy.js` 仅保留接口形状，供后续迭代。

## 目标（计划）

- 手机陀螺仪 / 虚拟摇杆 → 服务端 → vJoy 轴，用于转向/油门等连续控制。
- 与现有离散 `command`（灯光、雨刮等）并存。

## 拟议 WS 消息（未冻结，勿在 v1 前端依赖）

```json
{"type":"axis","axes":{"steer":0.0,"throttle":0.0,"brake":0.0},"ts":1710000000000}
```

- `steer` / `throttle` / `brake`：建议范围 `[-1,1]` 或 `[0,1]`（最终以二期契约为准）。
- 服务端需限频、死区、断线回中。

## 拟议服务接口

见 `server/src/phase2/vjoy.js`：

- `createVjoyController(options)` → `{ start, stop, setAxes, isAvailable }`
- 全部方法当前抛出 / 返回 `UNSUPPORTED`。

## 依赖（未来）

- Windows vJoy 驱动与设备配置
- 权限与签名注意
- 与按键注入互斥/共存策略

## TODO

- [ ] 冻结二期契约（Astra）
- [ ] 实现 vJoy 后端
- [ ] 前端陀螺仪校准 UI
- [ ] 断线安全回中与测试
