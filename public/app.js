'use strict';

// ── Upload busy lock — blocks Start until all uploads complete ─────
let _uploadsBusy = 0;

// delta: +1 lock / -1 unlock
// current, total: optional progress counters (e.g. 3, 10 → "Uploading 3 of 10…")
function setUploadBusy(delta, current = 0, total = 0) {
  _uploadsBusy = Math.max(0, _uploadsBusy + delta);
  const btn    = $('startBtn');
  const notice = $('uploadBusyNotice');
  const text   = $('uploadBusyText');
  if (!btn) return;
  if (_uploadsBusy > 0) {
    btn.disabled = true;
    btn.classList.add('upload-busy');
    btn.setAttribute('title', 'Waiting for images to finish uploading…');
    if (text) {
      text.textContent = (total > 1 && current > 0)
        ? `Uploading ${current} of ${total}…`
        : 'Uploading image…';
    }
    if (notice) notice.style.display = 'flex';
  } else {
    btn.disabled = false;
    btn.classList.remove('upload-busy');
    btn.removeAttribute('title');
    if (notice) notice.style.display = 'none';
    if (text) text.textContent = 'Uploading images…';
  }
}

// ── Resolve MIME type — fallback to extension for GIF/etc ─────────
function guessMime(file) {
  if (file.type && file.type.startsWith('image/')) return file.type;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return (
    { gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg',
      jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' }[ext] || ''
  );
}

// ── API Endpoints ──────────────────────────────────────────────────
const API = {
  settings:    '/api/settings',
  runtime:     '/api/runtime',
  start:       '/api/runtime/start',
  stop:        '/api/runtime/stop',
  refresh:     '/api/runtime/refresh',
  validate:    '/api/tokens/validate',
  profiles:    '/api/profiles',
  stats:       '/api/stats',
  schedule:    '/api/schedule',
  webhookTest: '/api/webhook/test',
  env:         '/api/env',
  logs:        '/api/logs',
  export:      '/api/export',
  import:      '/api/import',
  ratelimits:  '/api/ratelimits',
  upload:      '/api/uploads',
  checkImages: '/api/uploads/check',
  emojis:      '/api/emojis',
};

// ── State ──────────────────────────────────────────────────────────
const S = {
  settings:       null,
  rawTokens:      [],
  tokenInfo:      [],
  profiles:       [],
  schedule:       null,
  running:        false,
  pid:            null,
  sessionUptime:  0,
  rotationCounts: { text1: 0, text2: 0, text3: 0, text4: 0, images: 0, customStatus: 0, spotify: 0, url: 0 },
  section:        'overview',
  theme:          localStorage.getItem('theme') || 'dark',
  lang:           localStorage.getItem('lang')  || 'en',
  analyticsData:  null,
  lastCpu:        0,
  lastRam:        0,
  previewText1Idx:0,
  previewText2Idx:0,
  previewText3Idx:0,
  previewText4Idx:0,
  previewImageIdx:0,
  previewTimer:   null,
  account:        null,
  livePresence:   null,
  // In-memory field store (edited via popup)
  fields: {
    text1: [], text2: [], text3: [], text4: [],
    bigimg: [], smallimg: [],
  },
  customStatus: {
    enabled: false,
    intervalSec: 300,
    messages: [],
  },
  emojis: [],
  emojiPage: 0,
  activeCsIndex: 0,
  spotify: {
    enabled: false,
    tracks: [],
    activeTrack: 0,
  },
  _editingField: null,
};

// ── Chart & Compare State ───────────────────────────────────────────
let compareIds   = [];
let _chartRot    = null;
let _chartSess   = null;

// ── Field Config (popup editor metadata) ───────────────────────────
const FIELD_CONFIG = {
  text1:       { label: 'Details',      hint: 'Shown as the main activity details',               type: 'lines', rows: 2 },
  text2:       { label: 'State',        hint: 'Shown as the secondary activity line',             type: 'lines', rows: 4 },
  text3:       { label: 'Large Hover',  hint: 'Hover text for the large activity image',          type: 'lines', rows: 2 },
  text4:       { label: 'Small Hover',  hint: 'Hover text for the small activity image',          type: 'lines', rows: 2 },
  bigimg:      { label: 'Large Image',  hint: 'Activity asset image',                             type: 'lines', rows: 3 },
  smallimg:    { label: 'Small Image',  hint: 'Small activity image',                             type: 'lines', rows: 2 },
  spotifySong:   { label: 'Song Name',  hint: 'Track title shown in Discord',   type: 'text' },
  spotifyArtist: { label: 'Artist',     hint: 'Artist name',                     type: 'text' },
  spotifyAlbum:  { label: 'Duration',   hint: 'Full song length in seconds',     type: 'text' },
  spotifyArt:    { label: 'Song Art',   hint: 'Paste an image URL or attach one from the song list', type: 'text' },
};

function emptySpotifyTrack() {
  return { song: '', artist: '', duration: 210, albumArtUrl: '' };
}

function normalizeSpotifyConfig(sp = {}) {
  const legacy = (sp.song || sp.artist || sp.albumArtUrl)
    ? [{ song: sp.song || '', artist: sp.artist || '', duration: sp.duration || 210, albumArtUrl: sp.albumArtUrl || '' }]
    : [];
  const rawTracks = Array.isArray(sp.tracks) && sp.tracks.length ? sp.tracks : legacy;
  const tracks = rawTracks.map(track => ({
    song: String(track?.song || ''),
    artist: String(track?.artist || ''),
    duration: Math.max(Number(track?.duration) || 210, 10),
    albumArtUrl: String(track?.albumArtUrl || ''),
    albumArtId: String(track?.albumArtId || ''),
    songId: String(track?.songId || ''),
    albumId: String(track?.albumId || ''),
    artistIds: track?.artistIds || '',
  })).filter(track => track.song || track.artist || track.albumArtUrl);

  return {
    enabled: !!sp.enabled,
    tracks: tracks.length ? tracks : [emptySpotifyTrack()],
    activeTrack: 0,
  };
}

function activeSpotifyTrack(create = true) {
  if (!Array.isArray(S.spotify.tracks)) S.spotify.tracks = [];
  if (!S.spotify.tracks.length && create) S.spotify.tracks.push(emptySpotifyTrack());
  S.spotify.activeTrack = Math.max(0, Math.min(S.spotify.activeTrack || 0, Math.max(S.spotify.tracks.length - 1, 0)));
  return S.spotify.tracks[S.spotify.activeTrack] || null;
}

function serializeSpotifyConfig() {
  const tracks = (S.spotify.tracks || [])
    .map(track => ({
      song: (track.song || '').trim(),
      artist: (track.artist || '').trim(),
      duration: Math.max(Number(track.duration) || 210, 10),
      albumArtUrl: (track.albumArtUrl || '').trim(),
      albumArtId: (track.albumArtId || '').trim(),
      songId: (track.songId || '').trim(),
      albumId: (track.albumId || '').trim(),
      artistIds: track.artistIds || '',
    }))
    .filter(track => track.song || track.artist || track.albumArtUrl);
  const first = tracks[0] || emptySpotifyTrack();
  return {
    enabled: $('spotifyEnabled')?.checked || false,
    tracks,
    song: first.song || '',
    artist: first.artist || '',
    duration: first.duration || 210,
    albumArtUrl: first.albumArtUrl || '',
  };
}

// ── Inline Edit Popup ───────────────────────────────────────────────
function openEditPopup(field, el) {
  const cfg = FIELD_CONFIG[field];
  if (!cfg) return;

  S._editingField = field;
  const popup = $('editPopup');
  const input  = $('epInput');
  const subs   = $('epSubFields');
  const overlay = $('editOverlay');

  $('epLabel').textContent = cfg.label;
  $('epHint').textContent  = cfg.hint || '';

  if (cfg.type === 'button') {
    const btn = S.fields[field] || { name: '', url: '' };
    input.style.display = 'none';
    subs.style.display  = 'flex';
    subs.innerHTML = `
      <input class="ep-sub" id="epBtnName" placeholder="Button label" value="${escHtml(btn.name || '')}"/>
      <input class="ep-sub" id="epBtnUrl"  placeholder="https://..." value="${escHtml(btn.url  || '')}"/>`;
    const sync = () => {
      S.fields[field] = { name: $('epBtnName')?.value || '', url: $('epBtnUrl')?.value || '' };
      renderPreview();
    };
    setTimeout(() => {
      $('epBtnName')?.addEventListener('input', sync);
      $('epBtnUrl')?.addEventListener('input', sync);
      $('epBtnName')?.focus();
    }, 30);
  } else if (cfg.type === 'text') {
    // Spotify single-line fields
    input.style.display = '';
    subs.style.display  = 'none';
    input.rows = 1;
    const key = field.replace('spotify', '').toLowerCase();
    const spKey = { song:'song', artist:'artist', art:'albumArtUrl' }[key] || key;
    const track = activeSpotifyTrack(true);
    input.value = track?.[spKey] || '';
    input.oninput = () => {
      const current = activeSpotifyTrack(true);
      if (current) current[spKey] = input.value;
      renderSpotifyPreview();
      renderSpotifyTrackRows();
    };
    setTimeout(() => input.focus(), 30);
  } else {
    // lines type
    input.style.display = '';
    subs.style.display  = 'none';
    input.rows = cfg.rows || 3;
    const val = S.fields[field];
    input.value = Array.isArray(val) ? val.join('\n') : (val || '');
    input.oninput = () => {
      S.fields[field] = input.value.split('\n').map(x => x.trim()).filter(Boolean);
      renderPreview(); startPreviewRotation();
    };
    setTimeout(() => input.focus(), 30);
  }

  // Position popup
  const rect = el.getBoundingClientRect();
  const popW = 320;
  const left = Math.min(rect.left, window.innerWidth - popW - 12);
  const top  = rect.bottom + window.scrollY + 8;
  popup.style.left = Math.max(8, left) + 'px';
  popup.style.top  = top + 'px';
  popup.style.display = '';
  overlay.style.display = '';
}

function closeEditPopup() {
  const f = S._editingField;
  if (!f) return;
  // For button fields, ensure final sync
  if (FIELD_CONFIG[f]?.type === 'button') {
    S.fields[f] = { name: $('epBtnName')?.value || '', url: $('epBtnUrl')?.value || '' };
    renderPreview();
  }
  // For spotify art: sync to spotifyArtUrl input too
  if (f === 'spotifyArt') {
    const v = $('epInput')?.value || '';
    const track = activeSpotifyTrack(true);
    if (track) track.albumArtUrl = v;
    if ($('spotifyArtUrl')) $('spotifyArtUrl').value = v;
    renderSpotifyPreview();
    renderSpotifyTrackRows();
  }
  $('editPopup').style.display   = 'none';
  $('editOverlay').style.display = 'none';
  S._editingField = null;
}

// ── Spotify Preview Renderer ────────────────────────────────────────
function renderSpotifyPreview() {
  const track = activeSpotifyTrack(true) || emptySpotifyTrack();
  const song   = $('pvSpotifySong');
  const artist = $('pvSpotifyArtist');
  const album  = $('pvSpotifyAlbum');
  const art    = $('pvSpotifyArt');
  const account = S.account || S.tokenInfo.find(t => t.valid);
  if (song)   song.textContent   = track.song   || 'Song Name';
  if (artist) artist.textContent = track.artist || 'Artist';
  const dur = Math.max(Number(track.duration) || 210, 10);
  const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  if (album)  album.textContent  = `${fmt(dur)} total`;
  if ($('pvSpotifyAccountName')) $('pvSpotifyAccountName').textContent = account?.username || 'Discord account';
  if ($('pvSpotifyAccountAvatar')) {
    $('pvSpotifyAccountAvatar').innerHTML = account?.avatar
      ? `<img src="${escAttr(account.avatar)}" alt="">`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  }

  if (art) {
    if (track.albumArtUrl) {
      art.innerHTML = `<img src="${escAttr(track.albumArtUrl)}" alt="art" style="width:100%;height:100%;object-fit:cover;border-radius:8px" onerror="this.parentElement.innerHTML='<svg width=28 height=28 viewBox=\"0 0 24 24\" fill=none stroke=\"rgba(30,215,96,.5)\" stroke-width=\"1.5\"><path d=\"M9 18V5l12-2v13\"/><circle cx=6 cy=18 r=3/><circle cx=18 cy=16 r=3/></svg>'"/>`;
    } else {
      art.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(30,215,96,.5)" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    }
  }

  // Progress bar based on duration
  const elapsed = Math.floor((Date.now() / 1000) % dur);
  if ($('pvSpotifyElapsed')) $('pvSpotifyElapsed').textContent = fmt(elapsed);
  if ($('pvSpotifyTotal'))   $('pvSpotifyTotal').textContent   = fmt(dur);
  if ($('pvSpotifyFill')) $('pvSpotifyFill').style.width = `${Math.min(100, Math.round(elapsed / dur * 100))}%`;
  if ($('spotifyDuration')) $('spotifyDuration').value = dur;
  if ($('spotifyArtUrl')) $('spotifyArtUrl').value = track.albumArtUrl || '';
}

// ── Save Music ──────────────────────────────────────────────────────
async function saveMusic() {
  if (!S.settings) return;
  const cfg = structuredClone(S.settings.config || {});
  cfg.config = cfg.config || {};
  cfg.config.spotify = serializeSpotifyConfig();
  const r = await post(API.settings, { config: cfg, tokens: S.rawTokens });
  if (r.ok) { S.settings.config = cfg; toast('Music settings saved!', 'success'); }
  else toast('Save failed: ' + (r.error || 'unknown'), 'error');
}



// ── Helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    const data = text ? JSON.parse(text) : {};
    data.statusCode = response.status;
    if (!response.ok && !data.error) data.error = `HTTP ${response.status}`;
    return data;
  } catch {
    return { error: `HTTP ${response.status}`, statusCode: response.status };
  }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(parseJsonResponse);
const get  = url => fetch(url).then(parseJsonResponse);
const del  = url => fetch(url, { method: 'DELETE' }).then(parseJsonResponse);

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

// ── Template Processor ─────────────────────────────────────────────
// Turns {NF3(text)}, {hour:1}, {cpu:usage}, etc. into real rendered values
function processTemplate(raw) {
  if (!raw) return '';
  let s = String(raw);

  // Strip font wrappers: {NF3(text)} → text
  s = s.replace(/\{NF\d+\(([^)]*)\)\}/g, (_, inner) => inner.trim());
  // Also handle nested: {NF3( content )} with spaces
  s = s.replace(/\{NF\d+\(\s*([\s\S]*?)\s*\)\}/g, (_, inner) => inner.trim());

  const now = new Date();
  const h24 = now.getHours();
  const min  = now.getMinutes();
  const h12  = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'AM' : 'PM';

  // Time variables
  s = s.replace(/\{hour:1\}/g,     String(h24).padStart(2, '0'));
  s = s.replace(/\{hour:2\}/g,     String(h12).padStart(2, '0'));
  s = s.replace(/\{min:1\}/g,      String(min).padStart(2, '0'));
  s = s.replace(/\{sec:1\}/g,      String(now.getSeconds()).padStart(2, '0'));
  s = s.replace(/\{ampm\}/g,       ampm);

  // Date variables
  const months3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const months  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const days    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const days3   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  s = s.replace(/\{en=month:3\}/g, months3[now.getMonth()]);
  s = s.replace(/\{en=month\}/g,   months[now.getMonth()]);
  s = s.replace(/\{en=year:2\}/g,  String(now.getFullYear()).slice(-2));
  s = s.replace(/\{en=year\}/g,    String(now.getFullYear()));
  s = s.replace(/\{en=day:3\}/g,   days3[now.getDay()]);
  s = s.replace(/\{en=day\}/g,     days[now.getDay()]);
  s = s.replace(/\{th=date\}/g,    String(now.getDate()));

  // System variables
  const cpu = S.lastCpu || 0;
  const ram = S.lastRam || 0;
  const uptH = Math.floor(S.sessionUptime / 3600);
  const uptM = Math.floor(S.sessionUptime % 3600 / 60);
  s = s.replace(/\{cpu:usage\}/g,    `${cpu}%`);
  s = s.replace(/\{ram:usage\}/g,    `${ram}%`);
  s = s.replace(/\{uptime:hours\}/g, String(uptH));
  s = s.replace(/\{uptime:minutes\}/g, String(uptM));
  s = s.replace(/\{ping\}/g,         '42ms');

  // Emoji time
  const timeEmojis = ['🌑','🌑','🌑','🌑','🌑','🌅','🌅','🌄','🌤','☀️','☀️','🌤','☀️','🌤','⛅','🌤','🌆','🌇','🌆','🌃','🌙','🌙','🌙','🌙'];
  s = s.replace(/\{emoji:time\}/g, timeEmojis[h24] || '🕐');
  s = s.replace(/\{emoji:clock\}/g, '🕐');

  // Strip any remaining unresolved {vars}
  s = s.replace(/\{[^}]{1,40}\}/g, '');

  return s.trim();
}

