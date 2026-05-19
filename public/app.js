'use strict';

// ── API Endpoints ──────────────────────────────────────────────────
const API = {
  settings:       '/api/settings',
  runtime:        '/api/runtime',
  start:          '/api/runtime/start',
  stop:           '/api/runtime/stop',
  validate:       '/api/tokens/validate',
  profiles:       '/api/profiles',
  stats:          '/api/stats',
  schedule:       '/api/schedule',
  webhookTest:    '/api/webhook/test',
  env:            '/api/env',
  logs:           '/api/logs',
  export:         '/api/export',
  import:         '/api/import',
};

// ── State ──────────────────────────────────────────────────────────
const S = {
  settings: null,
  rawTokens: [],
  tokenInfo: [],
  profiles: [],
  schedule: null,
  running: false,
  pid: null,
  sessionUptime: 0,
  rotationCounts: { text1: 0, text2: 0, text3: 0, images: 0 },
  section: 'overview',
  theme: localStorage.getItem('theme') || 'dark',
  lang: localStorage.getItem('lang') || 'en',
  analyticsData: null,
};

// ── Helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get  = url => fetch(url).then(r => r.json());
const del  = url => fetch(url, { method: 'DELETE' }).then(r => r.json());

function fmtUptime(sec) {
  if (!sec) return '00:00:00';
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}
function fmtUptimeLong(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  if (h >= 24) return `${Math.floor(h/24)}d ${h%24}h`;
  return `${h}h ${m}m`;
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Toast ──────────────────────────────────────────────────────────
function toast(msg, type = 'info', dur = 3000) {
  const box = $('toast');
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, dur);
}

// ── WebSocket ──────────────────────────────────────────────────────
let ws, wsRetry = 0;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => { wsRetry = 0; };

  ws.onmessage = ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'init':
        if (msg.data.logs) msg.data.logs.forEach(e => appendLog(e, false));
        if (msg.data.errorLogs) msg.data.errorLogs.forEach(e => appendErrLog(e));
        break;
      case 'log':     appendLog(msg.data, true); break;
      case 'status':  updateStatus(msg.data); break;
      case 'sysStats': updateSysStats(msg.data); break;
      case 'alert':   toast(msg.data.message, msg.data.type || 'error', 6000); break;
      case 'clearLogs': clearLogBoxes(); break;
    }
  };

  ws.onclose = () => {
    wsRetry++;
    setTimeout(connectWS, Math.min(1000 * wsRetry, 10000));
  };
}

