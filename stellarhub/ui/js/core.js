/* StellarHub · core: utilities, animation engine, icons, PC data and module registry.
   Everything hangs off window.SH. See docs/UI_CONTRACT.md for how modules and Home views are written. */
'use strict';
(() => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ROOT = document.documentElement;
const t = (window.SH && SH.t) || (s => s); // i18n.js ran first
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- state and settings ---------- */
const DEFAULTS = {
  theme: 'deep', accent: '#FF7A66', accent2: '#9ED6FF', zoom: 'auto', intensity: reduceMQ.matches ? 'min' : 'max',
  stars: true, camera: true, parallax: true, homeVariant: 'bento', adminHints: true, trayOnClose: true,
  startWithWindows: false, autoUpdate: true, skipVersion: '', language: 'auto', density: 'comfortable', sounds: false,
  widgetStats: ['cpu', 'gpu', 'gpuTemp', 'ram', 'down', 'ping'], widgetLayout: 'grid',
  starCount: 400, starSpeed: 1.5, starBright: 1.2, widgetMode: 'full', widgetWasOpen: false, alwaysAdmin: false, twinkle: true, shooting: true, nebula: 1, animSpeed: 1, panelAlpha: 1.75, corners: 'mid',
  countUp: true, startView: 'home', quickActions: true, confirmDanger: true, teleRate: '1000', lastView: 'home',
};
const state = { view: 'home', admin: false, palOpen: false, setOpen: false, version: '0.2.0', settings: { ...DEFAULTS } };
const FACT = { max: 1, normal: .72, min: .3 };
const ORBIT = { max: 1, normal: .55, min: 0 };
const motion = () => FACT[state.settings.intensity] ?? 1;

/* simple events between parts of the UI */
const bus = {};
const on = (ev, fn) => { (bus[ev] ||= new Set()).add(fn); return () => bus[ev].delete(fn); };
const emit = (ev, data) => (bus[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });

/* bridge to Python (window.pywebview.api); outside the app it falls back to localStorage */
const api = () => (window.pywebview && window.pywebview.api) || null;
/* Inside the app (WebView2 always exposes window.chrome.webview) the bridge to Python can take several seconds on
   a slow start (elevated relaunch, first launch while Defender scans the files): wait for it, polling as a fallback
   in case the ready event fired before this script ran. In a normal browser there is no bridge: sample mode. */
const IN_APP = !!(window.chrome && window.chrome.webview);
const apiReady = new Promise(res => {
  if (api()) return res(api());
  addEventListener('pywebviewready', () => res(api()), { once: true });
  if (!IN_APP) { setTimeout(() => res(api()), 1200); return; }
  const t0 = Date.now(), poll = setInterval(() => {
    if (api() || Date.now() - t0 > 60000) { clearInterval(poll); res(api()); }
  }, 100);
});
async function call(name, ...args) {
  const a = await apiReady;
  if (!a) return undefined;
  /* pywebview can announce the API before all its methods are attached (seen right after relaunching as
     administrator): wait for the method instead of answering "nothing" to whoever asked first */
  const api = () => (window.pywebview && window.pywebview.api) || a;
  for (let i = 0; typeof api()[name] !== 'function' && i < 60; i++) await new Promise(r => setTimeout(r, 100));
  const target = api();
  if (typeof target[name] !== 'function') { console.error(`API method missing: ${name}`); return undefined; }
  try { return await target[name](...args); } catch (e) { console.error(name, e); return undefined; }
}
/* UI errors -> app log */
const reportErr = m => { try { if (window.pywebview && window.pywebview.api && window.pywebview.api.log_js_error) window.pywebview.api.log_js_error(String(m)); } catch {} };
addEventListener('error', e => reportErr(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', e => reportErr(`promise: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`));
const _cerr = console.error.bind(console); console.error = (...a) => { _cerr(...a); reportErr(a.map(x => x && x.stack || x).join(' ')); };

/* real engine (stellarhub/engine/<mod>.py). Outside the app these return undefined: the module uses its sample mode.
   SH.engine('drivers', 'list') -> data (throws Error if the engine fails)
   SH.job('drivers', 'search', [args], { onProgress(msg), onLog(lines) }) -> promise with the result; .cancel() */
async function engine(mod, fn, ...args) {
  const r = await call('engine', mod, fn, args);
  if (r === undefined) return undefined;
  if (!r.ok) throw new Error(r.error || t('the engine failed'));
  return r.data;
}
const jobWaiters = new Map();
on('job', m => {
  const w = jobWaiters.get(m.id); if (!w) return;
  if (m.kind === 'progress' || m.kind === 'end') { try { w.o.onProgress && w.o.onProgress(m); } catch (e) { console.error(e); } }
  if (m.log && w.o.onLog) { try { w.o.onLog(m.log); } catch (e) { console.error(e); } }
  if (m.kind === 'end') {
    jobWaiters.delete(m.id);
    if (m.state === 'done') w.res(m.result); else if (m.state === 'cancelled') w.rej(Object.assign(new Error('cancelled'), { cancelled: true }));
    else w.rej(new Error((m.result && m.result.error) || t('the task failed')));
  }
});
function job(mod, fn, args = [], o = {}) {
  let id = null, cancelWanted = false;
  const p = new Promise(async (res, rej) => {
    const r = await call('engine_job', mod, fn, args);
    if (r === undefined) { res(undefined); return; }
    if (!r.ok) { rej(new Error(r.error)); return; }
    id = r.id; jobWaiters.set(id, { res, rej, o }); if (cancelWanted) call('job_cancel', id);
  });
  p.cancel = () => { cancelWanted = true; if (id) call('job_cancel', id); };
  return p;
}
async function loadSettings() {
  let saved = await call('settings_get');
  if (saved === undefined) { try { saved = JSON.parse(localStorage.getItem('sh.settings') || '{}'); } catch { saved = {}; } }
  Object.assign(state.settings, saved || {});
  /* the language lives in the settings; i18n.js read a local copy to translate before this point. If they differ
     (first start after installing in another language, or changed elsewhere), switch once. */
  const L = window.SH && SH.i18n;
  if (L) {
    const pref = state.settings.language || 'auto';
    if (pref !== L.pref) {
      L.remember(pref);
      let ok = false; try { ok = localStorage.getItem('sh.lang') === pref; } catch {}
      if (ok && L.resolve(pref) !== L.lang) location.reload(); // only if it really changes, and never in a loop
    }
  }
}
function setSetting(key, val) {
  if (state.settings[key] === val) return;
  state.settings[key] = val;
  call('settings_set', { [key]: val }).then(r => {
    if (r === undefined) { try { localStorage.setItem('sh.settings', JSON.stringify(state.settings)); } catch {} }
  });
  emit('setting', { key, val });
}

/* ---------- springs ---------- */
class Spring {
  constructor(v = 0, k = 170, c = 24) { this.v = v; this.t = v; this.vel = 0; this.k = k; this.c = c; }
  set(v) { this.v = this.t = v; this.vel = 0; return this; }
  step(dt) {
    const it = state.settings.intensity;
    if (it === 'min') { this.v = this.t; this.vel = 0; return this.v; }
    const k = it === 'normal' ? this.k * 1.5 : this.k, c = it === 'normal' ? this.c * 1.22 : this.c;
    const n = Math.ceil(dt / 0.008), h = dt / n;
    for (let i = 0; i < n; i++) { const a = -k * (this.v - this.t) - c * this.vel; this.vel += a * h; this.v += this.vel * h; }
    return this.v;
  }
  get idle() { return Math.abs(this.v - this.t) < 1e-3 && Math.abs(this.vel) < 1e-3; }
}
function springEase(k = 180, c = 19) {
  let x = 0, v = 0; const pts = []; const h = 1 / 60;
  for (let i = 0; i <= 60; i++) { pts.push(+x.toFixed(4)); for (let j = 0; j < 4; j++) { const a = -k * (x - 1) - c * v; v += a * h / 4; x += v * h / 4; } }
  pts[pts.length - 1] = 1; return `linear(${pts.join(',')})`;
}
const EASE = { out: 'cubic-bezier(.16,1,.3,1)', io: 'cubic-bezier(.62,0,.18,1)', spring: springEase(), soft: springEase(120, 17), snappy: springEase(300, 26),
  glide: springEase(150, 22) /* settles without overshoot: smooth view and tab changes */ };

/* WAAPI with the motion intensity applied. Cancels whatever the element was animating (interruptible). */
function anim(el, kf, o = {}) {
  if (!el) return null;
  /* only animations made with anim() are interrupted; CSS transitions carry on */
  if (!o.keep) el.getAnimations().forEach(a => { if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) return; try { a.commitStyles(); } catch {} a.cancel(); });
  const d = Math.max(1, (o.d ?? 400) * motion());
  return el.animate(kf, { duration: d, delay: (o.delay || 0) * motion(), easing: o.e || EASE.out, fill: o.fill || 'both' });
}
/* staggered entrance of everything marked [data-asm] inside a container */
function assemble(root, base = 0, step = 40, sel = '[data-asm]') {
  $$(sel, root).forEach((el, i) => anim(el, [
    { opacity: 0, transform: 'translate3d(0,14px,0) scale(.97)' },
    { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }
  ], { d: 520, delay: base + Math.min(i, 14) * step, e: EASE.spring }));
}

/* single per-frame animation loop */
const tickers = new Set(); let last = performance.now();
function loop(t) { const dt = Math.min(.05, (t - last) / 1000); last = t; for (const fn of tickers) { try { fn(dt, t); } catch (e) { console.error(e); tickers.delete(fn); } } requestAnimationFrame(loop); }
requestAnimationFrame(loop);

/* ---------- formatting ---------- */
/* numbers follow the interface language (1,234.5 in English, 1.234,5 in Spanish...) */
const LOCALE = (window.SH && SH.i18n && SH.i18n.locale) || 'en-US';
const fmt1 = v => (+v).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtInt = v => Math.round(+v).toLocaleString(LOCALE);
function fmtBytes(b) { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? fmt1(b) : Math.round(b)) + ' ' + u[i]; }
function countUp(el, to, d = 900, dec = 0) {
  if (state.settings.countUp === false) { el.textContent = dec ? fmt1(to) : fmtInt(to); el.dataset.v = to; return; }
  const t0 = performance.now(), dur = Math.max(1, d * motion()); const from = +(el.dataset.v || 0);
  const f = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4), v = from + (to - from) * e;
    el.textContent = dec ? fmt1(v) : fmtInt(v); if (k < 1) requestAnimationFrame(f); else el.dataset.v = to; };
  requestAnimationFrame(f);
}
/* shrinks the font size until the text fits on one line */
function fitText(el, max, min = 14) {
  if (!el || !el.parentElement) return;
  el.style.whiteSpace = 'nowrap'; let s = max; el.style.fontSize = s + 'px';
  const w = el.parentElement.clientWidth;
  while (el.scrollWidth > w && s > min) { s -= 1; el.style.fontSize = s + 'px'; }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- icons (24×24 stroke) ---------- */
const P = {
  home: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(-22 12 12)"/>',
  monitor: '<path d="M3 12h3.5l2.5-6 4 12 2.5-6H21"/>',
  gamepad: '<path d="M7.5 7h9a5 5 0 0 1 4.9 4.1l.8 4.4a2.6 2.6 0 0 1-4.6 2.1L15.5 15h-7l-2.1 2.6a2.6 2.6 0 0 1-4.6-2.1l.8-4.4A5 5 0 0 1 7.5 7z"/><path d="M8 9.8v3M6.5 11.3h3M15.5 10h.01M17.5 12h.01"/>',
  drivers: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><path d="M12 9v6m-2.5-2.5L12 15l2.5-2.5"/>',
  remover: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>',
  updater: '<path d="M20 11a8 8 0 0 0-14.7-4.4L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.7 4.4L20 16"/><path d="M20 20v-4h-4"/>',
  storage: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M12 3v18M12 12h9M16.5 12v9"/>',
  optimizer: '<path d="M5 18a8 8 0 1 1 14 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.4"/>',
  tester: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10"/>',
  hangar: '<path d="M2.5 20.5h19"/><path d="M4 20.5v-9a8 6.5 0 0 1 16 0v9"/><path d="M8.5 20.5V14h7v6.5"/><path d="M12 14v6.5M8 8.5h8"/>',
  privacy: '<path d="M12 2.8 19.5 6v5.6c0 4.4-3.1 8.2-7.5 9.6-4.4-1.4-7.5-5.2-7.5-9.6V6Z"/><rect x="9.2" y="11" width="5.6" height="4.6" rx="1"/><path d="M10.4 11V9.6a1.6 1.6 0 0 1 3.2 0V11"/>',
  benchmark: '<circle cx="12" cy="13.5" r="7.5"/><path d="M10 2.5h4M12 2.5V6M18.2 6.8l1.6-1.6"/><path d="m12 13.5 3.2-3.2"/><circle cx="12" cy="13.5" r=".6"/>',
  autopilot: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/><path d="m9.5 14.5 1.6-4.2 4.2-1.6-1.6 4.2z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  gpu: '<rect x="2.5" y="6" width="19" height="11" rx="2"/><circle cx="9" cy="11.5" r="3"/><path d="M15 9.5h3.5M15 13h3.5M5 17v2.5M9 17v2.5"/>',
  ram: '<rect x="2.5" y="7" width="19" height="9" rx="1.5"/><path d="M6 10v3M10 10v3M14 10v3M18 10v3M2.5 19h19M7 16v3M17 16v3"/>',
  ssd: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h6"/><circle cx="16.5" cy="15" r="1"/><path d="M7 9h10"/>',
  display: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.2"/><path d="M21.5 10.5v3"/><path d="M6 10.5v3M9.5 10.5v3M13 10.5v3"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.7 16a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19.2" r=".9"/>',
  sys: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  audio: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  temp: '<path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 10v6.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  camera: '<rect x="3" y="6.5" width="13" height="11" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v3"/>',
  broom: '<path d="m14 4 6 6M12.5 8.5 4 17l3 3 8.5-8.5"/><path d="M15.5 8.5 11 4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  chev: '<path d="m9 6 6 6-6 6"/>', chevd: '<path d="m6 9 6 6 6-6"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  dots: '<circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  play: '<path d="M7 5v14l12-7z"/>', pause: '<path d="M8 5v14M16 5v14"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4l3 2"/>',
  download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>', upload: '<path d="M12 20V9m-4.5 4.5L12 9l4.5 4.5"/><path d="M4.5 4.5h15"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H12L11 21.5l8.5-11H12z"/>', wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5 17 4l3 3-2.5 2.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  store: '<path d="M4 8h16l-1 12H5z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>', windows: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1"/><rect x="13" y="13" width="7.5" height="7.5" rx="1"/>',
  code: '<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>', package: '<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  power: '<path d="M12 3v8"/><path d="M6.5 6.5a7.5 7.5 0 1 0 11 0"/>', sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  sparkle: '<path d="M12 3.5 13.8 10.2 20.5 12 13.8 13.8 12 20.5 10.2 13.8 3.5 12 10.2 10.2z"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  filter: '<path d="M3.5 5h17l-6.5 8v6l-4-2v-4z"/>', sort: '<path d="M7 4v16m-3.5-3.5L7 20l3.5-3.5M17 20V4m-3.5 3.5L17 4l3.5 3.5"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>', tray: '<path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/><path d="M5.5 5h13l2 8.5V19H3.5v-5.5z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.3 0 1.8-1 1.3-2-.6-1.2.2-2.5 1.6-2.5H17a3.5 3.5 0 0 0 3.5-3.5c0-5-3.8-9-8.5-9z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  cube: '<path d="m12 2.8 8.5 4.7v9L12 21.2l-8.5-4.7v-9z"/><path d="m3.5 7.5 8.5 4.7 8.5-4.7M12 12.2v9"/>',
};
const ic = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || P.dots}</svg>`;
const icons = { add(o) { Object.assign(P, o); }, has: n => n in P };

/* ---------- the PC (sample data; inside the app it is replaced by the real data from Python) ----------
   Component names, titles, values and typeName arrive translated; the row LABELS (rows[i][0]) stay in English because
   code looks rows up by them: translate them where they are shown, SH.t(label). */
const PC = {
  model: 'ASUS TUF Gaming F16', code: 'FX608JPR', type: 'laptop', typeName: t('Laptop'), maker: 'ASUSTeK',
  os: 'Windows 11 Pro 25H2', build: '26200', bios: 'FX608JPR.312',
  facts: { drivers: 303, programs: 116, freeC: 361 },
  components: [
    { id: 'cpu', name: t('Processor'), title: 'Intel Core i7-14650HX', rows: [['Cores', t('{n} ({p} performance, {e} efficient)', { n: 16, p: 8, e: 8 })], ['Threads', '24'], ['Max frequency', '5.2 GHz'], ['Cache', '30 MB']] },
    { id: 'gpu', name: t('Graphics'), title: 'NVIDIA GeForce RTX 5070 Laptop', rows: [['Memory', '8 GB GDDR7'], ['Integrated', 'Intel UHD Graphics'], ['Driver', '32.0.16.1742']] },
    { id: 'ram', name: t('Memory'), title: '16 GB DDR5', rows: [['Speed', '5600 MT/s'], ['Manufacturer', 'Samsung'], ['Modules', t('{n} × {size} GB, {free} free slot', { n: 1, size: 16, free: 1 })]] },
    { id: 'ssd', name: t('Storage'), title: 'WD PC SN5000S 1 TB', rows: [['Type', 'NVMe SSD'], ['Used', '592 GB'], ['Free', '361 GB']], bar: .62 },
    { id: 'display', name: t('Displays'), title: t('{n} inch, {res}', { n: 16, res: '2560 × 1600' }), rows: [['Refresh rate', '165 Hz'], ['External', '1920 × 1080, 144 Hz']] },
    { id: 'battery', name: t('Battery'), title: t('{wh} Wh, {pct}% health', { wh: 90, pct: 97 }), rows: [['Current capacity', '87.2 Wh'], ['Status', t('Good')]], bar: .97 },
    { id: 'wifi', name: t('Network'), title: 'Wi-Fi 6E', rows: [['Adapter', 'Realtek 8852CE'], ['Link', '1.2 Gb/s']] },
    { id: 'audio', name: t('Audio'), title: 'Realtek High Definition Audio', rows: [['Others', 'NVIDIA HD Audio, USB Audio']] },
    { id: 'sys', name: t('System'), title: 'Windows 11 Pro 25H2', rows: [['Build', '26200'], ['BIOS', 'FX608JPR.312']] },
  ],
};

/* ---------- modules: master list (the dock, the palette and the views come from here) ---------- */
const MODS0 = [
  { id: 'home', name: 'Home', icon: 'home' },
  { id: 'monitor', name: 'Live Monitor', icon: 'monitor', desc: 'Your PC in real time: usage, temperatures, network, battery and health.',
    tabs: [['overview', 'Overview'], ['cpu', 'Processor'], ['gpu', 'Graphics'], ['memory', 'Memory'], ['disks', 'Disks'], ['network', 'Network'], ['battery', 'Battery'], ['processes', 'Processes'], ['health', 'Health']] },
  { id: 'games', name: 'Games', icon: 'gamepad', real: true, desc: 'The frame rate of what you play, the slowdowns and what holds it back.',
    tabs: [['live', 'Live'], ['sessions', 'Sessions']] },
  { id: 'drivers', name: 'Driver Updater', icon: 'drivers', desc: 'Your drivers, new versions from Windows Update and backups.',
    tabs: [['updates', 'Updates'], ['all', 'All drivers'], ['problems', 'Problems'], ['backup', 'Backup'], ['history', 'History']] },
  { id: 'remover', name: 'Program Remover', icon: 'remover', desc: 'Uninstall programs and clear everything they leave behind, with a quarantine to undo.',
    tabs: [['programs', 'Programs'], ['batch', 'Batch'], ['watch', 'Watched install'], ['quarantine', 'Quarantine'], ['history', 'History']] },
  { id: 'updater', name: 'Program Updater', icon: 'updater', desc: 'Programs, Windows, Store and components up to date, in a single queue.',
    tabs: [['overview', 'Overview'], ['apps', 'Programs'], ['windows', 'Windows'], ['store', 'Store'], ['runtimes', 'Components'], ['dev', 'Development'], ['schedule', 'Schedule']] },
  { id: 'hangar', name: 'App Hangar', icon: 'hangar', real: true, desc: 'Pick the apps you want and install them all at once.',
    tabs: [['catalog', 'Catalog'], ['kits', 'Kits'], ['queue', 'Queue'], ['history', 'History']] },
  { id: 'storage', name: 'Storage Checker', icon: 'storage', desc: 'What every folder on your drives takes up, on a map you can explore.',
    tabs: [['map', 'Map'], ['tree', 'Folders'], ['types', 'File types'], ['largest', 'Largest'], ['duplicates', 'Duplicates'], ['compare', 'Compare']] },
  { id: 'optimizer', name: 'Super Optimizer', icon: 'optimizer', desc: 'Clean, repair and speed up Windows. Always with a restore point and undo.',
    tabs: [['overview', 'Overview'], ['clean', 'Cleanup'], ['startup', 'Startup'], ['services', 'Services'], ['registry', 'Registry'], ['repair', 'Repair'], ['performance', 'Performance'], ['debloat', 'Debloat']] },
  { id: 'privacy', name: 'Privacy & Security', icon: 'privacy', real: true, desc: 'What can see you, what is open and how well Windows protects you.',
    tabs: [['overview', 'Overview'], ['permissions', 'App permissions'], ['protection', 'Protection'], ['network', 'Network'], ['tracking', 'Tracking'], ['persistence', 'Auto-starts']] },
  { id: 'benchmark', name: 'Benchmark Testing', icon: 'benchmark', real: true, desc: 'Measure every component, stress-test it and get a score for your PC.',
    tabs: [['overview', 'Overview'], ['cpu', 'Processor'], ['gpu', 'Graphics'], ['memory', 'Memory'], ['disk', 'Disks'], ['network', 'Network'], ['stress', 'Stress test'], ['history', 'History']] },
  { id: 'tester', name: 'Device Tester', icon: 'tester', real: true, desc: 'Test your keyboard, screen, speakers, microphone, camera and mouse.',
    tabs: [['keyboard', 'Keyboard'], ['screen', 'Screen'], ['speakers', 'Speakers'], ['mic', 'Microphone'], ['camera', 'Camera'], ['mouse', 'Mouse']] },
  { id: 'autopilot', name: 'Autopilot', icon: 'autopilot', real: true, desc: 'Automatic maintenance: you set the rules, StellarHub follows them.',
    tabs: [['routines', 'Routines'], ['calendar', 'Calendar'], ['notify', 'Notifications'], ['log', 'Log']] },
];
/* names, descriptions and tab names in the interface language (ids stay as they are) */
const MODS = MODS0.map(m => ({ ...m, name: t(m.name), desc: m.desc && t(m.desc), tabs: m.tabs && m.tabs.map(([id, n]) => [id, t(n)]) }));
const modById = id => MODS.find(m => m.id === id);

/* registry of modules and Home views (filled in by the files in js/modules and js/home) */
const registry = { modules: {}, variants: {}, actions: [] };
function module(def) { registry.modules[def.id] = def; emit('module:registered', def); }
function homeVariant(def) { registry.variants[def.id] = def; emit('variant:registered', def); }
const actions = { add(list) { registry.actions.push(...list); }, all: () => registry.actions };

/* ---------- activity and pending items (modules feed them; Home shows them) ----------
   SH.logActivity('Brave updated', { sub: 'to version 1.85', ic: 'updater', go: 'updater', tab: 'apps' })
   SH.setPending('drivers', 4)   // keys: drivers, apps, junk (in GB) */
function logActivity(t, o = {}) {
  const list = (state.settings.activity || []).slice(0, 39);
  list.unshift({ t, sub: o.sub || '', ic: o.ic || 'check', go: o.go || '', tab: o.tab || '', at: Date.now() });
  state.settings.activity = undefined; setSetting('activity', list);
}
function setPending(key, n) {
  const p = { ...(state.settings.pending || {}) }; p[key] = { n, at: Date.now() };
  state.settings.pending = undefined; setSetting('pending', p); emit('pending', p);
}

/* ---------- automatic fade on scrollable areas ---------- */
const sfSet = new Set();
function sfUpdate(el) {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 2) { el.classList.remove('sf-t', 'sf-b'); return; }
  el.classList.toggle('sf-t', el.scrollTop > 2); el.classList.toggle('sf-b', el.scrollTop < max - 2);
}
function sfScan(root) {
  if (!root) return;
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) {
    if (sfSet.has(el) || !el.clientHeight || el.closest('[data-nofade]')) continue;
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY)) continue;
    const plain = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(cs.borderBottomWidth) === 0;
    if (!plain || el.dataset.nofade !== undefined) continue;
    el.classList.add('sf'); sfSet.add(el);
  }
  sfSet.forEach(el => { if (!el.isConnected) sfSet.delete(el); else sfUpdate(el); });
}
addEventListener('scroll', e => { const el = e.target; if (el.nodeType === 1 && sfSet.has(el)) sfUpdate(el); }, true);
addEventListener('resize', () => sfSet.forEach(sfUpdate));
setInterval(() => { const v = document.querySelector('.view.is-on'); if (v) sfScan(v); const s = document.querySelector('.overlay.on .sheet .body'); if (s) sfScan(s); }, 1200);

/* i18n.js ran first and already put SH.t and SH.i18n here: keep them */
window.SH = Object.assign(window.SH || {}, {
  $, $$, ROOT, state, DEFAULTS, FACT, ORBIT, motion, on, emit, call, apiReady, loadSettings, setSetting,
  engine, job, logActivity, setPending, Spring, springEase, EASE, anim, assemble, tickers, fmt1, fmtInt, fmtBytes, countUp, fitText, esc,
  ic, icons, PC, MODS, modById, registry, module, homeVariant, actions,
  go: () => {}, toast: () => {}, openComponent: () => {}, sfScan,
});
})();