// ── Toast ──────────────────────────────────────────────────────────
function toast(msg, type = 'info', dur = 3000) {
  const box = $('toast');
  const el  = document.createElement('div');
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
        if (msg.data.logs)      msg.data.logs.forEach(e => appendLog(e, false));
        if (msg.data.errorLogs) msg.data.errorLogs.forEach(e => appendErrLog(e));
        if (msg.data.lastPresence) { S.livePresence = msg.data.lastPresence; renderPreview(); }
        break;
      case 'log':       appendLog(msg.data, true);                    break;
      case 'status':    updateStatus(msg.data);                        break;
      case 'sysStats':  updateSysStats(msg.data);                      break;
      case 'presence':  S.livePresence = msg.data; renderPreview();    break;
      case 'alert':     toast(msg.data.message, msg.data.type || 'error', 6000); break;
      case 'clearLogs': clearLogBoxes();                               break;
      case 'rateLimit': renderRateLimits(msg.data.limits);             break;
    }
  };

  ws.onclose = () => {
    wsRetry++;
    setTimeout(connectWS, Math.min(1000 * wsRetry, 10000));
  };
}

// ── Log renderers ──────────────────────────────────────────────────
function appendLog(entry, broadcast = false) {
  const box = $('overviewLog');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'log-entry' + (entry.error ? ' err' : '');
  const ts = new Date(entry.ts).toLocaleTimeString('en', { hour12: false });
  el.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(entry.text)}`;
  box.appendChild(el);
  if (box.children.length > 300) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
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
  const b = $('overviewLog'), c = $('logCount');
  if (b && c) c.textContent = `${b.children.length} entries`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normalizeCustomStatus(cs = {}) {
  const legacy = (cs.text || cs.emoji) ? [{ text: cs.text || '', emoji: cs.emoji || '' }] : [];
  const raw = Array.isArray(cs.messages) && cs.messages.length ? cs.messages : legacy;
  return {
    enabled: !!cs.enabled,
    intervalSec: Math.max(Number(cs.intervalSec) || 300, 60),
    messages: raw.map(item => typeof item === 'string'
      ? { text: item, emoji: '' }
      : { text: item?.text || '', emoji: item?.emoji || '' }).filter(item => item.text || item.emoji),
  };
}

function delayMinutesFromSettings() {
  return Math.max(1, Math.round((Number(S.settings?.config?.setup?.delay) || 60) / 60));
}

function currentDelayMs() {
  const mins = Math.max(1, Number($('delay')?.value) || delayMinutesFromSettings());
  return mins * 60000;
}

// ── Status updates ─────────────────────────────────────────────────
function updateStatus(data) {
  S.running = data.running;
  S.pid     = data.pid || null;

  const dot  = $('statusDot'), mDot = $('mobileStatusDot'), text = $('statusText');
  [dot, mDot].forEach(d => { if (d) d.classList.toggle('running', S.running); });
  if (text) text.textContent = S.running ? 'Running' : 'Stopped';
  const pb = $('previewBadge'); if (pb) pb.style.display = S.running ? 'inline-flex' : 'none';
  if ($('ovPid')) $('ovPid').textContent = S.pid || '—';
  updateNavBadges();

  if (data.exitCode !== undefined && data.exitCode !== 0 && data.exitCode !== null) {
    toast(`Bot stopped — exit code ${data.exitCode}`, 'error', 5000);
  }
  if (!S.running) S.livePresence = null;
  updateActiveModeBar(S.running);
  renderPreview();
}

// ── Rate-Limit Monitor ─────────────────────────────────────────────
let _rlCountdownId = null;

function renderRateLimits(limits = []) {
  const panel = $('rlPanel');
  const list  = $('rlList');
  if (!panel || !list) return;

  // Filter to active limits
  const now   = Date.now();
  const active = limits.filter(l => l.endTs > now);

  if (!active.length) {
    panel.style.display = 'none';
    if (_rlCountdownId) { clearInterval(_rlCountdownId); _rlCountdownId = null; }
    return;
  }

  panel.style.display = '';

  const buildRows = () => {
    const n = Date.now();
    list.innerHTML = active.map(l => {
      const rem   = Math.max(0, l.endTs - n);
      const mins  = Math.floor(rem / 60000);
      const secs  = Math.floor((rem % 60000) / 1000);
      const pct   = Math.min(100, (l.attempts / 5) * 100);
      const label = rem > 0 ? `${mins}m ${String(secs).padStart(2,'0')}s` : 'Resuming…';
      const bg    = l.attempts >= 4 ? 'rgba(248,113,113,.08)' : 'rgba(251,191,36,.06)';
      const clr   = l.attempts >= 4 ? 'var(--danger)' : '#fbbf24';
      return `
        <div class="rl-row" style="border-left-color:${clr};background:${bg}">
          <div class="rl-token">${escHtml(l.masked)}</div>
          <div class="rl-meta">
            <span class="rl-attempts" style="color:${clr}">Attempt ${l.attempts}</span>
            <span class="rl-countdown">${label}</span>
          </div>
          <div class="rl-bar-track"><div class="rl-bar-fill" style="width:${pct}%;background:${clr}"></div></div>
        </div>`;
    }).join('');
  };

  buildRows();
  if (_rlCountdownId) clearInterval(_rlCountdownId);
  _rlCountdownId = setInterval(() => {
    const n = Date.now();
    if (active.every(l => l.endTs <= n)) {
      clearInterval(_rlCountdownId); _rlCountdownId = null;
      panel.style.display = 'none';
      return;
    }
    buildRows();
  }, 1000);
}

// ── Active Mode Banner ─────────────────────────────────────────────
function updateActiveModeBar(running) {
  const bar     = $('activeModeBar');
  const content = $('activeModeContent');
  if (!bar || !content) return;

  if (!running || !S.settings) { bar.style.display = 'none'; return; }

  const cfg = S.settings.config || {};
  const inner = cfg.config || {};
  const sp  = inner.spotify;
  const hasSpotify  = sp?.enabled && ((sp.tracks || []).length || sp.song);
  let html = '';
  html += `<span class="amb-pill amb-stream"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Streaming Active</span>`;
  if (hasSpotify) {
    html += `<span class="amb-divider">+</span>`;
    html += `<span class="amb-pill amb-music"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> Music (Spotify) Active</span>`;
    html += `<span class="amb-note">Both are running together in Discord</span>`;
  } else {
    html += `<span class="amb-note">Enable Music in the Music section to run Spotify alongside</span>`;
  }

  content.innerHTML = html;
  bar.style.display = '';
}

function updateSysStats(d) {
  S.sessionUptime  = d.sessionUptime  || 0;
  S.rotationCounts = d.rotationCounts || S.rotationCounts;
  S.lastCpu        = d.cpu || 0;
  S.lastRam        = d.ram || 0;

  if ($('ovUptime'))    $('ovUptime').textContent    = fmtUptime(d.sessionUptime);
  if ($('ovRotations')) $('ovRotations').textContent = Object.values(d.rotationCounts||{}).reduce((a,b)=>a+b,0);

  setBar('cpuBar',   'cpuVal',   d.cpu, '%');
  setBar('ramBar',   'ramVal',   d.ram, '%');
  setBar('anCpuBar', 'anCpu',    d.cpu, '%');
  setBar('anRamBar', 'anRam',    d.ram, '%');

  // Keep live preview up-to-date with real values
  renderPreview();
}

function setBar(barId, valId, pct, unit) {
  const bar = $(barId), val = $(valId);
  if (bar) bar.style.width = Math.min(pct||0, 100) + '%';
  if (val) val.textContent  = (pct||0) + (unit||'');
  if (bar && pct > 85)      bar.style.background = 'linear-gradient(90deg,#ef4444,#f97316)';
  else if (bar && pct > 60) bar.style.background = 'linear-gradient(90deg,#f59e0b,#fbbf24)';
  else if (bar) bar.style.background = '';
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
  if (section === 'profiles')  loadProfiles();
  if (section === 'schedule')  loadSchedule();
  if (section === 'tokens')    renderTokenCards();
  if (section === 'music')     { renderSpotifyTrackRows(); renderSpotifyPreview(); }
}

// ── Theme ──────────────────────────────────────────────────────────
function applyTheme(t) {
  S.theme = t;
  localStorage.setItem('theme', t);
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.theme-opt').forEach(el => el.classList.toggle('active', el.dataset.t === t));
}

// ── Settings Load ──────────────────────────────────────────────────
async function loadSettings() {
  const data = await get(API.settings);
  S.settings  = data;
  S.rawTokens = data.tokens || [];
  S.running   = data.runtime?.running || false;
  S.pid       = data.runtime?.pid     || null;
  S.livePresence = data.runtime?.lastPresence || null;

  const cfg  = data.config?.config  || {};
  const setup= data.config?.setup   || {};
  const opts = cfg.options           || {};

  // Populate S.fields from server config
  S.fields.text1   = cfg['text-1']  || [];
  S.fields.text2   = cfg['text-2']  || [];
  S.fields.text3   = cfg['text-3']  || [];
  S.fields.text4   = cfg['text-4']  || [];
  S.fields.bigimg  = cfg.bigimg     || [];
  S.fields.smallimg= cfg.smallimg   || [];

  // Sidebar inputs
  if ($('watchUrls')) $('watchUrls').value = (opts['watch-url'] || []).join('\n');
  if ($('delay'))     $('delay').value     = Math.max(1, Math.round((Number(setup.delay) || 60) / 60));
  if ($('activityName')) $('activityName').value = opts['activity-name'] || opts.activityName || '';
  if ($('presenceStatus')) $('presenceStatus').value = opts.status || opts['presence-status'] || opts.presenceStatus || 'online';
  if ($('tokenInput')) $('tokenInput').value = S.rawTokens.join('\n');

  // Custom Status + human mode
  S.customStatus = normalizeCustomStatus(cfg.customStatus || {});
  if ($('customStatusEnabled')) {
    $('customStatusEnabled').checked = !!S.customStatus.enabled;
    if ($('csFields')) $('csFields').style.display = S.customStatus.enabled ? '' : 'none';
  }
  if ($('customStatusDelay')) $('customStatusDelay').value = Math.max(1, Math.round(S.customStatus.intervalSec / 60));
  if ($('botId'))               $('botId').value             = opts.botid || '';
  if ($('humanModeEnabled'))    $('humanModeEnabled').checked = opts.humanMode !== false;

  // Spotify settings
  const sp = cfg.spotify || {};
  S.spotify = normalizeSpotifyConfig(sp);
  if ($('spotifyEnabled'))  $('spotifyEnabled').checked  = S.spotify.enabled;
  const activeTrack = activeSpotifyTrack(true);
  if ($('spotifyDuration')) $('spotifyDuration').value   = activeTrack?.duration || 210;
  if ($('spotifyArtUrl'))   $('spotifyArtUrl').value     = activeTrack?.albumArtUrl || '';
  renderSpotifyTrackRows();

  if (S.tokenInfo.length && S.tokenInfo[0].valid) updateAccountPreview(S.tokenInfo[0]);
  else renderAccountPreview();

  updateStatus(data.runtime || {});
  renderStreamEditors();
  renderPreview();
  startPreviewRotation();
  renderSpotifyPreview();
  updateNavBadges();
  if (S.rawTokens.length) loadAccountPreview();
  if (S.rawTokens.length && !S.emojis.length) loadEmojiPicker(true);
}

async function loadEnv() {
  const d = await get(API.env);
  if ($('webhookUrl')) $('webhookUrl').value = d.webhookUrl || '';
}

function updateNavBadges() {
  const tb = $('navTokenBadge');
  if (tb) { tb.textContent = S.rawTokens.length || ''; tb.style.display = S.rawTokens.length ? '' : 'none'; }
}

// ── Account Preview (Presence sidebar) ────────────────────────────
function updateAccountPreview(info) {
  if (!info) return;
  S.account = info.valid === false ? null : info;
  const connTag  = $('pvConnectedTag');
  if (connTag) connTag.textContent = info.username ? `@${info.username}` : '';
  renderAccountPreview();
  renderSpotifyPreview();
}

async function loadAccountPreview() {
  if (!S.rawTokens.length || S.account) return;
  try {
    const [info] = await validateTokens([S.rawTokens[0]]);
    if (info?.valid) {
      updateAccountPreview(info);
      renderPreview();
    }
  } catch {}
}

function fallbackAvatarSvg() {
  return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
}

function customEmojiUrl(value, size = 32) {
  const m = String(value || '').match(/^<a?:([a-zA-Z0-9_~]+):(\d+)>$/);
  if (!m) return null;
  return `https://cdn.discordapp.com/emojis/${m[2]}.${value.startsWith('<a:') ? 'gif' : 'png'}?size=${size}`;
}

