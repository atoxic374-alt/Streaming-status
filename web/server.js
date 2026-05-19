const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3210;
const CONFIG_PATH = path.join(__dirname, '..', 'setup', 'config.json');
const TOKENS_PATH = path.join(__dirname, '..', 'setup', 'starter.js');
const BOT_ENTRY = path.join(__dirname, '..', 'index.js');

let botProc = null;
let botLogs = [];

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function appendLog(line) {
  botLogs.push(`[${new Date().toISOString()}] ${line}`);
  if (botLogs.length > 500) botLogs = botLogs.slice(-500);
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function extractTokens() {
  const raw = fs.readFileSync(TOKENS_PATH, 'utf8');
  const match = raw.match(/tk:\s*\[([\s\S]*?)\]/m);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function saveTokens(tokens) {
  const raw = fs.readFileSync(TOKENS_PATH, 'utf8');
  const tokenBlock = `tk: [\n${tokens.map((t, i) => `        "${t}"${i < tokens.length - 1 ? ',' : ''}`).join('\n')}\n    ]`;
  const updated = raw.replace(/tk:\s*\[[\s\S]*?\]/m, tokenBlock);
  fs.writeFileSync(TOKENS_PATH, updated, 'utf8');
}

function sanitizePayload(config, tokens) {
  const safe = structuredClone(config);
  safe.setup = safe.setup || {};
  safe.config = safe.config || {};
  safe.setup.delay = Math.min(Math.max(Number(safe.setup.delay) || 10, 5), 120);
  safe.setup.city = String(safe.setup.city || '').slice(0, 80);

  ['text-1', 'text-2', 'text-3', 'bigimg', 'smallimg'].forEach((key) => {
    safe.config[key] = Array.isArray(safe.config[key]) ? safe.config[key].map((x) => String(x)).slice(0, 150) : [];
  });

  safe.config.options = safe.config.options || {};
  safe.config.options['watch-url'] = Array.isArray(safe.config.options['watch-url'])
    ? safe.config.options['watch-url'].map((x) => String(x)).slice(0, 150)
    : Array.isArray(safe.config['watch-url'])
      ? safe.config['watch-url'].map((x) => String(x)).slice(0, 150)
      : [];

  ['button-1', 'button-2'].forEach((key) => {
    const btn = safe.config[key]?.[0] || { name: '', url: '' };
    safe.config[key] = [{ name: String(btn.name || '').slice(0, 64), url: String(btn.url || '').slice(0, 512) }];
  });

  const cleanedTokens = tokens.map((t) => String(t).trim()).filter(Boolean);
  return { safe, cleanedTokens };
}

function runtimeStatus() {
  return {
    running: Boolean(botProc),
    pid: botProc?.pid || null,
    tokensConfigured: extractTokens().length,
    mode: 'real-script-execution',
    authMethod: 'token-based user auth from starter.js',
    cookieAuth: false,
    lastLogs: botLogs.slice(-100)
  };
}

app.get('/api/settings', (_, res) => {
  const config = readJSON(CONFIG_PATH);
  return res.json({ config, tokens: extractTokens(), runtime: runtimeStatus() });
});

app.get('/api/runtime', (_, res) => {
  return res.json(runtimeStatus());
});

app.post('/api/settings', (req, res) => {
  const { config, tokens } = req.body;
  if (!config || !Array.isArray(tokens)) return res.status(400).json({ error: 'invalid payload' });

  const { safe, cleanedTokens } = sanitizePayload(config, tokens);
  writeJSON(CONFIG_PATH, safe);
  saveTokens(cleanedTokens);
  appendLog(`settings persisted with ${cleanedTokens.length} token(s)`);
  return res.json({ ok: true, tokens: cleanedTokens.length });
});

app.post('/api/runtime/start', (_, res) => {
  if (botProc) return res.status(409).json({ error: 'already running', status: runtimeStatus() });

  botProc = spawn(process.execPath, [BOT_ENTRY], { cwd: path.join(__dirname, '..') });
  appendLog(`bot process started pid=${botProc.pid}`);

  botProc.stdout.on('data', (d) => appendLog(`stdout: ${String(d).trim()}`));
  botProc.stderr.on('data', (d) => appendLog(`stderr: ${String(d).trim()}`));
  botProc.on('exit', (code, signal) => {
    appendLog(`bot process exited code=${code} signal=${signal || 'none'}`);
    botProc = null;
  });

  return res.json({ ok: true, status: runtimeStatus() });
});

app.post('/api/runtime/stop', (_, res) => {
  if (!botProc) return res.status(409).json({ error: 'not running', status: runtimeStatus() });
  botProc.kill('SIGTERM');
  appendLog('stop signal sent');
  return res.json({ ok: true, status: runtimeStatus() });
});

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});
