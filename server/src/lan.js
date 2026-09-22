'use strict';

const os = require('os');
const net = require('net');

function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateOrLocalIp(ipRaw) {
  const ip = normalizeIp(ipRaw);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    return false;
  }

  const n = ipv4ToInt(ip);
  if (n === null) return false;

  if (n >= ipv4ToInt('10.0.0.0') && n <= ipv4ToInt('10.255.255.255')) return true;
  if (n >= ipv4ToInt('172.16.0.0') && n <= ipv4ToInt('172.31.255.255')) return true;
  if (n >= ipv4ToInt('192.168.0.0') && n <= ipv4ToInt('192.168.255.255')) return true;
  if (n >= ipv4ToInt('169.254.0.0') && n <= ipv4ToInt('169.254.255.255')) return true;

  return false;
}

function listLocalHostnames() {
  const set = new Set(['localhost', '127.0.0.1', '::1']);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces || {})) {
    for (const info of list || []) {
      if (!info || !info.address) continue;
      set.add(normalizeIp(info.address));
      set.add(info.address);
    }
  }
  return set;
}

function parseHostHeader(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  const trimmed = hostHeader.trim();
  // bracket IPv6: [::1]:4000
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return null;
    const hostname = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null;
    return { hostname, port };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && trimmed.indexOf(':') === idx) {
    return { hostname: trimmed.slice(0, idx), port: Number(trimmed.slice(idx + 1)) };
  }
  return { hostname: trimmed, port: null };
}

function isLocalInterfaceHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  const locals = listLocalHostnames();
  if (locals.has(hostname) || locals.has(normalizeIp(hostname))) return true;
  return false;
}

function getClientIp(req) {
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

/**
 * Origin must match request Host (same hostname+port) and Host must be this machine.
 */
function isAllowedOrigin(origin, listenPort, hostHeader) {
  if (origin === undefined || origin === null || origin === '') {
    return { ok: true, reason: 'no-origin' };
  }
  if (origin === 'null') {
    return { ok: false, reason: 'opaque-origin' };
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: 'bad-origin' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'bad-scheme' };
  }

  const originHost = url.hostname;
  const originPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (originPort !== Number(listenPort)) {
    return { ok: false, reason: 'port-mismatch' };
  }

  if (!isLocalInterfaceHost(originHost)) {
    return { ok: false, reason: 'origin-not-local-interface' };
  }

  const parsedHost = parseHostHeader(hostHeader);
  if (!parsedHost) {
    return { ok: false, reason: 'missing-host' };
  }
  if (!isLocalInterfaceHost(parsedHost.hostname)) {
    return { ok: false, reason: 'host-not-local-interface' };
  }
  if (parsedHost.port !== null && parsedHost.port !== Number(listenPort)) {
    return { ok: false, reason: 'host-port-mismatch' };
  }

  const oh = originHost.toLowerCase() === 'localhost' ? '127.0.0.1' : normalizeIp(originHost) || originHost.toLowerCase();
  const hh =
    parsedHost.hostname.toLowerCase() === 'localhost'
      ? '127.0.0.1'
      : normalizeIp(parsedHost.hostname) || parsedHost.hostname.toLowerCase();
  // Allow localhost ↔ 127.0.0.1 equivalence
  const originIsLoop = oh === '127.0.0.1' || originHost.toLowerCase() === 'localhost';
  const hostIsLoop = hh === '127.0.0.1' || parsedHost.hostname.toLowerCase() === 'localhost';
  if (originIsLoop && hostIsLoop) {
    return { ok: true, reason: 'ok' };
  }
  if (oh !== hh && originHost.toLowerCase() !== parsedHost.hostname.toLowerCase()) {
    return { ok: false, reason: 'origin-host-mismatch' };
  }
  return { ok: true, reason: 'ok' };
}

function assertLanRequest(req, listenPort) {
  const ip = getClientIp(req);
  if (!isPrivateOrLocalIp(ip)) {
    return { ok: false, error: 'FORBIDDEN', message: `non-LAN client IP: ${ip || 'unknown'}` };
  }
  const hostHeader = req.headers.host;
  const parsedHost = parseHostHeader(hostHeader);
  if (!parsedHost || !isLocalInterfaceHost(parsedHost.hostname)) {
    return {
      ok: false,
      error: 'FORBIDDEN',
      message: 'Host header must be localhost or this machine LAN IP',
    };
  }

  const origin = req.headers.origin;
  if (origin) {
    const o = isAllowedOrigin(origin, listenPort, hostHeader);
    if (!o.ok) {
      return { ok: false, error: 'FORBIDDEN', message: `Origin rejected: ${o.reason}` };
    }
  }
  return { ok: true, ip };
}

module.exports = {
  normalizeIp,
  isPrivateOrLocalIp,
  getClientIp,
  isAllowedOrigin,
  assertLanRequest,
  isLocalInterfaceHost,
  parseHostHeader,
  listLocalHostnames,
};