function renderEmojiValue(value, empty = '<span>+</span>') {
  const url = customEmojiUrl(value, 32);
  if (url) return `<img src="${escAttr(url)}" alt="">`;
  return value ? `<span>${escHtml(value)}</span>` : empty;
}

function renderAccountPreview() {
  const account = S.account;
  const banner = $('pvProfileBanner');
  const avatar = $('pvProfileAvatar');
  if (banner) {
    banner.style.backgroundImage = account?.banner ? `url("${String(account.banner).replace(/"/g, '\\"')}")` : '';
  }
  if (avatar) {
    avatar.innerHTML = account?.avatar
      ? `<img src="${escAttr(account.avatar)}" alt="">`
      : fallbackAvatarSvg();
  }
  if ($('pvProfileName')) $('pvProfileName').textContent = account?.username || 'Discord account';
  if ($('pvProfileTag')) $('pvProfileTag').textContent = account?.tag || account?.id || 'Validate a token to load profile info';
  renderCustomStatusPreview();
}

function renderCustomStatusPreview() {
  const line = $('pvCustomStatusLine');
  if (!line) return;
  const messages = S.customStatus.messages || [];
  const row = S.customStatus.enabled && messages.length
    ? messages[S.activeCsIndex % messages.length]
    : null;
  if (!row || (!row.text && !row.emoji)) {
    line.style.display = 'none';
    line.innerHTML = '';
    return;
  }
  line.style.display = '';
  line.innerHTML = `${row.emoji ? `<span class="dc-custom-emoji">${renderEmojiValue(row.emoji || '', '')}</span>` : ''}<span>${escHtml(row.text || '')}</span>`;
}

// ── Focus Field from Preview Click ────────────────────────────────
function focusField(id) {
  if (S.section !== 'presence') goTo('presence');
  setTimeout(() => {
    const el = $(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    el.classList.add('field-highlight');
    setTimeout(() => el.classList.remove('field-highlight'), 1000);
  }, 80);
}

function liveActivityType(activity = {}) {
  if (typeof activity.type === 'number') return ['PLAYING','STREAMING','LISTENING','WATCHING','CUSTOM','COMPETING','HANG'][activity.type] || 'PLAYING';
  return activity.type || 'PLAYING';
}

function liveAssetUrl(activity = {}, key = 'large') {
  const assets = activity.assets || {};
  const direct = key === 'large' ? assets.largeImageUrl : assets.smallImageUrl;
  const raw = key === 'large' ? assets.largeImage : assets.smallImage;
  if (direct) return direct;
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('mp:')) return `https://media.discordapp.net/${raw.slice(3)}`;
  if (raw.startsWith('spotify:')) return `https://i.scdn.co/image/${raw.slice(8)}`;
  if (raw.startsWith('youtube:')) return `https://i.ytimg.com/vi/${raw.slice(8)}/hqdefault_live.jpg`;
  if (raw.startsWith('twitch:')) return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${raw.slice(7)}.png`;
  return '';
}

function renderLiveCustomStatus(custom) {
  const line = $('pvCustomStatusLine');
  if (!line) return;
  if (!custom || (!custom.state && !custom.emoji)) {
    line.style.display = 'none';
    line.innerHTML = '';
    return;
  }
  const emoji = custom.emoji?.id
    ? `<span class="dc-custom-emoji"><img src="https://cdn.discordapp.com/emojis/${custom.emoji.id}.${custom.emoji.animated ? 'gif' : 'png'}?size=32" alt=""></span>`
    : custom.emoji?.name
      ? `<span class="dc-custom-emoji"><span>${escHtml(custom.emoji.name)}</span></span>`
      : '';
  line.style.display = '';
  line.innerHTML = `${emoji}<span>${escHtml(custom.state || '')}</span>`;
}

function renderActivityFields(activity, ids) {
  const type = liveActivityType(activity);
  const title = type === 'STREAMING' ? 'STREAMING' : type === 'LISTENING' ? 'LISTENING' : type === 'WATCHING' ? 'WATCHING' : 'PLAYING';
  const setText = (id, value, fallback = '') => {
    const el = $(id); if (!el) return;
    el.textContent = value || fallback;
    if (id === ids.state || id === ids.hover || id === ids.smallText) el.style.display = value ? '' : 'none';
  };
  const setAsset = (id, url, fallback) => {
    const el = $(id); if (!el) return;
    el.innerHTML = url ? `<img src="${escAttr(url)}" alt="" onerror="this.parentElement.textContent='${fallback}'">` : `<span>${fallback}</span>`;
  };

  if ($(ids.title)) $(ids.title).innerHTML = `<span class="dc-live-dot"></span>${title}`;
  setText(ids.name, activity.name || (type === 'STREAMING' ? 'Live' : title));
  setText(ids.details, activity.details || '');
  setText(ids.state, activity.state || '');
  setText(ids.hover, activity.assets?.largeText || '');
  if (ids.smallText) setText(ids.smallText, activity.assets?.smallText || '');
  setAsset(ids.large, liveAssetUrl(activity, 'large'), 'IMG');
  setAsset(ids.small, liveAssetUrl(activity, 'small'), 'SM');
}

function setPreviewSource(text, live = false) {
  ['previewSourceBadge', 'ovPreviewSourceBadge'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('badge-live', live);
  });
}

function renderLivePresence() {
  const presence = S.livePresence;
  const activities = presence?.activities || [];
  if (!S.running || !activities.length) return false;

  const custom = activities.find(a => liveActivityType(a) === 'CUSTOM');
  const visible = activities.filter(a => liveActivityType(a) !== 'CUSTOM');
  const primary = visible.find(a => liveActivityType(a) === 'STREAMING') || visible[0];
  if (!primary) return false;

  const hasStreaming = visible.some(a => liveActivityType(a) === 'STREAMING');
  renderAccountPreview();
  const statusDot = $('pvProfileStatus');
  if (statusDot) statusDot.className = `dc-avatar-status ${presence.status || (hasStreaming ? 'streaming' : 'online')}`;
  setPreviewSource('Live from Discord', true);

  renderLiveCustomStatus(custom);
  renderActivityFields(primary, {
    title: 'pvActivityTitle',
    name: 'pvName',
    details: 'pvText1p',
    state: 'pvText2p',
    hover: 'pvText3p',
    smallText: 'pvSmallTextp',
    large: 'pvLargeImg',
    small: 'pvSmallImg',
  });

  renderActivityFields(primary, {
    title: 'ovActivityLabel',
    name: 'ovPvName',
    details: 'ovPvT1',
    state: 'ovPvT2',
    hover: 'ovPvT3',
    large: 'ovPvLarge',
    small: 'ovPvSmall',
  });

  const extra = $('pvExtraActivities');
  if (extra) {
    const extras = visible.filter(a => a !== primary);
    extra.innerHTML = extras.map(activity => {
      const type = liveActivityType(activity);
      const large = liveAssetUrl(activity, 'large');
      const small = liveAssetUrl(activity, 'small');
      return `<div class="dc-activity dc-extra-activity">
        <div class="dc-activity-title"><span class="dc-live-dot"></span>${escHtml(type)}</div>
        <div class="dc-rich-content">
          <div class="dc-rich-art">
            <div class="dc-rich-large">${large ? `<img src="${escAttr(large)}" alt="">` : '<span>IMG</span>'}</div>
            <div class="dc-rich-small">${small ? `<img src="${escAttr(small)}" alt="">` : '<span>SM</span>'}</div>
          </div>
          <div class="dc-rich-copy">
            <div class="dc-rich-name">${escHtml(activity.name || type)}</div>
            <div class="dc-rich-details">${escHtml(activity.details || '')}</div>
            <div class="dc-rich-state">${escHtml(activity.state || '')}</div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  return true;
}

