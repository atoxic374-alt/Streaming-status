const i18n = {
  en: { title: 'Streaming Control Center', subtitle: 'Complete streaming control and real runtime monitor.', save: 'Save Settings' },
  ar: { title: 'لوحة تحكم الستريمنق', subtitle: 'تحكم كامل بالستريمنق مع مراقبة تشغيل فعلية.', save: 'حفظ الإعدادات' }
};
let lang = localStorage.getItem('lang') || 'en';
const toLines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
const fromLines = (arr) => (arr || []).join('\n');

function appendLog(m) {
  const log = document.getElementById('log');
  log.insertAdjacentHTML('beforeend', `<div>${m}</div>`);
  log.scrollTop = log.scrollHeight;
}

function renderPreview() {
  pv1.textContent = toLines(text1.value)[0] || 'Primary status';
  pv2.textContent = toLines(text2.value)[0] || 'Secondary status';
  pv3.textContent = toLines(text3.value)[0] || 'Footer status';
  pvBtn1.textContent = btn1Name.value || 'Primary Action';
  pvBtn2.textContent = btn2Name.value || 'Secondary Action';
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  title.textContent = i18n[lang].title;
  subtitle.textContent = i18n[lang].subtitle;
  saveBtn.textContent = i18n[lang].save;
}

function applyRuntime(rt) {
  runState.textContent = rt.running ? 'Yes' : 'No';
  runPid.textContent = rt.pid || '-';
  runTokens.textContent = rt.tokensConfigured;
  runCookie.textContent = rt.cookieAuth ? 'Yes' : 'No';
  log.innerHTML = '';
  (rt.lastLogs || []).forEach((line) => appendLog(line));
}

async function refreshRuntime() {
  const rt = await fetch('/api/runtime').then((r) => r.json());
  applyRuntime(rt);
}

async function load() {
  const data = await fetch('/api/settings').then((r) => r.json());
  window.settings = data;
  tokens.value = data.tokens.join('\n');
  city.value = data.config.setup?.city || '';
  delay.value = data.config.setup?.delay || 10;
  watchUrls.value = fromLines(data.config.config?.options?.['watch-url'] || data.config.config['watch-url']);
  bigimg.value = fromLines(data.config.config.bigimg);
  primaryColor.value = localStorage.getItem('themePrimary') || '#79b8ff';
  bgColor.value = localStorage.getItem('themeBg') || '#0b1220';
  orbSpeed.value = Number(localStorage.getItem('orbSpeed') || 14);
  smallimg.value = fromLines(data.config.config.smallimg);
  text1.value = fromLines(data.config.config['text-1']);
  text2.value = fromLines(data.config.config['text-2']);
  text3.value = fromLines(data.config.config['text-3']);
  btn1Name.value = data.config.config['button-1']?.[0]?.name || '';
  btn1Url.value = data.config.config['button-1']?.[0]?.url || '';
  btn2Name.value = data.config.config['button-2']?.[0]?.name || '';
  btn2Url.value = data.config.config['button-2']?.[0]?.url || '';
  applyRuntime(data.runtime);
  applyTheme();
  applyLang();
  renderPreview();
}

async function save() {
  const payload = structuredClone(window.settings);
  payload.tokens = toLines(tokens.value);
  payload.config.setup.city = city.value.trim();
  payload.config.setup.delay = Number(delay.value) || 10;
  payload.config.config.options = payload.config.config.options || {};
  payload.config.config.options['watch-url'] = toLines(watchUrls.value);
  payload.config.config.bigimg = toLines(bigimg.value);
  payload.config.config.smallimg = toLines(smallimg.value);
  payload.config.config['text-1'] = toLines(text1.value);
  payload.config.config['text-2'] = toLines(text2.value);
  payload.config.config['text-3'] = toLines(text3.value);
  payload.config.config['button-1'] = [{ name: btn1Name.value.trim(), url: btn1Url.value.trim() }];
  payload.config.config['button-2'] = [{ name: btn2Name.value.trim(), url: btn2Url.value.trim() }];
  await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  appendLog('Settings saved');
  await refreshRuntime();
}

langBtn.onclick = () => { lang = lang === 'en' ? 'ar' : 'en'; localStorage.setItem('lang', lang); applyLang(); };
saveBtn.onclick = save;
startBtn.onclick = async () => { await fetch('/api/runtime/start', { method: 'POST' }); await refreshRuntime(); };
stopBtn.onclick = async () => { await fetch('/api/runtime/stop', { method: 'POST' }); await refreshRuntime(); };

[tokens, city, delay, watchUrls, bigimg, smallimg, text1, text2, text3, btn1Name, btn2Name].forEach((el) => el.addEventListener('input', renderPreview));
[pv1, pv2, pv3].forEach((el, idx) => el.addEventListener('input', () => {[text1, text2, text3][idx].value = el.textContent; renderPreview();}));
pvBtn1.addEventListener('input', () => { btn1Name.value = pvBtn1.textContent; renderPreview(); });
pvBtn2.addEventListener('input', () => { btn2Name.value = pvBtn2.textContent; renderPreview(); });

setInterval(refreshRuntime, 4000);
load();

function applyTheme(){document.documentElement.style.setProperty('--primary', primaryColor.value);document.documentElement.style.setProperty('--bg', bgColor.value);document.documentElement.style.setProperty('--orb-speed', `${Number(orbSpeed.value)||14}s`);localStorage.setItem('themePrimary',primaryColor.value);localStorage.setItem('themeBg',bgColor.value);localStorage.setItem('orbSpeed',String(Number(orbSpeed.value)||14));}
[primaryColor,bgColor,orbSpeed].forEach(el=>el.addEventListener('input',applyTheme));
