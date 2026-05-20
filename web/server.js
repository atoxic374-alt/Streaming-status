'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const app = express();
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const BASE_PORT = process.env.PORT || 5000;
let dashboardPort = Number(BASE_PORT) || 5000;
const ROOT = path.join(__dirname, '..');

// Bind to 0.0.0.0 on Replit or any remote host (REMOTE=1), else localhost only
const IS_REMOTE  = !!(process.env.REPLIT_DEV_DOMAIN || process.env.REMOTE);
const BIND_HOST  = IS_REMOTE ? '0.0.0.0' : '127.0.0.1';
if (IS_REMOTE) process.env.NO_AUTO_OPEN = '1'; // no browser on remote servers

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'win32') spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' });
  else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
}

function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.listen(startPort, BIND_HOST, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(findAvailablePort(startPort + 1)));
  });
}

const PATHS = {
  config:   path.join(ROOT, 'setup', 'config.json'),
  tokens:   path.join(ROOT, 'setup', 'starter.js'),
  profiles: path.join(ROOT, 'setup', 'profiles.json'),
  stats:    path.join(ROOT, 'setup', 'stats.json'),
  schedule: path.join(ROOT, 'setup', 'schedule.json'),
  env:      path.join(ROOT, '.env'),
  uploads:  path.join(ROOT, 'public', 'uploads'),
  manifest: path.join(ROOT, 'public', 'uploads', 'manifest.json'),
};
const BOT_ENTRY = path.join(ROOT, 'index.js');

const ROTATION_KEYS = ['text1', 'text2', 'text3', 'text4', 'images', 'customStatus', 'spotify', 'url'];
const VALID_PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd']);
const MIN_STREAM_ROTATION_SEC = 60;
const MIN_CUSTOM_STATUS_SEC = 60;
const MAX_ROTATION_SEC = 86400;
function defaultRotationCounts() {
  return Object.fromEntries(ROTATION_KEYS.map(key => [key, 0]));
}
function addCounts(a = {}, b = {}, defaults = {}) {
  const out = { ...defaults, ...a };
  for (const [key, value] of Object.entries(b || {})) {
    out[key] = (out[key] || 0) + (Number(value) || 0);
  }
  return out;
}

// ── Runtime State ──────────────────────────────────────────────────
let botProc = null;
let botLogs = [];
let errorLogs = [];
let sessionStart = null;
let rotationCounts = defaultRotationCounts();
let verifyCounts = { failed: 0 };
let lastPresence = null;
let wsClients = new Set();
// Rate-limit tracking: masked_token → { masked, endTs, attempts, hitAt }
let rateLimits = {};

// ── WebSocket Broadcast ────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({
    type: 'init',
    data: { logs: botLogs.slice(-150), errorLogs: errorLogs.slice(-50), lastPresence }
  }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// ── Logging ────────────────────────────────────────────────────────
function appendLog(line, isError = false) {
  const entry = { text: line, ts: new Date().toISOString(), error: isError };
  botLogs.push(entry);
  if (botLogs.length > 600) botLogs = botLogs.slice(-600);
  if (isError) {
    errorLogs.push(entry);
    if (errorLogs.length > 200) errorLogs = errorLogs.slice(-200);
  }
  broadcast('log', entry);
}

