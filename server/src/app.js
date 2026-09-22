'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { assertLanRequest } = require('./lan');
const { renderStatusPage } = require('./statusPage');

function createApp(config, telemetry) {
  const app = express();

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const check = assertLanRequest(req, config.port);
    if (!check.ok) {
      res.status(403).json({ ok: false, error: check.error, message: check.message });
      return;
    }
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, mock: telemetry.isMock() });
  });

  app.use(express.static(config.publicDir, { index: 'index.html', fallthrough: true }));

  app.get('/', (req, res) => {
    const indexPath = path.join(config.publicDir, 'index.html');
    // 契约 §1：无前端构建产物时提供极简状态页，且必须是 200。
    // 全新克隆未执行 npm run build 时会走到这里；有产物时走 sendFile。
    if (!fs.existsSync(indexPath)) {
      res.status(200).type('text/html; charset=utf-8').send(renderStatusPage());
      return;
    }
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(200).type('text/html; charset=utf-8').send(renderStatusPage());
      }
    });
  });

  return app;
}

module.exports = { createApp };