// ── Live Preview renderer ──────────────────────────────────────────
function renderPreview() {
  if (renderLivePresence()) return;

  const f = S.fields;
  const text1Lines = f.text1 || [];
  const text2Lines = f.text2 || [];
  const text3Lines = f.text3 || [];
  const text4Lines = f.text4 || [];
  const bigimgUrls = f.bigimg || [];
  const smallimgUrls = f.smallimg || [];

  const t1 = processTemplate(text1Lines[S.previewText1Idx % Math.max(text1Lines.length, 1)] || '');
  const t2 = processTemplate(text2Lines[S.previewText2Idx % Math.max(text2Lines.length, 1)] || '');
  const t3 = processTemplate(text3Lines[S.previewText3Idx % Math.max(text3Lines.length, 1)] || '');
  const t4 = processTemplate(text4Lines[S.previewText4Idx % Math.max(text4Lines.length, 1)] || '');
  const largeImage = bigimgUrls[S.previewImageIdx % Math.max(bigimgUrls.length, 1)] || '';
  const smallImage = smallimgUrls[S.previewImageIdx % Math.max(smallimgUrls.length, 1)] || '';
  const activityName = previewActivityName(t1);
  const modeLabel = 'STREAMING';

  const setText = (id, val, hideIfEmpty = false) => {
    const el = $(id); if (!el) return;
    el.textContent = val;
    if (hideIfEmpty) el.style.display = val ? '' : 'none';
  };
  const setAsset = (id, url, fallback) => {
    const el = $(id); if (!el) return;
    if (url) {
      el.innerHTML = `<img src="${escAttr(url)}" alt="" onerror="this.parentElement.textContent='${fallback}'">`;
    } else {
      el.innerHTML = `<span>${fallback}</span>`;
    }
  };

  // ── Overview card ──
  setPreviewSource(S.running ? 'Waiting for Discord' : 'Local preview', false);
  const statusDot = $('pvProfileStatus');
  if (statusDot) statusDot.className = `dc-avatar-status ${previewPresenceStatus()}`;
  if ($('ovActivityLabel')) $('ovActivityLabel').innerHTML = `<span class="dc-live-dot"></span>${escHtml(modeLabel)}`;
  setText('ovPvName', activityName);
  setText('ovPvT1', t1 || '—');
  setText('ovPvT2', t2 || '');
  setText('ovPvT3', t3 || t4 || '', true);
  setAsset('ovPvLarge', largeImage, 'IMG');
  setAsset('ovPvSmall', smallImage, 'SM');

  // ── Streaming card (presence section) ──
  if ($('pvActivityTitle')) $('pvActivityTitle').innerHTML = `<span class="dc-live-dot"></span>${escHtml(modeLabel)}`;
  setText('pvName', activityName);
  setText('pvText1p', t1 || '');
  setText('pvText2p', t2 || '', true);
  setText('pvText3p', t3 || '', true);
  setText('pvSmallTextp', t4 || '', true);
  setAsset('pvLargeImg', largeImage, 'Large');
  setAsset('pvSmallImg', smallImage, 'Small');

  const extra = $('pvExtraActivities');
  if (extra) {
    extra.innerHTML = '';
  }

  // Store for rotation
  S._text2Lines = text2Lines;
  S._bigimgUrls = bigimgUrls;
  renderAccountPreview();
}

function previewActivityType() {
  return 'STREAMING';
}

function previewPresenceStatus() {
  const raw = $('presenceStatus')?.value ||
    S.settings?.config?.config?.options?.status ||
    S.settings?.config?.config?.options?.['presence-status'] ||
    'online';
  return ['online', 'idle', 'dnd'].includes(raw) ? raw : 'online';
}

function previewActivityName(detailsText = '') {
  const custom = $('activityName')?.value.trim();
  if (custom) return processTemplate(custom) || 'Live';
  return detailsText || 'Live';
}

// ── Text-2 line rotator for preview ───────────────────────────────
function startPreviewRotation() {
  if (S.previewTimer) clearInterval(S.previewTimer);
  S.previewTimer = setInterval(() => {
    if ((S.fields.text1 || []).length) S.previewText1Idx = (S.previewText1Idx + 1) % S.fields.text1.length;
    if ((S.fields.text2 || []).length) S.previewText2Idx = (S.previewText2Idx + 1) % S.fields.text2.length;
    if ((S.fields.text3 || []).length) S.previewText3Idx = (S.previewText3Idx + 1) % S.fields.text3.length;
    if ((S.fields.text4 || []).length) S.previewText4Idx = (S.previewText4Idx + 1) % S.fields.text4.length;
    if ((S.fields.bigimg || []).length || (S.fields.smallimg || []).length) {
      S.previewImageIdx++;
    }
    renderPreview();
  }, Math.max(60000, currentDelayMs()));

  renderPreview();
}

function setPreviewT2(text) {
  const ovT2 = $('ovPvT2');
  if (ovT2) ovT2.textContent = text || '—';
  const pvT2 = $('pvText2p');
  if (pvT2) pvT2.textContent = text || '—';
}

// ── Streaming Editors ─────────────────────────────────────────────
function renderStreamEditors() {
  renderLineRows('detailsRows', 'text1');
  renderLineRows('stateRows', 'text2');
  renderLineRows('largeTextRows', 'text3');
  renderLineRows('smallTextRows', 'text4');
  renderImageRows('largeImagesRows', 'bigimg');
  renderImageRows('smallImagesRows', 'smallimg');
  renderCustomStatusRows();
  renderEmojiOptions();
  renderPreview();
}

function renderLineRows(containerId, key) {
  const el = $(containerId); if (!el) return;
  const rows = S.fields[key] || [];
  el.innerHTML = rows.length ? rows.map((value, i) => `
    <div class="config-row">
      <input class="input-field compact-input" data-line-key="${key}" data-index="${i}" value="${escAttr(value)}" placeholder="${linePlaceholder(key)}"/>
      <button class="icon-btn mini-btn" data-remove-line="${key}" data-index="${i}" title="Remove">&times;</button>
    </div>`).join('') : `<div class="mini-empty">No entries</div>`;
}

function linePlaceholder(key) {
  return ({ text1: 'Details text', text2: 'State text', text3: 'Large image hover text', text4: 'Small image hover text' })[key] || 'Text';
}

// ── CDN image check ────────────────────────────────────────────────
async function checkImages() {
  const btn = $('checkImagesBtn');
  if (btn) setBusyButton(btn, true, 'Checking…');
  const checkPanel = $('imageCheckStatus');
  if (checkPanel) checkPanel.style.display = 'none';

  const allEntries = [
    ...(S.fields.bigimg   || []).map(url => ({ url, key: 'bigimg'   })),
    ...(S.fields.smallimg || []).map(url => ({ url, key: 'smallimg' })),
  ].filter(x => x.url);

  if (!allEntries.length) {
    toast('No images configured to check', 'info');
    if (btn) setBusyButton(btn, false, 'Check CDN');
    return;
  }

  try {
    const r = await post(API.checkImages, { urls: allEntries.map(x => x.url) });
    const results = r.results || [];

    // Apply refreshed/resolved URLs back into S.fields
    let updated = 0;
    for (const item of results) {
      if (item.status === 'refreshed' && item.newUrl && item.newUrl !== item.url) {
        for (const e of allEntries.filter(x => x.url === item.url)) {
          const idx = (S.fields[e.key] || []).indexOf(item.url);
          if (idx >= 0) { S.fields[e.key][idx] = item.newUrl; updated++; }
        }
      }
    }
    if (updated > 0) {
      renderStreamEditors();
      toast(`${updated} image URL(s) updated to fresh CDN links`, 'success');
    }

    showImageCheckResult(results);
  } catch (e) {
    toast(e.message || 'CDN check failed', 'error');
  } finally {
    if (btn) setBusyButton(btn, false, 'Check CDN');
  }
}