// ── File Helpers ───────────────────────────────────────────────────
function readJSON(p, def = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return def; }
}
function writeJSON(p, v) {
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
}
function ensureFile(p, def) {
  if (!fs.existsSync(p)) writeJSON(p, def);
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ── Token Encryption (AES-256-GCM) ────────────────────────────────
function _getTokenKey() {
  let k = process.env.TOKEN_KEY;
  if (!k || Buffer.from(k, 'hex').length !== 32) {
    k = crypto.randomBytes(32).toString('hex');
    try {
      const cur = fs.existsSync(PATHS.env) ? fs.readFileSync(PATHS.env, 'utf8') : '';
      if (!cur.includes('TOKEN_KEY=')) fs.appendFileSync(PATHS.env, `\nTOKEN_KEY=${k}\n`);
    } catch {}
    process.env.TOKEN_KEY = k;
  }
  return Buffer.from(k, 'hex');
}
function encryptToken(plain) {
  if (!plain || plain.startsWith('ENC:')) return plain;
  try {
    const key = _getTokenKey(), iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `ENC:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
  } catch { return plain; }
}
function decryptToken(stored) {
  if (!stored) return null;
  if (!stored.startsWith('ENC:')) return stored; // legacy plaintext
  try {
    const p = stored.split(':'), key = _getTokenKey();
    const dc = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p[1], 'hex'));
    dc.setAuthTag(Buffer.from(p[2], 'hex'));
    return dc.update(Buffer.from(p[3], 'hex')) + dc.final('utf8');
  } catch { return null; }
}

// ── Token Helpers ──────────────────────────────────────────────────
function extractRawStored() {
  try {
    const raw = fs.readFileSync(PATHS.tokens, 'utf8');
    const match = raw.match(/tk:\s*\[([\s\S]*?)\]/m);
    if (!match) return [];
    return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  } catch { return []; }
}
function extractTokens() {
  return extractRawStored().map(t => decryptToken(t)).filter(Boolean);
}
function saveTokens(tokens) {
  const raw = fs.readFileSync(PATHS.tokens, 'utf8');
  const block = `tk: [\n${tokens.map((t, i) =>
    `        "${t}"${i < tokens.length - 1 ? ',' : ''}`).join('\n')}\n    ]`;
  fs.writeFileSync(PATHS.tokens, raw.replace(/tk:\s*\[[\s\S]*?\]/m, block), 'utf8');
}
function maskToken(token) {
  const parts = token.split('.');
  return parts.length >= 2 ? `${parts[0]}.••••••••` : token.slice(0, 8) + '••••••••';
}

// ── Stats Helpers ──────────────────────────────────────────────────
function loadStats() {
  return readJSON(PATHS.stats, {
    schemaVersion: 2,
    totalUptime: 0,
    totalSessions: 0,
    sessions: [],
    rotationCounts: defaultRotationCounts(),
    verifyCounts: { failed: 0 },
  });
}
function saveStats(extra = {}) {
  const saved = loadStats();
  saved.schemaVersion = 2;
  const up = extra.session?.uptime ?? (sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0);
  saved.totalUptime = (Number(saved.totalUptime) || 0) + up;
  if (extra.session) {
    saved.totalSessions = (Number(saved.totalSessions) || saved.sessions.length || 0) + 1;
    saved.sessions.push(extra.session);
    if (saved.sessions.length > 50) saved.sessions = saved.sessions.slice(-50);
  }
  saved.rotationCounts = addCounts(saved.rotationCounts, rotationCounts, defaultRotationCounts());
  saved.verifyCounts = addCounts(saved.verifyCounts, verifyCounts, { failed: 0 });
  writeJSON(PATHS.stats, saved);
}

// ── Schedule ───────────────────────────────────────────────────────
setInterval(() => {
  const s = readJSON(PATHS.schedule, {});
  if (!s.enabled) return;
  const now = new Date();
  if (!s.days?.includes(now.getDay())) return;
  const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  if (t === s.startTime && !botProc) { startBot(); appendLog('[Schedule] Auto-started'); }
  else if (t === s.stopTime && botProc) { stopBot(); appendLog('[Schedule] Auto-stopped'); }
}, 30000);

// ── Webhook ────────────────────────────────────────────────────────
async function sendWebhook(event, extra = {}) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url || !url.startsWith('http')) return;
  const map = {
    start: { title: '🟢 Bot Started', color: 0x22c55e },
    stop:  { title: '🔴 Bot Stopped', color: 0xef4444 },
    error: { title: '⚠️ Bot Crashed', color: 0xf97316 },
  };
  const ev = map[event] || { title: event, color: 0x5b8def };
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: ev.title,
          color: ev.color,
          description: extra.message || `Bot ${event} at ${new Date().toLocaleString()}`,
          footer: { text: 'Streaming Status Dashboard' },
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (e) { appendLog(`[Webhook] Failed: ${e.message}`, true); }
}

// ── Bot Process ────────────────────────────────────────────────────
function startBot() {
  if (botProc) return false;
  const env = {
    ...process.env,
    DASHBOARD_PORT: String(dashboardPort),
    PORT: String(dashboardPort),
    WEATHER_API_KEY: process.env.WEATHER_API_KEY
  };
  botProc = spawn(process.execPath, [BOT_ENTRY], { cwd: ROOT, env });
  sessionStart = Date.now();
  rotationCounts = defaultRotationCounts();
  verifyCounts = { failed: 0 };
  lastPresence = null;
  appendLog(`[Bot] Started - PID ${botProc.pid}`);
  broadcast('status', { running: true, pid: botProc.pid });

  botProc.stdout.on('data', d => {
    const lines = String(d).trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse rotation counters
      const rot = line.match(/\[ROT:(\w+)\]/);
      if (rot) rotationCounts[rot[1]] = (rotationCounts[rot[1]] || 0) + 1;
      if (line.includes('[VERIFY:failed:')) verifyCounts.failed = (verifyCounts.failed || 0) + 1;

      // Parse live presence snapshots from the running Discord client
      const presence = line.match(/\[PRESENCE:([A-Za-z0-9+/=]+)\]/);
      if (presence) {
        try {
          lastPresence = JSON.parse(Buffer.from(presence[1], 'base64').toString('utf8'));
          broadcast('presence', lastPresence);
        } catch (e) {
          appendLog(`[Presence] Snapshot parse failed: ${e.message}`, true);
        }
      }

      // Parse rate-limit events: [RL429:masked:endTs:attempts]
      const rl = line.match(/\[RL429:([^:]+):(\d+):(\d+)\]/);
      if (rl) {
        const [, masked, endTsStr, attemptsStr] = rl;
        const endTs    = Number(endTsStr);
        const attempts = Number(attemptsStr);
        if (endTs === 0 && attempts === 0) {
          // Cleared
          delete rateLimits[masked];
        } else {
          rateLimits[masked] = { masked, endTs, attempts, hitAt: Date.now() };
        }
        broadcast('rateLimit', { limits: Object.values(rateLimits) });
      }

      const isErrorLine = /\[(Verify|Presence|CustomStatus|Spotify|Preflight)\].*(Failed|failed|mismatch|Error|error|skipped)/.test(line);
      appendLog(line.trim(), isErrorLine);
    }
  });
  botProc.stderr.on('data', d => appendLog(`[ERR] ${String(d).trim()}`, true));
  botProc.on('exit', (code, signal) => {
    const up = sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
    appendLog(`[Bot] Exited - code=${code} signal=${signal||'none'} uptime=${up}s`, code !== 0 && code !== null);
    saveStats({ session: { start: sessionStart, end: Date.now(), uptime: up, exitCode: code } });
    botProc = null; sessionStart = null;
    broadcast('status', { running: false, pid: null, exitCode: code });
    if (code !== 0 && code !== null) {
      sendWebhook('error', { message: `Bot crashed — exit code ${code}` });
      broadcast('alert', { message: 'Bot stopped unexpectedly!', type: 'error' });
    } else { sendWebhook('stop'); }
  });
  sendWebhook('start');
  return true;
}
function stopBot() {
  if (!botProc) return false;
  botProc.kill('SIGTERM');
  appendLog('[Bot] Stop signal sent');
  return true;
}

// ── CPU Helper ─────────────────────────────────────────────────────
function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  cpus.forEach(c => { idle += c.times.idle; for (const t in c.times) total += c.times[t]; });
  return 100 - Math.floor(idle / total * 100);
}

// ── Runtime Status ─────────────────────────────────────────────────
function runtimeStatus() {
  return {
    running: !!botProc,
    pid: botProc?.pid || null,
    tokensConfigured: extractTokens().length,
    sessionUptime: sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0,
    rotationCounts,
    verifyCounts,
    lastPresence,
    mode: 'real-script-execution',
    cookieAuth: false,
    lastLogs: botLogs.slice(-100)
  };
}

// ── Config Sanitize ────────────────────────────────────────────────
function sanitizeLines(value, max = 150) {
  return Array.isArray(value) ? value.map(x => String(x)).filter(Boolean).slice(0, max) : [];
}

function sanitizeCustomStatus(value) {
  const src = value || {};
  const legacy = (src.text || src.emoji) ? [{ text: src.text || '', emoji: src.emoji || '' }] : [];
  const rawMessages = Array.isArray(src.messages) ? src.messages.slice(0, 150) : legacy;
  const messages = rawMessages
    .map(item => typeof item === 'string'
      ? { text: item, emoji: '' }
      : { text: item?.text || '', emoji: item?.emoji || '' })
    .map(item => ({
      text: String(item.text || '').slice(0, 128),
      emoji: String(item.emoji || '').slice(0, 128),
    }))
    .filter(item => item.text || item.emoji);

  return {
    enabled: !!src.enabled,
    intervalSec: Math.min(Math.max(Number(src.intervalSec) || 300, MIN_CUSTOM_STATUS_SEC), MAX_ROTATION_SEC),
    messages,
  };
}

function sanitizeSpotify(value) {
  const src = value || {};
  const legacy = (src.song || src.artist || src.albumArtUrl)
    ? [{
        song: src.song || '',
        artist: src.artist || '',
        duration: src.duration || 210,
        albumArtUrl: src.albumArtUrl || '',
        albumArtId: src.albumArtId || '',
        songId: src.songId || '',
        albumId: src.albumId || '',
        artistIds: src.artistIds || '',
      }]
    : [];
  const rawTracks = Array.isArray(src.tracks) && src.tracks.length ? src.tracks : legacy;
  const tracks = rawTracks.map(track => ({
    song: String(track?.song || '').slice(0, 128),
    artist: String(track?.artist || '').slice(0, 128),
    duration: Math.min(Math.max(Number(track?.duration) || 210, 10), 86400),
    albumArtUrl: String(track?.albumArtUrl || '').slice(0, 1024),
    albumArtId: String(track?.albumArtId || '').slice(0, 128),
    songId: String(track?.songId || '').slice(0, 128),
    albumId: String(track?.albumId || '').slice(0, 128),
    artistIds: Array.isArray(track?.artistIds)
      ? track.artistIds.map(x => String(x).slice(0, 128)).slice(0, 20)
      : String(track?.artistIds || '').slice(0, 512),
  })).filter(track => track.song || track.artist || track.albumArtUrl).slice(0, 150);

  return {
    enabled: !!src.enabled,
    tracks,
    // Legacy fields stay populated for older profile/config consumers.
    song: tracks[0]?.song || '',
    artist: tracks[0]?.artist || '',
    duration: tracks[0]?.duration || 210,
    albumArtUrl: tracks[0]?.albumArtUrl || '',
  };
}

function sanitizePayload(config, tokens) {
  const safe = structuredClone(config);
  safe.setup = safe.setup || {};
  safe.config = safe.config || {};
  safe.setup.delay = Math.min(Math.max(Number(safe.setup.delay) || MIN_STREAM_ROTATION_SEC, MIN_STREAM_ROTATION_SEC), MAX_ROTATION_SEC);
  ['text-1','text-2','text-3','text-4','bigimg','smallimg'].forEach(k => {
    safe.config[k] = sanitizeLines(safe.config[k], 150);
  });
  safe.config.options = safe.config.options || {};
  safe.config.options['watch-url'] = Array.isArray(safe.config.options?.['watch-url'])
    ? safe.config.options['watch-url'].map(x => String(x)).slice(0,150) : [];
  safe.config.options['activity-name'] = String(
    safe.config.options['activity-name'] || safe.config.options.activityName || ''
  ).slice(0, 128);
  safe.config.options['activity-type'] = 'STREAMING';
  safe.config['button-1'] = [];
  safe.config['button-2'] = [];
  // Human simulation settings — preserve as-is (already validated by UI)
  const ho = safe.config.options;
  ho.humanMode   = ho.humanMode   !== false;
  ho.humanJitter = Math.min(Math.max(Number(ho.humanJitter) || 0.25, 0.05), 0.5);
  ho.idleChance  = Math.min(Math.max(Number(ho.idleChance)  || 0.04, 0),    0.15);
  ho.idleMinSec  = Math.min(Math.max(Number(ho.idleMinSec)  || 60,   30),   300);
  ho.idleMaxSec  = Math.min(Math.max(Number(ho.idleMaxSec)  || 240,  60),   600);
  ho.strictVerify = ho.strictVerify !== false;
  const status = String(ho.status || ho['presence-status'] || ho.presenceStatus || 'online').toLowerCase();
  ho.status = VALID_PRESENCE_STATUSES.has(status) ? status : 'online';
  ho['presence-status'] = ho.status;
  ho.requireGatewayEcho = ho.requireGatewayEcho === true;
  safe.config.spotify = sanitizeSpotify(safe.config.spotify);
  safe.config.customStatus = sanitizeCustomStatus(safe.config.customStatus);
  return { safe, cleanedTokens: tokens.map(t => String(t).trim()).filter(Boolean) };
}

// ── Middleware ─────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ── API: Settings ──────────────────────────────────────────────────
app.get('/api/settings', (_, res) => {
  // Never send raw tokens to the browser — masked only
  res.json({ config: readJSON(PATHS.config), tokens: extractTokens().map(maskToken), runtime: runtimeStatus() });
});
app.post('/api/settings', (req, res) => {
  const { config, tokens } = req.body;
  if (!config || !Array.isArray(tokens)) return res.status(400).json({ error: 'invalid payload' });
  const { safe, cleanedTokens } = sanitizePayload(config, tokens);

  // Smart merge: masked token → keep existing encrypted; new plain token → encrypt
  const existingStored = extractRawStored();
  const finalTokens = cleanedTokens.map(t => {
    if (t.includes('••')) {
      // Find matching stored token by first Discord token segment
      const seg = t.split('.')[0];
      const found = existingStored.find(enc => {
        const dec = decryptToken(enc);
        return dec && dec.split('.')[0] === seg;
      });
      return found || encryptToken(t);
    }
    return encryptToken(t);
  });

  writeJSON(PATHS.config, safe);
  saveTokens(finalTokens);
  appendLog(`[Config] Saved - ${finalTokens.length} token(s)`);
  res.json({ ok: true });
});

function sendBotCommand(command) {
  if (!botProc || !botProc.stdin || botProc.stdin.destroyed) return false;
  try {
    botProc.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  } catch (e) {
    appendLog(`[Bot] Refresh command failed: ${e.message}`, true);
    return false;
  }
}

function getPublicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL;
  if (configured && /^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// ── Image Manifest ────────────────────────────────────────────────
// Tracks local files → CDN URLs so expired CDN URLs can be refreshed.
function loadManifest() { return readJSON(PATHS.manifest, {}); }
function saveManifest(m) { fs.writeFileSync(PATHS.manifest, JSON.stringify(m, null, 2), 'utf8'); }

// Returns the stable part of a Discord CDN URL (without the expiry query params)
function cdnUrlKey(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; }
  catch { return url; }
}

// Returns true if this Discord CDN attachment URL has expired
function isExpiredCdnUrl(url) {
  try {
    if (!url || !url.includes('cdn.discordapp.com/attachments')) return false;
    const ex = new URL(url).searchParams.get('ex');
    if (!ex) return false;
    return Date.now() > parseInt(ex, 16) * 1000;
  } catch { return false; }
}

// Returns true if URL is a local server URL (Discord can't reach it)
function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch { return false; }
}

// Any dashboard-served upload URL must be converted to Discord CDN before
// it is used in Rich Presence. This covers localhost and public tunnel URLs.
function isManagedUploadUrl(url) {
  const fileName = uploadFileNameFromUrl(url);
  if (!fileName) return false;
  if (isLocalUrl(url)) return true;
  if (fs.existsSync(path.join(PATHS.uploads, fileName))) return true;
  return !!manifestEntryForFile(loadManifest(), fileName);
}

function safeDecodeUrlPart(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function uploadFileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const raw = pathname.split('/uploads/').pop() || '';
    const fileName = path.basename(safeDecodeUrlPart(raw));
    return fileName && fileName !== 'manifest.json' ? fileName : null;
  } catch {
    const raw = String(url || '').split('/uploads/').pop()?.split(/[?#]/)[0] || '';
    const fileName = path.basename(safeDecodeUrlPart(raw));
    return fileName && fileName !== 'manifest.json' ? fileName : null;
  }
}

function manifestEntryForFile(manifest, fileName) {
  if (!fileName) return null;
  return manifest[fileName] || Object.values(manifest).find(e => e?.fileName === fileName) || null;
}

async function resolveManagedUploadUrl(url, manifest = loadManifest()) {
  const fileName = uploadFileNameFromUrl(url);
  if (!fileName) {
    return { url, status: 'missing', detail: 'Upload file name could not be read from URL' };
  }

  const entry = manifestEntryForFile(manifest, fileName);
  if (entry?.cdnUrl && !isExpiredCdnUrl(entry.cdnUrl)) {
    return { url: entry.cdnUrl, status: 'refreshed', detail: 'Resolved upload URL to existing Discord CDN URL' };
  }

  const localFile = entry?.fileName || (fs.existsSync(path.join(PATHS.uploads, fileName)) ? fileName : null);
  if (!localFile) {
    return { url: null, status: 'missing', detail: 'Local upload file is missing; re-upload the image' };
  }

  const fresh = await refreshCdnUrl(localFile);
  if (fresh) Object.assign(manifest, loadManifest());
  return fresh
    ? { url: fresh, status: 'refreshed', detail: 'Uploaded local file to Discord CDN' }
    : { url: null, status: 'error', detail: 'Could not upload to Discord CDN; check token configuration' };
}

// ── Discord CDN Upload — Full Human Simulation ────────────────────
// Session cache: verified once per batch (10 min TTL)
let _cdnSession = null;
let _tokenAccountCache = new Map();
let _lastCdnUploadAt = new Map();

// ── Fingerprint pool — realistic Discord desktop client profiles ──
const _FP_POOL = [
  { chrome: '124.0.6367.208', electron: '30.0.6', client_version: '0.0.316', client_build_number: 338988, native_build_number: 49607, os_version: '10.0.22631' },
  { chrome: '122.0.6261.129', electron: '29.4.6', client_version: '0.0.313', client_build_number: 334300, native_build_number: 48702, os_version: '10.0.19045' },
  { chrome: '120.0.6099.291', electron: '28.3.3', client_version: '0.0.309', client_build_number: 327348, native_build_number: 47563, os_version: '10.0.22631' },
  { chrome: '126.0.6478.127', electron: '31.2.1', client_version: '0.0.320', client_build_number: 344862, native_build_number: 50901, os_version: '10.0.22631' },
  { chrome: '118.0.5993.119', electron: '27.3.11', client_version: '0.0.305', client_build_number: 318682, native_build_number: 46102, os_version: '10.0.19045' },
];

// ── Persistent session fingerprint (stable per server restart) ────
const _sessionFp = _FP_POOL[Math.floor(Math.random() * _FP_POOL.length)];
const _sessionUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${_sessionFp.client_version} Chrome/${_sessionFp.chrome} Electron/${_sessionFp.electron} Safari/537.36`;

// ── Cookie generator ──────────────────────────────────────────────
function _genHex(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}
function _genDcfduid()  { return `${_genHex(8)}-${_genHex(4)}-${_genHex(4)}-${_genHex(4)}-${_genHex(12)}`; }
function _genSdcfduid() { return _genHex(68); }
function _genCfuvid()   { return `${_genHex(8)}_${_genHex(8)}-${_genHex(8)}-${_genHex(16)}-${Math.floor(Date.now()/1000)}`; }

const _sessionCookies = (() => {
  const consentId = _genDcfduid();
  return [
    `__dcfduid=${_genDcfduid()}`,
    `__sdcfduid=${_genSdcfduid()}`,
    `locale=en-US`,
    `_cfuvid=${_genCfuvid()}`,
    `OptanonConsent=isGpcEnabled=0&datestamp=${encodeURIComponent(new Date().toUTCString())}&version=202501.2.0&browserGpcFlag=0&isIABGlobal=false&consentId=${consentId}&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1`,
  ].join('; ');
})();

// ── X-Super-Properties ────────────────────────────────────────────
const _superPropsB64 = (() => {
  const sp = {
    os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
    client_version: _sessionFp.client_version, os_version: _sessionFp.os_version,
    os_arch: 'x64', app_arch: 'x64', system_locale: 'en-US',
    browser_user_agent: _sessionUa, browser_version: _sessionFp.electron,
    client_build_number: _sessionFp.client_build_number,
    native_build_number: _sessionFp.native_build_number,
    client_event_source: null, design_id: 0,
  };
  return Buffer.from(JSON.stringify(sp)).toString('base64');
})();

// ── Full human Discord headers ────────────────────────────────────
function buildHumanHeaders(token, referer = 'https://discord.com/channels/@me', extra = {}) {
  return {
    'Authorization':       token,
    'User-Agent':          _sessionUa,
    'X-Super-Properties':  _superPropsB64,
    'X-Discord-Locale':    'en-US',
    'X-Discord-Timezone':  Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    'X-Debug-Options':     'bugReporterEnabled',
    'Cookie':              _sessionCookies,
    'Content-Type':        'application/json',
    'Accept':              '*/*',
    'Accept-Language':     'en-US,en;q=0.9',
    'Accept-Encoding':     'gzip, deflate, br',
    'Connection':          'keep-alive',
    'Sec-Fetch-Dest':      'empty',
    'Sec-Fetch-Mode':      'cors',
    'Sec-Fetch-Site':      'same-origin',
    'Referer':             referer,
    'Origin':              'https://discord.com',
    ...extra,
  };
}

// ── Human timing helper ───────────────────────────────────────────
// Natural delay with ±8% micro-jitter. Not too slow, not too fast.
const sleep = ms => new Promise(r => setTimeout(r, ms));
function humanDelay(minMs, maxMs) {
  const base = minMs + Math.random() * (maxMs - minMs);
  const jitter = base * 0.08 * (Math.random() * 2 - 1);
  return sleep(Math.max(200, Math.round(base + jitter)));
}

// ── Config helpers ────────────────────────────────────────────────
function uploadTargetConfigFromEnv() {
  const type = String(process.env.DISCORD_UPLOAD_TARGET_TYPE || '').trim().toLowerCase();
  const legacyChannelId = String(process.env.DISCORD_UPLOAD_CHANNEL_ID || process.env.UPLOAD_CHANNEL_ID || '').trim();
  const serverChannelId = String(process.env.DISCORD_UPLOAD_CHANNEL_ID || '').trim();
  return {
    accountId: String(process.env.DISCORD_UPLOAD_ACCOUNT_ID || '').trim(),
    type: type === 'dm' || type === 'server' ? type : (legacyChannelId ? 'server' : 'saved'),
    dmChannelId: String(process.env.DISCORD_UPLOAD_DM_CHANNEL_ID || '').trim(),
    guildId: String(process.env.DISCORD_UPLOAD_GUILD_ID || '').trim(),
    channelId: serverChannelId || legacyChannelId,
  };
}

function normalizeUploadTarget(raw = {}) {
  const type = String(raw.type || raw.uploadTargetType || '').trim().toLowerCase();
  return {
    accountId: String(raw.accountId || raw.uploadAccountId || '').trim(),
    type: type === 'dm' || type === 'server' ? type : '',
    dmChannelId: String(raw.dmChannelId || raw.uploadDmChannelId || '').trim(),
    guildId: String(raw.guildId || raw.uploadGuildId || '').trim(),
    channelId: String(raw.channelId || raw.uploadChannelId || '').trim(),
  };
}

function getCdnSession(token, targetKey) {
  const now = Date.now();
  if (_cdnSession && _cdnSession.token === token && _cdnSession.targetKey === targetKey && _cdnSession.validUntil > now) {
    return _cdnSession;
  }
  return null;
}

function uploadTargetKey(target) {
  const account = target.accountId || 'first-valid-account';
  if (target.type === 'dm') return `${account}:dm:${target.dmChannelId}`;
  if (target.type === 'server') return `${account}:server:${target.guildId || 'any'}:${target.channelId}`;
  return `${account}:saved-messages`;
}

// ── Account helpers ───────────────────────────────────────────────
async function fetchTokenAccount(token) {
  const cached = _tokenAccountCache.get(token);
  if (cached && cached.validUntil > Date.now()) return cached.account;

  const r = await fetch('https://discord.com/api/v10/users/@me', {
    headers: buildHumanHeaders(token),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`HTTP ${r.status} — ${err.message || 'invalid or expired token'}`);
  }
  const u = await r.json();
  const account = {
    id: u.id,
    username: u.global_name || u.username,
    tag: u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(u.id) % 6n)}.png`,
    masked: maskToken(token),
  };
  _tokenAccountCache.set(token, { account, validUntil: Date.now() + 5 * 60 * 1000 });
  return account;
}

async function listUploadAccounts() {
  const tokens = extractTokens();
  const results = await Promise.allSettled(tokens.map(async (token, index) => ({
    index,
    ...(await fetchTokenAccount(token)),
  })));
  return results.map((r, index) => r.status === 'fulfilled'
    ? { ...r.value, valid: true }
    : { index, valid: false, id: '', username: `Token ${index + 1}`, tag: r.reason?.message || 'Invalid token', masked: maskToken(tokens[index] || '') });
}

async function selectUploadToken(accountId = '') {
  const tokens = extractTokens();
  if (!tokens.length) return { error: 'No token configured' };

  if (accountId) {
    for (const token of tokens) {
      try {
        const account = await fetchTokenAccount(token);
        if (account.id === accountId) return { token, account };
      } catch {}
    }
    return { error: `Upload account ${accountId} is not configured or token is invalid` };
  }

  for (const token of tokens) {
    try {
      return { token, account: await fetchTokenAccount(token) };
    } catch {}
  }
  return { error: 'No valid token account available' };
}

// ── Channel helpers ───────────────────────────────────────────────
function isPrivateChannelType(type) { return type === 1 || type === 3; }
function isServerUploadChannelType(type) { return type === 0 || type === 5; }

function discordChannelName(channel) {
  if (!channel) return 'Unknown channel';
  if (channel.name) return channel.name;
  const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
  const names = recipients.map(u => u.global_name || u.username).filter(Boolean);
  return names.length ? names.join(', ') : `Channel ${channel.id}`;
}

async function discordJson(url, token, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { ...buildHumanHeaders(token, options._referer), ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// ── Simulate typing indicator (fire-and-forget) ───────────────────
async function simulateTyping(channelId, token) {
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
      method: 'POST',
      headers: buildHumanHeaders(token, `https://discord.com/channels/@me/${channelId}`),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function validateUploadTarget(target, token) {
  target = normalizeUploadTarget(target);
  if (!target.type) return { ok: false, error: 'Choose DM or Server upload target first' };

  const channelId = target.type === 'dm' ? target.dmChannelId : target.channelId;
  if (!channelId) return { ok: false, error: target.type === 'dm' ? 'Choose a DM first' : 'Choose a server channel first' };

  const referer = target.type === 'dm'
    ? `https://discord.com/channels/@me/${channelId}`
    : `https://discord.com/channels/${target.guildId || '@me'}/${channelId}`;

  const ch = await discordJson(`https://discord.com/api/v10/channels/${channelId}`, token, { _referer: referer });
  if (!ch.ok) {
    const noun = target.type === 'dm' ? 'DM' : 'channel';
    return { ok: false, error: `${noun} is missing or inaccessible: HTTP ${ch.status} — ${ch.data.message || 'not found'}` };
  }

  const channel = ch.data;
  if (target.type === 'dm') {
    if (!isPrivateChannelType(channel.type)) return { ok: false, error: 'Selected target is not a DM channel' };
  } else {
    if (!isServerUploadChannelType(channel.type)) return { ok: false, error: 'Selected target is not a text/announcement channel' };
    if (target.guildId && channel.guild_id && channel.guild_id !== target.guildId) {
      return { ok: false, error: 'Selected channel no longer belongs to the saved server' };
    }
  }

  // Simulate: human clicks into the channel, slight pause before sending typing
  await humanDelay(600, 1400);

  const typingR = await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
    method: 'POST',
    headers: buildHumanHeaders(token, referer),
    signal: AbortSignal.timeout(8000),
  });
  if (!typingR.ok && typingR.status !== 204) {
    const err = await typingR.json().catch(() => ({}));
    const hint = target.type === 'dm'
      ? 'DM exists but appears closed or not messageable'
      : 'Channel exists but the account cannot write there';
    return { ok: false, error: `${hint}: HTTP ${typingR.status} — ${err.message || 'cannot write'}` };
  }

  return {
    ok: true,
    channelId,
    referer,
    targetKey: uploadTargetKey(target),
    destination: target.type === 'dm' ? `DM: ${discordChannelName(channel)}` : `Server channel: #${discordChannelName(channel)}`,
    channel,
  };
}

