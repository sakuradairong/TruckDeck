'use strict';

/**
 * 无前端构建产物时的极简中文状态页。
 *
 * 契约 §1：`GET /` 在缺少 `server/public/` 时仍须提供页面（而不是错误码）。
 * 真实场景就是全新克隆（`server/public/` 被 .gitignore）尚未 `npm run build` 的首次启动。
 * `server/scripts/build.js` 与 `server/src/app.js` 共用本模块，避免两处文案漂移。
 */
function renderStatusPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TruckDeck</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #1a1a1a; color: #eee; }
    code { background: #333; padding: 0.1em 0.4em; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>TruckDeck</h1>
  <p>后端已启动，但未找到前端构建产物 <code>server/public/index.html</code>。请执行 <code>npm run build</code>（会从 <code>web/</code> 复制）。</p>
  <p>健康检查：<a href="/health" style="color:#8cf">/health</a> · WebSocket：<code>/ws</code></p>
</body>
</html>
`;
}

module.exports = { renderStatusPage };