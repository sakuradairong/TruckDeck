'use strict';

/**
 * 契约 §1 回归：缺少前端构建产物时 `GET /` 仍须返回 200 的极简状态页。
 *
 * 场景来自真实缺陷：`server/public/` 被 .gitignore，因此全新克隆第一次 `npm test`
 * 时该目录不存在，旧实现返回 500 使测试失败（只有先 `npm run build` 才通过）。
 * 本测试不依赖工作区里是否已有构建产物。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../server/src/app');
const { renderStatusPage } = require('../server/src/statusPage');

const BASE_PORT = Number(process.env.TRUCKDECK_FALLBACK_TEST_PORT || 4021);

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

/** 用指定 publicDir 起一个最小服务器（仅 HTTP 面，无需 WS/遥测）。 */
async function startWith(publicDir, port) {
  const config = { port, publicDir, wsPath: '/ws' };
  const telemetry = { isMock: () => true };
  const server = http.createServer(createApp(config, telemetry));
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('缺少 server/public 时 GET / 返回 200 极简状态页', async () => {
  const emptyDir = tempDir('truckdeck-nopublic-');
  const srv = await startWith(emptyDir, BASE_PORT);
  try {
    const res = await httpGet(BASE_PORT, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    assert.match(res.body, /TruckDeck/i);
    assert.match(res.body, /npm run build/);
  } finally {
    await srv.close();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('存在构建产物时 GET / 返回真实前端页面', async () => {
  const builtDir = tempDir('truckdeck-built-');
  fs.writeFileSync(path.join(builtDir, 'index.html'), '<!DOCTYPE html><title>TruckDeck 已构建页面</title>', 'utf8');
  const srv = await startWith(builtDir, BASE_PORT + 1);
  try {
    const res = await httpGet(BASE_PORT + 1, '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /已构建页面/);
  } finally {
    await srv.close();
    fs.rmSync(builtDir, { recursive: true, force: true });
  }
});

test('状态页与 build 兜底使用同一份渲染结果', async () => {
  const html = renderStatusPage();
  assert.match(html, /TruckDeck/);
  assert.match(html, /\/health/);
  assert.match(html, /\/ws/);
});