// ── Build session: login → navigate → open destination ───────────
async function buildCdnSession(token) {
  const target = uploadTargetConfigFromEnv();
  const targetKey = uploadTargetKey(target);

  // Phase 1: Simulate app open (Discord loading splash)
  await humanDelay(500, 1200);

  // Phase 2: Verify login (/@me — same call Discord client makes on startup)
  const meR = await fetch('https://discord.com/api/v10/users/@me', {
    headers: buildHumanHeaders(token, 'https://discord.com/login'),
    signal: AbortSignal.timeout(10000),
  });
  if (!meR.ok) {
    const err = await meR.json().catch(() => ({}));
    return { error: `HTTP ${meR.status} — ${err.message || 'invalid or expired token'}` };
  }
  const me = await meR.json();
  if (target.accountId && me.id !== target.accountId) {
    return { error: `Selected upload account does not match this token (${me.id})` };
  }

  // Phase 3: Simulate navigating to DM list / server list (natural pause)
  await humanDelay(800, 1800);

  if (target.type === 'dm' || target.type === 'server') {
    const check = await validateUploadTarget(target, token);
    if (!check.ok) return { error: check.error };
    _cdnSession = {
      token, targetKey: check.targetKey,
      username: me.global_name || me.username,
      channelId: check.channelId,
      referer: check.referer,
      target, destination: check.destination,
      validUntil: Date.now() + 10 * 60 * 1000,
    };
    return { session: _cdnSession };
  }

  // Phase 4: Open Saved Messages (self DM)
  const dmR = await fetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers: buildHumanHeaders(token, 'https://discord.com/channels/@me'),
    body: JSON.stringify({ recipient_id: me.id }),
    signal: AbortSignal.timeout(10000),
  });
  if (!dmR.ok) {
    const err = await dmR.json().catch(() => ({}));
    return { error: `HTTP ${dmR.status} — ${err.message || 'could not open Saved Messages'}` };
  }
  const dm = await dmR.json();

  // Phase 5: Navigate into Saved Messages
  await humanDelay(600, 1200);

  _cdnSession = {
    token, targetKey,
    username: me.global_name || me.username,
    channelId: dm.id,
    referer: `https://discord.com/channels/@me/${dm.id}`,
    target, destination: 'Saved Messages',
    validUntil: Date.now() + 10 * 60 * 1000,
  };
  return { session: _cdnSession };
}