function showImageCheckResult(results) {
  const panel = $('imageCheckStatus');
  const body  = $('imageCheckSteps');
  const icon  = $('imageCheckStatusIcon');
  const title = $('imageCheckStatusTitle');
  if (!panel || !body) return;

  const ok        = results.filter(r => r.status === 'ok' || r.status === 'external').length;
  const refreshed = results.filter(r => r.status === 'refreshed').length;
  const failed    = results.filter(r => ['error', 'expired', 'missing'].includes(r.status)).length;
  const allGood   = failed === 0;

  icon.textContent = allGood ? '✓' : failed > 0 ? '✗' : '⚠';
  icon.className   = `status-icon ${allGood ? 'ok' : failed > 0 ? 'error' : 'warn'}`;
  title.textContent = allGood
    ? `All ${results.length} image(s) are ready on Discord CDN${refreshed ? ` (${refreshed} refreshed)` : ''}`
    : `${failed} image(s) need re-uploading${refreshed ? ` · ${refreshed} fixed automatically` : ''}`;

  body.innerHTML = results.map(item => {
    const dot = { ok: '✓', external: '✓', refreshed: '↻', error: '✗', expired: '✗', missing: '✗' }[item.status] || '·';
    const cls = ['ok','external'].includes(item.status) ? 'ok'
              : item.status === 'refreshed' ? 'refreshed' : 'error';
    const label = (item.newUrl || item.url || '').replace(/^https?:\/\//, '').slice(0, 55);
    return `<div class="upload-step ${cls}">
      <span class="step-dot">${dot}</span>
      <span class="step-name" title="${escAttr(item.url || '')}">${escHtml(label)}</span>
      <span class="step-detail">${escHtml(item.detail)}</span>
    </div>`;
  }).join('');

  panel.className  = `upload-status ${allGood ? 'ok' : failed > 0 ? 'error' : 'warn'}`;
  panel.style.display = 'block';
  if (allGood) setTimeout(() => { panel.style.display = 'none'; }, 10000);
}

function renderImageRows(containerId, key) {
  const el = $(containerId); if (!el) return;
  const rows = S.fields[key] || [];
  el.innerHTML = rows.length ? rows.map((url, i) => `
    <div class="asset-row">
      <div class="asset-thumb">${url ? `<img src="${escAttr(url)}" alt="">` : '<span>IMG</span>'}</div>
      <div class="asset-meta">
        <div class="asset-title">${key === 'bigimg' ? 'Large image' : 'Small image'} ${i + 1}</div>
        <div class="asset-url">${escHtml(url)}</div>
      </div>
      <button class="icon-btn mini-btn" data-remove-line="${key}" data-index="${i}" title="Remove">&times;</button>
    </div>`).join('') : `<div class="mini-empty">No attached images</div>`;
}

function renderSpotifyTrackRows() {
  const el = $('spotifyTracksRows');
  if (!el) return;
  const rows = S.spotify.tracks || [];
  el.innerHTML = rows.length ? rows.map((track, i) => `
    <div class="spotify-track-row${i === S.spotify.activeTrack ? ' active' : ''}" data-spotify-row="${i}">
      <button class="spotify-track-art" data-spotify-art="${i}" type="button" title="Attach art">
        ${track.albumArtUrl ? `<img src="${escAttr(track.albumArtUrl)}" alt="">` : '<span>ART</span>'}
      </button>
      <div class="spotify-track-fields">
        <input class="input-field compact-input" data-spotify-track="${i}" data-spotify-field="song" value="${escAttr(track.song || '')}" placeholder="Song name"/>
        <input class="input-field compact-input" data-spotify-track="${i}" data-spotify-field="artist" value="${escAttr(track.artist || '')}" placeholder="Artist"/>
        <input class="input-field compact-input" data-spotify-track="${i}" data-spotify-field="duration" type="number" min="10" value="${escAttr(track.duration || 210)}" placeholder="Seconds"/>
      </div>
      <button class="icon-btn mini-btn" data-remove-spotify="${i}" title="Remove">&times;</button>
    </div>`).join('') : `<div class="mini-empty">No songs</div>`;
}

function renderCustomStatusRows() {
  const el = $('customStatusRows'); if (!el) return;
  const rows = S.customStatus.messages || [];
  el.innerHTML = rows.length ? rows.map((row, i) => `
    <div class="custom-status-row${i === S.activeCsIndex ? ' active' : ''}">
      <button class="emoji-slot" data-cs-pick="${i}" type="button" title="Choose emoji">${renderEmojiValue(row.emoji || '')}</button>
      <input class="input-field compact-input" data-cs-field="text" data-index="${i}" maxlength="128" value="${escAttr(row.text || '')}" placeholder="Custom status text"/>
      <button class="icon-btn mini-btn" data-remove-cs="${i}" title="Remove">&times;</button>
    </div>`).join('') : `<div class="mini-empty">No custom status messages</div>`;
}

function renderEmojiOptions() {
  renderEmojiGrid();
}

const STANDARD_EMOJIS = ['🙂','😀','😂','😍','😎','🥳','🔥','✨','💜','❤️','✅','⭐','🎵','🎮','📺','💬','🌙','☀️','⚡','👑'];
const EMOJI_PAGE_SIZE = 48;

function allEmojiChoices() {
  const standard = [{ value: '', name: 'No emoji', guildName: 'Standard', url: null }]
    .concat(STANDARD_EMOJIS.map(value => ({ value, name: value, guildName: 'Standard', url: null })));
  return [...standard, ...(S.emojis || [])];
}

function renderEmojiGrid() {
  const grid = $('emojiGrid');
  const label = $('emojiPageLabel');
  if (!grid) return;
  const q = ($('emojiSearch')?.value || '').trim().toLowerCase();
  const choices = allEmojiChoices().filter(e => {
    if (!q) return true;
    return String(e.name || '').toLowerCase().includes(q) ||
      String(e.guildName || '').toLowerCase().includes(q);
  });
  const pages = Math.max(1, Math.ceil(choices.length / EMOJI_PAGE_SIZE));
  S.emojiPage = Math.min(Math.max(S.emojiPage, 0), pages - 1);
  const start = S.emojiPage * EMOJI_PAGE_SIZE;
  const page = choices.slice(start, start + EMOJI_PAGE_SIZE);
  if (label) label.textContent = `${choices.length ? S.emojiPage + 1 : 0} / ${choices.length ? pages : 0}`;
  grid.innerHTML = page.length ? page.map(e => `
    <button class="emoji-choice${S.customStatus.messages?.[S.activeCsIndex]?.emoji === e.value ? ' selected' : ''}" data-emoji-value="${escAttr(e.value)}" type="button" title="${escAttr(`${e.name} · ${e.guildName || 'Server'}`)}">
      ${e.url ? `<img src="${escAttr(e.url)}" alt="">` : `<span>${escHtml(e.value || '×')}</span>`}
      <small>${escHtml(e.name || '')}</small>
    </button>`).join('') : `<div class="mini-empty">No emojis match</div>`;
}

function addLine(key, value = '') {
  S.fields[key] = S.fields[key] || [];
  S.fields[key].push(value);
  resetPreviewRotation();
  renderStreamEditors();
}

function addCustomStatusMessage() {
  S.customStatus.messages.push({ text: '', emoji: '' });
  S.activeCsIndex = S.customStatus.messages.length - 1;
  renderStreamEditors();
}

function resetPreviewRotation() {
  S.previewText1Idx = 0;
  S.previewText2Idx = 0;
  S.previewText3Idx = 0;
  S.previewText4Idx = 0;
  S.previewImageIdx = 0;
}

function showUploadStatus(fileName, result) {
  const panel  = $('imageUploadStatus');
  const icon   = $('imageUploadStatusIcon');
  const title  = $('imageUploadStatusTitle');
  const steps  = $('imageUploadSteps');
  if (!panel || !steps) return;

  const success = result.ok && result.url && result.cdn !== false;
  const hasWarn = result.cdn === false;

  icon.textContent  = success ? '✓' : hasWarn ? '⚠' : '✗';
  icon.className    = success ? 'status-icon ok' : hasWarn ? 'status-icon warn' : 'status-icon error';
  title.textContent = success
    ? `"${fileName}" uploaded to Discord CDN`
    : hasWarn
    ? `"${fileName}" saved locally (no CDN)`
    : `"${fileName}" upload failed`;

  steps.innerHTML = (result.steps || []).map(s => `
    <div class="upload-step ${s.status}">
      <span class="step-dot">${s.status === 'ok' ? '✓' : s.status === 'warn' ? '⚠' : s.status === 'info' ? '·' : '✗'}</span>
      <span class="step-name">${escHtml(s.step)}</span>
      <span class="step-detail">${escHtml(s.detail)}</span>
    </div>`).join('');

  panel.className = `upload-status ${success ? 'ok' : hasWarn ? 'warn' : 'error'}`;
  panel.style.display = 'block';
  if (success) setTimeout(() => { panel.style.display = 'none'; }, 9000);
}

async function uploadImages(files, key) {
  const list = Array.from(files || []);
  if (!list.length) return;

  // Filter valid files first so the progress counter is accurate
  const valid = list.filter(f => {
    const mime = guessMime(f);
    if (!mime) { toast(`"${f.name}" — unsupported type. Use PNG, JPG, GIF, WebP, or AVIF`, 'error'); return false; }
    if (f.size > 8 * 1024 * 1024) { toast(`"${f.name}" is too large — max 8 MB`, 'error'); return false; }
    return true;
  });
  if (!valid.length) return;

  const total = valid.length;
  setUploadBusy(+1, 1, total);
  try {
    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      setUploadBusy(0, i + 1, total);          // update progress counter
      const mime = guessMime(file);
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        // Ensure correct MIME in the data URL (critical for GIF)
        const fixedDataUrl = dataUrl.replace(/^data:([^;]+);base64,/, `data:${mime};base64,`);
        const r = await post(API.upload, { name: file.name, dataUrl: fixedDataUrl });
        showUploadStatus(file.name, r);
        if (r.ok && r.url) {
          S.fields[key].push(r.url);
          if (r.cdn) toast(`"${file.name}" ready on Discord CDN`, 'success');
          else toast(r.warning || 'Saved locally — add a token for CDN upload', 'warn');
        } else {
          toast(r.error || 'Upload failed', 'error');
        }
      } catch (e) {
        showUploadStatus(file.name, { ok: false, steps: [{ step: 'Read file', status: 'error', detail: e.message }] });
        toast(e.message || 'Upload failed', 'error');
      }
    }
  } finally {
    setUploadBusy(-1);
    resetPreviewRotation();
    renderStreamEditors();
    startPreviewRotation();
  }
}

function addSpotifyTrack() {
  S.spotify.tracks.push(emptySpotifyTrack());
  S.spotify.activeTrack = S.spotify.tracks.length - 1;
  renderSpotifyTrackRows();
  renderSpotifyPreview();
}

async function uploadSpotifyArt(files, index = S.spotify.activeTrack) {
  const file = Array.from(files || [])[0];
  if (!file) return;
  const mime = guessMime(file);
  if (!mime) {
    toast(`"${file.name}" — unsupported type. Use PNG, JPG, GIF, or WebP`, 'error');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast(`"${file.name}" is too large — max 8 MB`, 'error');
    return;
  }

  setUploadBusy(+1);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
    const fixedDataUrl = dataUrl.replace(
      /^data:([^;]+);base64,/,
      `data:${mime};base64,`
    );
    const r = await post(API.upload, { name: file.name, dataUrl: fixedDataUrl });
    showUploadStatus(file.name, r);
    if (r.ok && r.url) {
      S.spotify.activeTrack = Math.max(0, Math.min(Number(index) || 0, S.spotify.tracks.length - 1));
      const track = activeSpotifyTrack(true);
      if (track) track.albumArtUrl = r.url;
      renderSpotifyTrackRows();
      renderSpotifyPreview();
      if (r.cdn) toast(`Album art ready on Discord CDN`, 'success');
      else toast(r.warning || 'Saved locally — add a token for CDN upload', 'warn');
    } else {
      toast(r.error || 'Upload failed', 'error');
    }
  } catch (e) {
    showUploadStatus(file.name, { ok: false, steps: [{ step: 'Read file', status: 'error', detail: e.message }] });
    toast(e.message || 'Upload failed', 'error');
  } finally {
    setUploadBusy(-1);
  }
}

async function loadEmojiPicker(silent = false) {
  const btn = $('loadEmojiBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  try {
    const data = await get(API.emojis);
    S.emojis = data.emojis || [];
    S.emojiPage = 0;
    renderEmojiGrid();
    if (!silent) toast(S.emojis.length ? `Loaded ${S.emojis.length} emojis` : (data.error || 'No emojis found'), S.emojis.length ? 'success' : 'info');
  } catch (e) {
    if (!silent) toast(e.message || 'Emoji load failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Load server emojis'; }
  }
}

// ── Tokens ─────────────────────────────────────────────────────────
async function validateTokens(tokens) {
  if (!tokens.length) return [];
  return await post(API.validate, { tokens });
}

