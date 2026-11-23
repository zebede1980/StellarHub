/* StellarHub · Live Monitor. Tabs: overview, processor, graphics, memory, disks, network, battery, processes, health.
   Data: SH.tele (shared) + its own simulation of what telemetry does not provide yet (processes, SMART, battery, network). */
'use strict';
(() => {
const { $, $$, state, Spring, EASE, anim, tickers, ic, esc, fmt1, fmtInt } = SH;
/* SH.t is aliased as _t here because t is the tab id everywhere in this file */
const _t = SH.t;
/* short words whose meaning here may differ elsewhere (Power = watts, Read = disk reads...): key "monitor|Word" */
const _tc = (s, vars) => SH.tc('monitor', s, vars);
const LOCALE = (SH.i18n && SH.i18n.locale) || 'en-US';
const ID = 'monitor';
const V = () => SH.tele.v;
let curTab = 'overview', paused = false, lastPush = performance.now(), frozen = null, frozenFrac = 0;
const visible = () => state.view === ID;
const chev = ic('chev');

/* ---------- canvas colors ---------- */
const C = {};
const nctx = document.createElement('canvas').getContext('2d');
function rgba(c, a) {
  nctx.fillStyle = '#9ED6FF'; nctx.fillStyle = c || '#9ED6FF'; const h = nctx.fillStyle;
  if (h[0] === '#') { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
  const p = h.match(/[\d.]+/g) || [158, 214, 255]; return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
}
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  ['accent', 'accent2', 'ok', 'warn', 'bad', 'line', 'mute', 'faint', 'ink', 'deep'].forEach(k => C[k] = cs.getPropertyValue('--' + k).trim());
}
SH.on('look', () => setTimeout(readColors, 30));

/* ---------- own histories (what SH.tele does not keep) ---------- */
const LOC = { igpu: [], sysPower: [], cpuFreq: [], gpuClock: [], diskTemp: [], fanCpu: [] };
Object.values(LOC).forEach(a => { for (let i = 0; i < 120; i++) a.push(0); });
const extra = { diskTemp: 41, sysPower: 46 };
const hist = k => (paused && frozen ? frozen[k] : (SH.tele.hist[k] || LOC[k]));

/* ---------- line chart that glides between samples ---------- */
class Chart {
  constructor(canvas, o) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.w = 0; this.h = 0; this.hx = null;
    this.o = Object.assign({ n: 85, max: 100, grid: 4, unit: '%', dec: 0, min: 1 }, o);
    this.mx = new Spring(this.o.max === 'auto' ? 10 : this.o.max, 60, 14);
    this.reveal = new Spring(0, 34, 11); this.reveal.t = 1;
    new ResizeObserver(() => this.size()).observe(canvas);
    canvas.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); this.hx = e.clientX - r.left; });
    canvas.addEventListener('pointerleave', () => { this.hx = null; });
  }
  replay() { this.reveal.set(0); this.reveal.t = 1; }
  size() {
    const r = this.c.getBoundingClientRect(); if (!r.width || !r.height) return;
    const d = Math.min(2, devicePixelRatio || 1);
    this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); this.w = r.width; this.h = r.height;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  draw(frac, dt) {
    const { ctx, w, h, o } = this; if (!w || !h) { this.size(); return; }
    this.reveal.step(dt);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (let i = 1; i < o.grid; i++) { const y = Math.round(h * i / o.grid) + .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    /* optional series (CPU temperature...) are hidden when Windows does not provide that value */
    const series = o.series.filter(s => !(s.opt && REAL() && !SH.tele.has(s.key))).map(s => ({ ...s, data: hist(s.key).slice(-(o.n + 2)) }));
    if (!series.length) { ctx.clearRect(0, 0, w, h); return; }
    let max = o.max;
    if (max === 'auto') { let m = o.min; series.forEach(s => s.data.forEach(v => { if (v > m) m = v; })); this.mx.t = m * 1.18; this.mx.step(dt); max = this.mx.v; }
    const step = w / (o.n - 1), top = 6, ph = h - top - 3;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w * Math.max(0, Math.min(1, this.reveal.v)), h); ctx.clip();
    series.forEach(s => {
      const col = C[s.col] || s.col;
      s.pts = s.data.map((v, i) => [(i - 1 - frac) * step, top + ph - (Math.max(0, Math.min(v, max)) / max) * ph]);
      const p = s.pts; ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      ctx.strokeStyle = col; ctx.lineWidth = s.w || 1.8; ctx.lineJoin = 'round';
      if (s.dash) ctx.setLineDash(s.dash); ctx.stroke(); ctx.setLineDash([]);
      if (s.fill) {
        ctx.lineTo(w + step, h); ctx.lineTo(-step, h); ctx.closePath();
        const g = ctx.createLinearGradient(0, top, 0, h); g.addColorStop(0, rgba(col, .26)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.fill();
      }
    });
    ctx.restore();
    if (this.hx != null && this.hx >= 0 && this.hx <= w) this.cross(series, step, frac);
  }
  cross(series, step, frac) {
    const { ctx, w, h, o } = this, x = this.hx;
    ctx.strokeStyle = rgba(C.ink, .22); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, h); ctx.stroke();
    const idx = Math.round(x / step + 1 + frac); const labels = [];
    series.forEach(s => {
      const i = Math.max(0, Math.min(s.data.length - 1, idx)); const v = s.data[i], p = s.pts[i]; if (!p) return;
      const col = C[s.col] || s.col; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 6.283); ctx.fill();
      labels.push([col, (s.label ? s.label + ': ' : '') + (s.fmt ? s.fmt(v) : (o.dec ? fmt1(v) : Math.round(v)) + (s.unit ?? o.unit))]);
    });
    const secs = Math.max(0, Math.round((o.n + 1 - idx) * .7)); labels.push([C.mute, secs <= 1 ? _t('now') : _t('{n} s ago', { n: secs })]);
    ctx.font = '500 11.5px Onest, system-ui, sans-serif';
    const tw = Math.max(...labels.map(l => ctx.measureText(l[1]).width)) + 20, bh = labels.length * 17 + 10;
    const bx = x + 14 + tw > w ? x - 14 - tw : x + 14, by = 6;
    ctx.fillStyle = rgba(C.deep || '#0B1222', .94); ctx.strokeStyle = rgba(C.ink, .14);
    ctx.beginPath(); ctx.roundRect(bx, by, tw, bh, 8); ctx.fill(); ctx.stroke();
    labels.forEach((l, i) => { ctx.fillStyle = l[0]; ctx.fillText(l[1], bx + 10, by + 18 + i * 17); });
  }
}

/* ---------- data → interface bindings (springs so everything glides) ---------- */
const T = {};
const tab = id => (T[id] ||= { charts: [], nums: [], bars: [], arcs: [], fns: [], fans: [] });
const clamp01 = x => Math.max(0, Math.min(1, x));
/* a value Windows does not provide arrives as null: show "—" (never 0 or a made-up number) */
const nil = x => x == null || Number.isNaN(x);
const safe = f => v => { try { const x = f(v); return nil(x) ? null : x; } catch { return null; } };
function setNum(b, v) { const x = b.get(v); b.nil = nil(x); if (!b.nil) b.s.t = x; }
function num(t, el, get, fmt = v => fmtInt(v), k = 120, c = 20) { if (!el) return; const b = { el, get: safe(get), fmt, s: new Spring(0, k, c), last: '' }; setNum(b, V()); tab(t).nums.push(b); }
function bar(t, el, get, axis = 'x') { if (!el) return; const b = { el, get: safe(get), axis, s: new Spring(0, 90, 16) }; b.s.t = clamp01(b.get(V()) || 0); tab(t).bars.push(b); }
function arc(t, el, get, len, total) { if (!el) return; const b = { el, get: safe(get), len, total, s: new Spring(0, 70, 15) }; b.s.t = clamp01(b.get(V()) || 0); tab(t).arcs.push(b); }
function chart(t, canvas, o) { if (!canvas) return null; const ch = new Chart(canvas, o); tab(t).charts.push(ch); return ch; }
function fn(t, f) { tab(t).fns.push(f); try { f(V()); } catch (e) { console.error(e); } }
function fan(t, el, get) { if (!el) return; tab(t).fans.push({ el, get: safe(get), a: 0 }); }
function refresh(t) {
  const tc = T[t]; if (!tc) return; const v = V();
  tc.nums.forEach(b => setNum(b, v)); tc.bars.forEach(b => { b.s.t = clamp01(b.get(v) || 0); }); tc.arcs.forEach(b => { b.s.t = clamp01(b.get(v) || 0); });
  tc.fns.forEach(f => { try { f(v); } catch (e) { console.error(e); } });
}

/* ---------- real engine: inside the app SH.engine answers; outside it returns undefined and sample mode is used ---------- */
const REAL = () => !SH.tele.simulated;
const PC = () => SH.PC;
const comp = id => (PC().components || []).find(c => c.id === id) || { title: '', rows: [] };
/* spec rows are looked up by label; the patterns also accept the labels of older (Spanish) builds */
/* each LBL entry: [pattern, English label]; a row also matches the English label's translation, in case the engine sends it translated */
const row = (id, label) => ((comp(id).rows || []).find(r => label[0].test(r[0]) || r[0] === _t(label[1])) || [, ''])[1];
const LBL = { cores: [/^(cores|n\u00facleos)$/i, 'Cores'], threads: [/^(threads|hilos)$/i, 'Threads'], base: [/^(base|frecuencia base)/i, 'Base clock'], igpu: [/^(integrated|integrada)/i, 'Integrated'],
  driver: [/^driver/i, 'Driver'], speed: [/^(speed|velocidad)$/i, 'Speed'], maker: [/^(manufacturer|maker|fabricante)$/i, 'Manufacturer'] };
/* spec rows come from the engine with English labels: translated only when displayed */
const specRows = rows => (rows || []).map(([a, b]) => `<dt>${esc(_t(a))}</dt><dd>${esc(b)}</dd>`).join('');
async function eng(fn_, ...a) { try { return await SH.engine('monitor', fn_, ...a); } catch (e) { console.error(e); return null; } }
const cache = {};   /* slow engine results: requested once per tab visit */
async function load(k, fn_, ...a) { if (cache[k] && Date.now() - cache[k].t < 30000) return cache[k].d; const d = await eng(fn_, ...a); if (d !== undefined) cache[k] = { t: Date.now(), d }; return d; }
/* cores: the first 2×P threads belong to the performance cores (with HT), the rest to the efficient ones (no HT) */
function coreSplit() {
  const cores = parseInt(row('cpu', LBL.cores)) || 16, threads = parseInt(row('cpu', LBL.threads)) || (V().threads || []).length || 24;
  const p = Math.max(0, Math.min(cores, threads - cores)), e = cores - p; return { cores, threads, p, e };
}