// ── Main upload function with full human simulation ───────────────
// Returns { url: string|null, steps: [{step,status,detail}] }
async function uploadToDiscordCDN(imageBuffer, mimeType, fileName, sessionHint = null, options = {}) {
  const steps = [];
  const pass = (step, detail) => { steps.push({ step, status: 'ok',   detail }); appendLog(`[Image] ✓ ${step}: ${detail}`); };
  const fail = (step, detail) => { steps.push({ step, status: 'error', detail }); appendLog(`[Image] ✗ ${step}: ${detail}`, true); };
  const info = (step, detail) => { steps.push({ step, status: 'info', detail }); appendLog(`[Image]   ${step}: ${detail}`); };

  info('File check', `${fileName} · ${(imageBuffer.length / 1024).toFixed(1)} KB · ${mimeType}`);

  const target = uploadTargetConfigFromEnv();
  const selected = await selectUploadToken(target.accountId);
  if (selected.error) {
    fail('Upload account check', selected.error);
    return { url: null, steps };
  }

  const token = selected.token;

  try {
    // ── Phase A: Session (login + channel open) ───────────────────
    const targetKey = uploadTargetKey(target);
    let session = sessionHint || getCdnSession(token, targetKey);
    if (session) {
      pass('Upload destination check', `${session.destination || 'channel'} ${session.channelId} (cached)`);
    } else {
      const result = await buildCdnSession(token);
      if (result.error) {
        const label = result.error.includes('invalid or expired token') ? 'Token verification'
          : result.error.includes('Cannot send messages') ? 'Open destination'
          : 'Upload destination check';
        fail(label, result.error);
        return { url: null, steps };
      }
      session = result.session;
      pass('Login simulation', `Authenticated as ${session.username}`);
      pass('Channel navigation', `${session.destination} ready (${session.channelId})`);
    }

    // ── Phase B: Inter-upload natural pacing ──────────────────────
    // Between images in a batch: 1.2–2.5 s (natural, not a flat long wait)
    const lastUpload = _lastCdnUploadAt.get(session.targetKey) || 0;
    const elapsed = Date.now() - lastUpload;
    const minGap = 1200 + Math.random() * 1300; // 1.2–2.5 s
    if (elapsed < minGap && lastUpload > 0) {
      const wait = Math.round(minGap - elapsed);
      info('Pacing', `Natural pause ${(wait / 1000).toFixed(1)} s`);
      await sleep(wait);
    }

    // ── Phase C: Human compose simulation ────────────────────────
    // Simulate: user drags/picks file, sees preview, then clicks Send
    const referer = session.referer || `https://discord.com/channels/@me/${session.channelId}`;
    await simulateTyping(session.channelId, token);
    await humanDelay(700, 1600);

    // ── Phase D: Upload with full human headers ───────────────────
    const form = new FormData();
    form.append('files[0]', new Blob([imageBuffer], { type: mimeType }), fileName);
    form.append('payload_json', JSON.stringify({ content: '' }));

    // Build upload headers (no Content-Type — browser sets multipart boundary)
    const uploadHeaders = buildHumanHeaders(token, referer);
    delete uploadHeaders['Content-Type'];

    let msgR, attempt = 0;
    while (true) {
      attempt++;
      msgR = await fetch(`https://discord.com/api/v10/channels/${session.channelId}/messages`, {
        method: 'POST',
        headers: uploadHeaders,
        body: form,
        signal: AbortSignal.timeout(30000),
      });

      if (msgR.status === 429 && attempt <= 4) {
        const rl = await msgR.json().catch(() => ({}));
        const wait = Math.ceil((rl.retry_after || 2) * 1000) + 300;
        info('Rate limited', `Waiting ${(wait / 1000).toFixed(1)} s before retry (attempt ${attempt}/4)…`);
        await sleep(wait);
        continue;
      }
      break;
    }

    if (!msgR.ok) {
      const err = await msgR.json().catch(() => ({}));
      fail('Upload to Discord CDN', `HTTP ${msgR.status} — ${err.message || 'upload rejected'}`);
      return { url: null, steps };
    }

    const msg = await msgR.json();
    const cdnUrl = msg.attachments?.[0]?.url;
    if (!cdnUrl) {
      fail('Get CDN URL', 'Discord responded but returned no attachment URL');
      return { url: null, steps };
    }

    pass('Upload to Discord CDN', 'File sent — attachment URL received');
    _lastCdnUploadAt.set(session.targetKey, Date.now());

    // ── Phase E: Check expiry ─────────────────────────────────────
    const ex = new URL(cdnUrl).searchParams.get('ex');
    const expiry = ex ? new Date(parseInt(ex, 16) * 1000).toLocaleString() : 'no expiry';
    pass('CDN URL ready', `Valid until ${expiry} — auto-refresh enabled`);

    return { url: cdnUrl, steps };
  } catch (e) {
    fail('Upload', e.message || 'Unexpected error');
    return { url: null, steps };
  }
}

// Re-uploads a local file to Discord CDN and refreshes the manifest
async function refreshCdnUrl(fileName) {
  fileName = path.basename(String(fileName || ''));
  if (!fileName || fileName === 'manifest.json') return null;

  const filePath = path.join(PATHS.uploads, fileName);
  if (!fs.existsSync(filePath)) {
    appendLog(`[Image] Refresh failed — local file missing: ${fileName}`, true);
    return null;
  }
  const rawExt = path.extname(fileName).slice(1) || 'png';
  const mimeType = `image/${rawExt === 'jpg' ? 'jpeg' : rawExt}`;
  const data = fs.readFileSync(filePath);
  const imageHash = crypto.createHash('sha256').update(data).digest('hex');
  const cfg = readJSON(PATHS.config, {});
  const richOptions = cfg.config?.options || {};
  appendLog(`[Image] CDN URL expired — re-uploading "${fileName}"…`);
  const { url: newUrl } = await uploadToDiscordCDN(data, mimeType, fileName, null, {
    humanMode: richOptions.humanMode !== false,
    humanJitter: richOptions.humanJitter,
  });
  if (newUrl) {
    const manifest = loadManifest();
    const entry = manifestEntryForFile(manifest, fileName) || { fileName, filePath, mimeType, uploadedAt: Date.now() };
    entry.fileName = fileName;
    entry.filePath = filePath;
    entry.mimeType = entry.mimeType || mimeType;
    entry.cdnUrl = newUrl;
    entry.sha256 = entry.sha256 || imageHash;
    entry.refreshedAt = Date.now();
    manifest[fileName] = entry;
    manifest[cdnUrlKey(newUrl)] = entry;
    saveManifest(manifest);
  }
  return newUrl;
}