async function renderTokenCards() {
  const grid = $('tokenCards');
  if (!grid) return;
  const tokens = S.rawTokens;

  if (!tokens.length) {
    grid.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      <p>No tokens configured yet</p></div>`;
    return;
  }

  grid.innerHTML = tokens.map((t, i) => `
    <div class="token-card" id="tcard-${i}">
      <div class="token-card-shine"></div>
      <div class="token-card-header">
        <div class="token-avatar-wrap">
          <div class="token-avatar" style="display:flex;align-items:center;justify-content:center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="token-status-ring offline"></div>
        </div>
        <div>
          <div class="token-name">Validating...</div>
          <div class="token-tag">Token #${i + 1}</div>
        </div>
      </div>
      <div class="token-masked">${maskDisplay(t)}</div>
      <div class="token-actions"><button class="btn btn-outline" disabled>Loading...</button></div>
    </div>`).join('');

  const results = await validateTokens(tokens);
  S.tokenInfo = results;

  results.forEach((info, i) => {
    const card = $(`tcard-${i}`);
    if (!card) return;
    card.className = `token-card ${info.valid ? 'valid' : 'invalid'}`;
    card.innerHTML = `
      <div class="token-card-shine"></div>
      <div class="token-card-header">
        <div class="token-avatar-wrap">
          ${info.valid && info.avatar
            ? `<img class="token-avatar" src="${info.avatar}" alt="${info.username}" onerror="this.style.display='none'">`
            : `<div class="token-avatar" style="display:flex;align-items:center;justify-content:center;background:var(--bg-input)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`}
          <div class="token-status-ring ${info.valid ? 'online' : 'error'}"></div>
        </div>
        <div style="min-width:0">
          <div class="token-name">${info.valid ? escHtml(info.username || 'Unknown') : 'Invalid Token'}</div>
          <div class="token-tag">${info.valid ? escHtml(info.tag || info.id || '') : escHtml(info.error || 'Auth failed')}</div>
          ${info.valid && info.nitro ? `<span class="token-badge nitro">Nitro</span>` : ''}
        </div>
      </div>
      <div class="token-masked">${escHtml(info.masked || maskDisplay(tokens[i]))}</div>
      <div class="token-actions">
        ${info.valid
          ? `<button class="btn btn-outline" onclick="copyToken(${i})" style="font-size:10px">Copy</button>`
          : `<span class="badge badge-danger" style="font-size:10px">Invalid</span>`}
        <button class="btn btn-outline" onclick="removeToken(${i})" style="font-size:10px">Remove</button>
      </div>`;
  });

  if ($('ovTokens')) $('ovTokens').textContent = results.filter(r => r.valid).length;
  updateNavBadges();
  const firstValid = results.find(r => r.valid);
  if (firstValid) {
    updateAccountPreview(firstValid);
    renderPreview(); // update preview with real avatar
    renderSpotifyPreview();
  }
}

function maskDisplay(t) {
  if (!t) return '••••';
  const parts = t.split('.');
  if (parts.length >= 2) return `${parts[0]}.••••••••••••••`;
  return t.slice(0, 8) + '••••••••••••••••';
}

function copyToken(i) {
  // Tokens are encrypted in storage — masked display only, cannot copy raw token
  toast('Tokens are encrypted — cannot copy for security', 'info');
}

function removeToken(i) {
  S.rawTokens.splice(i, 1);
  $('tokenInput').value = S.rawTokens.join('\n');
  renderTokenCards();
}

function setBusyButton(btn, busy, text = 'Working...') {
  if (!btn) return;
  if (busy) {
    btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
    btn.disabled = true;
    btn.textContent = text;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    delete btn.dataset.originalHtml;
  }
}

// ── Save Presence ──────────────────────────────────────────────────
async function savePresence(options = {}) {
  const silent = options?.silent === true;
  if (!S.settings) {
    toast('Settings are still loading', 'error');
    return false;
  }
  const toLines = v => (v || '').split('\n').map(x => x.trim()).filter(Boolean);
  const cfg = structuredClone(S.settings.config || {});
  cfg.setup          = cfg.setup   || {};
  cfg.config         = cfg.config  || {};
  cfg.config.options = cfg.config.options || {};

  const f = S.fields;
  cfg.setup.delay                 = Math.max(1, Number($('delay')?.value) || 1) * 60;
  cfg.config.options['watch-url'] = toLines($('watchUrls')?.value || '');
  cfg.config.options['activity-name'] = $('activityName')?.value.trim() || '';
  cfg.config.options['activity-type'] = 'STREAMING';
  cfg.config.options.status = $('presenceStatus')?.value || 'online';
  cfg.config.options['presence-status'] = cfg.config.options.status;
  cfg.config['text-1']            = f.text1   || [];
  cfg.config['text-2']            = f.text2   || [];
  cfg.config['text-3']            = f.text3   || [];
  cfg.config['text-4']            = f.text4   || [];
  cfg.config.bigimg               = f.bigimg  || [];
  cfg.config.smallimg             = f.smallimg || [];
  cfg.config['button-1']          = [];
  cfg.config['button-2']          = [];

  cfg.config.customStatus = {
    enabled: $('customStatusEnabled')?.checked || false,
    intervalSec: Math.max(1, Number($('customStatusDelay')?.value) || 1) * 60,
    messages: (S.customStatus.messages || [])
      .map(item => ({ text: (item.text || '').trim(), emoji: (item.emoji || '').trim() }))
      .filter(item => item.text || item.emoji),
  };
  S.customStatus = normalizeCustomStatus(cfg.config.customStatus);

  cfg.config.options.botid     = $('botId')?.value.trim() || '';
  cfg.config.options.humanMode = $('humanModeEnabled')?.checked !== false;

  const r = await post(API.settings, { config: cfg, tokens: S.rawTokens });
  if (r.ok) {
    if (!silent) toast('Streaming saved!', 'success');
    S.settings.config = cfg;
    renderStreamEditors();
    startPreviewRotation();
    return true;
  }
  toast('Save failed: ' + (r.error || 'unknown'), 'error');
  return false;
}

async function refreshRuntime(options = {}) {
  const silent = options?.silent === true;
  const btn = options?.currentTarget || options?.button || null;
  setBusyButton(btn, true, 'Refreshing...');
  if (!silent) toast('Sending refresh...', 'info', 1200);
  try {
    const r = await post(API.refresh, {});
    if (r.ok) {
      if (!silent) toast('Refresh sent to Discord', 'success');
      if (r.status) updateStatus(r.status);
      return true;
    }
    if (r.statusCode === 404) {
      toast('Refresh API not loaded. Restart the dashboard server once.', 'error', 7000);
      return false;
    }
    toast(r.error || 'Bot is not running', 'error');
    return false;
  } catch (e) {
    toast('Refresh failed: ' + (e.message || 'request failed'), 'error');
    return false;
  } finally {
    setBusyButton(btn, false);
  }
}

async function refreshPresence(event) {
  const btn = event?.currentTarget || null;
  setBusyButton(btn, true, 'Refreshing...');
  toast('Saving and refreshing...', 'info', 1200);
  try {
    const saved = await savePresence({ silent: true });
    if (!saved) return;
    const ok = await refreshRuntime({ silent: true });
    if (ok) toast('Saved and refresh sent to Discord', 'success');
  } catch (e) {
    toast('Refresh failed: ' + (e.message || 'request failed'), 'error');
  } finally {
    setBusyButton(btn, false);
  }
}

// ── Discord App auto-detect ────────────────────────────────────────
async function detectApps() {
  const btn = $('detectAppBtn'), listEl = $('appsList'), gridEl = $('appsGrid'), statusEl = $('appsStatus');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin">↻</span> Detecting…'; }
  if (statusEl) statusEl.style.display = 'none';
  if (listEl)   listEl.style.display   = 'none';
  try {
    const data = await get('/api/discord-apps');
    if (data.error) { showAppsStatus(data.error, 'error'); return; }
    if (!data.apps?.length) { showAppsStatus('No applications found. <a href="https://discord.com/developers/applications" target="_blank" class="text-link" rel="noopener">Create one →</a>', 'warn'); return; }
    if (gridEl) {
      const current = $('botId')?.value.trim();
      gridEl.innerHTML = data.apps.map(app => `
        <div class="app-item${app.id === current ? ' selected' : ''}" data-id="${app.id}"
             onclick="selectApp('${app.id}','${app.name.replace(/['"]/g,'').slice(0,50)}')">
          ${app.icon
            ? `<img src="${app.icon}" class="app-icon" loading="lazy" onerror="this.style.display='none'">`
            : `<div class="app-icon-placeholder"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>`}
          <div class="app-info"><div class="app-name">${app.name}</div><div class="app-id">${app.id}</div></div>
          <div class="app-select-hint">Use</div>
        </div>`).join('');
    }
    if (listEl) listEl.style.display = '';
    if (!$('botId')?.value.trim() && data.apps[0]) selectApp(data.apps[0].id, data.apps[0].name);
  } catch(e) {
    showAppsStatus(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Auto-detect`; }
  }
}

function showAppsStatus(html, type) {
  const el = $('appsStatus');
  if (!el) return;
  el.innerHTML = html; el.style.display = '';
  el.style.borderColor = type === 'error' ? 'rgba(248,113,113,0.3)' : type === 'warn' ? 'rgba(251,191,36,0.3)' : 'var(--border)';
  el.style.background  = type === 'error' ? 'rgba(248,113,113,0.07)' : type === 'warn' ? 'rgba(251,191,36,0.07)' : 'var(--bg-hover)';
  el.style.color       = type === 'error' ? '#f87171' : type === 'warn' ? '#fbbf24' : 'var(--text-dim)';
}

function selectApp(id, name) {
  if ($('botId')) $('botId').value = id;
  document.querySelectorAll('.app-item').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  toast(`Application set: "${name}"`, 'success');
}

async function saveTokens() {
  const lines = $('tokenInput').value.split('\n').map(t => t.trim()).filter(Boolean);
  S.rawTokens = lines;
  if (!S.settings) await loadSettings();
  const r = await post(API.settings, { config: S.settings?.config || {}, tokens: lines });
  if (r.ok) { toast('Tokens saved!', 'success'); updateNavBadges(); renderTokenCards(); }
  else toast('Save failed', 'error');
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
  grid.querySelectorAll('.profile-card').forEach(e => e.remove());
  if (!S.profiles.length) { if (empty) empty.style.display = ''; return; }
  if (empty) empty.style.display = 'none';
  S.profiles.forEach((p, i) => {
    const card = document.createElement('div');
    const isSel = compareIds.includes(p.id);
    card.className = 'profile-card' + (isSel ? ' cmp-selected' : '');
    card.style.animationDelay = `${i * 50}ms`;
    card.innerHTML = `
      <div class="profile-name">${escHtml(p.name)}</div>
      <div class="profile-date">Saved ${fmtDate(p.createdAt)}</div>
      <div class="profile-actions">
        <button class="btn btn-primary" onclick="applyProfile('${p.id}')">Apply</button>
        <button class="btn ${isSel ? 'btn-primary' : 'btn-outline'}" onclick="toggleCompare('${p.id}')">
          ${isSel ? '✓ Selected' : 'Compare'}
        </button>
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
  if ($('schedStart'))   $('schedStart').value      = s.startTime || '20:00';
  if ($('schedStop'))    $('schedStop').value        = s.stopTime  || '00:00';
  const days = s.days || [0,1,2,3,4,5,6];
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('active', days.includes(Number(btn.dataset.day)));
  });
  updateSchedBadge(s.enabled);
  renderSchedInfo(s);
}

function renderSchedInfo(s) {
  const days = s.days || [0,1,2,3,4,5,6];
  const now  = new Date();
  let nextStart = '—', nextStop = '—';
  if (s.enabled && s.startTime) {
    const [sh, sm] = s.startTime.split(':').map(Number);
    for (let d = 0; d < 7; d++) {
      const day = (now.getDay() + d) % 7;
      if (!days.includes(day)) continue;
      const c = new Date(now); c.setDate(now.getDate() + d); c.setHours(sh, sm, 0, 0);
      if (c > now) { nextStart = fmtDateTime(c.toISOString()); break; }
    }
    const [eh, em] = s.stopTime.split(':').map(Number);
    for (let d = 0; d < 7; d++) {
      const day = (now.getDay() + d) % 7;
      if (!days.includes(day)) continue;
      const c = new Date(now); c.setDate(now.getDate() + d); c.setHours(eh, em, 0, 0);
      if (c > now) { nextStop = fmtDateTime(c.toISOString()); break; }
    }
  }
  if ($('nextStart')) $('nextStart').textContent = nextStart;
  if ($('nextStop'))  $('nextStop').textContent  = nextStop;
}

async function saveSchedule() {
  const activeDays = [...document.querySelectorAll('.day-btn.active')].map(b => Number(b.dataset.day));
  const data = {
    enabled:   $('schedEnabled').checked,
    startTime: $('schedStart').value,
    stopTime:  $('schedStop').value,
    days:      activeDays,
  };
  const r = await post(API.schedule, data);
  if (r.ok) { S.schedule = data; toast('Schedule saved!', 'success'); updateSchedBadge(data.enabled); renderSchedInfo(data); }
  else toast('Save failed', 'error');
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
  if ($('anSessions'))    $('anSessions').textContent    = d.totalSessions ?? (d.sessions || []).length;
  if ($('anErrors'))      $('anErrors').textContent      = d.errorCount || 0;

  const rot    = d.rotationCounts || {};
  const maxRot = Math.max(1, ...Object.values(rot));
  if ($('anText2Rot')) $('anText2Rot').textContent =
    (rot.text1 || 0) + (rot.text2 || 0) + (rot.text3 || 0) + (rot.text4 || 0);

  ['anT1','anT2','anImg'].forEach((id, i) => {
    const key = ['text1','text2','images'][i];
    if ($(id)) $(id).textContent = rot[key] || 0;
  });
  ['anT1Bar','anT2Bar','anImgBar'].forEach((id, i) => {
    const key = ['text1','text2','images'][i];
    if ($(id)) $(id).style.width = Math.floor((rot[key] || 0) / maxRot * 100) + '%';
  });

  setBar('anCpuBar', 'anCpu', d.cpu || 0, '%');
  setBar('anRamBar', 'anRam', d.ram || 0, '%');
  if ($('anRamDetail')) $('anRamDetail').textContent = `${d.ramUsed || 0} GB / ${d.ramTotal || 0} GB`;

  const list = $('sessionHistory');
  if (list) {
    const sessions = (d.sessions || []).slice().reverse();
    list.innerHTML = !sessions.length
      ? '<div class="empty-state" style="padding:20px"><p>No sessions recorded yet</p></div>'
      : sessions.map(s => {
          const ok = s.exitCode === 0 || s.exitCode === null;
          return `<div class="session-item">
            <div class="session-dot ${ok ? 'session-ok' : 'session-err'}"></div>
            <span class="session-ts">${fmtDateTime(new Date(s.start).toISOString())}</span>
            <span class="session-dur">${fmtUptimeLong(s.uptime || 0)}</span>
            <span class="badge ${ok ? 'badge-success' : 'badge-danger'}" style="font-size:10px">${ok ? 'Clean' : `Exit ${s.exitCode}`}</span>
          </div>`;
        }).join('');
  }

  _initCharts(d);
}

// ── Charts ─────────────────────────────────────────────────────────
function _initCharts(data) {
  if (!window.Chart) return;
  const rot  = data.rotationCounts || {};
  const sess = (data.sessions || []).slice(-10);
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const gridColor  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
  const tickColor  = isDark ? '#8a7278' : '#7a6268';

  const totalRot = Object.values(rot).reduce((a, b) => a + b, 0);
  const rotCtx = document.getElementById('chartRotation');
  if (rotCtx) {
    if (_chartRot) _chartRot.destroy();
    const rotData = [rot.text1||0, rot.text2||0, rot.images||0, rot.customStatus||0, rot.spotify||0, rot.url||0];
    const hasData = rotData.some(v => v > 0);
    document.getElementById('chartRotEmpty').style.display = hasData ? 'none' : '';
    if (hasData) {
      _chartRot = new Chart(rotCtx, {
        type: 'doughnut',
        data: {
          labels: ['Details', 'State', 'Images', 'Custom Status', 'Spotify', 'URLs'],
          datasets: [{ data: rotData, backgroundColor: ['#7a5060','#9a7080','#fb923c','#c084fc','#1DB954','#5b8def'], borderWidth: 0, hoverOffset: 6 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: {
            legend: { position: 'right', labels: { color: tickColor, font: { size: 11 }, padding: 10, boxWidth: 12 } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} rotations` } }
          }
        }
      });
    }
  }

  const sessCtx = document.getElementById('chartSessions');
  if (sessCtx) {
    if (_chartSess) _chartSess.destroy();
    document.getElementById('chartSessEmpty').style.display = sess.length ? 'none' : '';
    if (sess.length) {
      _chartSess = new Chart(sessCtx, {
        type: 'bar',
        data: {
          labels: sess.map(s => { const d = new Date(s.start); return `${d.getMonth()+1}/${d.getDate()}`; }),
          datasets: [{ label: 'Duration (min)', data: sess.map(s => Math.round((s.uptime||0)/60)),
            backgroundColor: sess.map(s => (s.exitCode===0||s.exitCode===null) ? 'rgba(74,222,128,0.6)' : 'rgba(248,113,113,0.6)'),
            borderColor:     sess.map(s => (s.exitCode===0||s.exitCode===null) ? '#4ade80'              : '#f87171'),
            borderWidth: 1, borderRadius: 4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: tickColor, font: { size: 10 } }, grid: { color: gridColor } },
            y: { ticks: { color: tickColor, font: { size: 10 } }, grid: { color: gridColor }, beginAtZero: true }
          }
        }
      });
    }
  }
}

