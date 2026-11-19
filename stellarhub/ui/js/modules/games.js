/* StellarHub · Games: the frame rate of the game being played, its slowdowns and what holds it back, measured by
   Intel PresentMon through stellarhub/engine/games.py, and the sessions saved when a game closes.
   Outside the app (browser, design reviews) it plays a simulated game and shows sample sessions.
   See docs/UI_CONTRACT.md. */
'use strict';
(() => {
const { $, $$, ic, esc, fmt1, fmtInt, state } = SH;
const t = SH.t;
const LOCALE = (SH.i18n && SH.i18n.locale) || 'en-US';
let REAL = false; SH.apiReady.then(a => { REAL = !!a; });

const TARGETS = [30, 60, 120, 144];
const target = () => +state.settings.gamesTarget || 60;
const nil = v => v == null || Number.isNaN(v);
const n0 = v => nil(v) ? '—' : fmtInt(v);
const n1 = v => nil(v) ? '—' : fmt1(v);
const pct = v => nil(v) ? '—' : fmtInt(v * 100) + '%';
const pad = v => String(v).padStart(2, '0');
const dur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`; };
const when = at => new Date(at).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const title = app => String(app || '').replace(/\.exe$/i, '');

/* ============================================================ sample mode (browser only) */
const SIM = (() => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const walk = (n, base, swing) => { const out = []; let v = base; for (let i = 0; i < n; i++) { v = Math.max(base * .6, Math.min(base * 1.3, v + (rnd() - .5) * swing)); out.push(+(rnd() < .03 ? v * .55 : v).toFixed(1)); } return out; };
  const session = (id, app, hoursAgo, minutes, fps, diagnosis, hw, events) => {
    const series = walk(Math.min(600, minutes * 60), fps, fps * .08), sorted = series.slice().sort((a, b) => a - b);
    return { id, app, at: Date.now() - hoursAgo * 36e5, seconds: minutes * 60, frames: Math.round(fps * minutes * 60), fps, min: sorted[0], max: sorted[sorted.length - 1],
      low1: +(fps * .62).toFixed(1), low01: +(fps * .41).toFixed(1), worstMs: +(4200 / fps).toFixed(1), gpuBusy: diagnosis.gpu, series, seriesStep: Math.max(1, Math.ceil(minutes * 60 / 600)),
      events, eventsDropped: 0, target: 60, diagnosis, hw };
  };
  let sessions = [
    session('g3', 'Starfall Odyssey.exe', 2, 84, 47.3, { limit: 'gpu', tooHigh: true, vramFull: true, gpu: .98, thread: .58, vram: .97 }, { cpu: 34, cpuTemp: 74, gpu: 98, gpuTemp: 81, vram: 7.8, vramTotal: 8, ram: 13.1 },
      [{ kind: 'pause', at: 12, seconds: 9.4, frames: 1, worst: 9400 }, { kind: 'hitch', at: 640, seconds: .4, frames: 3, worst: 96 }, { kind: 'dip', at: 1810, seconds: 14, fps: 26.4 }, { kind: 'hitch', at: 2954, seconds: .1, frames: 1, worst: 71 }, { kind: 'dip', at: 4102, seconds: 6, fps: 29.8 }]),
    session('g2', 'Rally Legends.exe', 27, 41, 143.6, { limit: 'cap', tooHigh: false, vramFull: false, gpu: .52, thread: .44, vram: .49 }, { cpu: 22, cpuTemp: 63, gpu: 54, gpuTemp: 66, vram: 3.9, vramTotal: 8, ram: 10.2 },
      [{ kind: 'pause', at: 3, seconds: 5.1, frames: 1, worst: 5100 }, { kind: 'hitch', at: 1203, seconds: .1, frames: 1, worst: 31 }]),
    session('g1', 'Colony Builder.exe', 52, 132, 58.9, { limit: 'cpu', tooHigh: false, vramFull: false, gpu: .61, thread: .96, vram: .55 }, { cpu: 41, cpuTemp: 86, gpu: 63, gpuTemp: 68, vram: 4.4, vramTotal: 8, ram: 14.6 },
      [{ kind: 'dip', at: 3320, seconds: 22, fps: 31.2 }, { kind: 'hitch', at: 5120, seconds: .9, frames: 7, worst: 142 }, { kind: 'dip', at: 6904, seconds: 9, fps: 34 }]),
  ];
  let on = true, secs = walk(150, 72, 6), tsec = 150, frames = 150 * 72;
  const events = [{ kind: 'pause', at: 4, seconds: 6.2, frames: 1, worst: 6200 }, { kind: 'hitch', at: 61, seconds: .3, frames: 2, worst: 64 }, { kind: 'hitch', at: 118, seconds: .1, frames: 1, worst: 49 }];
  return {
    status: () => ({ found: true, on, releases: '' }),
    start() { on = true; return { ok: true }; },
    stop() { on = false; return { saved: null }; },
    track: () => true,
    live(tg) {
      if (!on) return { on, found: true, game: null, target: tg, others: [], notes: [] };
      const f = walk(1, secs[secs.length - 1], 7)[0]; secs.push(Math.max(40, Math.min(96, f))); tsec++; frames += Math.round(f);
      if (f < 45) events.push({ kind: 'hitch', at: tsec, seconds: .2, frames: 2, worst: +(2600 / f).toFixed(1) });
      const view = secs.slice(-180), sorted = secs.slice().sort((a, b) => a - b), now = view[view.length - 1];
      return { on, found: true, target: tg, others: [], notes: [], game: {
        app: 'Starfall Odyssey.exe', pid: 4242, frames, seconds: tsec, now, fps: +(frames / tsec).toFixed(1), min: sorted[0], max: sorted[sorted.length - 1],
        low1: +(sorted[Math.floor(sorted.length * .02)] * .9).toFixed(1), ms: +(1000 / now).toFixed(1), gpuNow: .97, series: view, events: events.slice(-8),
        diagnosis: { limit: 'gpu', tooHigh: now < tg, vramFull: false, gpu: .97, thread: .61, vram: .72 }, hw: { cpu: 36, cpuTemp: 72, gpu: 97, gpuTemp: 77, vram: 5.8, vramTotal: 8, ram: 11.4 } } };
    },
    history: () => sessions.slice(),
    delete_session(id) { const n = sessions.length; sessions = sessions.filter(s => s.id !== id); return n - sessions.length; },
    save_session(s) { const r = { ...s, id: 'g' + Date.now() }; sessions.push(r); sessions.sort((a, b) => b.at - a.at); return r; },
  };
})();
async function eng(fn, ...args) { const r = await SH.engine('games', fn, ...args); return r === undefined ? SIM[fn](...args) : r; }

/* ============================================================ shared pieces */
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function fitCanvas(c) {
  const r = c.getBoundingClientRect(); if (!r.width || !r.height) return null;
  const d = Math.min(2, devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0); return { x, w: r.width, h: r.height };
}
/* frame rate over time. values: one per point; o.target: dashed line; o.marks: [{ i0, i1, kind }] in points;
   o.left / o.right: the labels under both ends */
function drawFps(c, values, o = {}) {
  const f = fitCanvas(c); if (!f) return; const { x, w, h } = f; x.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  const L = 36, R = w - 6, T = 8, B = h - 22, n = values.length - 1;
  const top = Math.max(...values, o.target || 0) * 1.12 || 1;
  const px = i => L + Math.max(0, Math.min(n, i)) / n * (R - L), py = v => B - v / top * (B - T);
  x.font = '11px Onest, system-ui, sans-serif'; x.textBaseline = 'middle'; x.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = top * i / 3, y = Math.round(py(v)) + .5;
    x.strokeStyle = css('--line'); x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke();
    x.fillStyle = css('--faint'); x.textAlign = 'right'; x.fillText(fmtInt(v), L - 8, y);
  }
  (o.marks || []).forEach(m => {
    const a = px(m.i0), b = Math.max(a + 2, px(m.i1));
    x.globalAlpha = m.kind === 'hitch' ? .7 : .16; x.fillStyle = css(m.kind === 'pause' ? '--mute' : m.kind === 'dip' ? '--bad' : '--warn');
    x.fillRect(a, T, m.kind === 'hitch' ? 2 : b - a, B - T); x.globalAlpha = 1;
  });
  if (o.target && o.target < top) {
    const y = Math.round(py(o.target)) + .5; x.setLineDash([4, 5]); x.strokeStyle = css('--mute'); x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); x.setLineDash([]);
  }
  const col = css('--accent2') || '#9ED6FF';
  x.beginPath(); values.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v)));
  x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
  x.lineTo(R, B); x.lineTo(L, B); x.closePath(); x.globalAlpha = .1; x.fillStyle = col; x.fill(); x.globalAlpha = 1;
  x.fillStyle = css('--faint'); x.textBaseline = 'alphabetic';
  if (o.left) { x.textAlign = 'left'; x.fillText(o.left, L, h - 4); }
  if (o.right) { x.textAlign = 'right'; x.fillText(o.right, R, h - 4); }
}
const tile = (label, value, unit, cls = '') => `<div class="gm-tile${cls ? ' ' + cls : ''}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;

/* the diagnosis in words. d: diagnose() from the engine; tg: the frame rate wanted */
function verdict(d, tg) {
  if (!d || nil(d.gpu)) return { cls: '', short: '', h: t('Not enough data yet'), p: t('The verdict appears after a few seconds of play.') };
  if (d.limit === 'gpu' && d.tooHigh) return { cls: 'bad', short: t('Settings too high'), h: t('The graphics card cannot keep up with these settings'),
    p: t('It is busy for {n} of every frame and the game still runs under {fps} fps. Lowering the resolution or the quality settings will raise the frame rate.', { n: pct(d.gpu), fps: fmtInt(tg) }) };
  if (d.limit === 'gpu') return { cls: 'ok', short: t('Graphics card at its limit'), h: t('The graphics card sets the pace, and it keeps up'),
    p: t('It is busy for {n} of every frame, which is normal without a frame cap. Nothing needs lowering.', { n: pct(d.gpu) }) };
  if (d.limit === 'cpu') return { cls: 'warn', short: t('Held back by the processor'), h: t('The processor is holding the frame rate back'),
    p: t('One thread is at {n} while the graphics card waits. Graphics quality will change little; view distance, crowds or physics settings will change more.', { n: pct(d.thread) }) };
  if (d.limit === 'other') return { cls: 'warn', short: t('Graphics card shared'), h: t('Another program is using the graphics card'),
    p: t('The card is {all} busy, but this game only accounts for {n} of every frame. Closing whatever else is rendering or computing on it will help more than lowering settings.', { all: pct(d.gpuAll), n: pct(d.gpu) }) };
  if (d.limit === 'cap') return { cls: 'ok', short: t('Frame cap'), h: t('A frame cap or vsync sets the frame rate'),
    p: t('Neither the graphics card nor the processor is working hard: there is room to raise the quality settings.') };
  return { cls: '', short: '', h: t('No single limit'),
    p: nil(d.thread) ? t('The graphics card is busy for {n} of every frame. There are no processor readings for this run.', { n: pct(d.gpu) })
      : t('The graphics card is busy for {n} of every frame and the busiest thread is at {c}: the work is shared.', { n: pct(d.gpu), c: pct(d.thread) }) };
}
function verdictHTML(d, tg) {
  const v = verdict(d, tg);
  return `<div class="gm-v ${v.cls}"><b>${v.h}</b><p>${v.p}</p>${d && d.vramFull ? `<p class="gm-vram">${ic('alert')}${t('Video memory is almost full. Lowering texture quality frees it and often removes stutter.')}</p>` : ''}</div>`;
}
function metersHTML(d, hw) {
  const bar = v => `<div class="bar"><span style="transform:scaleX(${nil(v) ? 0 : Math.max(0, Math.min(1, v))})"></span></div>`;
  const vram = hw && !nil(hw.vram) && !nil(hw.vramTotal) ? t('{used} of {total} GB', { used: n1(hw.vram), total: n1(hw.vramTotal) }) : pct(d && d.vram);
  return [[t('Graphics card busy'), d && d.gpu, pct(d && d.gpu)], [t('Busiest processor thread'), d && d.thread, pct(d && d.thread)], [t('Video memory'), d && d.vram, vram]]
    .map(([name, v, txt]) => `<div class="gm-m"><span>${name}</span><b>${txt}</b>${bar(v)}</div>`).join('')
    + `<div class="gm-m"><span>${t('Graphics card temperature')}</span><b>${hw && !nil(hw.gpuTemp) ? n0(hw.gpuTemp) + ' °C' : '—'}</b></div>`;
}
function eventHTML(e) {
  const [icon, text] = e.kind === 'pause' ? ['pause', t('Paused or loading for {s} s', { s: n0(e.seconds) })]
    : e.kind === 'dip' ? ['alert', t('{s} s at about {fps} fps', { s: n0(e.seconds), fps: n0(e.fps) })]
    : e.frames > 1 ? ['bolt', t('{n} slow frames, the worst took {ms} ms', { n: fmtInt(e.frames), ms: n0(e.worst) })]
    : ['bolt', t('One slow frame of {ms} ms', { ms: n0(e.worst) })];
  return `<div class="gm-e ${e.kind}"><span class="gm-ei">${ic(icon)}</span><span class="gm-et">${text}</span><span class="gm-ea">${dur(e.at)}</span></div>`;
}
const eventsHTML = (list, empty) => list.length ? list.map(eventHTML).join('') : `<div class="gm-quiet">${empty}</div>`;

/* ============================================================ live */
const LV = { el: null, timer: null, busy: false, data: null, hadGame: false };
function renderLive(el) {
  LV.el = el; el.classList.add('fill');
  el.innerHTML = `<div class="gm-live">
    <div class="pan gm-top" data-asm><span class="gm-ico">${ic('gamepad')}</span>
      <div class="gm-who"><b data-name>${t('Checking')}</b><span data-sub></span></div>
      <div class="gm-ctl"><label class="gm-auto"><span>${t('Watch whenever StellarHub is open')}</span><button class="toggle${state.settings.gamesAuto ? ' on' : ''}" data-auto aria-label="${esc(t('Watch whenever StellarHub is open'))}"><i></i></button></label>
        <button class="btn pri" data-go disabled>${t('Start watching')}</button></div></div>
    <div class="gm-tiles" data-asm data-tiles></div>
    <div class="gm-body">
      <div class="pan gm-chart" data-asm><h4>${t('Frame rate, last 3 minutes')}<em data-cap></em></h4><div class="gm-cv"><canvas data-cv></canvas></div><div class="gm-none" data-none hidden></div></div>
      <div class="gm-side">
        <div class="pan gm-diag" data-asm><div class="gm-dh"><h4 class="pan-h">${t('What limits the frame rate')}</h4>
          <div class="seg" data-tg title="${esc(t('The frame rate you want'))}"><span class="ind"></span>${TARGETS.map(v => `<button data-v="${v}"${v === target() ? ' class="on"' : ''}>${v}</button>`).join('')}</div></div>
          <div data-verdict></div><div class="gm-meters" data-meters></div></div>
        <div class="pan gm-ev" data-asm><h4>${t('Slowdowns')}<em data-evn></em></h4><div class="gm-evl" data-events></div></div>
      </div>
    </div></div>`;
  const seg = $('[data-tg]', el); requestAnimationFrame(() => SH.placeSeg(seg, true));
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.classList.contains('on')) return; $$('button', seg).forEach(x => x.classList.toggle('on', x === b)); SH.placeSeg(seg); SH.setSetting('gamesTarget', +b.dataset.v); pollLive(); });
  $('[data-auto]', el).addEventListener('click', e => { const on = !state.settings.gamesAuto; SH.setSetting('gamesAuto', on); e.currentTarget.classList.toggle('on', on); if (on && LV.data && LV.data.found && !LV.data.on) toggleWatch(); });
  $('[data-go]', el).addEventListener('click', toggleWatch);
  $('[data-none]', el).addEventListener('click', async e => {
    const pick = e.target.closest('[data-pid]'), get = e.target.closest('[data-get]');
    if (pick) { try { await eng('track', +pick.dataset.pid); } catch (er) { console.error(er); } pollLive(); }
    if (get) { const s = await eng('status').catch(() => null); if (s && s.releases) SH.call('open_url', s.releases); }
  });
  new ResizeObserver(() => LV.data && drawLive(LV.data)).observe($('[data-cv]', el));
  paintLive({ on: false, found: true, game: null, others: [], notes: [], pending: true });
}
async function toggleWatch() {
  const d = LV.data || {};
  try {
    if (d.on) { const r = await eng('stop'); if (r && r.saved) { SS.list = null; SH.toast(t('Session saved: {name}', { name: title(r.saved.app) })); } }
    else { const r = await eng('start'); if (r && !r.ok) SH.toast(t('PresentMon was not found.')); }
  } catch (e) { console.error(e); SH.toast(e.message); }
  pollLive();
}
function drawLive(d) {
  const g = d.game, c = $('[data-cv]', LV.el); if (!c) return;
  if (!g) { const f = fitCanvas(c); if (f) f.x.clearRect(0, 0, f.w, f.h); return; }
  const n = g.series.length, first = g.seconds - n;  /* the series is the last n seconds of the run */
  const marks = g.events.filter(e => e.at + e.seconds >= first).map(e => ({ kind: e.kind, i0: e.at - first, i1: e.at + e.seconds - first }));
  drawFps(c, g.series, { target: d.target, marks, left: t('{time} ago', { time: dur(n) }), right: t('now') });
}
function paintLive(d) {
  LV.data = d; const el = LV.el; if (!el) return;
  const g = d.game, go = $('[data-go]', el), none = $('[data-none]', el);
  $('[data-name]', el).textContent = d.pending ? t('Checking') : g ? title(g.app) : !d.found ? t('PresentMon is missing') : d.on ? t('Waiting for a game') : t('Not watching');
  $('[data-sub]', el).textContent = d.pending ? '' : g ? t('Measured for {time}, {n} frames', { time: dur(g.seconds), n: fmtInt(g.frames) })
    : !d.found ? t('Games needs it to measure frames.') : d.on ? t('Fullscreen and borderless games are picked up after a few seconds.') : t('Nothing is being measured.');
  go.disabled = !!d.pending || !d.found; go.textContent = d.on ? t('Stop watching') : t('Start watching'); go.className = 'btn ' + (d.on ? 'sec' : 'pri');
  $('[data-tiles]', el).innerHTML = tile(t('Now'), n0(g && g.now), 'fps', 'main') + tile(t('Average'), n0(g && g.fps), 'fps') + tile(t('1% low'), n0(g && g.low1), 'fps')
    + tile(t('Slowest second'), n0(g && g.min), 'fps') + tile(t('Fastest second'), n0(g && g.max), 'fps') + tile(t('Frame time'), n1(g && g.ms), 'ms');
  $('[data-cap]', el).textContent = g ? t('dashed line: {n} fps', { n: fmtInt(d.target) }) : '';
  none.hidden = !!g;
  if (!g) none.innerHTML = d.pending ? '' : !d.found
    ? `<b>${t('Intel PresentMon is needed')}</b><p>${t('It is a small free program from Intel that reads frame times from Windows without touching the game. Download PresentMon-x64.exe and put it in a folder called tools next to StellarHub.')}</p><button class="btn sec" data-get>${t('Open the download page')}</button>`
    : !d.on ? `<b>${t('Not watching')}</b><p>${d.notes.length ? esc(d.notes.join(' ')) : t('Start watching and StellarHub measures any game that runs full screen, then keeps a summary when you close it.')}</p>`
    : `<b>${t('Waiting for a game')}</b><p>${t('Start a game in fullscreen or borderless mode.')}</p>${d.others.length ? `<p class="faint">${t('Or measure something that is drawing right now:')}</p><div class="gm-others">${d.others.map(o => `<button class="btn sm sec" data-pid="${esc(o.pid)}">${esc(title(o.app))}<small>${n0(o.fps)} fps</small></button>`).join('')}</div>` : ''}`;
  $('[data-verdict]', el).innerHTML = g ? verdictHTML(g.diagnosis, d.target) : `<div class="gm-v"><p>${t('The verdict appears while a game is being measured.')}</p></div>`;
  $('[data-meters]', el).innerHTML = metersHTML(g && g.diagnosis, g && g.hw);
  $('[data-evn]', el).textContent = g && g.events.length ? t('latest {n}', { n: g.events.length }) : '';
  $('[data-events]', el).innerHTML = eventsHTML(g ? g.events.slice().reverse() : [], g ? t('Smooth so far.') : t('Hitches, dips and loading pauses are listed here.'));
  drawLive(d);
  if (LV.hadGame && !g) SS.list = null;  /* the game closed: its session may have been saved */
  LV.hadGame = !!g;
}
async function pollLive() {
  if (LV.busy || !LV.el) return; LV.busy = true;
  try { paintLive(await eng('live', target())); } catch (e) { console.error(e); } finally { LV.busy = false; }
}
function startPoll() { stopPoll(); pollLive(); LV.timer = setInterval(pollLive, 1000); }
function stopPoll() { clearInterval(LV.timer); LV.timer = null; }