// ── Batch CDN upload: up to 10 files in ONE Discord message ──────
// items: [{ buffer, mimeType, fileName }]
// Returns: [{ url: string|null, fileName }] — same order as input
async function uploadBatchToDiscordCDN(items, options = {}) {
  if (!items.length) return [];
  const capped = items.slice(0, 10); // Discord hard limit

  const log  = (msg) => appendLog(`[Batch]   ${msg}`);
  const logOk = (msg) => appendLog(`[Batch] ✓ ${msg}`);
  const logErr = (msg) => appendLog(`[Batch] ✗ ${msg}`, true);

  const target = uploadTargetConfigFromEnv();
  const selected = await selectUploadToken(target.accountId);
  if (selected.error) {
    logErr(`Upload account check: ${selected.error}`);
    return capped.map(i => ({ url: null, fileName: i.fileName }));
  }

  const token = selected.token;

  // ── Session (shared for all files in this batch) ──────────────
  const targetKey = uploadTargetKey(target);
  let session = getCdnSession(token, targetKey);
  if (!session) {
    const result = await buildCdnSession(token);
    if (result.error) {
      logErr(`Session: ${result.error}`);
      return capped.map(i => ({ url: null, fileName: i.fileName }));
    }
    session = result.session;
    logOk(`Login: ${session.username} → ${session.destination}`);
  } else {
    logOk(`Session cached → ${session.destination}`);
  }

  // ── Natural pacing since last upload ─────────────────────────
  const lastUpload = _lastCdnUploadAt.get(session.targetKey) || 0;
  const elapsed = Date.now() - lastUpload;
  const minGap = 1200 + Math.random() * 800;
  if (elapsed < minGap && lastUpload > 0) {
    await sleep(Math.round(minGap - elapsed));
  }

  // ── Human compose: simulate attaching multiple files ──────────
  const referer = session.referer || `https://discord.com/channels/@me/${session.channelId}`;
  await simulateTyping(session.channelId, token);
  // slightly longer compose for multiple files (user picks them one by one)
  await humanDelay(900 + capped.length * 200, 1800 + capped.length * 300);

  // ── Build multipart form with all files ───────────────────────
  const form = new FormData();
  capped.forEach((item, idx) => {
    form.append(`files[${idx}]`, new Blob([item.buffer], { type: item.mimeType }), item.fileName);
  });
  form.append('payload_json', JSON.stringify({ content: '' }));

  const uploadHeaders = buildHumanHeaders(token, referer);
  delete uploadHeaders['Content-Type'];

  log(`Sending ${capped.length} file(s) in one message…`);

  let msgR, attempt = 0;
  while (true) {
    attempt++;
    msgR = await fetch(`https://discord.com/api/v10/channels/${session.channelId}/messages`, {
      method: 'POST',
      headers: uploadHeaders,
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (msgR.status === 429 && attempt <= 4) {
      const rl = await msgR.json().catch(() => ({}));
      const wait = Math.ceil((rl.retry_after || 2) * 1000) + 300;
      log(`Rate limited — waiting ${(wait / 1000).toFixed(1)} s (attempt ${attempt}/4)…`);
      await sleep(wait);
      continue;
    }
    break;
  }

  if (!msgR.ok) {
    const err = await msgR.json().catch(() => ({}));
    logErr(`HTTP ${msgR.status} — ${err.message || 'upload rejected'}`);
    return capped.map(i => ({ url: null, fileName: i.fileName }));
  }

  const msg = await msgR.json();
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  _lastCdnUploadAt.set(session.targetKey, Date.now());

  logOk(`${attachments.length}/${capped.length} attachment(s) received`);

  // Match returned attachments back to input by filename
  return capped.map(item => {
    const att = attachments.find(a => a.filename === item.fileName) || attachments[capped.indexOf(item)];
    const url = att?.url || null;
    if (url) {
      const ex = new URL(url).searchParams.get('ex');
      const expiry = ex ? new Date(parseInt(ex, 16) * 1000).toLocaleString() : 'unknown';
      logOk(`${item.fileName} → CDN ready (expires ${expiry})`);
    } else {
      logErr(`${item.fileName} → no attachment returned`);
    }
    return { url, fileName: item.fileName };
  });
}

// ── API: Batch Image Upload ────────────────────────────────────────
// POST /api/uploads/batch  { items: [{name, dataUrl}] }
// Uploads up to 10 images in ONE Discord message. Returns per-item results.
app.post('/api/uploads/batch', async (req, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: 'items array is required' });
  if (rawItems.length > 10) return res.status(400).json({ error: 'Max 10 images per batch (Discord limit)' });

  ensureDir(PATHS.uploads);
  const manifest = loadManifest();
  const results = [];
  const toUpload = []; // items that actually need CDN upload (not deduped)

  const magic = { png: [0x89,0x50,0x4e,0x47], jpg: [0xff,0xd8,0xff], gif: [0x47,0x49,0x46], webp: [0x52,0x49,0x46,0x46] };

  // ── Phase 1: validate, save locally, dedup check ─────────────
  for (let i = 0; i < rawItems.length; i++) {
    const { name, dataUrl } = rawItems[i] || {};
    const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|gif|webp|avif);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) {
      results[i] = { ok: false, error: 'Invalid image format — must be PNG, JPG, GIF, WebP, or AVIF', index: i };
      continue;
    }

    const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
    const data = Buffer.from(match[2].replace(/\s/g, ''), 'base64');

    if (!data.length || data.length > 8 * 1024 * 1024) {
      results[i] = { ok: false, error: data.length ? 'Image too large — max 8 MB' : 'Image data is empty', index: i };
      continue;
    }

    const header = magic[ext] || magic.png;
    if (ext !== 'avif' && !header.every((b, j) => data[j] === b)) {
      results[i] = { ok: false, error: `File does not appear to be a valid ${ext.toUpperCase()}`, index: i };
      continue;
    }

    const imageHash = crypto.createHash('sha256').update(data).digest('hex');
    const safeName = String(name || `asset.${ext}`).replace(/[^a-z0-9._-]/gi, '-').slice(-80);
    const normalizedName = safeName.toLowerCase().endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`;
    const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${normalizedName}`;
    const filePath = path.join(PATHS.uploads, fileName);
    fs.writeFileSync(filePath, data);

    const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

    // Dedup check
    const existing = Object.values(manifest).find(e =>
      e?.sha256 === imageHash && e?.cdnUrl && !isExpiredCdnUrl(e.cdnUrl));

    if (existing) {
      const entry = { fileName, filePath, cdnUrl: existing.cdnUrl, mimeType, sha256: imageHash, uploadedAt: Date.now(), dedupedFrom: existing.fileName || null };
      manifest[fileName] = entry;
      manifest[cdnUrlKey(existing.cdnUrl)] = entry;
      appendLog(`[Batch] Dedup [${i+1}/${rawItems.length}] ${fileName}`);
      results[i] = { ok: true, url: existing.cdnUrl, cdn: true, deduped: true, fileName, index: i };
      continue;
    }

    // Needs real upload
    toUpload.push({ index: i, data, mimeType, fileName, filePath, imageHash });
  }

  saveManifest(manifest);

  // ── Phase 2: batch upload non-deduped items ───────────────────
  if (toUpload.length) {
    appendLog(`[Batch] Uploading ${toUpload.length} new image(s) in one message…`);
    const uploadItems = toUpload.map(t => ({ buffer: t.data, mimeType: t.mimeType, fileName: t.fileName }));
    const uploadResults = await uploadBatchToDiscordCDN(uploadItems, {});

    const freshManifest = loadManifest();
    for (let j = 0; j < toUpload.length; j++) {
      const t = toUpload[j];
      const cdnUrl = uploadResults[j]?.url || null;
      const entry = { fileName: t.fileName, filePath: t.filePath, cdnUrl, mimeType: t.mimeType, sha256: t.imageHash, uploadedAt: Date.now() };
      freshManifest[t.fileName] = entry;
      if (cdnUrl) freshManifest[cdnUrlKey(cdnUrl)] = entry;
      results[t.index] = { ok: !!cdnUrl, url: cdnUrl || null, cdn: !!cdnUrl, fileName: t.fileName, index: t.index,
        ...(cdnUrl ? {} : { error: 'Upload failed — check token and upload target' }) };
    }
    saveManifest(freshManifest);
  }

  const allOk = results.every(r => r?.ok);
  const successCount = results.filter(r => r?.ok).length;
  appendLog(`[Batch] Done — ${successCount}/${rawItems.length} uploaded successfully`);
  res.json({ ok: allOk, total: rawItems.length, succeeded: successCount, results });
});

// ── API: Image Upload ─────────────────────────────────────────────
app.post('/api/uploads', async (req, res) => {
  const { name, dataUrl } = req.body || {};
  const cfg = readJSON(PATHS.config, {});
  const richOptions = cfg.config?.options || {};
  const hasHumanModeInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'humanMode');
  const humanMode = hasHumanModeInput
    ? req.body?.humanMode !== false && req.body?.humanMode !== 'false'
    : richOptions.humanMode !== false;

  // ── Validate format
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|gif|webp|avif);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return res.status(400).json({ error: 'Invalid image — must be PNG, JPG, GIF, WebP, or AVIF' });

  const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
  const data = Buffer.from(match[2].replace(/\s/g, ''), 'base64');

  // ── Validate size (max 8 MB)
  if (!data.length) return res.status(400).json({ error: 'Image data is empty' });
  if (data.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large — max 8 MB' });

  // ── Validate magic bytes (basic image header check)
  const magic = { png: [0x89,0x50,0x4e,0x47], jpg: [0xff,0xd8,0xff], gif: [0x47,0x49,0x46], webp: [0x52,0x49,0x46,0x46] };
  const header = magic[ext] || magic.png;
  const isValid = header.every((b, i) => data[i] === b);
  if (!isValid && ext !== 'avif') {
    appendLog(`[Image] Rejected — header mismatch for .${ext}`, true);
    return res.status(400).json({ error: `File does not appear to be a valid ${ext.toUpperCase()}` });
  }

  appendLog(`[Image] Received "${name || 'unnamed'}" (${(data.length / 1024).toFixed(1)} KB, .${ext})`);

  // ── Save locally (always — used for CDN refresh if URL expires)
  ensureDir(PATHS.uploads);
  const imageHash = crypto.createHash('sha256').update(data).digest('hex');
  const safeName = String(name || `asset.${ext}`).replace(/[^a-z0-9._-]/gi, '-').slice(-80);
  const normalizedName = safeName.toLowerCase().endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`;
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${normalizedName}`;
  const filePath = path.join(PATHS.uploads, fileName);
  fs.writeFileSync(filePath, data);
  appendLog(`[Image] Saved locally: ${fileName}`);

  // ── Step: save locally confirmed
  const saveStep = { step: 'Save locally', status: 'ok', detail: `${fileName} · ${(data.length / 1024).toFixed(1)} KB` };

  // ── Upload to Discord CDN for a publicly accessible URL
  const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const manifest = loadManifest();
  const localUrl = `${getPublicBaseUrl(req)}/uploads/${encodeURIComponent(fileName)}`;
  let finalUrl;
  const existing = Object.values(manifest).find(entry =>
    entry?.sha256 === imageHash && entry?.cdnUrl && !isExpiredCdnUrl(entry.cdnUrl));

  if (existing) {
    finalUrl = existing.cdnUrl;
    const entry = { fileName, filePath, cdnUrl: finalUrl, mimeType, localUrl, sha256: imageHash, uploadedAt: Date.now(), dedupedFrom: existing.fileName || null };
    manifest[fileName] = entry;
    manifest[cdnUrlKey(finalUrl)] = entry;
    saveManifest(manifest);
    appendLog(`[Image] Duplicate detected — reused existing CDN URL`);
    return res.json({
      ok: true,
      url: finalUrl,
      cdn: true,
      deduped: true,
      steps: [
        saveStep,
        { step: 'Duplicate check', status: 'ok', detail: 'Image already exists — reused CDN URL without sending again' },
      ],
    });
  }

  const { url: cdnUrl, steps: cdnSteps } = await uploadToDiscordCDN(data, mimeType, fileName, null, {
    humanMode,
    humanJitter: richOptions.humanJitter,
  });
  const allSteps = [saveStep, ...cdnSteps];

  if (cdnUrl) {
    finalUrl = cdnUrl;
    const entry = { fileName, filePath, cdnUrl, mimeType, localUrl, sha256: imageHash, uploadedAt: Date.now() };
    manifest[fileName] = entry;
    manifest[cdnUrlKey(cdnUrl)] = entry;
    saveManifest(manifest);
    appendLog(`[Image] Ready — using Discord CDN URL`);
    return res.json({ ok: true, url: finalUrl, cdn: true, steps: allSteps });
  }

  // ── Fallback: local server URL (only reachable if server has public domain)
  finalUrl = localUrl;
  manifest[fileName] = { fileName, filePath, cdnUrl: null, mimeType, localUrl: finalUrl, sha256: imageHash, uploadedAt: Date.now() };
  saveManifest(manifest);
  appendLog(`[Image] Warning — no CDN URL, using local fallback (add a token first for Discord CDN upload)`);
  const warnStep = { step: 'CDN upload', status: 'warn', detail: 'Skipped — no token. Image saved locally but may not display in Rich Presence.' };
  res.json({ ok: true, url: finalUrl, cdn: false, steps: [saveStep, warnStep], warning: 'Add a token first so images upload to Discord CDN' });
});