// ── Profile Comparison ─────────────────────────────────────────────
function toggleCompare(id) {
  const idx = compareIds.indexOf(id);
  if (idx > -1) { compareIds.splice(idx, 1); }
  else if (compareIds.length < 2) { compareIds.push(id); }
  else { compareIds = [compareIds[1], id]; }
  renderProfiles();
  if (compareIds.length === 2) _showCompareModal();
}

function _showCompareModal() {
  const p1 = S.profiles.find(p => p.id === compareIds[0]);
  const p2 = S.profiles.find(p => p.id === compareIds[1]);
  if (!p1 || !p2) return;

  const c1 = p1.config || {}, c2 = p2.config || {};
  const cfg1 = c1.config || {}, cfg2 = c2.config || {};
  const opt1 = cfg1.options || {}, opt2 = cfg2.options || {};

  const row = (label, v1, v2) => {
    const diff = String(v1) !== String(v2);
    return `<tr class="${diff ? 'cmp-diff' : ''}">
      <td class="cmp-label">${escHtml(label)}</td>
      <td class="cmp-val">${escHtml(String(v1 ?? '—'))}</td>
      <td class="cmp-val">${escHtml(String(v2 ?? '—'))}</td>
    </tr>`;
  };

  const rows = [
    row('Rotation Delay', (c1.setup?.delay||60)+'s', (c2.setup?.delay||60)+'s'),
    row('Status',         opt1.status||'online',      opt2.status||'online'),
    row('Activity Name',  opt1['activity-name']||'—', opt2['activity-name']||'—'),
    row('Details (text-1)',   (cfg1['text-1']||[]).length+' items', (cfg2['text-1']||[]).length+' items'),
    row('State (text-2)',     (cfg1['text-2']||[]).length+' items', (cfg2['text-2']||[]).length+' items'),
    row('Large Images',       (cfg1['bigimg']||[]).length+' items', (cfg2['bigimg']||[]).length+' items'),
    row('Small Images',       (cfg1['smallimg']||[]).length+' items', (cfg2['smallimg']||[]).length+' items'),
    row('Watch URLs',         (opt1['watch-url']||[]).length,         (opt2['watch-url']||[]).length),
    row('Custom Status',      cfg1.customStatus?.enabled?'On':'Off',  cfg2.customStatus?.enabled?'On':'Off'),
    row('CS Messages',        (cfg1.customStatus?.messages||[]).length, (cfg2.customStatus?.messages||[]).length),
    row('CS Interval',        (cfg1.customStatus?.intervalSec||300)+'s', (cfg2.customStatus?.intervalSec||300)+'s'),
    row('Spotify',            cfg1.spotify?.enabled?'On':'Off',  cfg2.spotify?.enabled?'On':'Off'),
    row('Spotify Tracks',     (cfg1.spotify?.tracks||[]).length, (cfg2.spotify?.tracks||[]).length),
    row('Human Mode',         opt1.humanMode!==false?'On':'Off', opt2.humanMode!==false?'On':'Off'),
    row('Strict Verify',      opt1.strictVerify!==false?'On':'Off', opt2.strictVerify!==false?'On':'Off'),
  ];

  $('cmpTitle1').textContent = p1.name;
  $('cmpTitle2').textContent = p2.name;
  $('cmpTableBody').innerHTML = rows.join('');
  $('cmpApplyA').onclick = () => { applyProfile(p1.id); closeCompareModal(); };
  $('cmpApplyB').onclick = () => { applyProfile(p2.id); closeCompareModal(); };
  $('compareModal').style.display = 'flex';
}

function closeCompareModal(e) {
  if (e && e.target !== $('compareModal')) return;
  $('compareModal').style.display = 'none';
}

// ── Presets ────────────────────────────────────────────────────────
const PRESETS = [
  {
    name: 'Gaming Stream',
    desc: 'Classic gaming streaming setup with rotating game info',
    data: { 'text-1': ['Live gaming session'], 'text-2': ['In-game right now...', 'Grinding ranked...', 'On the battlefield...'], 'text-3': ['Gaming Stream'] }
  },
  {
    name: 'Night Vibes',
    desc: 'Aesthetic late-night chill stream',
    data: { 'text-1': ['Night vibes live'], 'text-2': ['Late night session...', 'Coffee & streams...', "Can't sleep streaming..."], 'text-3': ['stay cozy'] }
  },
  {
    name: 'Coding Live',
    desc: 'Developer stream with CPU & uptime display',
    data: { 'text-1': ['Coding session'], 'text-2': ['Writing code live...', 'Debugging sessions...', 'Building in public...'], 'text-3': ['Developer stream'] }
  },
  {
    name: 'Music & Chill',
    desc: 'Music-focused stream aesthetic',
    data: { 'text-1': ['Now streaming'], 'text-2': ['Lost in the music...', 'Vibing right now...', 'Full audio mode...'], 'text-3': ['Stream & Chill'] }
  },
  {
    name: 'System Monitor',
    desc: 'Show real-time system resource info',
    data: { 'text-1': ['System monitor live'], 'text-2': ['Monitoring system...', 'Checking performance...', 'Live diagnostics...'], 'text-3': ['System Monitoring Mode'] }
  },
  {
    name: 'Time Display',
    desc: 'Dynamic time display in presence',
    data: { 'text-1': ['Streaming now'], 'text-2': ['Watch me live...', 'Come join!', 'Live stream active'], 'text-3': ['Live stream'] }
  },
];

function renderPresets() {
  const grid = $('presetsGrid');
  if (!grid) return;
  grid.innerHTML = PRESETS.map((p, i) => `
    <div class="preset-card" onclick="applyPreset(${i})">
      <div class="preset-name">${escHtml(p.name)}</div>
      <div class="preset-desc">${escHtml(p.desc)}</div>
    </div>`).join('');
}

function applyPreset(i) {
  const p = PRESETS[i];
  S.fields.text1 = p.data['text-1'] || [];
  S.fields.text2 = p.data['text-2'] || [];
  S.fields.text3 = p.data['text-3'] || [];
  renderStreamEditors(); startPreviewRotation();
  toast(`Preset "${p.name}" loaded!`, 'success');
}

// ── Tabs ───────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
}

// ── Export / Import ────────────────────────────────────────────────
async function exportConfig() {
  const d = await get(API.export);
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `streamdash-config-${Date.now()}.json`; a.click();
  toast('Config exported!', 'success');
}

async function importConfig(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await post(API.import, data);
    if (r.ok) { toast('Config imported!', 'success'); await loadSettings(); }
    else toast('Import failed', 'error');
  } catch { toast('Invalid JSON file', 'error'); }
}

// ── Webhook ────────────────────────────────────────────────────────
async function testWebhook() {
  const url = $('webhookUrl')?.value.trim();
  if (!url) { toast('Enter a webhook URL first', 'error'); return; }
  const btn = $('testWebhookBtn');
  btn.textContent = 'Sending...'; btn.disabled = true;
  const r = await post(API.webhookTest, { url });
  btn.textContent = 'Test'; btn.disabled = false;
  if (r.ok) toast('Webhook test sent! Check Discord.', 'success');
  else toast('Webhook failed: ' + (r.error || 'unknown'), 'error');
}

