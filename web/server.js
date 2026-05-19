'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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

const PORT = process.env.PORT || 5000;
const ROOT = path.join(__dirname, '..');

const PATHS = {
  config:   path.join(ROOT, 'setup', 'config.json'),
  tokens:   path.join(ROOT, 'setup', 'starter.js'),
  profiles: path.join(ROOT, 'setup', 'profiles.json'),
  stats:    path.join(ROOT, 'setup', 'stats.json'),
  schedule: path.join(ROOT, 'setup', 'schedule.json'),
  env:      path.join(ROOT, '.env'),
};
const BOT_ENTRY = path.join(ROOT, 'index.js');

// ── Runtime State ──────────────────────────────────────────────────
let botProc = null;
let botLogs = [];
let errorLogs = [];
let sessionStart = null;
let rotationCounts = { text1: 0, text2: 0, text3: 0, images: 0 };
let wsClients = new Set();

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
    data: { logs: botLogs.slice(-150), errorLogs: errorLogs.slice(-50) }
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

// ── Token Helpers ──────────────────────────────────────────────────
function extractTokens() {
  try {
    const raw = fs.readFileSync(PATHS.tokens, 'utf8');
    const match = raw.match(/tk:\s*\[([\s\S]*?)\]/m);
    if (!match) return [];
    return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  } catch { return []; }
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
    totalUptime: 0, sessions: [],
    rotationCounts: { text1: 0, text2: 0, text3: 0, images: 0 }
  });
}
function saveStats(extra = {}) {
  const saved = loadStats();
  const up = sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
  saved.totalUptime += up;
  if (extra.session) {
    saved.sessions.push(extra.session);
    if (saved.sessions.length > 50) saved.sessions = saved.sessions.slice(-50);
  }
  saved.rotationCounts = { ...saved.rotationCounts, ...rotationCounts };
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
  rotationCounts = { text1: 0, text2: 0, text3: 0, images: 0 };
  appendLog(`[Bot] Started — PID ${botProc.pid}`);
  broadcast('status', { running: true, pid: botProc.pid });

  botProc.stdout.on('data', d => {
    const line = String(d).trim();
    if (!line) return;
    const m = line.match(/\[ROT:(\w+)\]/);
    if (m) rotationCounts[m[1]] = (rotationCounts[m[1]] || 0) + 1;
    appendLog(line, false);
  });
  botProc.stderr.on('data', d => appendLog(`[ERR] ${String(d).trim()}`, true));
  botProc.on('exit', (code, signal) => {
    const up = sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
    appendLog(`[Bot] Exited — code=${code} signal=${signal||'none'} uptime=${up}s`, code !== 0 && code !== null);
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
    mode: 'real-script-execution',
    cookieAuth: false,
    lastLogs: botLogs.slice(-100)
  };
}

// ── Config Sanitize ────────────────────────────────────────────────
function sanitizePayload(config, tokens) {
  const safe = structuredClone(config);
  safe.setup = safe.setup || {};
  safe.config = safe.config || {};
  safe.setup.delay = Math.min(Math.max(Number(safe.setup.delay) || 10, 5), 120);
  safe.setup.city = String(safe.setup.city || '').slice(0, 80);
  ['text-1','text-2','text-3','bigimg','smallimg'].forEach(k => {
    safe.config[k] = Array.isArray(safe.config[k]) ? safe.config[k].map(x => String(x)).slice(0,150) : [];
  });
  safe.config.options = safe.config.options || {};
  safe.config.options['watch-url'] = Array.isArray(safe.config.options?.['watch-url'])
    ? safe.config.options['watch-url'].map(x => String(x)).slice(0,150) : [];
  ['button-1','button-2'].forEach(k => {
    const b = safe.config[k]?.[0] || { name:'', url:'' };
    safe.config[k] = [{ name: String(b.name||'').slice(0,64), url: String(b.url||'').slice(0,512) }];
  });
  // Human simulation settings — preserve as-is (already validated by UI)
  const ho = safe.config.options;
  ho.humanMode   = ho.humanMode   !== false;
  ho.humanJitter = Math.min(Math.max(Number(ho.humanJitter) || 0.25, 0.05), 0.5);
  ho.idleChance  = Math.min(Math.max(Number(ho.idleChance)  || 0.04, 0),    0.15);
  ho.idleMinSec  = Math.min(Math.max(Number(ho.idleMinSec)  || 60,   30),   300);
  ho.idleMaxSec  = Math.min(Math.max(Number(ho.idleMaxSec)  || 240,  60),   600);
  // Preserve spotify, customStatus
  if (safe.config.spotify)      safe.config.spotify      = safe.config.spotify;
  if (safe.config.customStatus) safe.config.customStatus = safe.config.customStatus;
  return { safe, cleanedTokens: tokens.map(t => String(t).trim()).filter(Boolean) };
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ── API: Settings ──────────────────────────────────────────────────
app.get('/api/settings', (_, res) => {
  res.json({ config: readJSON(PATHS.config), tokens: extractTokens(), runtime: runtimeStatus() });
});
app.post('/api/settings', (req, res) => {
  const { config, tokens } = req.body;
  if (!config || !Array.isArray(tokens)) return res.status(400).json({ error: 'invalid payload' });
  const { safe, cleanedTokens } = sanitizePayload(config, tokens);
  writeJSON(PATHS.config, safe);
  saveTokens(cleanedTokens);
  appendLog(`[Config] Saved — ${cleanedTokens.length} token(s)`);
  res.json({ ok: true });
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
  res.json({
    running: !!botProc, pid: botProc?.pid || null,
    sessionUptime: cur,
    totalUptime: saved.totalUptime + cur,
    sessions: saved.sessions.slice(-10),
    rotationCounts: { ...saved.rotationCounts, ...Object.fromEntries(Object.entries(rotationCounts).map(([k,v]) => [k, (saved.rotationCounts[k]||0)+v])) },
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
  appendLog(`[Schedule] ${enabled ? 'Enabled' : 'Disabled'} — ${startTime} → ${stopTime}`);
  res.json({ ok: true, schedule: s });
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
    hasWeatherKey: !!process.env.WEATHER_API_KEY,
    hasWebhook: !!(process.env.DISCORD_WEBHOOK && process.env.DISCORD_WEBHOOK.startsWith('http')),
    webhookUrl: process.env.DISCORD_WEBHOOK || '',
  });
});
app.post('/api/env', (req, res) => {
  const { weatherKey, webhookUrl } = req.body;
  let content = '';
  try { content = fs.readFileSync(PATHS.env, 'utf8'); } catch {}
  const lines = content.split('\n').filter(Boolean);
  const set = (k, v) => {
    const i = lines.findIndex(l => l.startsWith(`${k}=`));
    if (v) { if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`); }
    else if (i >= 0) lines.splice(i, 1);
  };
  if (weatherKey && !weatherKey.includes('•')) { set('WEATHER_API_KEY', weatherKey); process.env.WEATHER_API_KEY = weatherKey; }
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
  });
}, 5000);

// ── Init & Listen ──────────────────────────────────────────────────
ensureFile(PATHS.profiles, []);
ensureFile(PATHS.stats, { totalUptime: 0, sessions: [], rotationCounts: { text1: 0, text2: 0, text3: 0, images: 0 } });
ensureFile(PATHS.schedule, { enabled: false, startTime: '20:00', stopTime: '00:00', days: [0,1,2,3,4,5,6] });

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
});