/* ---------- simulation: processes and extras ---------- */
const PROCS = [
  { n: 'Brave', exe: 'brave.exe', k: 14, cpu: 4.2, ram: 1880, gpu: 3, disk: .4, net: 2.4, path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application' },
  { n: 'FL Studio', exe: 'FL64.exe', k: 1, cpu: 6.5, ram: 1420, gpu: 2, disk: 1.2, net: 0, path: 'C:\\Program Files\\Image-Line\\FL Studio 2025' },
  { n: 'Discord', exe: 'Discord.exe', k: 6, cpu: 1.1, ram: 610, gpu: 1, disk: .1, net: .6, path: 'C:\\Users\\user\\AppData\\Local\\Discord' },
  { n: 'Spotify', exe: 'Spotify.exe', k: 5, cpu: .8, ram: 420, gpu: 0, disk: .2, net: .4, path: 'C:\\Users\\user\\AppData\\Roaming\\Spotify' },
  { n: 'Claude', exe: 'claude.exe', k: 4, cpu: 1.6, ram: 540, gpu: 1, disk: .2, net: .3, path: 'C:\\Users\\user\\AppData\\Local\\AnthropicClaude' },
  { n: 'StellarHub', exe: 'pythonw.exe', k: 3, cpu: 1.3, ram: 260, gpu: 2, disk: .1, net: 0, path: 'C:\\Users\\user\\Documents\\StellarHub' },
  { n: 'Wallpaper Engine', exe: 'wallpaper64.exe', k: 2, cpu: 2.1, ram: 230, gpu: 9, disk: 0, net: 0, path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine' },
  { n: 'Medal', exe: 'Medal.exe', k: 5, cpu: 1.4, ram: 380, gpu: 4, disk: 2.6, net: .2, path: 'C:\\Users\\user\\AppData\\Local\\Medal' },
  { n: 'Windows Explorer', exe: 'explorer.exe', k: 1, cpu: .7, ram: 190, gpu: 1, disk: .1, net: 0, path: 'C:\\Windows', sys: true },
  { n: 'Desktop Window Manager', exe: 'dwm.exe', k: 1, cpu: 1.9, ram: 140, gpu: 6, disk: 0, net: 0, path: 'C:\\Windows\\System32', sys: true },
  { n: 'Microsoft Defender Antimalware', exe: 'MsMpEng.exe', k: 1, cpu: 1.2, ram: 310, gpu: 0, disk: 1.8, net: 0, path: 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform', sys: true },
  { n: 'Service Host', exe: 'svchost.exe', k: 86, cpu: 1.5, ram: 980, gpu: 0, disk: .6, net: .3, path: 'C:\\Windows\\System32', sys: true },
  { n: 'System', exe: 'System', k: 1, cpu: .9, ram: 12, gpu: 0, disk: .9, net: .1, path: 'C:\\Windows\\System32', sys: true },
  { n: 'NVIDIA Container', exe: 'nvcontainer.exe', k: 3, cpu: .3, ram: 120, gpu: 0, disk: 0, net: 0, path: 'C:\\Program Files\\NVIDIA Corporation\\NvContainer' },
  { n: 'Windows Audio', exe: 'audiodg.exe', k: 1, cpu: .9, ram: 36, gpu: 0, disk: 0, net: 0, path: 'C:\\Windows\\System32', sys: true },
  { n: 'Steam', exe: 'steam.exe', k: 4, cpu: .4, ram: 290, gpu: 0, disk: .3, net: .9, path: 'C:\\Program Files (x86)\\Steam' },
  { n: 'OneDrive', exe: 'OneDrive.exe', k: 1, cpu: .2, ram: 95, gpu: 0, disk: .4, net: .5, path: 'C:\\Program Files\\Microsoft OneDrive' },
  { n: 'Windows Terminal', exe: 'WindowsTerminal.exe', k: 2, cpu: .3, ram: 120, gpu: 0, disk: 0, net: 0, path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal' },
  { n: 'Python', exe: 'python.exe', k: 2, cpu: .6, ram: 85, gpu: 0, disk: .1, net: 0, path: 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps' },
  { n: 'Search', exe: 'SearchHost.exe', k: 1, cpu: .1, ram: 160, gpu: 0, disk: 0, net: 0, path: 'C:\\Windows\\SystemApps', sys: true },
  { n: 'Realtek Audio Console', exe: 'RtkAudUService64.exe', k: 1, cpu: .1, ram: 18, gpu: 0, disk: 0, net: 0, path: 'C:\\Windows\\System32\\DriverStore' },
  { n: 'Armoury Crate', exe: 'ArmouryCrate.exe', k: 3, cpu: .4, ram: 210, gpu: 0, disk: .1, net: .1, path: 'C:\\Program Files\\ASUS\\ARMOURY CRATE Service' },
];
/* sample dedicated video memory in MB (the rest of the sample VRAM is the driver's and Windows' own) */
const MOCK_VRAM = { 'brave.exe': 640, 'FL64.exe': 180, 'Discord.exe': 150, 'Spotify.exe': 90, 'claude.exe': 120, 'pythonw.exe': 170, 'wallpaper64.exe': 430,
  'Medal.exe': 260, 'explorer.exe': 150, 'dwm.exe': 410, 'steam.exe': 70, 'WindowsTerminal.exe': 60, 'SearchHost.exe': 40 };
PROCS.forEach((p, i) => { p.id = i; p.vram = MOCK_VRAM[p.exe] || 0; p.b = { cpu: p.cpu, ram: p.ram, gpu: p.gpu, vram: p.vram, disk: p.disk, net: p.net }; p.alive = true; });
/* peak temperatures this session (real data only; sample values in sample mode) */
const MAXT = { cpu: null, gpu: null, ssd: null, cpuAt: 0, gpuAt: 0 };
const SUM = { cpu: PROCS.reduce((s, p) => s + p.b.cpu, 0), gpu: PROCS.reduce((s, p) => s + p.b.gpu, 0) };
const jit = (b, j, lo = 0) => Math.max(lo, b * (1 + (Math.random() - .5) * j));
const pushLoc = (k, x) => { LOC[k].push(x ?? 0); LOC[k].shift(); };
function simTick(v) {
  if (REAL()) {
    pushLoc('igpu', v.igpu); pushLoc('gpuClock', v.gpuClock); pushLoc('sysPower', v.charging === false && !nil(v.batteryPower) ? Math.abs(v.batteryPower) : null);
    if (!nil(v.cpuTemp) && (MAXT.cpu == null || v.cpuTemp > MAXT.cpu)) { MAXT.cpu = v.cpuTemp; MAXT.cpuAt = Date.now(); }
    if (!nil(v.gpuTemp) && (MAXT.gpu == null || v.gpuTemp > MAXT.gpu)) { MAXT.gpu = v.gpuTemp; MAXT.gpuAt = Date.now(); }
    return;
  }
  const load = Math.max(.15, v.cpu * .9 / SUM.cpu), gl = Math.max(.05, v.gpu * .9 / SUM.gpu); /* the processes share the real total */
  PROCS.forEach(p => {
    if (!p.alive) return;
    p.cpu = jit(p.b.cpu * load, .8); p.ram = jit(p.b.ram, .06, 4); p.gpu = jit(p.b.gpu * gl, .9); p.vram = jit(p.b.vram, .05);
    p.disk = Math.random() < .2 ? jit(p.b.disk * 4, 1) : jit(p.b.disk, 1); p.net = jit(p.b.net * (v.down / 12), 1);
  });
  extra.diskTemp = Math.max(34, Math.min(66, extra.diskTemp + (Math.random() - .5) * 1.2 + (v.diskRead + v.diskWrite > 400 ? .8 : -.15)));
  extra.sysPower = 16 + v.cpu * .55 + v.gpuPower * .9;
  pushLoc('igpu', v.igpu); pushLoc('sysPower', extra.sysPower); pushLoc('cpuFreq', v.cpuFreq); pushLoc('gpuClock', v.gpuClock); pushLoc('diskTemp', extra.diskTemp); pushLoc('fanCpu', v.fanCpu);
  MAXT.cpu = Math.max(MAXT.cpu || 0, v.cpuTemp); MAXT.gpu = Math.max(MAXT.gpu || 0, v.gpuTemp); MAXT.ssd = Math.max(MAXT.ssd || 0, extra.diskTemp);
}

/* ---------- real processes: the engine groups them per program like Task Manager ---------- */
const RP = new Map();   // key (lowercase exe) -> stable process object
let procTimer = 0, procBusy = false, procInfo = { total: 0, gpuPerProcess: true };
const PROC_TABS = new Set(['overview', 'cpu', 'gpu', 'memory', 'network', 'processes']);
async function pollProcs() {
  if (procBusy || !REAL() || !visible() || !PROC_TABS.has(curTab) || paused) return;
  procBusy = true;
  try {
    const known = [...RP.values()].filter(p => p.iconDone).map(p => p.id);
    const r = await eng('processes', known); if (!r || !r.list) return;
    procInfo = r; const seen = new Set();
    r.list.forEach(g => {
      let p = RP.get(g.key);
      if (!p) { p = { id: g.key, alive: true }; RP.set(g.key, p); }
      Object.assign(p, { n: g.n, exe: g.exe, k: g.k, cpu: g.cpu, ram: g.ram, gpu: g.gpu, vram: g.vram, disk: g.disk, net: g.net, path: g.path, sys: g.sys || g.own, own: g.own, alive: true });
      if ('icon' in g) { p.icon = g.icon; p.iconDone = true; }
      seen.add(g.key);
    });
    RP.forEach((p, k) => { if (!seen.has(k)) RP.delete(k); });
    if (visible()) { refresh(curTab); if (curTab === 'processes') renderProcs(!hoverTable); }
  } finally { procBusy = false; }
}
function startProcPoll() { if (!procTimer) { pollProcs(); procTimer = setInterval(pollProcs, 2000); } }
function stopProcPoll() { clearInterval(procTimer); procTimer = 0; }
const procList = () => REAL() ? [...RP.values()] : PROCS;
const top = (key, n) => procList().filter(p => p.alive).sort((a, b) => b[key] - a[key]).slice(0, n);
const initial = n => (String(n || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?');
const mono = (n, icon) => icon ? `<span class="mono img"><img src="${icon}" alt=""></span>` : `<span class="mono">${esc(initial(n))}</span>`;
function topList(t, el, key, n, fmt, max) {
  if (!el) return;
  el.innerHTML = Array.from({ length: n }, () => `<div class="tp">${mono('?')}<span class="tn"></span><span class="tv"></span><span class="bar"><span></span></span></div>`).join('');
  const rows = $$('.tp', el);
  fn(t, () => {
    const list = top(key, n); const mx = max || Math.max(...list.map(p => p[key]), .001);
    rows.forEach((r, i) => { r.style.visibility = list[i] ? '' : 'hidden'; });
    list.forEach((p, i) => {
      const r = rows[i]; if (!r) return;
      const hasIc = p.icon ? '1' : '0';
      if (r.dataset.p !== String(p.id) || r.dataset.ic !== hasIc) {
        const first = r.dataset.p == null, same = r.dataset.p === String(p.id); r.dataset.p = p.id; r.dataset.ic = hasIc;
        $('.mono', r).outerHTML = mono(p.n, p.icon); $('.tn', r).textContent = p.n;
        if (!first && !same) anim(r, [{ opacity: .3, transform: 'translate3d(0,4px,0)' }, { opacity: 1, transform: 'none' }], { d: 300, keep: true });
      }
      $('.tv', r).textContent = fmt(p[key]); $('.bar>span', r).style.transform = `scaleX(${clamp01(p[key] / mx).toFixed(3)})`;
    });
  });
}
const mb = v => v >= 1024 ? fmt1(v / 1024) + ' GB' : fmtInt(v) + ' MB';
const pct = v => (v < 10 ? fmt1(v) : fmtInt(v)) + ' %';
function upt(s) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; }

/* ---------- HTML pieces ---------- */
const head = (title, em, go) => `<h4>${go ? `<button class="goto" data-goto="${go}">${title}${chev}</button>` : title}${em ? `<em>${em}</em>` : ''}</h4>`;
const stat = (label, id, unit = '', sub = '') => `<div class="st"><span class="sl">${label}</span><b><span id="${id}">–</span>${unit ? `<small>${unit}</small>` : ''}</b>${sub ? `<span class="ss">${sub}</span>` : ''}</div>`;
const cv = id => `<canvas class="ch" id="${id}"></canvas>`;
const axis = `<div class="axis"><span>${_t('1 min ago')}</span><span>${_t('now')}</span></div>`;
const gauge = id => `<div class="gauge"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="none" style="stroke:var(--raise2)" stroke-width="9" stroke-linecap="round" stroke-dasharray="235.6 314.2"/><circle id="${id}A" cx="60" cy="60" r="50" fill="none" style="stroke:var(--accent)" stroke-width="9" stroke-linecap="round" stroke-dasharray="0 314.2"/></svg><div class="gv"><div><b id="${id}V">0</b><span>${_t('% used')}</span></div></div></div>`;
const ring = (id, col = 'var(--accent2)') => `<svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" style="stroke:var(--raise2)" stroke-width="4"/><circle id="${id}" cx="20" cy="20" r="16" fill="none" style="stroke:${col}" stroke-width="4" stroke-linecap="round" stroke-dasharray="0 100.5"/></svg>`;
const fanIc = id => `<svg class="i fan" id="${id}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M12 10c-1-3-.5-6 1.5-7 2 1.5 1.5 5-1.5 7zM14 12c3-1 6-.5 7 1.5-1.5 2-5 1.5-7-1.5zM12 14c1 3 .5 6-1.5 7-2-1.5-1.5-5 1.5-7zM10 12c-3 1-6 .5-7-1.5 1.5-2 5-1.5 7 1.5z"/></svg>`;
const S = (root, id) => $('#' + id, root);

/* ================= tabs ================= */
const R = {};

/* short names for headers */
const short = s => String(s || '').replace(/^(NVIDIA|Intel|AMD)\s+/i, '').replace(/GeForce\s+/i, '').replace(/\s+GPU$/i, '').replace(/\(R\)|\(TM\)/g, '').trim();
const gpuTitle = () => comp('gpu').title || 'GPU';
const NA = (why) => `<span class="na" title="${esc(why)}">—</span>`;
/* short explanation of a value that does not arrive */
const why = {
  cpuTemp: () => _t('Windows only exposes the ACPI thermal zone, and on this PC it is missing or a fixed placeholder. Reading the processor\'s own sensors needs a kernel driver (WinRing0) that Microsoft Defender blocks as vulnerable, so StellarHub does not install one.'),
  gpuState: { asleep: _t('The dedicated GPU is powered down to save energy. StellarHub does not wake it just to read its sensors: they come back as soon as a program uses it.'),
    idle: _t('On battery and idle: sensor reading is paused so the dedicated GPU can power down. Usage and video memory are still live.') },
  fan: _t('Windows does not report fan speed; the manufacturer\'s firmware controls it (on this PC, Armoury Crate).'),
};

R.overview = (el, t) => {
  el.classList.add('fill');
  const sp = coreSplit();
  el.innerHTML = `<div class="ov">
    <div class="pan p-cpu" data-asm>${head(_t('Processor'), esc(short(comp('cpu').title)), 'cpu')}
      <div class="top3"><div class="big"><span id="oCpu">0</span><small>%</small></div>
        <div class="meta"><b id="oFreq">–</b> GHz<br>${_t('{n} threads', { n: sp.threads })}</div><div class="meta"><b id="oCt">–</b> °C<br>${_t('temperature')}</div></div>
      ${cv('oCpuCh')}<div class="threads" id="oThr" style="grid-template-columns:repeat(${sp.threads},1fr)">${'<i><b></b></i>'.repeat(sp.threads)}</div></div>
    <div class="pan p-gpu" data-asm>${head(_t('Graphics'), esc(short(gpuTitle())), 'gpu')}
      <div class="gbody">${gauge('oG')}<div class="gstats">
        <div class="s"><b><span id="oGt">–</span> °C</b>${_t('temperature')}</div><div class="s"><b><span id="oGp">–</span> W</b>${_tc('power')}</div>
        <div class="s"><b>${_t('{used} of {total} GB', { used: '<span id="oVr">–</span>', total: '<span id="oVrT">–</span>' })}</b>${_t('video memory')}<div class="bar acc"><span id="oVrB"></span></div></div></div></div></div>
    <div class="pan p-ram" data-asm>${head(_t('Memory'), esc(comp('ram').title), 'memory')}
      <div class="big"><span id="oRam">–</span><small>${_t('of {total} GB', { total: '<span id="oRamT">–</span>' })}</small></div><div class="bar" style="margin-top:12px"><span id="oRamB"></span></div>
      <div class="tops" id="oRamTop"></div></div>
    <div class="pan p-net" data-asm>${head(_t('Network'), esc(short(comp('wifi').title)), 'network')}
      <div class="pair"><div><i style="background:var(--accent2)"></i>${_t('{v} Mb/s down', { v: '<b id="oDn">–</b>' })}</div><div><i style="background:var(--accent)"></i>${_t('{v} Mb/s up', { v: '<b id="oUp">–</b>' })}</div></div>${cv('oNetCh')}</div>
    <div class="pan p-disk" data-asm>${head(_t('Disk'), esc(short(comp('ssd').title)), 'disks')}
      <div class="pair"><div><i style="background:var(--accent2)"></i>${_t('{v} MB/s read', { v: '<b id="oRd">–</b>' })}</div><div><i style="background:var(--accent)"></i>${_t('{v} MB/s write', { v: '<b id="oWr">–</b>' })}</div></div>${cv('oDiskCh')}</div>
  </div>`;
  num(t, S(el, 'oCpu'), v => v.cpu); num(t, S(el, 'oFreq'), v => v.cpuFreq, fmt1); num(t, S(el, 'oCt'), v => v.cpuTemp);
  S(el, 'oCt').title = why.cpuTemp();
  chart(t, S(el, 'oCpuCh'), { series: [{ key: 'cpu', col: 'accent', fill: true, label: 'CPU' }] });
  $$('#oThr b', el).forEach((b, i) => bar(t, b, v => (v.threads || [])[i], 'y'));
  arc(t, S(el, 'oGA'), v => v.gpu / 100, 235.6, 314.2); num(t, S(el, 'oGV'), v => v.gpu);
  num(t, S(el, 'oGt'), v => v.gpuTemp); num(t, S(el, 'oGp'), v => v.gpuPower); num(t, S(el, 'oVr'), v => v.vram, fmt1); num(t, S(el, 'oVrT'), v => v.vramTotal);
  bar(t, S(el, 'oVrB'), v => v.vram / (v.vramTotal || 8));
  num(t, S(el, 'oRam'), v => v.ram, fmt1); num(t, S(el, 'oRamT'), v => v.ramTotal); bar(t, S(el, 'oRamB'), v => v.ram / v.ramTotal);
  topList(t, S(el, 'oRamTop'), 'ram', 3, mb);
  num(t, S(el, 'oDn'), v => v.down, fmt1); num(t, S(el, 'oUp'), v => v.up, fmt1);
  chart(t, S(el, 'oNetCh'), { max: 'auto', min: 20, unit: ' Mb/s', dec: 1, series: [{ key: 'down', col: 'accent2', fill: true, label: _tc('Download') }, { key: 'up', col: 'accent', label: _tc('Upload') }] });
  num(t, S(el, 'oRd'), v => v.diskRead); num(t, S(el, 'oWr'), v => v.diskWrite);
  chart(t, S(el, 'oDiskCh'), { max: 'auto', min: 100, unit: ' MB/s', series: [{ key: 'diskRead', col: 'accent2', fill: true, label: _tc('Read') }, { key: 'diskWrite', col: 'accent', label: _tc('Write') }] });
};

R.cpu = (el, t) => {
  const sp = coreSplit(), c = comp('cpu');
  el.innerHTML = `<div class="grid g-cpu">
    <div class="pan wide" data-asm>${head(_t('Processor usage'), _t('last minute'))}
      <div class="hero"><div class="big"><span id="cU">0</span><small>%</small></div>
        <div class="legend"><span><i style="background:var(--accent)"></i>${_t('usage')}</span><span class="ltemp"><i class="dash" style="border-color:var(--accent2)"></i>${_t('temperature')}</span></div></div>
      <div class="chwrap tall">${cv('cCh')}</div>${axis}</div>
    <div class="pan" data-asm>${head(_t('Status'), _t('live'))}<div class="stats">
      ${stat(_t('Frequency'), 'cF', 'GHz', _t('base {v}', { v: esc(row('cpu', LBL.base) || '–') }))}${stat(_t('Temperature'), 'cT', '°C', '<span id="cTw"></span>')}
      <div class="st"><span class="sl">${_t('Fan')}</span><b>${fanIc('cFan')}<span id="cFn">–</span><small>rpm</small></b><span class="ss" id="cFnW"></span></div>
      ${stat(_t('Processes'), 'cP', '', '<span id="cPh"></span>')}${stat(_t('Busy threads'), 'cHo', _t('of {n}', { n: sp.threads }), _t('above 50 %'))}${stat(_t('Uptime'), 'cUp', '', _t('since the last startup'))}</div></div>
    <div class="pan wide" data-asm>${head(_t('Cores'), sp.p && sp.e ? _t('{p} performance and {e} efficient', { p: sp.p, e: sp.e }) : _t('{n} cores', { n: sp.cores }))}
      <div class="cores">${sp.p ? `<div class="cg"><span class="cgl">${_tc('Performance')}</span><div class="pc" id="cPc"></div></div>` : ''}${sp.e ? `<div class="cg"><span class="cgl">${sp.p ? _tc('Efficient') : _t('Cores')}</span><div class="ec" id="cEc"></div></div>` : ''}</div></div>
    <div class="pan" data-asm>${head(_t('Using the most CPU'))}<div class="tops" id="cTop"></div></div>
    <div class="pan" data-asm>${head(_t('Specifications'))}<dl class="spec">
      <dt>${_t('Model')}</dt><dd>${esc(c.title)}</dd>${specRows(c.rows)}</dl></div>
  </div>`;
  num(t, S(el, 'cU'), v => v.cpu);
  chart(t, S(el, 'cCh'), { series: [{ key: 'cpu', col: 'accent', fill: true, label: _t('Usage') }, { key: 'cpuTemp', col: 'accent2', dash: [5, 4], w: 1.5, label: _tc('Temp.'), unit: ' °C', opt: true }] });
  num(t, S(el, 'cF'), v => v.cpuFreq, fmt1); num(t, S(el, 'cT'), v => v.cpuTemp); num(t, S(el, 'cFn'), v => v.fanCpu); fan(t, S(el, 'cFan'), v => v.fanCpu);
  fn(t, v => {
    S(el, 'cTw').textContent = nil(v.cpuTemp) ? _t('Windows does not report it') : _t('ACPI thermal zone');
    S(el, 'cTw').title = nil(v.cpuTemp) ? why.cpuTemp() : '';
    S(el, 'cFnW').textContent = nil(v.fanCpu) ? _t('Windows does not report it') : _t('automatic');
    S(el, 'cFnW').title = why.fan; $('.ltemp', el).hidden = REAL() && nil(v.cpuTemp);
    S(el, 'cPh').textContent = nil(v.threadsTotal) ? '' : _t('and {n} threads', { n: fmtInt(v.threadsTotal) });
  });
  num(t, S(el, 'cP'), v => REAL() ? v.procs : 287); num(t, S(el, 'cHo'), v => (v.threads || []).filter(x => x > .5).length); num(t, S(el, 'cUp'), v => v.uptime, upt, 400, 40);
  const pc = S(el, 'cPc'), ec = S(el, 'cEc');
  if (pc) { pc.innerHTML = Array.from({ length: sp.p }, (_, i) => `<div class="core"><div class="th"><b></b></div><div class="th"><b></b></div><span>P${i + 1}</span></div>`).join(''); $$('.th b', pc).forEach((b, i) => bar(t, b, v => (v.threads || [])[i], 'y')); }
  if (ec) { ec.innerHTML = Array.from({ length: sp.e }, (_, i) => `<div class="core e"><div class="th"><b></b></div><span>${sp.p ? 'E' : 'N'}${i + 1}</span></div>`).join(''); $$('.th b', ec).forEach((b, i) => bar(t, b, v => (v.threads || [])[sp.p * 2 + i], 'y')); }
  topList(t, S(el, 'cTop'), 'cpu', 6, pct, 0);
};

R.gpu = (el, t) => {
  const g = comp('gpu'), igpu = row('gpu', LBL.igpu);
  const mons = (comp('display').monitors || []);
  el.innerHTML = `<div class="grid g-gpu">
    <div class="pan wide" data-asm>${head(esc(short(gpuTitle())), _t('driver {v}', { v: `<span id="gDrv">${esc(row('gpu', LBL.driver) || '–')}</span>` }))}
      <div class="gsplit">
        <div class="gl"><div class="gpuhero">${gauge('gG')}<div class="stats s4">
          ${stat(_t('Temperature'), 'gT', '°C', '<span id="gTl"></span>')}${stat(_tc('Power'), 'gP', 'W', '')}${stat(_t('Clock'), 'gC', 'GHz', '<span id="gCm"></span>')}
          <div class="st"><span class="sl">${_t('Fan')}</span><b>${fanIc('gFan')}<span id="gFn">–</span><small id="gFnU">%</small></b><span class="ss" id="gFnW"></span></div></div></div>
          <div class="vram"><span>${_t('Video memory')}</span><b>${_t('{used} of {total} GB', { used: '<span id="gV">–</span>', total: '<span id="gVT">–</span>' })}</b><div class="bar acc"><span id="gVB"></span></div></div></div>
        <div class="gr"><div class="legend"><span><i style="background:var(--accent)"></i>${_t('usage')}</span><span><i class="dash" style="border-color:var(--accent2)"></i>${_t('temperature')}</span></div>
          <div class="chwrap">${cv('gCh')}</div>
          <div class="legend gmleg"><span><i style="background:var(--accent)"></i>${_t('video memory')}</span></div>
          <div class="chwrap">${cv('gMCh')}</div>${axis}</div></div>
      <p class="mnote gstate" id="gState" hidden></p></div>
    <div class="pan" data-asm>${head(esc(short(igpu) || _t('Integrated graphics')), _tc('integrated'))}
      ${igpu ? `<div class="igu"><div class="big"><span id="gI">–</span><small>%</small></div><div class="chwrap sm">${cv('gICh')}</div></div>` : ''}
      <p class="mnote">${igpu ? _t('Drives the laptop screen and saves battery. The dedicated GPU kicks in when a program asks for it.') : _t('This PC has no active integrated graphics.')}</p></div>
    <div class="pan" data-asm>${head(_t('Using the GPU'), procInfo.gpuPerProcess === false ? _t('not available') : '')}
      <div class="seg gseg" id="gTopSeg"><span class="ind"></span><button data-v="gpu" class="on">${_t('Usage')}</button><button data-v="vram"${procInfo.vramPerProcess === false ? ' disabled' : ''}>${_t('Video memory')}</button></div>
      <div class="tops" id="gTop"></div><div class="tops" id="gTopM" hidden></div></div>
    <div class="pan" data-asm>${head(_t('Displays'), `${mons.length || '–'}`)}<div class="rows">
      ${mons.map(m => `<div class="row"><span class="ri">${ic('display')}</span><span class="rt"><b>${m.internal ? _t('Laptop screen') : _t('External monitor')}</b><span>${esc([m.vendor, m.name || m.code].filter(Boolean).join(' '))}${m.inches ? `, ${m.inches}"` : ''}</span></span><span class="chip ok">${_t('active')}</span></div>`).join('') || `<div class="muted">${_t('No display data.')}</div>`}</div></div>
    <div class="pan" data-asm>${head(_t('Specifications'))}<dl class="spec" id="gSpec">
      <dt>${_t('Model')}</dt><dd>${esc(gpuTitle())}</dd>${specRows(g.rows)}</dl></div>
  </div>`;
  arc(t, S(el, 'gGA'), v => v.gpu / 100, 235.6, 314.2); num(t, S(el, 'gGV'), v => v.gpu);
  num(t, S(el, 'gT'), v => v.gpuTemp); num(t, S(el, 'gP'), v => v.gpuPower); num(t, S(el, 'gC'), v => v.gpuClock, fmt1); num(t, S(el, 'gFn'), v => v.fanGpu); fan(t, S(el, 'gFan'), v => (v.fanGpu || 0) * 40);
  fn(t, v => {
    S(el, 'gFnW').textContent = nil(v.fanGpu) ? _t('Windows does not report it') : _t('automatic'); S(el, 'gFnW').title = why.fan;
    const st = S(el, 'gState'), msg = why.gpuState[v.gpuState] || '';
    if (st.textContent !== msg) { st.textContent = msg; st.hidden = !msg; }
  });
  if (S(el, 'gI')) { num(t, S(el, 'gI'), v => v.igpu); chart(t, S(el, 'gICh'), { series: [{ key: 'igpu', col: 'accent2', fill: true, label: _t('Usage') }] }); }
  num(t, S(el, 'gV'), v => v.vram, fmt1); num(t, S(el, 'gVT'), v => v.vramTotal); bar(t, S(el, 'gVB'), v => v.vram / (v.vramTotal || 8));
  chart(t, S(el, 'gCh'), { series: [{ key: 'gpu', col: 'accent', fill: true, label: _t('Usage') }, { key: 'gpuTemp', col: 'accent2', dash: [5, 4], w: 1.5, label: _tc('Temp.'), unit: ' °C', opt: true }] });
  const mch = chart(t, S(el, 'gMCh'), { max: V().vramTotal || 8, unit: ' GB', dec: 1, series: [{ key: 'vram', col: 'accent', fill: true, label: _t('Video memory'), opt: true }] });
  fn(t, v => { if (v.vramTotal) mch.o.max = v.vramTotal; });
  topList(t, S(el, 'gTop'), 'gpu', 6, pct, 0);
  topList(t, S(el, 'gTopM'), 'vram', 6, mb, 0);
  const tseg = S(el, 'gTopSeg');
  tseg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled || b.classList.contains('on')) return;
    $$('button', tseg).forEach(x => x.classList.toggle('on', x === b)); SH.placeSeg(tseg);
    S(el, 'gTop').hidden = b.dataset.v !== 'gpu'; S(el, 'gTopM').hidden = b.dataset.v !== 'vram';
  });
  load('gpu', 'gpu_info').then(gi => {
    if (!gi || !gi.driver) return; /* {asleep:true} with nothing cached: the GPU was not woken up to read it */
    S(el, 'gDrv').textContent = gi.driver;
    if (gi.maxClock) S(el, 'gCm').textContent = _t('max {v} GHz', { v: fmt1(gi.maxClock) });
    if (gi.tlimitMargin != null) S(el, 'gTl').textContent = _t('{n} °C before throttling', { n: gi.tlimitMargin });
    const add = [gi.pcie && [_t('Connection'), gi.pcie], gi.powerLimit && [_t('Max power'), gi.powerLimit + ' W']].filter(Boolean);
    S(el, 'gSpec').insertAdjacentHTML('beforeend', add.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join(''));
  });
};

R.memory = (el, t) => {
  const r = comp('ram'), slots = r.slots || 0, mods = r.modules || 0;
  el.innerHTML = `<div class="grid g-mem">
    <div class="pan wide" data-asm>${head(_t('Memory in use'), _t('{v} GB usable', { v: '<span id="mTot">–</span>' }))}
      <div class="hero"><div class="big"><span id="mU">–</span><small>GB</small></div>
        <div class="legend"><span><i style="background:var(--accent)"></i>${_t('in use {v}', { v: '<b id="mL1"></b>' })}</span><span><i style="background:var(--accent2)"></i>${_t('cached {v}', { v: '<b id="mL2"></b>' })}</span><span><i style="background:var(--raise3)"></i>${_t('free {v}', { v: '<b id="mL3"></b>' })}</span></div></div>
      <div class="stack"><span class="s2" id="mS2"></span><span class="s1" id="mS1"></span></div>
      <div class="chwrap">${cv('mCh')}</div>${axis}</div>
    <div class="pan" data-asm>${head(_t('Modules'), esc(r.title))}
      <div class="slots">${Array.from({ length: Math.max(slots, mods, 1) }, (_, i) => i < mods
        ? `<div class="slot on"><div class="stick"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><b>${_t('Slot {n}', { n: i + 1 })}</b><span>${esc(row('ram', LBL.maker))}, ${esc(row('ram', LBL.speed))}</span></div>`
        : `<div class="slot"><div class="stick empty"></div><b>${_t('Slot {n}', { n: i + 1 })}</b><span>${_tc('Empty')}</span></div>`).join('')}</div>
      ${mods === 1 && slots > 1 ? `<p class="mnote">${_t('With a single module, memory runs in single-channel mode. A second identical module would double the bandwidth.')}</p>` : ''}</div>
    <div class="pan" data-asm>${head(_t('Details'))}<div class="stats">
      ${stat(_tc('Committed'), 'mC', '<span id="mCl"></span>', _t('includes the page file'))}${stat(_tc('Cached'), 'mCa', 'GB')}${stat(_t('Paged pool'), 'mPp', 'MB')}${stat(_t('Non-paged pool'), 'mNp', 'MB')}${stat(_t('Speed'), 'mSp', '')}${stat(_tc('Compressed'), 'mZ', 'MB')}</div></div>
    <div class="pan" data-asm>${head(_t('Using the most memory'))}<div class="tops" id="mTop"></div></div>
  </div>`;
  const mi = { paged: null, nonpaged: null, compressed: null, commitLimit: null };
  num(t, S(el, 'mU'), v => v.ram, fmt1); num(t, S(el, 'mTot'), v => v.ramTotal, fmt1);
  fn(t, v => { const free = Math.max(0, (v.ramTotal || 0) - (v.ram || 0) - (v.ramCache || 0)); S(el, 'mL1').textContent = fmt1(v.ram || 0) + ' GB'; S(el, 'mL2').textContent = nil(v.ramCache) ? '—' : fmt1(v.ramCache) + ' GB'; S(el, 'mL3').textContent = fmt1(free) + ' GB';
    S(el, 'mCl').textContent = _t('of {total} GB', { total: fmt1(v.ramCommitLimit || mi.commitLimit || 0) }); });
  bar(t, S(el, 'mS1'), v => v.ram / v.ramTotal); bar(t, S(el, 'mS2'), v => (v.ram + (v.ramCache || 0)) / v.ramTotal);
  chart(t, S(el, 'mCh'), { max: Math.ceil(V().ramTotal || 16), unit: ' GB', dec: 1, series: [{ key: 'ram', col: 'accent', fill: true, label: _tc('In use') }] });
  num(t, S(el, 'mC'), v => v.ramCommit, fmt1); num(t, S(el, 'mCa'), v => v.ramCache, fmt1);
  num(t, S(el, 'mPp'), () => REAL() ? mi.paged : 612); num(t, S(el, 'mNp'), () => REAL() ? mi.nonpaged : 488); num(t, S(el, 'mZ'), () => REAL() ? mi.compressed : 240);
  S(el, 'mSp').textContent = row('ram', LBL.speed) || '–';
  topList(t, S(el, 'mTop'), 'ram', 6, mb);
  const poll = async () => { const d = await eng('memory_info'); if (d) { Object.assign(mi, d); if (curTab === 'memory') refresh('memory'); } };
  if (REAL()) { poll(); tab(t).poll = poll; }
};

/* ---------- disks: real SMART health and partitions ---------- */
const gb = b => b >= 1e12 ? fmt1(b / 1e12) + ' TB' : b >= 1e9 ? fmtInt(b / 1e9) + ' GB' : fmtInt(b / 1e6) + ' MB';
const MOCK_DISKS = { admin: true, trim: true, physical: [{ name: 'WD PC SN5000S SDEQNSJ-1T00', media: 'SSD', bus: 'NVMe', size: 1024209543168, health: 'Healthy', fw: '34230100', temp: 41, tempMax: 70, wear: 2, hours: 1204, starts: 412, readErr: 0, writeErr: 0, smart: true }],
  volumes: [{ disk: 0, letter: 'C', type: 'Basic', size: 1023141740544, hidden: false, fs: 'NTFS', free: 382796140544 }, { disk: 0, letter: '', type: 'Recovery', size: 943718400, hidden: true, fs: 'NTFS', free: null }, { disk: 0, letter: '', type: 'System', size: 104857600, hidden: true, fs: '', free: null }] };
R.disks = (el, t) => {
  el.innerHTML = `<div class="grid g-disk">
    <div class="pan wide" data-asm>${head(_t('Activity'), esc(short(comp('ssd').title)))}
      <div class="pair big2"><div><i style="background:var(--accent2)"></i>${_t('{v} MB/s read', { v: '<b id="dR">–</b>' })}</div><div><i style="background:var(--accent)"></i>${_t('{v} MB/s write', { v: '<b id="dW">–</b>' })}</div></div>
      <div class="chwrap">${cv('dCh')}</div>${axis}</div>
    <div class="pan" data-asm>${head(_t('Health'), 'SMART')}<div id="dHealth"><div class="sk" style="height:46px"></div><div class="sk" style="height:120px;margin-top:12px"></div></div></div>
    <div class="pan" data-asm>${head(_tc('Space'))}<div id="dVols"><div class="sk" style="height:40px"></div><div class="sk" style="height:40px;margin-top:10px"></div></div>
      <button class="btn sec sm" data-act="storage">${ic('storage')}${_t('See what fills the disk')}</button></div>
    <div class="pan" data-asm>${head(_t('Specifications'))}<dl class="spec" id="dSpec"><dt>${_t('Model')}</dt><dd>${esc(comp('ssd').title)}</dd></dl></div>
  </div>`;
  num(t, S(el, 'dR'), v => v.diskRead); num(t, S(el, 'dW'), v => v.diskWrite);
  chart(t, S(el, 'dCh'), { max: 'auto', min: 100, unit: ' MB/s', series: [{ key: 'diskRead', col: 'accent2', fill: true, label: _tc('Read') }, { key: 'diskWrite', col: 'accent', label: _tc('Write') }] });
  load('disks', 'disks').then(d => {
    d = d === undefined ? MOCK_DISKS : d; if (!d) { S(el, 'dHealth').innerHTML = `<p class="mnote">${_t('Could not read the disk.')}</p>`; return; }
    const p = (d.physical || [])[0] || {};
    const ok = (p.health || '').toLowerCase() === 'healthy';
    const hd = S(el, 'dHealth');
    if (!p.smart) hd.innerHTML = `<div class="health-big">${ring('dRing', ok ? 'var(--ok)' : 'var(--warn)')}<div><b>${ok ? _t('Good') : esc(_t(p.health || 'Unknown'))}</b><span>${_t('According to Windows. SMART details need administrator mode.')}</span></div></div>
      <button class="btn sec sm" data-act="admin">${ic('shield')}${_t('See SMART details')}</button>`;
    else {
      const life = nil(p.wear) ? null : 100 - p.wear;
      hd.innerHTML = `<div class="health-big">${ring('dRing', ok ? 'var(--ok)' : 'var(--warn)')}<div><b>${ok ? _t('Good') : esc(_t(p.health || 'Unknown'))}</b><span>${life == null ? _t('The disk reports no errors.') : _t('{n} % of its lifespan left.', { n: life })}</span></div></div>
      <dl class="spec">${[[_t('Life used'), nil(p.wear) ? null : p.wear + ' %'], [_t('Power-on hours'), nil(p.hours) ? null : fmtInt(p.hours) + ' h'], [_t('Power cycles'), nil(p.starts) ? null : fmtInt(p.starts)],
        [_t('Temperature'), nil(p.temp) ? null : p.tempMax ? _t('{t} °C, max {max} °C', { t: p.temp, max: p.tempMax }) : `${p.temp} °C`], [_t('Read errors'), nil(p.readErr) ? null : fmtInt(p.readErr)], [_t('Write errors'), nil(p.writeErr) ? null : fmtInt(p.writeErr)]]
        .filter(x => x[1] != null).map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('') || `<dt>SMART</dt><dd>${_t('no manufacturer data')}</dd>`}</dl>`;
    }
    arc(t, S(el, 'dRing'), () => ok ? (nil(p.wear) ? .96 : 1 - p.wear / 100) : .5, 100.5, 100.5); refresh(t);
    const vols = (d.volumes || []).filter(v => v.size > 50e6);
    const vName = v => v.letter && v.letter.trim() && v.letter !== '\u0000' ? v.letter + ':' : ({ Recovery: _tc('Recovery'), System: _t('EFI boot'), Reserved: _tc('Reserved') }[v.type] || v.type || _t('Partition'));
    S(el, 'dVols').innerHTML = vols.map((v, i) => `<div class="part"><div class="pl"><b>${esc(vName(v))}</b><span>${v.hidden ? _t('hidden') : esc([v.label, v.fs].filter(Boolean).join(', ') || '—')}</span><em>${v.free != null ? _t('{free} free of {total}', { free: gb(v.free), total: gb(v.size) }) : gb(v.size)}</em></div>
      <div class="bar ${v.hidden ? '' : 'acc'}"><span id="dV${i}"></span></div></div>`).join('');
    vols.forEach((v, i) => bar(t, S(el, 'dV' + i), () => v.free != null ? 1 - v.free / v.size : 1));
    S(el, 'dSpec').insertAdjacentHTML('beforeend', [[_t('Capacity'), p.size ? gb(p.size) : null], [_t('Type'), [p.media, p.bus].filter(x => x && x !== 'Unspecified').join(', ') || null], [_t('Firmware'), p.fw || null],
      ['TRIM', d.trim == null ? null : d.trim ? _t('On') : _t('Off')], [_t('Disks in this PC'), (d.physical || []).length]].filter(x => x[1] != null).map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join(''));
    refresh(t); assembleIn(el);
  });
};
const assembleIn = el => $$('.part, .health-big, .spec dt, .spec dd', el).forEach((x, i) => anim(x, [{ opacity: 0 }, { opacity: 1 }], { d: 300, delay: Math.min(i, 12) * 20, keep: true }));

/* ---------- network ---------- */
let ipShown = false, pubIp = null;
const MOCK_NET = { admin: true, adapters: [{ alias: 'Wi-Fi', desc: 'Realtek 8852CE WiFi 6E PCI-E NIC', ipv4: ['192.168.1.37'], gw: ['192.168.1.1'], dns: ['192.168.1.1'], dhcpDns: true, mac: '3C-A6-F6-12-34-7E', speed: '1.2 Gbps', virtual: false }],
  wifi: { connected: true, ssid: 'Home_WiFi_6E', signal: 82, band: '6 GHz', channel: '37', radio: '802.11ax', rx: '1201', tx: '1201' },
  apps: [{ n: 'Brave', conns: 14 }, { n: 'Discord', conns: 6 }, { n: 'Spotify', conns: 3 }, { n: 'Steam', conns: 2 }] };
R.network = (el, t) => {
  el.innerHTML = `<div class="grid g-net">
    <div class="pan wide" data-asm>${head(_t('Traffic'), '<span id="nAd">–</span>')}
      <div class="pair big2"><div><i style="background:var(--accent2)"></i>${_t('{v} Mb/s down', { v: '<b id="nD">–</b>' })}</div><div><i style="background:var(--accent)"></i>${_t('{v} Mb/s up', { v: '<b id="nU">–</b>' })}</div></div>
      <div class="chwrap">${cv('nCh')}</div>${axis}</div>
    <div class="pan" data-asm>${head(_t('Latency'), _t('to {ip}', { ip: '1.1.1.1' }))}
      <div class="big"><span id="nP">–</span><small>ms</small></div><div class="chwrap sm">${cv('nPCh')}</div>
      <div class="mini"><span>${_t('Jitter {v} ms', { v: '<b id="nJ">–</b>' })}</span><span>${_t('Min {v} ms', { v: '<b id="nMin">–</b>' })}</span></div></div>
    <div class="pan" data-asm>${head(_t('Connection'))}<div id="nConn"><div class="sk" style="height:44px"></div><div class="sk" style="height:140px;margin-top:12px"></div></div></div>
    <div class="pan" data-asm>${head(_t('DNS server'))}
      <div class="seg" id="nDns"><span class="ind"></span><button data-v="auto" class="on">${_t('Automatic')}</button><button data-v="cloudflare">Cloudflare</button><button data-v="google">Google</button></div>
      <p class="mnote" id="nDnsTxt">${_t('Checking which DNS you use…')}</p>
      <div class="dnsl"><span>${_t('Response time measured from your network')}</span>
        <div class="dnsr"><b>${_t('Router')}</b><span class="bar"><span id="nDr1"></span></span><em id="nDv1">–</em></div>
        <div class="dnsr"><b>Cloudflare</b><span class="bar"><span id="nDr2"></span></span><em id="nDv2">–</em></div>
        <div class="dnsr"><b>Google</b><span class="bar"><span id="nDr3"></span></span><em id="nDv3">–</em></div></div></div>
    <div class="pan" data-asm>${head(_t('Using the network'), _t('open connections'))}<div class="tops" id="nTop"></div></div>
  </div>`;
  num(t, S(el, 'nD'), v => v.down, fmt1); num(t, S(el, 'nU'), v => v.up, fmt1);
  chart(t, S(el, 'nCh'), { max: 'auto', min: 20, unit: ' Mb/s', dec: 1, series: [{ key: 'down', col: 'accent2', fill: true, label: _tc('Download') }, { key: 'up', col: 'accent', label: _tc('Upload') }] });
  num(t, S(el, 'nP'), v => v.ping);
  fn(t, () => { const h = SH.tele.hist.ping.slice(-40).filter(x => x > 0); if (!h.length) return; const mn = Math.min(...h), avg = h.reduce((a, b) => a + b, 0) / h.length;
    S(el, 'nMin').textContent = fmtInt(mn); S(el, 'nJ').textContent = fmt1(h.reduce((a, b) => a + Math.abs(b - avg), 0) / h.length); });
  chart(t, S(el, 'nPCh'), { max: 'auto', min: 40, unit: ' ms', grid: 3, series: [{ key: 'ping', col: 'accent2', fill: true, label: _t('Latency') }] });
  topList(t, S(el, 'nTop'), 'net', 5, v => _t('{n} conn.', { n: fmtInt(v) }));
  const seg = S(el, 'nDns'); let adapter = null;
  const DNSN = { auto: _t('Automatic'), cloudflare: 'Cloudflare', google: 'Google' };
  const DNST = { auto: ip => ip ? _t('Uses the one your router provides ({ip}).', { ip }) : _t('Uses the one your router provides.'), cloudflare: () => _t('{a} and {b}. Fast, and it does not log what you visit.', { a: '1.1.1.1', b: '1.0.0.1' }), google: () => _t('{a} and {b}. Very reliable worldwide.', { a: '8.8.8.8', b: '8.8.4.4' }) };
  const setSeg = v => { $$('button', seg).forEach(x => x.classList.toggle('on', x.dataset.v === v)); SH.placeSeg(seg); const p = S(el, 'nDnsTxt'); p.textContent = DNST[v](adapter && adapter.gw && adapter.gw[0]); };
  load('net', 'network').then(d => {
    d = d === undefined ? MOCK_NET : d; if (!d) return;
    adapter = (d.adapters || []).find(a => !a.virtual) || (d.adapters || [])[0] || null; const w = d.wifi || {};
    S(el, 'nAd').textContent = adapter ? short(adapter.desc) : _t('offline');
    const sig = w.signal != null ? w.signal : V().wifiSignal;
    const mask = ip => ip ? ip.replace(/^(\d+)\.\d+\.\d+\.(\d+)$/, '$1.•••.•••.$2') : '—';
    S(el, 'nConn').innerHTML = `${w.connected ? `<div class="wifi"><div class="sig" id="nSig">${'<i></i>'.repeat(4)}</div><div><b>${esc(w.ssid)}</b><span>${sig != null ? _t('{n} % signal', { n: sig }) : 'Wi-Fi'}${w.band ? `, ${esc(w.band)}` : ''}${w.channel ? `, ${_t('channel {n}', { n: esc(w.channel) })}` : ''}</span></div></div>`
      : adapter ? `<div class="wifi"><div class="ri">${ic('globe')}</div><div><b>${esc(adapter.alias)}</b><span>${_t('Wired connection')}</span></div></div>` : `<p class="mnote">${_t('No network connection.')}</p>`}
      ${adapter ? `<dl class="spec"><dt>${_t('Adapter')}</dt><dd>${esc(adapter.desc)}</dd><dt>${_t('Link speed')}</dt><dd>${esc(adapter.speed || '—')}</dd>${w.radio ? `<dt>${_tc('Standard')}</dt><dd>${esc(w.radio)}</dd>` : ''}
        <dt>${_t('Local IP')}</dt><dd>${esc((adapter.ipv4 || [])[0] || '—')}</dd><dt>${_t('Gateway')}</dt><dd>${esc((adapter.gw || [])[0] || '—')}</dd>
        <dt>${_t('Public IP')}</dt><dd class="reveal"><span id="nIp">${_t('hidden')}</span><button class="iconbtn" id="nEye" title="${_t('Show or hide')}">${ic('eye')}</button></dd>
        <dt>MAC</dt><dd>${esc((adapter.mac || '').replace(/^(\w\w)-(\w\w)-(\w\w)-\w\w-\w\w-(\w\w)$/, '$1:$2:$3:••:••:$4') || '—')}</dd></dl>` : ''}`;
    $$('#nSig i', el).forEach((b, i) => b.classList.toggle('on', (sig || 0) >= [5, 30, 55, 78][i]));
    const eye = S(el, 'nEye');
    if (eye) eye.addEventListener('click', async () => {
      ipShown = !ipShown; const ip = S(el, 'nIp');
      if (ipShown && !pubIp) { ip.textContent = _t('checking…'); pubIp = REAL() ? await eng('public_ip') : '181.199.47.214'; }
      anim(ip, [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(6px)' }], { d: 140 }).finished.then(() => {
        ip.textContent = ipShown ? (pubIp || _t('could not check')) : (pubIp ? mask(pubIp) : _t('hidden')); anim(ip, [{ opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)' }], { d: 260 });
      }).catch(() => {});
    });
    const dns = adapter && adapter.dns || [];
    const cur = adapter && !adapter.dhcpDns ? (dns.includes('1.1.1.1') ? 'cloudflare' : dns.includes('8.8.8.8') ? 'google' : 'custom') : 'auto';
    if (cur === 'custom') { $$('button', seg).forEach(x => x.classList.remove('on')); S(el, 'nDnsTxt').textContent = _t('Custom: {list}', { list: dns.join(', ') }); } else setSeg(cur);
    /* apps with connections: the engine already groups them; in real mode they come from processes (network = connections) */
    (REAL() ? load('dns', 'dns_test', adapter && adapter.gw && adapter.gw[0]) : Promise.resolve({ router: 9.4, cloudflare: 4.1, google: 5.3 })).then(r => {
      if (!r) return; const vals = [r.router, r.cloudflare, r.google]; const best = Math.min(...vals.filter(x => x != null));
      vals.forEach((x, i) => { S(el, 'nDv' + (i + 1)).textContent = x == null ? _t('no response') : `${fmt1(x)} ms`; const b = S(el, 'nDr' + (i + 1)); b.style.transform = `scaleX(${x == null ? 0 : Math.min(1, x / Math.max(30, best * 4)).toFixed(3)})`;
        b.parentElement.classList.toggle('ok', x === best); b.closest('.dnsr').classList.toggle('best', x === best); });
    });
  });
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.classList.contains('on')) return;
    if (!SH.requireAdmin(_t('to change the DNS server.'))) return;
    if (!adapter) { SH.toast(_t('There is no active network adapter.')); return; }
    const name = DNSN[b.dataset.v];
    confirmDlg({ title: _t('Change the DNS to {name}', { name }), text: _t('It applies to the "{adapter}" adapter. You can switch back to {auto} at any time.', { adapter: adapter.alias, auto: DNSN.auto }), yes: _t('Change DNS'), danger: false }, async () => {
      const r = REAL() ? await eng('set_dns', adapter.alias, b.dataset.v) : { ok: true };
      if (r && r.ok) { setSeg(b.dataset.v); SH.toast(_t('DNS changed to {name}.', { name })); SH.logActivity && SH.logActivity(_t('DNS changed to {name}', { name }), { sub: adapter.alias, ic: 'globe', go: 'monitor', tab: 'network' }); delete cache.net; }
      else if (r && r.needAdmin) SH.requireAdmin(_t('to change the DNS server.'));
      else SH.toast(r && r.error ? _t('Could not change the DNS: {msg}', { msg: r.error }) : _t('Could not change the DNS.'));
    });
  });
};

/* ---------- battery ---------- */
let batChart = null;
R.battery = (el, t) => {
  if (!SH.PC.components.some(c => c.id === 'battery') && REAL()) { el.innerHTML = `<div class="empty"><b>${_t('This PC has no battery')}</b>${_t('It is a desktop PC or the battery is not connected.')}</div>`; return; }
  el.innerHTML = `<div class="grid g-bat">
    <div class="pan" data-asm>${head(_tc('Charge'))}
      <div class="batrow"><div class="batt"><div class="body"><span id="bF"></span></div><div class="cap"></div><svg class="i bolt" id="bBolt" viewBox="0 0 24 24"><path d="M13 2.5 4.5 13.5H12L11 21.5l8.5-11H12z"/></svg></div>
        <div><div class="big"><span id="bP">–</span><small>%</small></div><p class="muted" id="bSt">–</p></div></div>
      <div class="stats s2">${stat(_t('Charge or discharge'), 'bW', 'W', '<span id="bWs"></span>')}${stat(_t('Time left'), 'bE', '', '<span id="bEs"></span>')}</div></div>
    <div class="pan" data-asm>${head(_t('Health'), '<span id="bName">–</span>')}
      <div class="health-big">${ring('bRing', 'var(--ok)')}<div><b><span id="bH">–</span> %</b><span>${_t('of the original capacity')}</span></div></div>
      <dl class="spec" id="bSpec"></dl>
      <p class="mnote">${_t('If the laptop stays plugged in most of the day, limiting the charge to 80 % in the manufacturer\'s app extends battery life.')}</p></div>
    <div class="pan wide" data-asm>${head(_t('Charge level'), `<span id="bRange">${_t('this session')}</span>`)}
      <div class="legend"><span><i style="background:var(--accent2)"></i>${_tc('charge')}</span><span><i style="background:var(--raise3)"></i>${_t('plugged in')}</span></div>
      <div class="chwrap tall"><canvas class="ch" id="bCh"></canvas></div><div class="axis"><span id="bA0">${_t('earlier')}</span><span>${_t('now')}</span></div></div>
  </div>`;
  num(t, S(el, 'bP'), v => v.battery); bar(t, S(el, 'bF'), v => v.battery / 100);
  num(t, S(el, 'bW'), v => nil(v.batteryPower) ? null : Math.abs(v.batteryPower), fmt1);
  num(t, S(el, 'bE'), v => v.batterySecs, s => `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min`, 60, 16);
  num(t, S(el, 'bH'), v => v.batteryHealth); arc(t, S(el, 'bRing'), v => (v.batteryHealth || 0) / 100, 100.5, 100.5);
  fn(t, v => {
    S(el, 'bSt').textContent = v.charging ? (v.battery >= 99 ? _t('Plugged in, fully charged.') : _t('Plugged in and charging.')) : _t('Running on battery.');
    S(el, 'bWs').textContent = nil(v.batteryPower) ? _t('Windows does not report it') : v.batteryPower > 0 ? _t('going into the battery') : v.batteryPower < 0 ? _t('used by the PC') : _t('not charging or discharging');
    S(el, 'bEs').textContent = v.charging ? _t('plugged in') : nil(v.batterySecs) ? _t('calculating') : _t('at this rate');
    S(el, 'bBolt').style.opacity = v.charging ? 1 : 0;
  });
  /* chart: the Windows report for the last 24 h if it has changes; otherwise what was measured this session */
  let pts = null;
  const cvs = S(el, 'bCh'); const ctx = cvs.getContext('2d'); const rv = new Spring(0, 30, 10); let w = 0, h = 0;
  const size = () => { const r = cvs.getBoundingClientRect(); if (!r.width || !r.height) return; const d = Math.min(2, devicePixelRatio || 1); cvs.width = r.width * d; cvs.height = r.height * d; w = r.width; h = r.height; ctx.setTransform(d, 0, 0, d, 0, 0); };
  new ResizeObserver(size).observe(cvs);
  const session = () => SH.tele.hist.battery.map(c => ({ c, plugged: !!V().charging }));
  batChart = {
    replay() { rv.set(0); rv.t = 1; },
    draw(dt) {
      if (!w) { size(); return; } rv.step(dt); ctx.clearRect(0, 0, w, h);
      const data = pts || (REAL() ? session() : BAT24); if (data.length < 2) return;
      const st = w / (data.length - 1), y = c => 6 + (h - 10) * (1 - c / 100);
      ctx.fillStyle = rgba(C.ink, .05); data.forEach((p, i) => { if (p.plugged) ctx.fillRect(i * st - st / 2, 0, st + .5, h); });
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; [25, 50, 75].forEach(c => { ctx.beginPath(); ctx.moveTo(0, Math.round(y(c)) + .5); ctx.lineTo(w, Math.round(y(c)) + .5); ctx.stroke(); });
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w * clamp01(rv.v), h); ctx.clip();
      ctx.beginPath(); data.forEach((p, i) => i ? ctx.lineTo(i * st, y(p.c)) : ctx.moveTo(0, y(p.c)));
      ctx.strokeStyle = C.accent2; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, rgba(C.accent2, .22)); g.addColorStop(1, rgba(C.accent2, 0)); ctx.fillStyle = g; ctx.fill();
      ctx.restore();
    },
  };
  batChart.replay();
  const fill = (rep) => {
    const spec = rep ? [[_t('Original capacity'), rep.design ? fmt1(rep.design / 1000) + ' Wh' : null], [_t('Current capacity'), rep.full ? fmt1(rep.full / 1000) + ' Wh' : null],
      [_t('Charge cycles'), rep.cycles ? fmtInt(rep.cycles) : _t('Windows does not report them')], [_t('Manufacturer'), rep.maker || null]].filter(x => x[1] != null) : [];
    S(el, 'bSpec').innerHTML = spec.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join(''); S(el, 'bName').textContent = rep && rep.name || _t('battery');
    const u = rep && rep.usage || [];
    if (u.length >= 3) { pts = u.map(e => ({ c: e.pct, plugged: e.ac })); S(el, 'bRange').textContent = _t('last 24 h'); S(el, 'bA0').textContent = _t('24 h ago'); batChart.replay(); }
    else { S(el, 'bRange').textContent = REAL() ? _t('this session (Windows has no changes in the last 24 h)') : _t('last 24 h'); S(el, 'bA0').textContent = REAL() ? _t('1 min ago') : _t('24 h ago'); }
  };
  if (REAL()) load('bat', 'battery_report').then(fill); else fill({ design: 90001, full: 87206, cycles: 38, maker: 'ASUS', name: 'GU60558', usage: [] });
};
const BAT24 = (() => { const a = []; let c = 100; for (let i = 0; i < 96; i++) { const plugged = !(i >= 52 && i < 66); c = plugged ? Math.min(100, c + 6) : Math.max(20, c - 4.6 - Math.random()); a.push({ c, plugged }); } return a; })();

