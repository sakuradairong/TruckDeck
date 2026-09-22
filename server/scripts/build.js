'use strict';

/**
 * Copy publishable files from web/ → server/public/.
 * If web/ has no index.html, write a minimal Chinese status page so the server still boots.
 */

const fs = require('fs');
const path = require('path');
const { renderStatusPage } = require('../src/statusPage');

const root = path.join(__dirname, '..', '..');
const webDir = path.join(root, 'web');
const publicDir = path.join(root, 'server', 'public');

const SKIP = new Set(['.gitkeep', '.gitignore', 'README.md', 'readme.md']);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    ensureDir(dest);
    for (const name of fs.readdirSync(src)) {
      if (SKIP.has(name) || name.startsWith('.')) continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function writeFallback() {
  ensureDir(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), renderStatusPage(), 'utf8');
  console.log('[build] web/ 无 index.html，已写入极简状态页 → server/public/');
}

function main() {
  ensureDir(publicDir);
  for (const name of fs.readdirSync(publicDir)) {
    fs.rmSync(path.join(publicDir, name), { recursive: true, force: true });
  }

  const indexPath = path.join(webDir, 'index.html');
  if (!fs.existsSync(webDir) || !fs.existsSync(indexPath)) {
    writeFallback();
    return;
  }

  copyRecursive(webDir, publicDir);
  console.log('[build] 已复制 web/ → server/public/');
}

main();