async function saveWebhook() {
  const url = $('webhookUrl')?.value.trim();
  const r = await post(API.env, { webhookUrl: url });
  if (r.ok) toast('Webhook saved!', 'success');
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
  applyTheme(S.theme);

  document.querySelectorAll('.nav-item, .mnav-item').forEach(el => {
    el.addEventListener('click', () => goTo(el.dataset.section));
  });

  $('themeBtn')?.addEventListener('click', () => applyTheme(S.theme === 'dark' ? 'light' : 'dark'));
  document.querySelectorAll('.theme-opt[data-t]').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.t));
  });

  document.querySelectorAll('.theme-opt[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.lang = btn.dataset.lang;
      localStorage.setItem('lang', S.lang);
      document.documentElement.lang = S.lang;
      document.documentElement.dir  = S.lang === 'ar' ? 'rtl' : 'ltr';
      document.querySelectorAll('.theme-opt[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === S.lang));
      toast(S.lang === 'ar' ? 'تم تغيير اللغة' : 'Language changed', 'info');
    });
  });

  $('startBtn')?.addEventListener('click', async () => {
    const btn = $('startBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    try {
      const r = await post(API.start, {});
      if (r.ok || r.status) {
        const ic = r.imageCheck;
        if (ic && ic.checked > 0) {
          if (ic.refreshed > 0 && ic.failed === 0) {
            toast(`Bot starting — ${ic.refreshed} image URL(s) refreshed ✓`, 'success');
          } else if (ic.failed > 0) {
            toast(`Bot starting — ${ic.failed} image(s) couldn't refresh (check token)`, 'warn');
          } else {
            toast(`Bot starting — all ${ic.checked} image(s) verified ✓`, 'success');
          }
        } else {
          toast('Bot starting…', 'info');
        }
      } else {
        toast(r.error || 'Already running', 'error');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
      }
    }
  });
  $('stopBtn')?.addEventListener('click', async () => {
    const r = await post(API.stop, {});
    if (r.ok) toast('Stop signal sent', 'info');
    else toast(r.error || 'Not running', 'error');
  });
  $('refreshRuntimeBtn')?.addEventListener('click', refreshRuntime);

  $('validateAllBtn')?.addEventListener('click', () => renderTokenCards());
  $('saveTokensBtn')?.addEventListener('click', saveTokens);
  $('testNewTokensBtn')?.addEventListener('click', async () => {
    const tokens = $('tokenInput').value.split('\n').map(t => t.trim()).filter(Boolean);
    if (!tokens.length) { toast('No tokens to validate', 'error'); return; }
    S.rawTokens = tokens;
    goTo('tokens');
    renderTokenCards();
  });

  $('detectAppBtn')?.addEventListener('click', detectApps);

  $('savePresenceBtn')?.addEventListener('click', savePresence);
  $('refreshPresenceBtn')?.addEventListener('click', refreshPresence);
  $('watchUrls')?.addEventListener('input', () => { renderPreview(); startPreviewRotation(); });
  $('activityName')?.addEventListener('input', renderPreview);
  $('presenceStatus')?.addEventListener('change', renderPreview);
  $('delay')?.addEventListener('input', startPreviewRotation);
  $('addDetailsBtn')?.addEventListener('click', () => addLine('text1'));
  $('addStateBtn')?.addEventListener('click', () => addLine('text2'));
  $('addLargeTextBtn')?.addEventListener('click', () => addLine('text3'));
  $('addSmallTextBtn')?.addEventListener('click', () => addLine('text4'));
  $('addLargeImageBtn')?.addEventListener('click', () => $('largeImageUpload')?.click());
  $('addSmallImageBtn')?.addEventListener('click', () => $('smallImageUpload')?.click());
  $('checkImagesBtn')?.addEventListener('click', checkImages);
  $('largeImageUpload')?.addEventListener('change', e => uploadImages(e.target.files, 'bigimg').then(() => { e.target.value = ''; }));
  $('smallImageUpload')?.addEventListener('change', e => uploadImages(e.target.files, 'smallimg').then(() => { e.target.value = ''; }));
  $('addCustomStatusBtn')?.addEventListener('click', addCustomStatusMessage);
  $('loadEmojiBtn')?.addEventListener('click', () => loadEmojiPicker(false));
  $('emojiSearch')?.addEventListener('input', () => { S.emojiPage = 0; renderEmojiGrid(); });
  $('emojiPrevBtn')?.addEventListener('click', () => { S.emojiPage = Math.max(0, S.emojiPage - 1); renderEmojiGrid(); });
  $('emojiNextBtn')?.addEventListener('click', () => { S.emojiPage += 1; renderEmojiGrid(); });
  $('customStatusEnabled')?.addEventListener('change', e => {
    S.customStatus.enabled = e.target.checked;
    if ($('csFields')) $('csFields').style.display = e.target.checked ? '' : 'none';
    renderCustomStatusPreview();
  });
  $('customStatusDelay')?.addEventListener('input', e => {
    S.customStatus.intervalSec = Math.max(1, Number(e.target.value) || 1) * 60;
  });

  document.addEventListener('input', e => {
    const lineKey = e.target.dataset?.lineKey;
    if (lineKey) {
      const i = Number(e.target.dataset.index);
      S.fields[lineKey][i] = e.target.value;
      resetPreviewRotation();
      renderPreview();
      startPreviewRotation();
      return;
    }

    const spotifyTrack = e.target.dataset?.spotifyTrack;
    if (spotifyTrack !== undefined) {
      const i = Number(spotifyTrack);
      const field = e.target.dataset.spotifyField;
      const track = S.spotify.tracks?.[i];
      if (!track || !field) return;
      S.spotify.activeTrack = i;
      track[field] = field === 'duration'
        ? Math.max(Number(e.target.value) || 10, 10)
        : e.target.value;
      renderSpotifyPreview();
      return;
    }

    const csField = e.target.dataset?.csField;
    if (csField) {
      const i = Number(e.target.dataset.index);
      S.customStatus.messages[i][csField] = e.target.value;
      S.activeCsIndex = i;
      renderCustomStatusPreview();
    }
  });

  document.addEventListener('focusin', e => {
    const spotifyTrack = e.target.dataset?.spotifyTrack;
    if (spotifyTrack !== undefined) {
      S.spotify.activeTrack = Number(spotifyTrack);
      renderSpotifyPreview();
    }

    const csField = e.target.dataset?.csField;
    if (csField) {
      S.activeCsIndex = Number(e.target.dataset.index);
      renderEmojiGrid();
      renderCustomStatusPreview();
    }
  });

  document.addEventListener('click', e => {
    const removeLine = e.target.closest('[data-remove-line]');
    if (removeLine) {
      const key = removeLine.dataset.removeLine;
      S.fields[key].splice(Number(removeLine.dataset.index), 1);
      resetPreviewRotation();
      renderStreamEditors();
      startPreviewRotation();
      return;
    }

    const removeCs = e.target.closest('[data-remove-cs]');
    if (removeCs) {
      S.customStatus.messages.splice(Number(removeCs.dataset.removeCs), 1);
      S.activeCsIndex = Math.max(0, Math.min(S.activeCsIndex, S.customStatus.messages.length - 1));
      renderStreamEditors();
      renderCustomStatusPreview();
      return;
    }

    const pickCs = e.target.closest('[data-cs-pick]');
    if (pickCs) {
      S.activeCsIndex = Number(pickCs.dataset.csPick);
      renderCustomStatusRows();
      renderEmojiGrid();
      renderCustomStatusPreview();
      return;
    }

    const emojiChoice = e.target.closest('[data-emoji-value]');
    if (emojiChoice) {
      if (!S.customStatus.messages.length) addCustomStatusMessage();
      const idx = Math.max(0, Math.min(S.activeCsIndex, S.customStatus.messages.length - 1));
      S.customStatus.messages[idx].emoji = emojiChoice.dataset.emojiValue || '';
      renderCustomStatusRows();
      renderEmojiGrid();
      renderCustomStatusPreview();
      return;
    }

    const removeSpotify = e.target.closest('[data-remove-spotify]');
    if (removeSpotify) {
      const i = Number(removeSpotify.dataset.removeSpotify);
      S.spotify.tracks.splice(i, 1);
      if (!S.spotify.tracks.length) S.spotify.tracks.push(emptySpotifyTrack());
      S.spotify.activeTrack = Math.max(0, Math.min(S.spotify.activeTrack, S.spotify.tracks.length - 1));
      renderSpotifyTrackRows();
      renderSpotifyPreview();
      return;
    }

    const spotifyArt = e.target.closest('[data-spotify-art]');
    if (spotifyArt) {
      S.spotify.activeTrack = Number(spotifyArt.dataset.spotifyArt);
      $('spotifyArtUpload')?.click();
      return;
    }

    const spotifyRow = e.target.closest('[data-spotify-row]');
    if (spotifyRow && !e.target.closest('input,button')) {
      S.spotify.activeTrack = Number(spotifyRow.dataset.spotifyRow);
      renderSpotifyTrackRows();
      renderSpotifyPreview();
    }
  });

  // Music page
  $('saveMusicBtn')?.addEventListener('click', saveMusic);
  $('addSpotifyTrackBtn')?.addEventListener('click', addSpotifyTrack);
  $('spotifyArtUpload')?.addEventListener('change', e => uploadSpotifyArt(e.target.files, S.spotify.activeTrack).then(() => { e.target.value = ''; }));
  $('spotifyArtUrl')?.addEventListener('input', e => {
    const track = activeSpotifyTrack(true);
    if (track) track.albumArtUrl = e.target.value.trim();
    renderSpotifyTrackRows();
    renderSpotifyPreview();
  });
  $('spotifyDuration')?.addEventListener('input', e => {
    const track = activeSpotifyTrack(true);
    if (track) track.duration = Math.max(Number(e.target.value) || 10, 10);
    renderSpotifyTrackRows();
    renderSpotifyPreview();
  });

  $('saveProfileBtn')?.addEventListener('click', () => {
    const p = $('saveProfilePanel');
    p.style.display = p.style.display === 'none' ? '' : 'none';
  });
  $('confirmSaveProfile')?.addEventListener('click', saveCurrentProfile);

  $('saveScheduleBtn')?.addEventListener('click', saveSchedule);
  document.querySelectorAll('.day-btn').forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('active')));

  $('refreshStatsBtn')?.addEventListener('click', loadAnalytics);
  $('clearErrBtn')?.addEventListener('click', async () => {
    await del(API.logs);
    $('errorLog').innerHTML = '';
    $('errCount').textContent = '0';
    toast('Logs cleared', 'info');
  });

  $('testWebhookBtn')?.addEventListener('click', testWebhook);
  $('saveWebhookBtn')?.addEventListener('click', saveWebhook);
  $('exportBtn')?.addEventListener('click', exportConfig);
  $('importFile')?.addEventListener('change', e => importConfig(e.target.files[0]));

  $('clearLogsBtn')?.addEventListener('click', async () => {
    await del(API.logs);
    clearLogBoxes();
    toast('Logs cleared', 'info');
  });

  $('menuBtn')?.addEventListener('click', () => $('sidebar').classList.toggle('open'));
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => $('sidebar')?.classList.remove('open'));
  });

  if (S.lang === 'ar') {
    document.documentElement.lang = 'ar';
    document.documentElement.dir  = 'rtl';
    document.querySelectorAll('.theme-opt[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === 'ar'));
  }

  await Promise.all([loadSettings(), loadEnv()]);
  connectWS();

  // Load initial rate-limit state
  try {
    const rlData = await get(API.ratelimits);
    if (rlData?.limits?.length) renderRateLimits(rlData.limits);
  } catch {}

  // Refresh time-based variables in preview every 30 seconds
  setInterval(() => { if (S._text2Lines?.length) renderPreview(); }, 30000);
  setInterval(() => { if (S.section === 'analytics') loadAnalytics(); }, 10000);

  // ── Kill-switch wiring ──
  $('cleanupImagesBtn')?.addEventListener('click', async () => {
    const btn = $('cleanupImagesBtn');
    const result = $('cleanupResult');
    setBusyButton(btn, true, 'Scanning…');
    result.style.display = 'none';
    try {
      const r = await post('/api/uploads/cleanup', {});
      if (!r.ok) { toast('Cleanup failed', 'error'); return; }
      const d = await r.json();
      if (d.error) { toast(d.error, 'error'); return; }
      const freed = d.freed >= 1024 * 1024
        ? `${(d.freed / 1024 / 1024).toFixed(1)} MB`
        : `${(d.freed / 1024).toFixed(1)} KB`;
      result.style.display = 'block';
      if (d.deleted === 0) {
        result.style.color = 'var(--text-dim)';
        result.textContent = `Nothing to clean — all ${d.kept} image(s) are in use.`;
      } else {
        result.style.color = 'var(--success)';
        result.textContent = `Deleted ${d.deleted} file(s), freed ${freed}. ${d.kept} image(s) kept.`;
        toast(`Cleaned ${d.deleted} image(s) — ${freed} freed`, 'success');
      }
    } catch (e) {
      toast('Cleanup error: ' + e.message, 'error');
    } finally {
      setBusyButton(btn, false);
    }
  });

  $('killSwitchBtn')?.addEventListener('click', () => {
    $('killModal').style.display = 'flex';
  });
  $('cancelKillBtn')?.addEventListener('click', () => {
    $('killModal').style.display = 'none';
  });
  $('confirmKillBtn')?.addEventListener('click', async () => {
    const btn = $('confirmKillBtn');
    btn.disabled = true;
    btn.innerHTML = `<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg> Stopping...`;
    try { await fetch('/api/shutdown', { method: 'POST' }); } catch {}
    document.body.innerHTML = `
      <div class="stopped-screen">
        <div class="stopped-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#9a7080" stroke-width="1.8">
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
          </svg>
        </div>
        <h2 class="stopped-title">Server Stopped</h2>
        <p class="stopped-sub">StreamDash أُوقف بنجاح.<br>يمكنك إغلاق هذه النافذة.</p>
      </div>`;
  });
});