/* ---------- processes: sortable table whose rows reorder (FLIP) ---------- */
const COLS = [['n', _t('Name')], ['cpu', 'CPU'], ['ram', _t('Memory')], ['gpu', 'GPU'], ['disk', _t('Disk')], ['net', _t('Network')]];
let sortK = 'cpu', sortDir = -1, query = '', hoverTable = false, procBody = null; const rowEls = new Map();
const CELL = { cpu: v => pct(v), ram: mb, gpu: v => pct(v), disk: v => fmt1(v) + ' MB/s', net: v => REAL() ? (v ? _t('{n} conn.', { n: fmtInt(v) }) : '—') : fmt1(v) + ' Mb/s' };
const HEAT = { cpu: 12, ram: 2000, gpu: 12, disk: 6, net: 12 };
R.processes = (el, t) => {
  el.classList.add('fill');
  el.innerHTML = `<div class="procs">
    <div class="ptools" data-asm><label class="field"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><input id="pQ" placeholder="${_t('Search for a process')}" spellcheck="false"></label>
      <span class="muted" id="pCount"></span><span class="faint hint" id="pHint">${_t('Sorting pauses while the pointer is over the list.')}</span></div>
    <div class="pan ptable" data-asm>
      <div class="ph">${COLS.map(([k, n]) => `<button data-sort="${k}"${k === sortK ? ' class="on"' : ''}>${n}<svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>`).join('')}<span></span></div>
      <div class="pb" id="pB"></div></div></div>`;
  procBody = S(el, 'pB');
  S(el, 'pQ').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderProcs(true, true); });
  $('.ph', el).addEventListener('click', e => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    if (sortK === b.dataset.sort) sortDir *= -1; else { sortK = b.dataset.sort; sortDir = sortK === 'n' ? 1 : -1; }
    $$('.ph [data-sort]', el).forEach(x => { x.classList.toggle('on', x === b); x.classList.toggle('asc', x === b && sortDir === 1); });
    renderProcs(true, true);
  });
  procBody.addEventListener('pointerenter', () => { hoverTable = true; anim(S(el, 'pHint'), [{ opacity: .3 }, { opacity: 1 }], { d: 240 }); });
  procBody.addEventListener('pointerleave', () => { hoverTable = false; });
  procBody.addEventListener('click', e => {
    const b = e.target.closest('[data-pact]'); if (!b) return; const id = b.closest('.pr').dataset.id;
    const p = procList().find(x => String(x.id) === id); if (!p) return;
    if (b.dataset.pact === 'loc') { if (REAL()) eng('open_location', p.path).then(r => { if (!r) SH.toast(_t('Windows does not show where that program is located.')); }); else SH.toast(_t('Opening {path}', { path: p.path })); }
    if (b.dataset.pact === 'end') askEnd(p);
  });
  fn(t, () => renderProcs(!hoverTable));
};
function sortedProcs() {
  return procList().filter(p => p.alive && (!query || (p.n + ' ' + p.exe).toLowerCase().includes(query)))
    .sort((a, b) => sortK === 'n' ? a.n.localeCompare(b.n, 'en') * sortDir : (a[sortK] - b[sortK]) * sortDir);
}
/* "brave.exe, 14 processes" */
const procSub = p => p.k > 1 ? _t('{exe}, {n} processes', { exe: p.exe, n: p.k }) : p.exe;
function makeRow(p) {
  const el = document.createElement('div'); el.className = 'pr'; el.dataset.id = p.id;
  el.dataset.ic = p.icon ? '1' : '0';
  el.innerHTML = `${mono(p.n, p.icon)}<span class="pn"><b>${esc(p.n)}</b><span>${esc(procSub(p))}</span></span>
    ${['cpu', 'ram', 'gpu', 'disk', 'net'].map(k => `<span class="c" data-c="${k}"></span>`).join('')}
    <span class="pa"><button class="iconbtn" data-pact="loc" title="${_t('Open file location')}">${ic('folder')}</button>
    <button class="iconbtn" data-pact="end" title="${p.own ? _t('This is StellarHub') : p.sys ? _t('Windows needs it') : _t('End task')}"${p.sys || p.own ? ' disabled' : ''}>${ic('x')}</button></span>`;
  return el;
}
function fillRow(el, p) {
  if (p.icon && el.dataset.ic !== '1') { el.dataset.ic = '1'; $('.mono', el).outerHTML = mono(p.n, p.icon); }
  const sub = $('.pn span', el); const st = procSub(p); if (sub.textContent !== st) sub.textContent = st;
  $$('.c', el).forEach(c => { const k = c.dataset.c; c.textContent = CELL[k](p[k]); c.style.setProperty('--h', clamp01(p[k] / HEAT[k]).toFixed(3)); });
}
function renderProcs(reorder, force) {
  if (!procBody || (paused && !force)) return;
  const list = sortedProcs();
  const cnt = $('#pCount'); if (cnt) cnt.textContent = _t('{n} programs, {m} processes', { n: list.length, m: list.reduce((s, p) => s + p.k, 0) });
  if (!list.length) { rowEls.forEach(el => el.remove()); if (!$('.empty', procBody)) procBody.insertAdjacentHTML('beforeend', `<div class="empty"><b>${_t('Nothing matches "{q}"', { q: esc(query) })}</b>${_t('Try the program name or its .exe file.')}</div>`); return; }
  const em = $('.empty', procBody); if (em) em.remove();
  if (!reorder) { list.forEach(p => { const el = rowEls.get(p.id); if (el && el.parentNode) fillRow(el, p); }); return; }
  const first = new Map(); rowEls.forEach((el, id) => { if (el.parentNode) first.set(id, el.getBoundingClientRect().top); });
  const keep = new Set(list.map(p => p.id));
  rowEls.forEach((el, id) => { if (!keep.has(id) && el.parentNode) el.remove(); });
  list.forEach(p => { let el = rowEls.get(p.id); if (!el) { el = makeRow(p); rowEls.set(p.id, el); } fillRow(el, p); procBody.appendChild(el); });
  if (state.settings.intensity === 'min') return;
  list.forEach((p, i) => {
    const el = rowEls.get(p.id), f = first.get(p.id);
    /* keep + fill without 'forwards': row animations do not cancel each other (cancelling midway left opacity stuck at 0) */
    if (f == null) anim(el, [{ opacity: 0 }, { opacity: 1 }], { d: 320, delay: Math.min(i, 12) * 18, keep: true, fill: 'backwards' });
    else { const d = f - el.getBoundingClientRect().top; if (Math.abs(d) > 1) { el.getAnimations().forEach(a => { if (a.effect && a.effect.getKeyframes().some(k => k.transform)) a.cancel(); }); anim(el, [{ transform: `translate3d(0,${d}px,0)` }, { transform: 'none' }], { d: 460, e: EASE.spring, keep: true, fill: 'none' }); } }
  });
}
function askEnd(p) {
  confirmDlg({ title: _t('End {name}', { name: p.n }), text: p.k > 1 ? _t('It will close along with its {n} processes without saving. Anything unsaved in that program will be lost.', { n: p.k }) : _t('It will close without saving. Anything unsaved in that program will be lost.'), yes: _t('End task') }, async () => {
    const row = rowEls.get(p.id);
    const r = REAL() ? await eng('end_process', p.exe) : { killed: 1 };
    if (!r || !r.killed) { SH.toast(r && r.denied ? (SH.state.admin ? _t('Windows did not allow closing {name}.', { name: p.n }) : _t('Windows did not allow closing {name}: try administrator mode.', { name: p.n })) : _t('Could not close {name}.', { name: p.n })); return; }
    const done = () => { p.alive = false; if (REAL()) RP.delete(p.id); if (row) row.remove(); renderProcs(true, true); SH.toast(_t('{name} ended.', { name: p.n }));
      if (SH.logActivity) SH.logActivity(_t('{name} ended', { name: p.n }), { sub: _t('from Live Monitor'), ic: 'x', go: 'monitor', tab: 'processes' }); };
    if (row && row.parentNode) anim(row, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(24px,0,0)' }], { d: 220 }).finished.then(done).catch(done); else done();
  });
}
/* our own confirmation dialog (no confirm()): used by end task and change DNS */
function confirmDlg(o, onYes) {
  const sec = $('#v-monitor'); let dlg = $('.mdlg', sec);
  if (!dlg) { dlg = document.createElement('div'); dlg.className = 'mdlg'; sec.appendChild(dlg); }
  dlg.innerHTML = `<div class="scrim"></div><div class="box" role="dialog" aria-label="${esc(o.title)}"><span class="bi">${ic(o.danger === false ? 'info' : 'alert')}</span>
    <h3>${esc(o.title)}</h3><p>${esc(o.text)}</p>
    <div class="row-btns"><button class="btn ghost" data-d="no">${_t('Cancel')}</button><button class="btn ${o.danger === false ? 'pri' : 'danger'}" data-d="yes">${esc(o.yes)}</button></div></div>`;
  dlg.classList.add('on');
  anim($('.scrim', dlg), [{ opacity: 0 }, { opacity: 1 }], { d: 200 });
  anim($('.box', dlg), [{ opacity: 0, transform: 'translate3d(0,12px,0) scale(.94)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { d: 380, e: EASE.spring });
  setTimeout(() => { const b = $('[data-d="no"]', dlg); if (b) b.focus(); }, 30);
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(false); } };
  function close(yes) {
    document.removeEventListener('keydown', onKey, true);
    anim($('.scrim', dlg), [{ opacity: 1 }, { opacity: 0 }], { d: 160 });
    anim($('.box', dlg), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(0,6px,0) scale(.97)' }], { d: 160 }).finished.then(() => dlg.classList.remove('on')).catch(() => {});
    if (yes) onYes();
  }
  document.addEventListener('keydown', onKey, true);
  dlg.onclick = e => { const b = e.target.closest('[data-d]'); if (b) close(b.dataset.d === 'yes'); else if (e.target.classList.contains('scrim')) close(false); };
}

/* ---------- health: devices with errors and real events ---------- */
const CLASS_N = { Display: ['display', _t('Display and graphics')], Monitor: ['display', _t('Monitors')], MEDIA: ['audio', _t('Audio')], AudioEndpoint: ['speaker', _t('Audio inputs and outputs')],
  Net: ['wifi', _t('Network')], Bluetooth: ['wifi', 'Bluetooth'], DiskDrive: ['ssd', _t('Disks')], SCSIAdapter: ['ssd', _t('Storage controllers')], Volume: ['ssd', _t('Volumes')],
  Keyboard: ['keyboard', _t('Keyboards')], Mouse: ['mouse', _t('Mice and touchpads')], HIDClass: ['keyboard', _t('Input devices')], USB: ['tray', 'USB'], Battery: ['battery', _t('Battery and power')],
  System: ['cpu', _t('System and motherboard')], Processor: ['cpu', _t('Processors')], Camera: ['camera', _t('Cameras')], Image: ['camera', _t('Cameras')], Biometric: ['lock', _t('Biometrics')],
  SecurityDevices: ['shield', _t('Security (TPM)')], Firmware: ['cpu', _t('Firmware')], SoftwareDevice: ['package', _t('Software devices')], SoftwareComponent: ['package', _t('Software components')], Printer: ['file', _t('Printers')] };
const MOCK_HEALTH = { admin: true, fastStartup: true, boot: new Date(Date.now() - 3 * 864e5).toISOString(),
  errors: [{ name: 'Unknown USB Device (Device Descriptor Request Failed)', code: 43, cls: 'USB', why: _t('Windows stopped it because it reported a problem') }],
  classes: [{ cls: 'Display', n: 4, bad: 0 }, { cls: 'MEDIA', n: 5, bad: 0 }, { cls: 'Net', n: 3, bad: 0 }, { cls: 'USB', n: 14, bad: 1 }, { cls: 'System', n: 41, bad: 0 }, { cls: 'Battery', n: 3, bad: 0 }],
  events: [{ src: 'Microsoft-Windows-WindowsUpdateClient', id: 20, level: 2, t: new Date(Date.now() - 864e5).toISOString(), msg: 'Installation Failure', count: 7, help: _t('A Windows update could not be installed.') },
    { src: 'Service Control Manager', id: 7023, level: 2, t: new Date(Date.now() - 2 * 864e5).toISOString(), msg: 'The service terminated with an error', count: 2, help: _t('A service stopped with an error.') }] };
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const srcName = s => String(s || '').replace(/^Microsoft-Windows-/, '').replace(/-/g, ' ');
R.health = (el, t) => {
  el.innerHTML = `<div class="grid g-health">
    <div class="pan wide allok" data-asm id="hTop"><div class="sk" style="width:52px;height:52px;border-radius:50%"></div>
      <div class="okt"><h3>${_t('Checking the system…')}</h3><p>${_t('Devices, drivers and Windows warnings from the last 7 days.')}</p></div>
      <div class="stats s3">${stat(_t('Uptime'), 'hUp', '', _t('since the last startup'))}${stat(_t('Last startup'), 'hBoot', '', '<span id="hFast"></span>')}${stat(_t('Devices'), 'hDev', '', `<span id="hDevS">${_t('counting')}</span>`)}</div></div>
    <div class="pan" data-asm>${head(_t('Devices'), '<span id="hDevT">–</span>')}<div class="devs" id="hDevs"><div class="sk" style="height:180px"></div></div></div>
    <div class="pan" data-asm>${head(_t('With errors'))}<div class="rows" id="hErr"><div class="sk" style="height:60px"></div></div>
      ${head(_t('Peak temperatures this session'))}<div class="maxt">
        <div><span>${_t('Processor')}</span><b><span id="hMc">–</span> °C</b><em id="hMcA"></em></div><div><span>${_t('Graphics')}</span><b><span id="hMg">–</span> °C</b><em id="hMgA"></em></div></div></div>
    <div class="pan wide" data-asm>${head(_t('Windows warnings'), _t('last 7 days'))}<div class="events" id="hEv"><div class="sk" style="height:120px"></div></div></div>
  </div>`;
  num(t, S(el, 'hUp'), v => v.uptime, upt, 400, 40);
  fn(t, v => {
    if (nil(v.uptime)) return; const b = new Date(Date.now() - v.uptime * 1000);
    S(el, 'hBoot').textContent = b.toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const at = ts => _t('at {time}', { time: new Date(ts || Date.now()).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) });
    S(el, 'hMcA').textContent = MAXT.cpu == null ? (REAL() ? (SH.state.admin ? _t('not available') : _t('admin mode only')) : '') : at(MAXT.cpuAt);
    S(el, 'hMgA').textContent = MAXT.gpu == null ? '' : at(MAXT.gpuAt);
  });
  num(t, S(el, 'hMc'), () => MAXT.cpu); num(t, S(el, 'hMg'), () => MAXT.gpu);
  load('health', 'health').then(d => {
    d = d === undefined ? MOCK_HEALTH : d; if (!d) return;
    const errs = d.errors || [], total = (d.classes || []).reduce((s, c) => s + c.n, 0);
    const top = S(el, 'hTop'); const ok = !errs.length;
    top.classList.toggle('warn', !ok);
    top.firstElementChild.outerHTML = ok ? '<svg class="okmark go" viewBox="0 0 52 52"><circle cx="26" cy="26" r="23"/><path d="m15 27 7.5 7.5L37.5 19"/></svg>'
      : `<span class="warnmark">${ic('alert')}</span>`;
    const nEv = (d.events || []).length;
    $('.okt', top).innerHTML = ok ? `<h3>${_t('All good')}</h3><p>${_t('No devices with errors.')} ${nEv ? _t('Below are {n} kinds of Windows warnings from this week.', { n: nEv }) : _t('No Windows warnings this week.')}</p>`
      : `<h3>${errs.length > 1 ? _t('{n} devices with errors', { n: errs.length }) : _t('{n} device with errors', { n: errs.length })}</h3><p>${_t('{name}: {why}.', { name: esc(errs[0].name), why: esc(errs[0].why) })}</p>`;
    S(el, 'hDev').textContent = fmtInt(total); S(el, 'hDevS').textContent = ok ? _t('all working') : _t('{n} with errors', { n: errs.length }); S(el, 'hDevT').textContent = _t('{n} in total', { n: fmtInt(total) });
    S(el, 'hFast').textContent = d.fastStartup ? _t('fast startup on') : _t('normal startup');
    const cls = (d.classes || []).filter(c => c.n).sort((a, b) => b.bad - a.bad || b.n - a.n).slice(0, 10);
    S(el, 'hDevs').innerHTML = cls.map(c => { const [i, n] = CLASS_N[c.cls] || ['package', c.cls || _t('Other')]; return `<div class="dv"><span class="ri">${ic(i)}</span><span>${esc(n)}</span><em>${c.n}</em><span class="chip ${c.bad ? 'warn' : 'ok'}">${c.bad ? _t('{n} with warnings', { n: c.bad }) : 'OK'}</span></div>`; }).join('');
    S(el, 'hErr').innerHTML = errs.length ? errs.map(e => `<div class="row"><span class="ri">${ic('alert')}</span><span class="rt"><b>${esc(e.name)}</b><span>${esc(e.why)}${e.code === 43 && /usb/i.test(e.name) ? '. ' + _t('It is usually a faulty cable or USB port: unplug it and plug it into another port.') : ''}</span></span><button class="btn sec sm" data-act="drivers">${_t('Drivers')}</button></div>`).join('')
      : `<div class="row"><span class="ri">${ic('check')}</span><span class="rt"><b>${_t('No devices with errors')}</b><span>${_t('All drivers load correctly.')}</span></span></div>`;
    const ev = d.events || [];
    S(el, 'hEv').innerHTML = ev.length ? ev.map(e => `<div class="evt"><span class="dotc ${e.level === 1 ? 'bad' : 'warn'}"></span><div><b>${esc(e.help || e.msg || _t('Windows warning'))}</b>
      <p>${esc(srcName(e.src))} ${e.id}${e.count > 1 ? ', ' + _t('{n} times this week', { n: e.count }) : ''}${e.help && e.msg ? '. ' + _t('Windows says: "{msg}"', { msg: esc(e.msg.slice(0, 160)) }) : ''}</p></div><time>${when(e.t)}</time></div>`).join('')
      : `<p class="mnote">${_t('No errors or critical warnings in the last 7 days.')}</p>`;
    refresh(t);
    $$('#hDevs .dv, #hEv .evt, #hErr .row', el).forEach((x, i) => anim(x, [{ opacity: 0, transform: 'translate3d(0,6px,0)' }, { opacity: 1, transform: 'none' }], { d: 360, delay: Math.min(i, 14) * 25, keep: true }));
  });
};

/* ---------- loop ---------- */
SH.tele.on(v => {
  simTick(v);
  if (paused) return;
  lastPush = performance.now();
  if (visible()) refresh(curTab);
});
tickers.add((dt, t) => {
  if (!visible()) return;
  const tc = T[curTab]; if (!tc) return;
  const minI = state.settings.intensity === 'min';
  const frac = paused ? frozenFrac : minI ? 0 : Math.min(1, (t - lastPush) / 700);
  for (const b of tc.nums) { b.s.step(dt); const s = b.nil ? '—' : b.fmt(Math.max(0, b.s.v)); if (s !== b.last) { b.el.textContent = s; b.last = s; } }
  for (const b of tc.bars) { b.s.step(dt); b.el.style.transform = b.axis === 'y' ? `scaleY(${b.s.v.toFixed(4)})` : `scaleX(${b.s.v.toFixed(4)})`; }
  for (const b of tc.arcs) { b.s.step(dt); b.el.setAttribute('stroke-dasharray', `${(b.len * b.s.v).toFixed(2)} ${b.total}`); }
  if (!minI && !paused) for (const f of tc.fans) { const rpm = f.get(V()); if (!rpm) continue; f.a = (f.a + dt * rpm / 60 * 360 * .25) % 360; f.el.style.transform = `rotate(${f.a.toFixed(1)}deg)`; }
  for (const c of tc.charts) c.draw(frac, dt);
  if (curTab === 'battery' && batChart) batChart.draw(dt);
});

/* ---------- registration ---------- */
SH.module({
  id: ID, real: true,
  actions(el) {
    el.innerHTML = `<button class="btn ghost" id="monPause">${ic('pause')}<span>${_t('Pause')}</span></button><button class="btn sec" id="monCompact">${ic('monitor')}${_t('Compact mode')}</button>`;
    $('#monPause', el).addEventListener('click', e => {
      paused = !paused; const b = e.currentTarget;
      if (paused) { frozen = {}; Object.keys(SH.tele.hist).forEach(k => { frozen[k] = SH.tele.hist[k].slice(); }); Object.keys(LOC).forEach(k => { frozen[k] = LOC[k].slice(); }); frozenFrac = Math.min(1, (performance.now() - lastPush) / 700); }
      else { frozen = null; lastPush = performance.now(); refresh(curTab); }
      b.innerHTML = `${ic(paused ? 'play' : 'pause')}<span>${paused ? _t('Resume') : _t('Pause')}</span>`;
      anim(b, [{ transform: 'scale(.92)' }, { transform: 'scale(1)' }], { d: 320, e: EASE.spring });
      SH.toast(paused ? _t('Charts paused. Hover over them to see each moment.') : _t('Charts running again.'));
    });
    $('#monCompact', el).addEventListener('click', () => { if (SH.toggleWidget) SH.toggleWidget(); else SH.toast(_t('Compact mode is coming soon.')); });
  },
  renderTab(id, el) {
    readColors();
    const f = R[id]; if (!f) return;
    f(el, id);
    /* each panel's content goes in a flexible body: charts stretch and whatever does not fit scrolls inside (with a fade) */
    $$('.grid>.pan', el).forEach(p => {
      if (p.classList.contains('allok')) return;
      const h = p.firstElementChild && p.firstElementChild.tagName === 'H4' ? p.firstElementChild : null;
      const body = document.createElement('div'); body.className = 'pbody';
      [...p.childNodes].forEach(n => { if (n !== h) body.appendChild(n); }); p.appendChild(body);
    });
    el.addEventListener('click', e => {
      const g = e.target.closest('[data-goto]'); if (g) { SH.go(ID, { tab: g.dataset.goto }); return; }
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'storage') SH.go('storage', { tab: 'map' });
      if (a.dataset.act === 'drivers') SH.go('drivers', { tab: 'updates' });
      if (a.dataset.act === 'admin') SH.go('admin');
    });
    requestAnimationFrame(() => $$('.seg', el).forEach(s => SH.placeSeg(s, true)));
  },
  enterTab(id) {
    curTab = id; readColors(); refresh(id);
    if (REAL()) { if (PROC_TABS.has(id)) startProcPoll(); else stopProcPoll(); if (T[id] && T[id].poll) T[id].poll(); }
    const tc = T[id]; if (tc) tc.charts.forEach(c => { c.size(); c.replay(); });
    if (id === 'battery' && batChart) batChart.replay();
    if (id === 'processes') renderProcs(true, true);
    if (id === 'health') { const m = $('#v-monitor .okmark'); if (m) { m.classList.remove('go'); void m.getBoundingClientRect(); m.classList.add('go'); } }
  },
  enter() { readColors(); },
  leave() { stopProcPoll(); },
});

SH.actions.add([
  { t: _t('See which processes use the most CPU'), go: ID, tab: 'processes', ic: 'cpu' },
  { t: _t('End a process'), go: ID, tab: 'processes', ic: 'x' },
  { t: _t('Change the DNS server'), go: ID, tab: 'network', ic: 'globe' },
  { t: _t('Show my IP address'), go: ID, tab: 'network', ic: 'wifi' },
  { t: _t('Disk health (SMART)'), go: ID, tab: 'disks', ic: 'ssd' },
  { t: _t('See Windows warnings and errors'), go: ID, tab: 'health', ic: 'alert' },
]);
})();
