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
  const env = { ...process.env, WEATHER_API_KEY: process.env.WEATHER_API_KEY };
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

// ── Discord CDN Upload (DM-to-self / Saved Messages) ─────────────
// Discord's "DM to self" creates a Saved Messages channel — this is
// a supported API feature used to get a publicly accessible CDN URL.
// ── Session cache: token + channel verified once per batch ────────
// Avoids repeating 2 API calls per image when uploading many at once.
// Cache lives for 10 minutes; invalidated when token changes.
let _cdnSession = null; // { token, username, channelId, validUntil }

function getCdnSession(token) {
  const now = Date.now();
  if (_cdnSession && _cdnSession.token === token && _cdnSession.validUntil > now) {
    return _cdnSession;
  }
  return null;
}

async function buildCdnSession(token, ua) {
  // ① Verify token
  const meR = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: token, 'User-Agent': ua },
    signal: AbortSignal.timeout(10000)
  });
  if (!meR.ok) {
    const err = await meR.json().catch(() => ({}));
    return { error: `HTTP ${meR.status} — ${err.message || 'invalid or expired token'}` };
  }
  const me = await meR.json();

  // ② Open / confirm Saved Messages channel
  const dmR = await fetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({ recipient_id: me.id }),
    signal: AbortSignal.timeout(10000)
  });
  if (!dmR.ok) {
    const err = await dmR.json().catch(() => ({}));
    return { error: `HTTP ${dmR.status} — ${err.message || 'could not open Saved Messages'}` };
  }
  const dm = await dmR.json();

  _cdnSession = {
    token,
    username: me.global_name || me.username,
    channelId: dm.id,
    validUntil: Date.now() + 10 * 60 * 1000   // 10 min
  };
  return { session: _cdnSession };
}