// ── API: Image CDN Check — verifies + auto-refreshes all image URLs ──
// POST /api/uploads/check  { urls: string[] }
// Returns per-URL status: ok | refreshed | expired | missing | error | external
app.post('/api/uploads/check', async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (!urls.length) return res.json({ results: [] });

  const manifest = loadManifest();
  const results  = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || '').trim();
    if (!url) continue;

    // ── Dashboard upload URL (localhost, Replit, tunnel, etc.) → force CDN
    if (isManagedUploadUrl(url)) {
      const resolved = await resolveManagedUploadUrl(url, manifest);
      results.push({
        url,
        status: resolved.status,
        newUrl: resolved.url,
        detail: resolved.detail,
      });
      continue;
    }

    // ── External (non-Discord, non-dashboard-upload) — user manages it
    if (!url.includes('cdn.discordapp.com')) {
      results.push(isLocalUrl(url)
        ? { url, status: 'error', newUrl: null, detail: 'Local URL is not reachable by Discord; use an uploaded image' }
        : { url, status: 'external', newUrl: url, detail: 'External URL — not managed by StreamDash' });
      continue;
    }

    // ── Discord CDN URL: check expiry first
    if (!isExpiredCdnUrl(url)) {
      const entry = manifest[cdnUrlKey(url)];
      results.push({ url, status: 'ok', newUrl: url,
        detail: entry ? 'Valid CDN URL — tracked in manifest' : 'Valid CDN URL — externally managed' });
      continue;
    }

    // ── Expired Discord CDN URL → find local copy + re-upload
    const entry = manifest[cdnUrlKey(url)];
    if (entry?.fileName) {
      const fresh = await refreshCdnUrl(entry.fileName);
      results.push(fresh
        ? { url, status: 'refreshed', newUrl: fresh, detail: 'CDN URL expired — re-uploaded automatically' }
        : { url, status: 'error',     newUrl: null,  detail: 'CDN URL expired — re-upload failed, check token' });
    } else {
      results.push({ url, status: 'expired', newUrl: null,
        detail: 'CDN URL expired and no local backup found — re-upload the image manually' });
    }
  }

  appendLog(`[Image] CDN check: ${results.length} URLs — ${results.filter(r=>r.status==='ok').length} ok, ${results.filter(r=>r.status==='refreshed').length} refreshed, ${results.filter(r=>r.status==='error'||r.status==='expired'||r.status==='missing').length} failed`);
  return res.json({ results });
});

// ── API: Image URL Resolver (used by bot to refresh expired CDN URLs)
// GET /api/uploads/resolve?url=<encoded_url>
app.get('/api/uploads/resolve', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url param required' });

  // Case 1: URL is from dashboard uploads — return/refresh Discord CDN URL
  if (isManagedUploadUrl(url)) {
    const manifest = loadManifest();
    const resolved = await resolveManagedUploadUrl(url, manifest);
    if (resolved.url) {
      appendLog(`[Image] Resolved upload URL to CDN: ${uploadFileNameFromUrl(url) || 'unknown file'}`);
      return res.json({ url: resolved.url, refreshed: resolved.url !== url });
    }
    appendLog(`[Image] Upload URL unresolvable — ${resolved.detail}`, true);
    return res.json({ url, refreshed: false, warning: resolved.detail });
  }

  // Case 2: Discord CDN URL that has expired — find in manifest and refresh
  if (isExpiredCdnUrl(url)) {
    appendLog(`[Image] Expired CDN URL detected — looking up manifest…`);
    const key = cdnUrlKey(url);
    const manifest = loadManifest();
    const entry = manifest[key];
    if (entry?.fileName) {
      const fresh = await refreshCdnUrl(entry.fileName);
      if (fresh) return res.json({ url: fresh, refreshed: true });
    }
    appendLog(`[Image] No manifest entry for expired URL — cannot refresh`, true);
    return res.json({ url, refreshed: false, warning: 'Expired CDN URL — re-upload the image in settings' });
  }

  // Case 3: Valid, non-expired URL — use as-is
  return res.json({ url, refreshed: false });
});

// ── API: Custom Status Emojis ──────────────────────────────────────
app.get('/api/emojis', async (_, res) => {
  const tokens = extractTokens();
  if (!tokens.length) return res.json({ emojis: [], error: 'No token configured' });

  const token = tokens[0];
  const headers = {
    Authorization: token,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0 Safari/537.36',
  };

  try {
    const guildReq = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers,
      signal: AbortSignal.timeout(9000),
    });
    if (!guildReq.ok) {
      const err = await guildReq.json().catch(() => ({}));
      return res.json({ emojis: [], error: err.message || `HTTP ${guildReq.status}` });
    }

    const guilds = (await guildReq.json()).slice(0, 80);
    const emojis = [];
    for (const guild of guilds) {
      try {
        const r = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/emojis`, {
          headers,
          signal: AbortSignal.timeout(9000),
        });
        if (!r.ok) continue;
        const list = await r.json();
        for (const emoji of Array.isArray(list) ? list : []) {
          if (!emoji?.id || !emoji?.name) continue;
          emojis.push({
            id: emoji.id,
            name: emoji.name,
            animated: !!emoji.animated,
            guildId: guild.id,
            guildName: guild.name || 'Server',
            value: `${emoji.animated ? '<a' : '<'}:${emoji.name}:${emoji.id}>`,
            url: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}?size=48`,
          });
        }
      } catch {}
      if (emojis.length >= 500) break;
    }

    res.json({ emojis: emojis.slice(0, 500) });
  } catch (e) {
    res.json({ emojis: [], error: e.message });
  }
});

// ── API: Rate Limits ───────────────────────────────────────────────
app.get('/api/ratelimits', (_, res) => {
  // Prune expired entries
  const now = Date.now();
  for (const k of Object.keys(rateLimits)) {
    if (rateLimits[k].endTs > 0 && rateLimits[k].endTs < now) delete rateLimits[k];
  }
  res.json({ limits: Object.values(rateLimits) });
});

// ── Pre-start image check: refreshes expired/local URLs in config ──
// Called automatically every time the bot is about to start.
// Reads the active config, fixes stale URLs, saves updated config,
// and returns a summary so the frontend can show what happened.
async function preStartImageCheck() {
  const cfg = readJSON(PATHS.config, {});
  const presenceCfg = cfg.config || {};
  const allUrls = [
    ...(presenceCfg.bigimg   || []),
    ...(presenceCfg.smallimg || [])
  ].filter(Boolean);
  if (!allUrls.length) return { checked: 0, refreshed: 0, failed: 0 };

  const manifest = loadManifest();
  let refreshed = 0, failed = 0, changed = false;
  const replacements = [];

  const tryRefresh = async (url) => {
    if (!url) return url;
    if (isManagedUploadUrl(url)) {
      const resolved = await resolveManagedUploadUrl(url, manifest);
      return resolved.url || null;
    }
    if (!isExpiredCdnUrl(url)) return url;   // already valid/external

    // Expired Discord CDN URL — find local backup + re-upload
    const entry = manifest[cdnUrlKey(url)];
    if (entry?.fileName) return await refreshCdnUrl(entry.fileName) || null;
    return null;
  };

  for (let i = 0; i < (presenceCfg.bigimg || []).length; i++) {
    const oldUrl = presenceCfg.bigimg[i];
    const fresh = await tryRefresh(oldUrl);
    if (fresh === null)                  { failed++;    }
    else if (fresh !== oldUrl)    {
      presenceCfg.bigimg[i] = fresh;
      replacements.push({ key: 'bigimg', index: i, oldUrl, newUrl: fresh });
      refreshed++;
      changed = true;
    }
  }
  for (let i = 0; i < (presenceCfg.smallimg || []).length; i++) {
    const oldUrl = presenceCfg.smallimg[i];
    const fresh = await tryRefresh(oldUrl);
    if (fresh === null)                   { failed++;     }
    else if (fresh !== oldUrl)   {
      presenceCfg.smallimg[i] = fresh;
      replacements.push({ key: 'smallimg', index: i, oldUrl, newUrl: fresh });
      refreshed++;
      changed = true;
    }
  }

  if (changed) {
    writeJSON(PATHS.config, cfg);
    appendLog(`[Image] Pre-start: refreshed ${refreshed} URL(s) in config before bot launch`);
  }
  if (failed) appendLog(`[Image] Pre-start: ${failed} image URL(s) could not be refreshed — bot will try again at runtime`, true);

  return { checked: allUrls.length, refreshed, failed, replacements };
}