// ── Log renderers ──────────────────────────────────────────────────
function appendLog(entry, broadcast = false) {
  ['overviewLog'].forEach(id => {
    const box = $(id);
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'log-entry' + (entry.error ? ' err' : '');
    const ts = new Date(entry.ts).toLocaleTimeString('en', { hour12: false });
    el.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(entry.text)}`;
    box.appendChild(el);
    if (box.children.length > 300) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  });
  updateLogCount();
  if (entry.error) appendErrLog(entry);
}
function appendErrLog(entry) {
  const box = $('errorLog');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'log-entry err';
  const ts = new Date(entry.ts).toLocaleTimeString('en', { hour12: false });
  el.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(entry.text)}`;
  box.appendChild(el);
  if (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
  const c = $('errCount'); if (c) c.textContent = box.children.length;
  const a = $('anErrors'); if (a) a.textContent = box.children.length;
}
function clearLogBoxes() {
  ['overviewLog', 'errorLog'].forEach(id => { const b = $(id); if (b) b.innerHTML = ''; });
  updateLogCount();
}
function updateLogCount() {
  const b = $('overviewLog');
  const c = $('logCount');
  if (b && c) c.textContent = `${b.children.length} entries`;
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Status updates ─────────────────────────────────────────────────
function updateStatus(data) {
  S.running = data.running;
  S.pid = data.pid || null;
  const dot = $('statusDot'), mDot = $('mobileStatusDot');
  const text = $('statusText');
  const pv = $('previewBadge');
  [dot, mDot].forEach(d => { if (d) d.classList.toggle('running', S.running); });
  if (text) text.textContent = S.running ? 'Running' : 'Stopped';
  if (pv) pv.style.display = S.running ? 'inline-flex' : 'none';
  if ($('ovPid')) $('ovPid').textContent = S.pid || '—';
  // Update token badges
  if ($('navTokenBadge')) $('navTokenBadge').textContent = S.rawTokens.length || '';
  if (data.exitCode !== undefined && data.exitCode !== 0 && data.exitCode !== null) {
    toast(`Bot stopped — exit code ${data.exitCode}`, 'error', 5000);
  }
}

function updateSysStats(d) {
  S.sessionUptime = d.sessionUptime || 0;
  S.rotationCounts = d.rotationCounts || S.rotationCounts;
  // Overview stats
  if ($('ovUptime')) $('ovUptime').textContent = fmtUptime(d.sessionUptime);
  if ($('ovRotations')) $('ovRotations').textContent = Object.values(d.rotationCounts||{}).reduce((a,b)=>a+b,0);
  // CPU/RAM bars
  setBar('cpuBar', 'cpuVal', d.cpu, '%');
  setBar('ramBar', 'ramVal', d.ram, '%');
  setBar('anCpuBar', 'anCpu', d.cpu, '%');
  setBar('anRamBar', 'anRam', d.ram, '%');
}

function setBar(barId, valId, pct, unit) {
  const bar = $(barId), val = $(valId);
  if (bar) bar.style.width = Math.min(pct, 100) + '%';
  if (val) val.textContent = pct + (unit || '');
  // Color shift for high usage
  if (bar) {
    bar.style.background = pct > 85 ? 'linear-gradient(90deg,#ef4444,#f97316)' :
                           pct > 60 ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : '';
  }
}

// ── Navigation ─────────────────────────────────────────────────────
function goTo(section) {
  S.section = section;
  document.querySelectorAll('.nav-item, .mnav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.section === section);
  });
  document.querySelectorAll('.section').forEach(el => {
    el.classList.toggle('active', el.id === `section-${section}`);
  });
  if (section === 'analytics') loadAnalytics();
  if (section === 'profiles') loadProfiles();
  if (section === 'schedule') loadSchedule();
  if (section === 'tokens') renderTokenCards();
}

// ── Theme ──────────────────────────────────────────────────────────
function applyTheme(t) {
  S.theme = t;
  localStorage.setItem('theme', t);
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.theme-opt').forEach(el => el.classList.toggle('active', el.dataset.t === t));
  const btn = $('themeBtn');
  if (btn) btn.innerHTML = t === 'dark'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

// ── Settings Load ──────────────────────────────────────────────────
async function loadSettings() {
  const data = await get(API.settings);
  S.settings = data;
  S.rawTokens = data.tokens || [];
  S.running = data.runtime?.running || false;
  S.pid = data.runtime?.pid || null;

  // Fill presence form
  const cfg = data.config?.config || {};
  const setup = data.config?.setup || {};
  const opts = cfg.options || {};

  $('watchUrls').value  = (opts['watch-url'] || []).join('\n');
  $('text1').value      = (cfg['text-1'] || []).join('\n');
  $('text2').value      = (cfg['text-2'] || []).join('\n');
  $('text3').value      = (cfg['text-3'] || []).join('\n');
  $('bigimg').value     = (cfg.bigimg || []).join('\n');
  $('smallimg').value   = (cfg.smallimg || []).join('\n');
  $('btn1Name').value   = cfg['button-1']?.[0]?.name || '';
  $('btn1Url').value    = cfg['button-1']?.[0]?.url || '';
  $('btn2Name').value   = cfg['button-2']?.[0]?.name || '';
  $('btn2Url').value    = cfg['button-2']?.[0]?.url || '';
  $('city').value       = setup.city || '';
  $('delay').value      = setup.delay || 10;
  $('tokenInput').value = S.rawTokens.join('\n');

  // Advanced
  const sp = cfg.spotify || {};
  const cs = cfg.customStatus || {};
  if ($('spotifyEnabled')) $('spotifyEnabled').checked = !!sp.enabled;
  if ($('spotifySong')) $('spotifySong').value = sp.song || '';
  if ($('spotifyArtist')) $('spotifyArtist').value = sp.artist || '';
  if ($('spotifyAlbum')) $('spotifyAlbum').value = sp.album || '';
  if ($('spotifyDuration')) $('spotifyDuration').value = sp.duration || 210;
  if ($('spotifyArt')) $('spotifyArt').value = sp.albumArtUrl || '';
  if ($('customStatusEnabled')) $('customStatusEnabled').checked = !!cs.enabled;
  if ($('customStatusText')) $('customStatusText').value = cs.text || '';
  if ($('customStatusEmoji')) $('customStatusEmoji').value = cs.emoji || '';
  if ($('timestampMode')) $('timestampMode').value = opts.timestamp || '{start}';

  // Human simulation settings
  const humanOn = opts.humanMode !== false;
  const jitterPct = Math.round((opts.humanJitter ?? 0.25) * 100);
  const idlePct   = Math.round((opts.idleChance  ?? 0.04) * 100);
  if ($('humanModeEnabled')) $('humanModeEnabled').checked = humanOn;
  if ($('humanJitter'))      { $('humanJitter').value = jitterPct; }
  if ($('humanJitterVal'))   $('humanJitterVal').textContent = jitterPct + '%';
  if ($('idleChance'))       { $('idleChance').value = idlePct; }
  if ($('idleChanceVal'))    $('idleChanceVal').textContent = idlePct + '%';
  if ($('idleMinSec'))       $('idleMinSec').value = opts.idleMinSec ?? 60;
  if ($('idleMaxSec'))       $('idleMaxSec').value = opts.idleMaxSec ?? 240;

  // Status
  updateStatus(data.runtime || {});
  renderPreview();
  updateNavBadges();
}

async function loadEnv() {
  const d = await get(API.env);
  if ($('webhookUrl')) $('webhookUrl').value = d.webhookUrl || '';
  if ($('weatherKey')) $('weatherKey').placeholder = d.hasWeatherKey ? '••••••••••••••••' : 'Your WeatherAPI key...';
}

function updateNavBadges() {
  const tb = $('navTokenBadge');
  if (tb) { tb.textContent = S.rawTokens.length || ''; tb.style.display = S.rawTokens.length ? '' : 'none'; }
}

// ── Token Validate & Cards ─────────────────────────────────────────
async function validateTokens(tokens) {
  if (!tokens.length) return [];
  return await post(API.validate, { tokens });
}

async function renderTokenCards() {
  const grid = $('tokenCards');
  if (!grid) return;

  const tokens = S.rawTokens;
  if (!tokens.length) {
    grid.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg><p>No tokens configured yet</p></div>`;
    return;
  }

  // Show loading state first
  grid.innerHTML = tokens.map((t, i) => `
    <div class="token-card" id="tcard-${i}">
      <div class="token-card-shine"></div>
      <div class="token-card-header">
        <div class="token-avatar-wrap">
          <div class="token-avatar" style="display:flex;align-items:center;justify-content:center;font-size:20px">⏳</div>
          <div class="token-status-ring offline"></div>
        </div>
        <div>
          <div class="token-name">Validating...</div>
          <div class="token-tag">Checking token #${i + 1}</div>
        </div>
      </div>
      <div class="token-masked">${maskDisplay(t)}</div>
      <div class="token-actions">
        <button class="btn btn-outline" disabled>Loading...</button>
      </div>
    </div>`).join('');

  // Validate in background
  const results = await validateTokens(tokens);
  S.tokenInfo = results;

  results.forEach((info, i) => {
    const card = $(`tcard-${i}`);
    if (!card) return;

    const isValid = info.valid;
    card.className = `token-card ${isValid ? 'valid' : 'invalid'}`;

    card.innerHTML = `
      <div class="token-card-shine"></div>
      <div class="token-card-header">
        <div class="token-avatar-wrap">
          ${isValid && info.avatar
            ? `<img class="token-avatar" src="${info.avatar}" alt="${info.username}" onerror="this.style.display='none'">`
            : `<div class="token-avatar" style="display:flex;align-items:center;justify-content:center;font-size:22px;background:var(--bg-input)">${isValid ? '👤' : '❌'}</div>`}
          <div class="token-status-ring ${isValid ? 'online' : 'error'}"></div>
        </div>
        <div style="min-width:0">
          <div class="token-name">${isValid ? escHtml(info.username || 'Unknown User') : 'Invalid Token'}</div>
          <div class="token-tag">${isValid ? escHtml(info.tag || info.id || '') : escHtml(info.error || 'Authentication failed')}</div>
          ${isValid && info.nitro ? `<span class="token-badge nitro">✨ Nitro</span>` : ''}
        </div>
      </div>
      <div class="token-masked">${escHtml(info.masked || maskDisplay(tokens[i]))}</div>
      <div class="token-actions">
        ${isValid
          ? `<button class="btn btn-success" onclick="copyToken(${i})" style="font-size:10px">Copy</button>`
          : `<span class="badge badge-danger" style="font-size:10px">Invalid</span>`}
        <button class="btn btn-outline" onclick="removeToken(${i})" style="font-size:10px">Remove</button>
      </div>`;
  });

  $('ovTokens').textContent = results.filter(r => r.valid).length;
  updateNavBadges();
}

function maskDisplay(t) {
  if (!t) return '••••';
  const parts = t.split('.');
  if (parts.length >= 2) return `${parts[0]}.••••••••••••••`;
  return t.slice(0, 8) + '••••••••••••••••';
}

function copyToken(i) {
  navigator.clipboard.writeText(S.rawTokens[i]).then(() => toast('Token copied!', 'success'));
}

function removeToken(i) {
  S.rawTokens.splice(i, 1);
  $('tokenInput').value = S.rawTokens.join('\n');
  renderTokenCards();
}

// ── Presence save ──────────────────────────────────────────────────
async function savePresence() {
  if (!S.settings) return;
  const toLines = v => v.split('\n').map(x => x.trim()).filter(Boolean);
  const cfg = structuredClone(S.settings.config || {});
  cfg.setup = cfg.setup || {};
  cfg.config = cfg.config || {};
  cfg.config.options = cfg.config.options || {};

  cfg.setup.city    = $('city').value.trim();
  cfg.setup.delay   = Number($('delay').value) || 10;
  cfg.config.options['watch-url'] = toLines($('watchUrls').value);
  cfg.config.options.timestamp    = $('timestampMode')?.value || '{start}';
  cfg.config['text-1']   = toLines($('text1').value);
  cfg.config['text-2']   = toLines($('text2').value);
  cfg.config['text-3']   = toLines($('text3').value);
  cfg.config.bigimg      = toLines($('bigimg').value);
  cfg.config.smallimg    = toLines($('smallimg').value);
  cfg.config['button-1'] = [{ name: $('btn1Name').value.trim(), url: $('btn1Url').value.trim() }];
  cfg.config['button-2'] = [{ name: $('btn2Name').value.trim(), url: $('btn2Url').value.trim() }];

  // Advanced
  cfg.config.spotify = {
    enabled: $('spotifyEnabled')?.checked || false,
    song: $('spotifySong')?.value.trim() || '',
    artist: $('spotifyArtist')?.value.trim() || '',
    album: $('spotifyAlbum')?.value.trim() || '',
    duration: Number($('spotifyDuration')?.value) || 210,
    albumArtUrl: $('spotifyArt')?.value.trim() || '',
  };
  cfg.config.customStatus = {
    enabled: $('customStatusEnabled')?.checked || false,
    text: $('customStatusText')?.value.trim() || '',
    emoji: $('customStatusEmoji')?.value.trim() || '',
  };

  // Human simulation / anti-detection
  cfg.config.options.humanMode    = $('humanModeEnabled')?.checked !== false;
  cfg.config.options.humanJitter  = (Number($('humanJitter')?.value) || 25) / 100;
  cfg.config.options.idleChance   = (Number($('idleChance')?.value) || 4) / 100;
  cfg.config.options.idleMinSec   = Number($('idleMinSec')?.value) || 60;
  cfg.config.options.idleMaxSec   = Number($('idleMaxSec')?.value) || 240;

  const r = await post(API.settings, { config: cfg, tokens: S.rawTokens });
  if (r.ok) { toast('Settings saved!', 'success'); S.settings.config = cfg; }
  else toast('Save failed: ' + (r.error || 'unknown'), 'error');
}

async function saveTokens() {
  const lines = $('tokenInput').value.split('\n').map(t => t.trim()).filter(Boolean);
  S.rawTokens = lines;
  if (!S.settings) await loadSettings();
  const r = await post(API.settings, { config: S.settings?.config || {}, tokens: lines });
  if (r.ok) { toast('Tokens saved!', 'success'); updateNavBadges(); renderTokenCards(); }
  else toast('Save failed', 'error');
}

// ── Live Preview ───────────────────────────────────────────────────
function renderPreview() {
  const toLines = v => (v || '').split('\n').map(x => x.trim()).filter(Boolean);
  const t1 = toLines($('text1')?.value)[0] || '—';
  const t2 = toLines($('text2')?.value)[0] || '—';
  const t3 = toLines($('text3')?.value)[0] || '—';
  const b1 = $('btn1Name')?.value || 'Button 1';
  const b2 = $('btn2Name')?.value || 'Button 2';

  ['pvText1','pvText1b'].forEach(id => { const el=$(id); if(el) el.textContent = t1; });
  ['pvText2','pvText2b'].forEach(id => { const el=$(id); if(el) el.textContent = t2; });
  ['pvText3','pvText3b'].forEach(id => { const el=$(id); if(el) el.textContent = t3; });
  ['pvBtn1','pvBtn1b'].forEach(id => { const el=$(id); if(el) el.textContent = b1; });
  ['pvBtn2','pvBtn2b'].forEach(id => { const el=$(id); if(el) el.textContent = b2; });
}

// ── Profiles ───────────────────────────────────────────────────────
async function loadProfiles() {
  S.profiles = await get(API.profiles);
  renderProfiles();
  const badge = $('navProfileBadge');
  if (badge) { badge.textContent = S.profiles.length || ''; badge.style.display = S.profiles.length ? '' : 'none'; }
}

function renderProfiles() {
  const grid = $('profilesGrid');
  if (!grid) return;
  const empty = $('profilesEmpty');

  if (!S.profiles.length) {
    if (empty) empty.style.display = '';
    const existing = grid.querySelectorAll('.profile-card');
    existing.forEach(e => e.remove());
    return;
  }
  if (empty) empty.style.display = 'none';
  const existing = grid.querySelectorAll('.profile-card');
  existing.forEach(e => e.remove());

  S.profiles.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.style.animationDelay = `${i * 50}ms`;
    card.innerHTML = `
      <div class="profile-name">${escHtml(p.name)}</div>
      <div class="profile-date">Saved ${fmtDate(p.createdAt)}</div>
      <div class="profile-actions">
        <button class="btn btn-primary" onclick="applyProfile('${p.id}')">Apply</button>
        <button class="btn btn-outline" onclick="deleteProfile('${p.id}')">Delete</button>
      </div>`;
    grid.insertBefore(card, $('profilesEmpty'));
  });
}

async function applyProfile(id) {
  const r = await post(`${API.profiles}/${id}/apply`, {});
  if (r.ok) { toast('Profile applied!', 'success'); await loadSettings(); }
  else toast('Failed: ' + (r.error || ''), 'error');
}

async function deleteProfile(id) {
  const r = await del(`${API.profiles}/${id}`);
  if (r.ok) { toast('Profile deleted', 'info'); await loadProfiles(); }
  else toast('Delete failed', 'error');
}

async function saveCurrentProfile() {
  const name = $('profileNameInput')?.value.trim();
  if (!name) { toast('Please enter a profile name', 'error'); return; }
  if (!S.settings) return;
  const r = await post(API.profiles, { name, config: S.settings.config });
  if (r.ok) {
    toast(`Profile "${name}" saved!`, 'success');
    $('profileNameInput').value = '';
    $('saveProfilePanel').style.display = 'none';
    await loadProfiles();
  } else toast('Save failed', 'error');
}

// ── Schedule ───────────────────────────────────────────────────────
async function loadSchedule() {
  S.schedule = await get(API.schedule);
  const s = S.schedule;
  if ($('schedEnabled')) $('schedEnabled').checked = !!s.enabled;
  if ($('schedStart')) $('schedStart').value = s.startTime || '20:00';
  if ($('schedStop')) $('schedStop').value = s.stopTime || '00:00';

  const days = s.days || [0,1,2,3,4,5,6];
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('active', days.includes(Number(btn.dataset.day)));
  });

  updateSchedBadge(s.enabled);
  renderSchedInfo(s);
}

function renderSchedInfo(s) {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const days = s.days || [0,1,2,3,4,5,6];
  const now = new Date();

  let nextStart = '—', nextStop = '—';
  if (s.enabled && s.startTime) {
    const [sh, sm] = s.startTime.split(':').map(Number);
    for (let d = 0; d < 7; d++) {
      const day = (now.getDay() + d) % 7;
      if (!days.includes(day)) continue;
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + d);
      candidate.setHours(sh, sm, 0, 0);
      if (candidate > now) { nextStart = fmtDateTime(candidate.toISOString()); break; }
    }
    const [eh, em] = s.stopTime.split(':').map(Number);
    for (let d = 0; d < 7; d++) {
      const day = (now.getDay() + d) % 7;
      if (!days.includes(day)) continue;
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + d);
      candidate.setHours(eh, em, 0, 0);
      if (candidate > now) { nextStop = fmtDateTime(candidate.toISOString()); break; }
    }
  }

  if ($('nextStart')) $('nextStart').textContent = nextStart;
  if ($('nextStop')) $('nextStop').textContent = nextStop;
}

async function saveSchedule() {
  const activeDays = [...document.querySelectorAll('.day-btn.active')].map(b => Number(b.dataset.day));
  const data = {
    enabled: $('schedEnabled').checked,
    startTime: $('schedStart').value,
    stopTime: $('schedStop').value,
    days: activeDays,
  };
  const r = await post(API.schedule, data);
  if (r.ok) {
    S.schedule = data;
    toast('Schedule saved!', 'success');
    updateSchedBadge(data.enabled);
    renderSchedInfo(data);
  } else toast('Save failed', 'error');
}

function updateSchedBadge(enabled) {
  const dot = $('navSchedBadge');
  if (dot) dot.style.display = enabled ? '' : 'none';
}

// ── Analytics ──────────────────────────────────────────────────────
async function loadAnalytics() {
  const d = await get(API.stats);
  S.analyticsData = d;

  if ($('anTotalUptime')) $('anTotalUptime').textContent = fmtUptimeLong(d.totalUptime || 0);
  if ($('anSessions')) $('anSessions').textContent = (d.sessions || []).length;
  if ($('anErrors')) $('anErrors').textContent = d.errorCount || 0;

  const rot = d.rotationCounts || {};
  const maxRot = Math.max(1, ...Object.values(rot));
  if ($('anText2Rot')) $('anText2Rot').textContent = Object.values(rot).reduce((a, b) => a + b, 0);

  if ($('anT1')) $('anT1').textContent = rot.text1 || 0;
  if ($('anT2')) $('anT2').textContent = rot.text2 || 0;
  if ($('anImg')) $('anImg').textContent = rot.images || 0;
  if ($('anT1Bar')) $('anT1Bar').style.width = Math.floor((rot.text1 || 0) / maxRot * 100) + '%';
  if ($('anT2Bar')) $('anT2Bar').style.width = Math.floor((rot.text2 || 0) / maxRot * 100) + '%';
  if ($('anImgBar')) $('anImgBar').style.width = Math.floor((rot.images || 0) / maxRot * 100) + '%';

  setBar('anCpuBar', 'anCpu', d.cpu || 0, '%');
  setBar('anRamBar', 'anRam', d.ram || 0, '%');
  if ($('anRamDetail')) $('anRamDetail').textContent = `${d.ramUsed || 0} GB / ${d.ramTotal || 0} GB`;

  // Session history
  const list = $('sessionHistory');
  if (list) {
    const sessions = (d.sessions || []).reverse();
    if (!sessions.length) {
      list.innerHTML = '<div class="empty-state" style="padding:20px"><p>No sessions recorded yet</p></div>';
    } else {
      list.innerHTML = sessions.map(s => {
        const ok = s.exitCode === 0 || s.exitCode === null;
        return `<div class="session-item">
          <div class="session-dot ${ok ? 'session-ok' : 'session-err'}"></div>
          <span class="session-ts">${fmtDateTime(new Date(s.start).toISOString())}</span>
          <span class="session-dur">${fmtUptimeLong(s.uptime || 0)}</span>
          <span class="badge ${ok ? 'badge-success' : 'badge-danger'}" style="font-size:10px">${ok ? 'Clean' : `Exit ${s.exitCode}`}</span>
        </div>`;
      }).join('');
    }
  }
}

// ── Presets ────────────────────────────────────────────────────────
const PRESETS = [
  {
    name: '🎮 Gaming Stream',
    desc: 'Classic gaming streaming setup with rotating game info',
    data: {
      'text-1': ['{NF3( 〈 {emoji:time} {hour:1}:{min:1} 〉 )}'],
      'text-2': ['🎮 In-game right now...', '🕹️ Grinding ranked...', '⚔️ On the battlefield...'],
      'text-3': ['★ Gaming Stream ★'],
    }
  },
  {
    name: '🌙 Night Vibes',
    desc: 'Aesthetic late-night chill stream aesthetic',
    data: {
      'text-1': ['{NF5( ✦ {hour:1}:{min:1} night vibes ✦ )}'],
      'text-2': ['🌙 Late night session...', '☕ Coffee & streams...', '✨ Can\'t sleep streaming...'],
      'text-3': ['◈ stay cozy ◈'],
    }
  },
  {
    name: '💻 Coding Live',
    desc: 'Developer stream with CPU & uptime display',
    data: {
      'text-1': ['{NF3(Coding Session — {uptime:hours}h {uptime:minutes}m)}'],
      'text-2': ['💻 Writing code live...', '🐛 Debugging sessions...', '🚀 Building in public...'],
      'text-3': ['CPU: {cpu:usage}% | RAM: {ram:usage}%'],
    }
  },
  {
    name: '🌤️ Weather & Time',
    desc: 'Dynamic weather and time display in presence',
    data: {
      'text-1': ['{emoji:time} {hour:1}:{min:1} • {city}'],
      'text-2': ['🌡️ {temp:c}°C / {temp:f}°F', '💨 Wind: {wind:kph} km/h', '💧 Humidity: {humidity}%'],
      'text-3': ['☀️ Real-time weather info'],
    }
  },
  {
    name: '🎵 Music & Chill',
    desc: 'Music-focused stream aesthetic',
    data: {
      'text-1': ['{NF4(♪ now streaming ♪)}'],
      'text-2': ['🎵 Lost in the music...', '🎶 Vibing right now...', '🎧 Full audio mode...'],
      'text-3': ['𝄞 Stream & Chill 𝄞'],
    }
  },
  {
    name: '📊 System Monitor',
    desc: 'Show real-time system resource info',
    data: {
      'text-1': ['⚡ CPU: {cpu:usage}% | RAM: {ram:usage}%'],
      'text-2': ['{cpu:name}', '🔄 Ping: {ping}ms', '⏱ Up: {uptime:hours}h {uptime:minutes}m'],
      'text-3': ['System Monitoring Mode'],
    }
  },
];

function renderPresets() {
  const grid = $('presetsGrid');
  if (!grid) return;
  grid.innerHTML = PRESETS.map((p, i) => `
    <div class="preset-card" onclick="applyPreset(${i})">
      <div class="preset-name">${p.name}</div>
      <div class="preset-desc">${escHtml(p.desc)}</div>
    </div>`).join('');
}

function applyPreset(i) {
  const p = PRESETS[i];
  if ($('text1')) $('text1').value = (p.data['text-1'] || []).join('\n');
  if ($('text2')) $('text2').value = (p.data['text-2'] || []).join('\n');
  if ($('text3')) $('text3').value = (p.data['text-3'] || []).join('\n');
  renderPreview();
  toast(`Preset "${p.name}" loaded!`, 'success');
  // Switch to basic tab
  switchTab('basic');
}

// ── Tab switching ──────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
}

// ── Export / Import ────────────────────────────────────────────────
async function exportConfig() {
  const d = await get(API.export);
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `streamdash-config-${Date.now()}.json`;
  a.click();
  toast('Config exported!', 'success');
}

async function importConfig(file) {
  if (!file) return;
  try {
    const txt = await file.text();
    const data = JSON.parse(txt);
    const r = await post(API.import, data);
    if (r.ok) { toast('Config imported!', 'success'); await loadSettings(); }
    else toast('Import failed', 'error');
  } catch (e) { toast('Invalid JSON file', 'error'); }
}

// ── Webhook ────────────────────────────────────────────────────────
async function testWebhook() {
  const url = $('webhookUrl')?.value.trim();
  if (!url) { toast('Enter a webhook URL first', 'error'); return; }
  const btn = $('testWebhookBtn');
  btn.textContent = 'Sending...'; btn.disabled = true;
  const r = await post(API.webhookTest, { url });
  btn.textContent = 'Test Connection'; btn.disabled = false;
  if (r.ok) toast('Webhook test sent! Check Discord.', 'success');
  else toast('Webhook failed: ' + (r.error || 'unknown'), 'error');
}

async function saveWebhook() {
  const url = $('webhookUrl')?.value.trim();
  const r = await post(API.env, { webhookUrl: url });
  if (r.ok) toast('Webhook saved!', 'success');
  else toast('Save failed', 'error');
}

async function saveWeatherKey() {
  const key = $('weatherKey')?.value.trim();
  if (!key || key.includes('•')) { toast('Enter a valid API key', 'error'); return; }
  const r = await post(API.env, { weatherKey: key });
  if (r.ok) { toast('Weather API key saved!', 'success'); $('weatherKey').value = ''; $('weatherKey').placeholder = '••••••••••••••••'; }
  else toast('Save failed', 'error');
}

// ── Uptime ticker ──────────────────────────────────────────────────
setInterval(() => {
  if (S.running) {
    S.sessionUptime++;
    if ($('ovUptime')) $('ovUptime').textContent = fmtUptime(S.sessionUptime);
  }
}, 1000);

// ── Event Wiring ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Theme
  applyTheme(S.theme);

  // Navigation (sidebar + mobile)
  document.querySelectorAll('.nav-item, .mnav-item').forEach(el => {
    el.addEventListener('click', () => goTo(el.dataset.section));
  });

  // Theme button
  $('themeBtn')?.addEventListener('click', () => applyTheme(S.theme === 'dark' ? 'light' : 'dark'));

  // Theme opts in settings
  document.querySelectorAll('.theme-opt[data-t]').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.t));
  });

  // Language
  document.querySelectorAll('.theme-opt[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.lang = btn.dataset.lang;
      localStorage.setItem('lang', S.lang);
      document.documentElement.lang = S.lang;
      document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
      document.querySelectorAll('.theme-opt[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === S.lang));
      toast(S.lang === 'ar' ? 'تم تغيير اللغة' : 'Language changed', 'info');
    });
  });

  // Start / Stop
  $('startBtn')?.addEventListener('click', async () => {
    const r = await post(API.start, {});
    if (r.ok || r.status) toast('Bot starting...', 'info');
    else toast(r.error || 'Already running', 'error');
  });
  $('stopBtn')?.addEventListener('click', async () => {
    const r = await post(API.stop, {});
    if (r.ok) toast('Stop signal sent', 'info');
    else toast(r.error || 'Not running', 'error');
  });

  // Tokens section
  $('validateAllBtn')?.addEventListener('click', () => renderTokenCards());
  $('saveTokensBtn')?.addEventListener('click', saveTokens);
  $('testNewTokensBtn')?.addEventListener('click', async () => {
    const tokens = $('tokenInput').value.split('\n').map(t => t.trim()).filter(Boolean);
    if (!tokens.length) { toast('No tokens to validate', 'error'); return; }
    S.rawTokens = tokens;
    goTo('tokens');
    renderTokenCards();
  });

  // Presence
  $('savePresenceBtn')?.addEventListener('click', savePresence);
  ['text1','text2','text3','btn1Name','btn2Name','watchUrls'].forEach(id => {
    $(id)?.addEventListener('input', renderPreview);
  });

  // Human simulation sliders — live value display
  $('humanJitter')?.addEventListener('input', function() {
    if ($('humanJitterVal')) $('humanJitterVal').textContent = this.value + '%';
  });
  $('idleChance')?.addEventListener('input', function() {
    if ($('idleChanceVal')) $('idleChanceVal').textContent = this.value + '%';
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Profiles
  $('saveProfileBtn')?.addEventListener('click', () => {
    const panel = $('saveProfilePanel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  $('confirmSaveProfile')?.addEventListener('click', saveCurrentProfile);

  // Schedule
  $('saveScheduleBtn')?.addEventListener('click', saveSchedule);
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // Analytics
  $('refreshStatsBtn')?.addEventListener('click', loadAnalytics);
  $('clearErrBtn')?.addEventListener('click', async () => {
    await del(API.logs);
    $('errorLog').innerHTML = '';
    $('errCount').textContent = '0';
    toast('Logs cleared', 'info');
  });

  // Settings
  $('testWebhookBtn')?.addEventListener('click', testWebhook);
  $('saveWebhookBtn')?.addEventListener('click', saveWebhook);
  $('saveWeatherBtn')?.addEventListener('click', saveWeatherKey);
  $('exportBtn')?.addEventListener('click', exportConfig);
  $('importFile')?.addEventListener('change', e => importConfig(e.target.files[0]));

  // Clear logs
  $('clearLogsBtn')?.addEventListener('click', async () => {
    await del(API.logs);
    clearLogBoxes();
    toast('Logs cleared', 'info');
  });

  // Mobile menu
  $('menuBtn')?.addEventListener('click', () => {
    $('sidebar').classList.toggle('open');
  });

  // Mobile: close sidebar on nav click
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => $('sidebar')?.classList.remove('open'));
  });

  // Presets
  renderPresets();

  // Language init
  if (S.lang === 'ar') {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    document.querySelectorAll('.theme-opt[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === 'ar'));
  }

  // Load data
  await Promise.all([loadSettings(), loadEnv()]);
  connectWS();

  // Auto-refresh analytics if on that section
  setInterval(() => { if (S.section === 'analytics') loadAnalytics(); }, 10000);
});