// Sleep helper for rate-limit back-off
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Returns { url: string|null, steps: [{step,status,detail}] }
// Pass `sessionHint` (pre-built session) to skip token/channel steps in batch mode.
async function uploadToDiscordCDN(imageBuffer, mimeType, fileName, sessionHint = null) {
  const steps = [];
  const pass = (step, detail) => { steps.push({ step, status: 'ok',   detail }); appendLog(`[Image] ✓ ${step}: ${detail}`); };
  const fail = (step, detail) => { steps.push({ step, status: 'error', detail }); appendLog(`[Image] ✗ ${step}: ${detail}`, true); };
  const info = (step, detail) => { steps.push({ step, status: 'info', detail }); appendLog(`[Image]   ${step}: ${detail}`); };

  const tokens = extractTokens();
  if (!tokens.length) {
    fail('Token check', 'No token configured — add a token in the Tokens section first');
    return { url: null, steps };
  }

  const token = tokens[0];
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Discord/1.0 Safari/537.36';
  info('File check', `${fileName} · ${(imageBuffer.length / 1024).toFixed(1)} KB · ${mimeType}`);

  try {
    // ① + ② — use session cache to avoid repeating these for every image in a batch
    let session = sessionHint || getCdnSession(token);
    if (session) {
      pass('Token & channel', `${session.username} · channel ${session.channelId} (cached)`);
    } else {
      const result = await buildCdnSession(token, ua);
      if (result.error) {
        fail('Token verification', result.error);
        return { url: null, steps };
      }
      session = result.session;
      pass('Token verification', `Logged in as ${session.username}`);
      pass('Open Saved Messages', `Channel ready (${session.channelId})`);
    }

    // ③ Upload image — with automatic retry on Discord rate-limit (429)
    const form = new FormData();
    form.append('files[0]', new Blob([imageBuffer], { type: mimeType }), fileName);
    form.append('payload_json', JSON.stringify({ content: '' }));

    let msgR, attempt = 0;
    while (true) {
      attempt++;
      msgR = await fetch(`https://discord.com/api/v10/channels/${session.channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: token, 'User-Agent': ua },
        body: form,
        signal: AbortSignal.timeout(25000)
      });

      if (msgR.status === 429 && attempt <= 4) {
        // Discord rate-limit — read retry_after and wait
        const rl = await msgR.json().catch(() => ({}));
        const wait = Math.ceil((rl.retry_after || 2) * 1000) + 200;
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

    // ④ Check expiry
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
  const filePath = path.join(PATHS.uploads, fileName);
  if (!fs.existsSync(filePath)) {
    appendLog(`[Image] Refresh failed — local file missing: ${fileName}`, true);
    return null;
  }
  const rawExt = path.extname(fileName).slice(1) || 'png';
  const mimeType = `image/${rawExt === 'jpg' ? 'jpeg' : rawExt}`;
  const data = fs.readFileSync(filePath);
  appendLog(`[Image] CDN URL expired — re-uploading "${fileName}"…`);
  const { url: newUrl } = await uploadToDiscordCDN(data, mimeType, fileName);
  if (newUrl) {
    const manifest = loadManifest();
    const entry = Object.values(manifest).find(e => e.fileName === fileName);
    if (entry) {
      entry.cdnUrl = newUrl;
      entry.refreshedAt = Date.now();
      manifest[cdnUrlKey(newUrl)] = entry;
    }
    saveManifest(manifest);
  }
  return newUrl;
}

// ── API: Image Upload ─────────────────────────────────────────────
app.post('/api/uploads', async (req, res) => {
  const { name, dataUrl } = req.body || {};

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
  const { url: cdnUrl, steps: cdnSteps } = await uploadToDiscordCDN(data, mimeType, fileName);
  const allSteps = [saveStep, ...cdnSteps];

  const manifest = loadManifest();
  let finalUrl;

  if (cdnUrl) {
    finalUrl = cdnUrl;
    manifest[cdnUrlKey(cdnUrl)] = { fileName, filePath, cdnUrl, mimeType, uploadedAt: Date.now() };
    saveManifest(manifest);
    appendLog(`[Image] Ready — using Discord CDN URL`);
    return res.json({ ok: true, url: finalUrl, cdn: true, steps: allSteps });
  }

  // ── Fallback: local server URL (only reachable if server has public domain)
  finalUrl = `${getPublicBaseUrl(req)}/uploads/${encodeURIComponent(fileName)}`;
  manifest[fileName] = { fileName, filePath, cdnUrl: null, mimeType, localUrl: finalUrl, uploadedAt: Date.now() };
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

    // ── External (non-Discord, non-local) — user manages it themselves
    if (!url.includes('cdn.discordapp.com') && !isLocalUrl(url)) {
      results.push({ url, status: 'external', newUrl: url, detail: 'External URL — not managed by StreamDash' });
      continue;
    }

    // ── Local server URL → try to resolve to CDN
    if (isLocalUrl(url)) {
      const fileName = decodeURIComponent(url.split('/uploads/').pop() || '');
      const entry = manifest[fileName] || Object.values(manifest).find(e => e.fileName === fileName);
      if (entry?.cdnUrl && !isExpiredCdnUrl(entry.cdnUrl)) {
        results.push({ url, status: 'refreshed', newUrl: entry.cdnUrl, detail: 'Resolved local URL → existing CDN URL' });
      } else if (entry?.fileName) {
        const fresh = await refreshCdnUrl(entry.fileName);
        results.push(fresh
          ? { url, status: 'refreshed', newUrl: fresh,  detail: 'Re-uploaded from local file to CDN' }
          : { url, status: 'error',     newUrl: null,   detail: 'Re-upload failed — check token configuration' });
      } else {
        results.push({ url, status: 'missing', newUrl: null, detail: 'File not tracked in manifest — re-upload manually' });
      }
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

  // Case 1: URL is from local server — return CDN URL from manifest if available
  if (isLocalUrl(url)) {
    const fileName = decodeURIComponent(url.split('/uploads/').pop() || '');
    const manifest = loadManifest();
    const entry = manifest[fileName] || Object.values(manifest).find(e => e.fileName === fileName);
    if (entry?.cdnUrl && !isExpiredCdnUrl(entry.cdnUrl)) {
      appendLog(`[Image] Resolved local URL to CDN: ${fileName}`);
      return res.json({ url: entry.cdnUrl, refreshed: false });
    }
    if (entry?.fileName) {
      const fresh = await refreshCdnUrl(entry.fileName);
      if (fresh) return res.json({ url: fresh, refreshed: true });
    }
    appendLog(`[Image] Local URL unresolvable — no CDN entry for: ${fileName}`, true);
    return res.json({ url, refreshed: false, warning: 'Could not resolve to CDN URL' });
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

// ── API: Runtime ───────────────────────────────────────────────────
app.get('/api/runtime', (_, res) => res.json(runtimeStatus()));
app.post('/api/runtime/start', (_, res) => {
  if (botProc) return res.status(409).json({ error: 'already running', status: runtimeStatus() });
  startBot();
  res.json({ ok: true, status: runtimeStatus() });
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
  const tokens = extractTokens();
  if (!tokens.length) return res.json({ apps: [], error: 'No token configured — add a token first' });

  try {
    const r = await fetch('https://discord.com/api/v10/applications?with_team_applications=true', {
      headers: {
        'Authorization': tokens[0],
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9166 Chrome/124.0.6367.243 Electron/30.2.0 Safari/537.36',
      },
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

    appendLog(`[Apps] Fetched ${apps.length} application(s) from Developer Portal`);
    res.json({ apps });
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
  });
});
app.post('/api/env', (req, res) => {
  const { webhookUrl } = req.body;
  let content = '';
  try { content = fs.readFileSync(PATHS.env, 'utf8'); } catch {}
  const lines = content.split('\n').filter(Boolean);
  const set = (k, v) => {
    const i = lines.findIndex(l => l.startsWith(`${k}=`));
    if (v) { if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`); }
    else if (i >= 0) lines.splice(i, 1);
  };
  if (webhookUrl !== undefined) { set('DISCORD_WEBHOOK', webhookUrl); process.env.DISCORD_WEBHOOK = webhookUrl; }
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
  httpServer.listen(PORT, BIND_HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Dashboard running on ${url}`);
    if (Number(BASE_PORT) !== PORT) {
      console.log(`[Info] Port ${BASE_PORT} was busy, switched to port ${PORT}`);
    }
    if (!process.env.NO_AUTO_OPEN) openBrowser(url);
  });
});