// ── API: Runtime ───────────────────────────────────────────────────
app.get('/api/runtime', (_, res) => res.json(runtimeStatus()));
app.post('/api/runtime/start', async (_, res) => {
  if (botProc) return res.status(409).json({ error: 'already running', status: runtimeStatus() });

  // Validate + auto-refresh all image URLs before bot starts
  const imageCheck = await preStartImageCheck();

  startBot();
  res.json({ ok: true, status: runtimeStatus(), imageCheck });
});
app.post('/api/runtime/stop', (_, res) => {
  if (!botProc) return res.status(409).json({ error: 'not running' });
  stopBot();
  res.json({ ok: true });
});
app.post('/api/runtime/refresh', (_, res) => {
  if (!botProc) return res.status(409).json({ error: 'not running' });
  const ok = sendBotCommand({ type: 'refreshPresence', reason: 'dashboard' });
  if (!ok) return res.status(500).json({ error: 'refresh command failed' });
  appendLog('[Bot] Refresh requested');
  res.json({ ok: true, status: runtimeStatus() });
});

// ── API: Discord Developer Portal Applications ─────────────────────
// Fetches the user's own applications from discord.com/developers/applications
// using their selfbot token — returns list of apps with id, name, icon
app.get('/api/discord-apps', async (req, res) => {
  const picked = await selectUploadToken(String(req.query.accountId || process.env.DISCORD_APP_ACCOUNT_ID || '').trim());
  if (picked.error) return res.json({ apps: [], error: picked.error });

  try {
    const r = await fetch('https://discord.com/api/v10/applications?with_team_applications=true', {
      headers: buildHumanHeaders(picked.token, 'https://discord.com/developers/applications'),
      signal: AbortSignal.timeout(9000)
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = r.status === 401
        ? 'Token is invalid or expired'
        : r.status === 403
          ? 'Access denied — token may not have Developer access'
          : (err.message || `HTTP ${r.status}`);
      return res.json({ apps: [], error: msg });
    }

    const raw = await r.json();
    const apps = (Array.isArray(raw) ? raw : []).map(a => ({
      id:          a.id,
      name:        a.name || 'Unnamed App',
      description: (a.description || '').slice(0, 120),
      icon:        a.icon
        ? `https://cdn.discordapp.com/app-icons/${a.id}/${a.icon}.png?size=64`
        : null,
      hasRichPresence: !!(a.flags & (1 << 9)), // RPC_HAS_CONNECTED flag
    }));

    appendLog(`[Apps] Fetched ${apps.length} application(s) from Developer Portal for ${picked.account?.username || 'selected account'}`);
    res.json({ apps, account: picked.account });
  } catch (e) {
    res.json({ apps: [], error: e.message });
  }
});

// ── API: Token Validation ──────────────────────────────────────────
app.post('/api/tokens/validate', async (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens)) return res.status(400).json({ error: 'tokens must be array' });
  const results = await Promise.allSettled(tokens.map(async (token) => {
    const t = String(token).trim();
    if (!t) return { valid: false, error: 'Empty token', masked: '••••' };
    try {
      const r = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: t },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return { valid: false, error: err.message || `HTTP ${r.status}`, masked: maskToken(t) };
      }
      const u = await r.json();
      const avatar = u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(u.id) % 6n)}.png`;
      return {
        valid: true, id: u.id,
        username: u.global_name || u.username,
        tag: u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username,
        avatar,
        banner: u.banner ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.${u.banner.startsWith('a_')?'gif':'png'}?size=480` : null,
        masked: maskToken(t),
        nitro: u.premium_type > 0,
      };
    } catch (e) {
      return { valid: false, error: e.message, masked: maskToken(t) };
    }
  }));
  res.json(results.map(r => r.value || { valid: false, error: r.reason?.message || 'Unknown error' }));
});

// ── API: Image Upload Destinations ─────────────────────────────────
app.get('/api/upload-targets', async (req, res) => {
  const guildId = String(req.query.guildId || '').trim();
  const selected = uploadTargetConfigFromEnv();
  const accountId = String(req.query.accountId || selected.accountId || '').trim();
  const out = { accounts: [], dms: [], guilds: [], channels: [], selected };

  try {
    out.accounts = await listUploadAccounts();
    const picked = await selectUploadToken(accountId);
    if (picked.error) return res.json({ ...out, error: picked.error });
    const token = picked.token;
    out.account = picked.account;

    const [dmR, guildR] = await Promise.all([
      discordJson('https://discord.com/api/v10/users/@me/channels', token),
      discordJson('https://discord.com/api/v10/users/@me/guilds', token),
    ]);

    if (dmR.ok && Array.isArray(dmR.data)) {
      out.dms = dmR.data
        .filter(ch => isPrivateChannelType(ch.type))
        .map(ch => ({
          id: ch.id,
          type: ch.type,
          name: discordChannelName(ch),
          recipients: (ch.recipients || []).map(u => ({
            id: u.id,
            username: u.global_name || u.username,
            tag: u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username,
          })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      out.dmError = dmR.data?.message || `HTTP ${dmR.status}`;
    }

    if (guildR.ok && Array.isArray(guildR.data)) {
      out.guilds = guildR.data
        .map(g => ({ id: g.id, name: g.name || `Server ${g.id}` }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      out.guildError = guildR.data?.message || `HTTP ${guildR.status}`;
    }

    if (guildId) {
      const chR = await discordJson(`https://discord.com/api/v10/guilds/${guildId}/channels`, token);
      if (chR.ok && Array.isArray(chR.data)) {
        out.channels = chR.data
          .filter(ch => isServerUploadChannelType(ch.type))
          .map(ch => ({ id: ch.id, guildId: ch.guild_id || guildId, name: ch.name || `channel-${ch.id}`, type: ch.type, parentId: ch.parent_id || '' }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } else {
        out.channelError = chR.data?.message || `HTTP ${chR.status}`;
      }
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, ...out });
  }
});

app.post('/api/upload-targets/validate', async (req, res) => {
  const target = normalizeUploadTarget(req.body?.target || req.body || {});
  const picked = await selectUploadToken(target.accountId);
  if (picked.error) return res.status(400).json({ ok: false, error: picked.error });

  const token = picked.token;
  const check = await validateUploadTarget(target, token);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  res.json({ ok: true, targetKey: check.targetKey, destination: check.destination, channelId: check.channelId, account: picked.account });
});

// ── API: Profiles ──────────────────────────────────────────────────
app.get('/api/profiles', (_, res) => res.json(readJSON(PATHS.profiles, [])));
app.post('/api/profiles', (req, res) => {
  const { name, config } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'name and config required' });
  const list = readJSON(PATHS.profiles, []);
  const p = { id: crypto.randomUUID(), name, config, createdAt: new Date().toISOString() };
  list.push(p);
  writeJSON(PATHS.profiles, list);
  appendLog(`[Profiles] Saved: "${name}"`);
  res.json({ ok: true, profile: p });
});
app.delete('/api/profiles/:id', (req, res) => {
  const list = readJSON(PATHS.profiles, []).filter(p => p.id !== req.params.id);
  writeJSON(PATHS.profiles, list);
  appendLog(`[Profiles] Deleted: ${req.params.id}`);
  res.json({ ok: true });
});
app.post('/api/profiles/:id/apply', (req, res) => {
  const p = readJSON(PATHS.profiles, []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  writeJSON(PATHS.config, p.config);
  appendLog(`[Profiles] Applied: "${p.name}"`);
  res.json({ ok: true, config: p.config });
});

// ── API: Stats ─────────────────────────────────────────────────────
app.get('/api/stats', (_, res) => {
  const saved = loadStats();
  const cur = sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
  const ramTotal = os.totalmem();
  const ramFree = os.freemem();
  const savedSessions = Number(saved.totalSessions) || (saved.sessions || []).length || 0;
  res.json({
    running: !!botProc, pid: botProc?.pid || null,
    sessionUptime: cur,
    totalUptime: (Number(saved.totalUptime) || 0) + cur,
    totalSessions: savedSessions + (botProc ? 1 : 0),
    sessions: saved.sessions.slice(-10),
    rotationCounts: addCounts(saved.rotationCounts, rotationCounts, defaultRotationCounts()),
    verifyCounts: addCounts(saved.verifyCounts, verifyCounts, { failed: 0 }),
    cpu: getCpuUsage(),
    ram: Math.floor((ramTotal - ramFree) / ramTotal * 100),
    ramUsed: +(( ramTotal - ramFree) / 1e9).toFixed(1),
    ramTotal: +(ramTotal / 1e9).toFixed(1),
    logCount: botLogs.length,
    errorCount: errorLogs.length,
    tokensConfigured: extractTokens().length,
  });
});

// ── API: Schedule ──────────────────────────────────────────────────
app.get('/api/schedule', (_, res) => res.json(readJSON(PATHS.schedule, {})));
app.post('/api/schedule', (req, res) => {
  const { enabled, startTime, stopTime, days } = req.body;
  const s = { enabled: !!enabled, startTime: startTime||'20:00', stopTime: stopTime||'00:00', days: days||[0,1,2,3,4,5,6] };
  writeJSON(PATHS.schedule, s);
  appendLog(`[Schedule] ${enabled ? 'Enabled' : 'Disabled'} - ${startTime} -> ${stopTime}`);
  res.json({ ok: true, schedule: s });
});

// ── API: Image Cleanup ─────────────────────────────────────────────
// Deletes local upload files no longer referenced in any config or profile.
app.post('/api/uploads/cleanup', (_, res) => {
  try {
    // Collect every upload URL referenced anywhere
    const cfg      = readJSON(PATHS.config, {});
    const profiles = readJSON(PATHS.profiles, []);

    const referencedUrls = new Set();

    function collectUrls(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(collectUrls); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.includes('/uploads/')) referencedUrls.add(v);
        else collectUrls(v);
      }
    }
    collectUrls(cfg);
    profiles.forEach(p => collectUrls(p));

    // Extract file names from referenced URLs
    const referencedFiles = new Set(
      [...referencedUrls].map(u => {
        try { return decodeURIComponent(new URL(u).pathname.split('/uploads/').pop()); }
        catch { return null; }
      }).filter(Boolean)
    );

    // List all files in uploads dir (skip manifest.json)
    const uploadsDir = PATHS.uploads;
    if (!fs.existsSync(uploadsDir)) return res.json({ deleted: 0, freed: 0, kept: 0 });

    const allFiles = fs.readdirSync(uploadsDir)
      .filter(f => f !== 'manifest.json' && !f.startsWith('.'));

    let deleted = 0, freed = 0;
    const manifest = loadManifest();

    for (const file of allFiles) {
      if (referencedFiles.has(file)) continue;

      const fp = path.join(uploadsDir, file);
      try {
        const size = fs.statSync(fp).size;
        fs.unlinkSync(fp);
        freed += size;
        deleted++;
        appendLog(`[Cleanup] Deleted unused image: ${file}`);

        // Remove from manifest
        for (const key of Object.keys(manifest)) {
          if (manifest[key].fileName === file) delete manifest[key];
        }
      } catch (e) {
        appendLog(`[Cleanup] Could not delete ${file}: ${e.message}`, true);
      }
    }

    saveManifest(manifest);
    const kept = allFiles.length - deleted;
    appendLog(`[Cleanup] Done — ${deleted} file(s) deleted, ${(freed / 1024).toFixed(1)} KB freed, ${kept} kept`);
    res.json({ ok: true, deleted, freed, kept });
  } catch (e) {
    appendLog(`[Cleanup] Error: ${e.message}`, true);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Shutdown (kill-switch) ────────────────────────────────────
app.post('/api/shutdown', (req, res) => {
  if (botProc) stopBot();
  res.json({ ok: true, message: 'Server shutting down...' });
  setTimeout(() => {
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  }, 400);
});

// ── API: Webhook ───────────────────────────────────────────────────
app.post('/api/webhook/test', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: '✅ Webhook Connected', description: 'Streaming Dashboard — connection test successful!', color: 0x22c55e, timestamp: new Date().toISOString() }] }),
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok || r.status === 204) return res.json({ ok: true });
    res.status(400).json({ error: `Discord returned ${r.status}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── API: Environment ───────────────────────────────────────────────
app.get('/api/env', (_, res) => {
  res.json({
    hasWebhook: !!(process.env.DISCORD_WEBHOOK && process.env.DISCORD_WEBHOOK.startsWith('http')),
    webhookUrl: process.env.DISCORD_WEBHOOK || '',
    appAccountId: process.env.DISCORD_APP_ACCOUNT_ID || '',
    uploadAccountId: process.env.DISCORD_UPLOAD_ACCOUNT_ID || '',
    uploadTargetType: process.env.DISCORD_UPLOAD_TARGET_TYPE || '',
    uploadDmChannelId: process.env.DISCORD_UPLOAD_DM_CHANNEL_ID || '',
    uploadGuildId: process.env.DISCORD_UPLOAD_GUILD_ID || '',
    uploadChannelId: process.env.DISCORD_UPLOAD_CHANNEL_ID || '',
  });
});
app.post('/api/env', (req, res) => {
  const { webhookUrl, appAccountId, uploadAccountId, uploadTargetType, uploadDmChannelId, uploadGuildId, uploadChannelId } = req.body;
  let content = '';
  try { content = fs.readFileSync(PATHS.env, 'utf8'); } catch {}
  const lines = content.split('\n').filter(Boolean);
  const set = (k, v) => {
    const i = lines.findIndex(l => l.startsWith(`${k}=`));
    if (v) { if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`); }
    else if (i >= 0) lines.splice(i, 1);
  };
  if (webhookUrl !== undefined) { set('DISCORD_WEBHOOK', webhookUrl); process.env.DISCORD_WEBHOOK = webhookUrl; }
  if (appAccountId !== undefined) { set('DISCORD_APP_ACCOUNT_ID', appAccountId); process.env.DISCORD_APP_ACCOUNT_ID = appAccountId; }
  if (uploadAccountId !== undefined) { set('DISCORD_UPLOAD_ACCOUNT_ID', uploadAccountId); process.env.DISCORD_UPLOAD_ACCOUNT_ID = uploadAccountId; _cdnSession = null; }
  if (uploadTargetType !== undefined) { set('DISCORD_UPLOAD_TARGET_TYPE', uploadTargetType); process.env.DISCORD_UPLOAD_TARGET_TYPE = uploadTargetType; _cdnSession = null; }
  if (uploadDmChannelId !== undefined) { set('DISCORD_UPLOAD_DM_CHANNEL_ID', uploadDmChannelId); process.env.DISCORD_UPLOAD_DM_CHANNEL_ID = uploadDmChannelId; _cdnSession = null; }
  if (uploadGuildId !== undefined) { set('DISCORD_UPLOAD_GUILD_ID', uploadGuildId); process.env.DISCORD_UPLOAD_GUILD_ID = uploadGuildId; _cdnSession = null; }
  if (uploadChannelId !== undefined) { set('DISCORD_UPLOAD_CHANNEL_ID', uploadChannelId); process.env.DISCORD_UPLOAD_CHANNEL_ID = uploadChannelId; _cdnSession = null; }
  set('DISCORD_UPLOAD_WEBHOOK', '');
  set('UPLOAD_WEBHOOK_URL', '');
  fs.writeFileSync(PATHS.env, lines.join('\n') + '\n', 'utf8');
  appendLog('[Settings] Environment updated');
  res.json({ ok: true });
});

