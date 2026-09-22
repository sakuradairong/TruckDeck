'use strict';

const path = require('path');
const express = require('express');
const { assertLanRequest } = require('./lan');

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
    res.sendFile(path.join(config.publicDir, 'index.html'), (err) => {
      if (err) {
        res.status(500).type('text/plain').send('public/index.html missing — run npm run build');
      }
    });
  });

  return app;
}

module.exports = { createApp };