/* ============================================================ sessions */
const SS = { el: null, list: null, sel: null };
function renderSessions(el) {
  SS.el = el; el.classList.add('fill');
  el.innerHTML = `<div class="gm-ses">
    <div class="pan gm-list" data-asm><h4>${t('Saved sessions')}<em data-n></em></h4><div class="gm-rows" data-rows></div></div>
    <div class="pan gm-det" data-asm data-det></div></div>`;
  $('[data-rows]', el).addEventListener('click', async e => {
    const del = e.target.closest('[data-del]'), row = e.target.closest('[data-id]');
    if (del) {
      const s = SS.list.find(x => x.id === del.dataset.del); if (!s) return;
      try { await eng('delete_session', s.id); } catch (er) { console.error(er); return; }
      SS.list = SS.list.filter(x => x !== s); if (SS.sel === s.id) SS.sel = SS.list[0] && SS.list[0].id; paintSessions();
      SH.toast(t('Session deleted.'), { action: { label: t('Undo'), run: async () => { const { id: _old, ...rest } = s; try { await eng('save_session', rest); } catch (er) { console.error(er); } loadSessions(); } } });
    } else if (row && row.dataset.id !== SS.sel) { SS.sel = row.dataset.id; paintSessions(); }
  });
  new ResizeObserver(drawSession).observe($('[data-det]', el));
}
async function loadSessions() {
  try { SS.list = await eng('history'); } catch (e) { console.error(e); SS.list = []; }
  if (!SS.list.some(s => s.id === SS.sel)) SS.sel = SS.list[0] && SS.list[0].id;
  paintSessions();
}
function drawSession() {
  const s = SS.list && SS.list.find(x => x.id === SS.sel), c = SS.el && $('[data-scv]', SS.el); if (!s || !c) return;
  const step = s.seriesStep || 1, series = s.series || [];
  const marks = (s.events || []).map(e => ({ kind: e.kind, i0: e.at / step, i1: (e.at + (e.seconds || 0)) / step }));
  drawFps(c, series, { target: s.target, marks, left: '0:00', right: dur(s.seconds) });
}
function paintSessions() {
  const el = SS.el; if (!el || !SS.list) return; const L = SS.list;
  $('[data-n]', el).textContent = L.length ? (L.length === 1 ? t('{n} session', { n: 1 }) : t('{n} sessions', { n: L.length })) : '';
  $('[data-rows]', el).innerHTML = L.length ? L.map(s => { const v = verdict(s.diagnosis, s.target);
    return `<div class="row gm-row${s.id === SS.sel ? ' on' : ''}" data-id="${esc(s.id)}"><span class="ri">${ic('gamepad')}</span><span class="rt"><b>${esc(title(s.app))}</b><span>${esc(when(s.at))}, ${dur(s.seconds)}</span></span>
      ${v.short ? `<span class="chip ${v.cls}">${v.short}</span>` : ''}<span class="gm-val">${n0(s.fps)}<small>fps</small></span>
      <button class="btn sm ghost gm-del" data-del="${esc(s.id)}" title="${esc(t('Delete this session'))}" aria-label="${esc(t('Delete this session'))}">${ic('trash')}</button></div>`; }).join('')
    : `<div class="empty"><b>${t('No sessions yet')}</b>${t('When a game you played for more than a minute closes, its summary is kept here.')}</div>`;
  const s = L.find(x => x.id === SS.sel), det = $('[data-det]', el);
  if (!s) { det.innerHTML = `<div class="empty"><b>${t('Nothing selected')}</b>${t('Pick a session to see how it ran.')}</div>`; return; }
  const hw = s.hw || {}, ev = s.events || [];
  det.innerHTML = `<div class="gm-sh"><span class="gm-ico">${ic('gamepad')}</span><div class="gm-who"><b>${esc(title(s.app))}</b><span>${esc(when(s.at))}, ${t('played for {time}', { time: dur(s.seconds) })}</span></div></div>
    <div class="gm-tiles">${tile(t('Average'), n0(s.fps), 'fps', 'main')}${tile(t('1% low'), n0(s.low1), 'fps')}${tile(t('0.1% low'), n0(s.low01), 'fps')}${tile(t('Slowest second'), n0(s.min), 'fps')}${tile(t('Fastest second'), n0(s.max), 'fps')}${tile(t('Worst frame'), n0(s.worstMs), 'ms')}</div>
    <div class="gm-cv"><canvas data-scv></canvas></div>
    <div class="gm-two"><div>${verdictHTML(s.diagnosis, s.target)}<div class="gm-meters">${metersHTML(s.diagnosis, hw)}</div></div>
      <div class="gm-sev"><h4 class="pan-h">${t('Slowdowns')}<em>${ev.length ? fmtInt(ev.length) : ''}</em></h4><div class="gm-evl">${eventsHTML(ev, t('None: it ran smoothly from start to finish.'))}</div></div></div>`;
  requestAnimationFrame(drawSession);
}

/* ============================================================ module */
SH.module({
  id: 'games',
  actions(el) { el.innerHTML = `<span class="chip">${ic('info')}${t('Measured on this PC, nothing is sent anywhere')}</span>`; },
  renderTab(tab, el) { if (tab === 'live') renderLive(el); else renderSessions(el); },
  enterTab(tab, el) {
    if (tab === 'live') { startPoll(); $$('.seg', el).forEach(s => requestAnimationFrame(() => SH.placeSeg(s, true))); }
    else { stopPoll(); if (SS.list) paintSessions(); else loadSessions(); }
  },
  leaveTab(tab) { if (tab === 'live') stopPoll(); },
  enter() {}, leave() { stopPoll(); },
});
SH.actions.add([
  { t: t('See the frame rate of my game'), go: 'games', tab: 'live', ic: 'gamepad' },
  { t: t('See how my last games ran'), go: 'games', tab: 'sessions', ic: 'gamepad' },
]);
/* "Watch whenever StellarHub is open": start as soon as the settings are in */
SH.on('boot', () => { if (REAL && state.settings.gamesAuto) SH.engine('games', 'start').catch(e => console.error(e)); });
})();