// ── API: Logs ──────────────────────────────────────────────────────
app.get('/api/logs', (_, res) => res.json({ logs: botLogs.slice(-200), errorLogs: errorLogs.slice(-100) }));
app.delete('/api/logs', (_, res) => {
  botLogs = []; errorLogs = [];
  broadcast('clearLogs', {});
  res.json({ ok: true });
});

// ── API: Import / Export ───────────────────────────────────────────
app.get('/api/export', (_, res) => {
  res.json({
    config: readJSON(PATHS.config),
    tokens: extractTokens().map(maskToken),
    profiles: readJSON(PATHS.profiles, []),
    schedule: readJSON(PATHS.schedule, {}),
    exportedAt: new Date().toISOString(),
    version: '3.0'
  });
});
app.post('/api/import', (req, res) => {
  const { config, profiles, schedule } = req.body;
  if (config) writeJSON(PATHS.config, config);
  if (profiles && Array.isArray(profiles)) writeJSON(PATHS.profiles, profiles);
  if (schedule) writeJSON(PATHS.schedule, schedule);
  appendLog('[Import] Configuration imported successfully');
  res.json({ ok: true });
});

// ── Broadcast sys stats every 5s ──────────────────────────────────
setInterval(() => {
  if (!wsClients.size) return;
  const ram = os.totalmem();
  broadcast('sysStats', {
    cpu: getCpuUsage(),
    ram: Math.floor((ram - os.freemem()) / ram * 100),
    running: !!botProc,
    sessionUptime: sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0,
    rotationCounts,
    verifyCounts,
  });
}, 5000);

// ── CDN URL Health-Check Scheduler ────────────────────────────────
// Runs every 25 minutes. Finds images expiring within 2 hours and
// re-uploads them proactively before Discord breaks the presence.
let _cdnRefreshRunning = false;

async function runCdnHealthCheck() {
  if (_cdnRefreshRunning) return;

  const tokens = extractTokens();
  if (!tokens.length) return;

  const manifest = loadManifest();
  const entries = Object.values(manifest);
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  // Collect unique files expiring within 2 hours (deduplicate by fileName)
  const seen = new Set();
  const toRefresh = [];
  for (const entry of entries) {
    if (!entry?.fileName || !entry?.cdnUrl || seen.has(entry.fileName)) continue;
    seen.add(entry.fileName);
    if (!isExpiredCdnUrl(entry.cdnUrl)) {
      try {
        const ex = new URL(entry.cdnUrl).searchParams.get('ex');
        if (!ex) continue;
        const expiresAt = parseInt(ex, 16) * 1000;
        if (expiresAt - now < TWO_HOURS) toRefresh.push(entry);
      } catch {}
    } else {
      toRefresh.push(entry);
    }
  }

  if (!toRefresh.length) return;

  _cdnRefreshRunning = true;
  appendLog(`[CDN] Health-check: refreshing ${toRefresh.length} image(s) expiring soon…`);

  let ok = 0, fail = 0;
  for (const entry of toRefresh) {
    try {
      const fresh = await refreshCdnUrl(entry.fileName);
      if (fresh) {
        ok++;
        appendLog(`[CDN] ✓ Refreshed: ${entry.fileName}`);
      } else {
        fail++;
        appendLog(`[CDN] ✗ Failed to refresh: ${entry.fileName}`, true);
      }
      // Natural pace between refreshes
      if (toRefresh.indexOf(entry) < toRefresh.length - 1) {
        await humanDelay(1500, 3000);
      }
    } catch (e) {
      fail++;
      appendLog(`[CDN] ✗ Error refreshing ${entry.fileName}: ${e.message}`, true);
    }
  }

  _cdnRefreshRunning = false;
  const summary = `[CDN] Health-check done — ${ok} refreshed, ${fail} failed`;
  appendLog(summary, fail > 0 && ok === 0);
  if (wsClients.size) broadcast('cdnHealth', { ok, fail, total: toRefresh.length, ts: Date.now() });
}

// Start first check 2 minutes after boot (let session settle), then every 25 min
setTimeout(() => {
  runCdnHealthCheck();
  setInterval(runCdnHealthCheck, 25 * 60 * 1000);
}, 2 * 60 * 1000);

// ── API: manual CDN health-check trigger ──────────────────────────
app.post('/api/cdn-health-check', async (req, res) => {
  if (_cdnRefreshRunning) return res.json({ ok: false, message: 'Health-check already running' });
  res.json({ ok: true, message: 'CDN health-check started' });
  runCdnHealthCheck();
});

app.get('/api/cdn-health-check/status', (req, res) => {
  const manifest = loadManifest();
  const entries = Object.values(manifest);
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  let total = 0, expiredCount = 0, soonCount = 0, healthyCount = 0;
  const seen = new Set();

  for (const entry of entries) {
    if (!entry?.fileName || !entry?.cdnUrl || seen.has(entry.fileName)) continue;
    seen.add(entry.fileName);
    total++;

    if (isExpiredCdnUrl(entry.cdnUrl)) {
      expiredCount++;
    } else {
      try {
        const ex = new URL(entry.cdnUrl).searchParams.get('ex');
        if (ex) {
          const expiresAt = parseInt(ex, 16) * 1000;
          if (expiresAt - now < TWO_HOURS) soonCount++;
          else healthyCount++;
        } else {
          healthyCount++;
        }
      } catch { healthyCount++; }
    }
  }

  res.json({
    running: _cdnRefreshRunning,
    total,
    healthy: healthyCount,
    expiringSoon: soonCount,
    expired: expiredCount,
  });
});

// ── Init & Listen ──────────────────────────────────────────────────
ensureFile(PATHS.profiles, []);
ensureFile(PATHS.stats, {
  schemaVersion: 2,
  totalUptime: 0,
  totalSessions: 0,
  sessions: [],
  rotationCounts: defaultRotationCounts(),
  verifyCounts: { failed: 0 },
});
ensureFile(PATHS.schedule, { enabled: false, startTime: '20:00', stopTime: '00:00', days: [0,1,2,3,4,5,6] });
ensureDir(PATHS.uploads);

findAvailablePort(Number(BASE_PORT)).then((PORT) => {
  dashboardPort = PORT;
  process.env.DASHBOARD_PORT = String(PORT);
  httpServer.listen(PORT, BIND_HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Dashboard running on ${url}`);
    if (Number(BASE_PORT) !== PORT) {
      console.log(`[Info] Port ${BASE_PORT} was busy, switched to port ${PORT}`);
    }
    if (!process.env.NO_AUTO_OPEN) openBrowser(url);
  });
});
