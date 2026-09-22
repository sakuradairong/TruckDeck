'use strict';

const http = require('http');
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');
const { createTelemetryService } = require('./src/telemetry');
const { createInputService } = require('./src/input');
const { createWsHub } = require('./src/wsHub');
// Phase2 stub kept for discovery; unused in v1:
require('./src/phase2/vjoy');

async function main() {
  const config = loadConfig();
  const telemetry = createTelemetryService(config);
  const input = createInputService(config, telemetry);
  const app = createApp(config, telemetry);
  const server = http.createServer(app);
  const hub = createWsHub({ server, config, telemetry, input });

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} — shutting down`);
    try {
      await hub.dispose(); // closes queue, drains, then sockets
    } catch (_) {
      /* ignore */
    }
    try {
      await input.dispose();
    } catch (_) {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] TruckDeck listening on http://0.0.0.0:${config.port}`);
    console.log(`[server] WebSocket path ${config.wsPath}`);
    console.log(`[server] mock=${telemetry.isMock()} (${telemetry.getModeReason()})`);
    console.log(`[config] 键位来源：${config.keybindsSource}`);
    console.log(`[config] 输入通道：${config.inputMode}（keyboard=SendInput 按键；scs=语义输入，不经键盘）`);
    console.log(
      '[config] 双闪=' + config.keybinds['lights.hazard'] +
        ' 灯光=' + config.keybinds['lights.parking'] +
        ' 远光=' + config.keybinds['lights.beamHigh'] +
        ' 雨刮=' + config.keybinds['wipers.cycle'] +
        ' 手刹=' + config.keybinds['handbrake.toggle'] +
        ' 引擎=' + config.keybinds['engine.toggle'],
    );
  });
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
