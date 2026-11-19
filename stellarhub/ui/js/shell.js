/* StellarHub · shell: stars, dock, navigation between views and tabs, palette, settings, admin mode and toasts. */
'use strict';
(() => {
const { $, $$, ROOT, state, Spring, EASE, anim, assemble, tickers, ic, MODS, modById, registry, motion, esc } = SH;
const S = () => state.settings;

/* ================= stars ================= */
const cv = $('#stars'), cx = cv.getContext('2d'); let SW = 0, SH_ = 0, DPR = 1;
let stars = [];
const star = () => ({ x: Math.random(), y: Math.random(), z: .15 + Math.random() * .85, r: Math.random() * 1.1 + .25, p: Math.random() * 6.28, tw: .4 + Math.random() * 1.4 });
function makeStars(n) { n = Math.max(0, Math.round(n || 0)); if (n > stars.length) stars = stars.concat(Array.from({ length: n - stars.length }, star)); else stars = stars.slice(0, n); }
makeStars(240);
const shooters = []; let nextShot = performance.now() + 4000;
const warp = new Spring(0, 70, 13);
const mouse = { x: new Spring(0, 40, 12), y: new Spring(0, 40, 12) };
function sizeStars() { DPR = Math.min(2, devicePixelRatio || 1); SW = innerWidth; SH_ = innerHeight; cv.width = SW * DPR; cv.height = SH_ * DPR; }
sizeStars(); addEventListener('resize', sizeStars);
addEventListener('pointermove', e => { mouse.x.t = (e.clientX / innerWidth - .5) * 2; mouse.y.t = (e.clientY / innerHeight - .5) * 2; });
const starAlpha = new Spring(0, 40, 12); starAlpha.t = 1;
tickers.add((dt, t) => {
  mouse.x.step(dt); mouse.y.step(dt); warp.step(dt); starAlpha.t = S().stars ? 1 : 0; starAlpha.step(dt);
  cx.setTransform(DPR, 0, 0, DPR, 0, 0); cx.clearRect(0, 0, SW, SH_);
  if (starAlpha.v < .01) return;
  const st = S(), moving = st.intensity !== 'min'; const drift = moving ? dt * .004 * SH.ORBIT[st.intensity] * st.starSpeed : 0;
  const par = st.parallax && moving ? 1 : 0, bright = st.starBright || 1;
  const cxs = SW / 2, cys = SH_ * .52; const w = warp.v;
  /* shooting stars */
  if (st.shooting && moving && t > nextShot) {
    nextShot = t + 7000 + Math.random() * 11000;
    const a = .35 + Math.random() * .35, sp = 900 + Math.random() * 500;
    shooters.push({ x: Math.random() * SW * .8 + SW * .1, y: Math.random() * SH_ * .35, vx: Math.cos(a) * sp * (Math.random() < .5 ? -1 : 1), vy: Math.sin(a) * sp, life: 0, max: .7 + Math.random() * .4 });
  }
  for (let i = shooters.length - 1; i >= 0; i--) {
    const sh = shooters[i]; sh.life += dt; sh.x += sh.vx * dt; sh.y += sh.vy * dt;
    const k = sh.life / sh.max; if (k >= 1) { shooters.splice(i, 1); continue; }
    const fade = Math.sin(k * Math.PI), tail = .12;
    const g = cx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * tail, sh.y - sh.vy * tail);
    g.addColorStop(0, `rgba(230,242,255,${.9 * fade * starAlpha.v})`); g.addColorStop(1, 'rgba(230,242,255,0)');
    cx.globalAlpha = 1; cx.strokeStyle = g; cx.lineWidth = 1.4; cx.beginPath(); cx.moveTo(sh.x, sh.y); cx.lineTo(sh.x - sh.vx * tail, sh.y - sh.vy * tail); cx.stroke();
  }
  for (const s of stars) {
    s.x -= drift * s.z; if (s.x < 0) s.x += 1;
    const x = s.x * SW - mouse.x.v * 22 * s.z * par, y = s.y * SH_ - mouse.y.v * 16 * s.z * par;
    const tw = moving && st.twinkle ? (.65 + .35 * Math.sin(t / 1000 * s.tw + s.p)) : .8;
    cx.globalAlpha = Math.min(1, (.25 + .6 * s.z) * tw * starAlpha.v * bright);
    if (Math.abs(w) > .02) {
      const dx = x - cxs, dy = y - cys, len = w * s.z * .22;
      cx.strokeStyle = s.z > .7 ? '#cfe6ff' : '#9fb6d8'; cx.lineWidth = s.r; cx.beginPath(); cx.moveTo(x, y); cx.lineTo(x + dx * len, y + dy * len); cx.stroke();
    } else { cx.fillStyle = s.z > .75 ? '#e6f2ff' : '#a9bddc'; cx.beginPath(); cx.arc(x, y, s.r * s.z + .2, 0, 6.283); cx.fill(); }
  }
  cx.globalAlpha = 1;
});
SH.mouse = mouse; SH.warp = warp;

/* ================= dock ================= */
const DOCK = ['home', '|', 'monitor', 'drivers', 'remover', 'updater', 'hangar', '|', 'storage', 'optimizer', 'privacy', '|', 'benchmark', 'tester', '|', 'autopilot'];
const dock = $('#dock');
dock.innerHTML = DOCK.map(id => id === '|' ? '<span class="sep"></span>' : (m => `<button class="dk${id === 'home' ? ' on' : ''}" data-go="${id}" aria-label="${m.name}">${ic(m.icon)}<span class="tip">${m.name}</span></button>`)(modById(id))).join('') + '<span class="dot" id="dockDot"></span>';
const BASE = 52, GROW = .3;
const dks = $$('.dk', dock).map(el => ({ el, s: new Spring(1, 320, 24) }));
const dotX = new Spring(0, 260, 24); let dockMouse = null;
dock.addEventListener('pointermove', e => dockMouse = e.clientX);
dock.addEventListener('pointerleave', () => dockMouse = null);
tickers.add(dt => {
  for (const d of dks) {
    let t = 1;
    if (dockMouse !== null && S().intensity !== 'min') {
      const r = d.el.getBoundingClientRect(); const dist = Math.abs(dockMouse - (r.left + r.width / 2));
      t = 1 + GROW * Math.max(0, 1 - dist / 140);
    }
    d.s.t = t; d.s.step(dt);
    const px = (BASE * d.s.v).toFixed(2) + 'px';
    if (d.el.style.width !== px) { d.el.style.width = px; d.el.style.height = px; d.el.firstElementChild.style.transform = `scale(${(.85 + .15 * d.s.v).toFixed(4)})`; }
  }
  /* the dock dot: measured only while the dock moves or the module changes (measuring every frame
     forces a full-page layout and drops the frame rate while scrolling) */
  const dockMoving = dockMouse !== null || dks.some(d => !d.s.idle);
  if (dockMoving || dotDirty) { const on = $('.dk.on', dock); if (on) dotX.t = on.offsetLeft + on.offsetWidth / 2 - 9; dotDirty = false; }
  if (!dotX.idle || dockMoving) { dotX.step(dt); $('#dockDot').style.transform = `translateX(${dotX.v.toFixed(2)}px)`; }
});
let dotDirty = true;
SH.on('view', () => { dotDirty = true; });
addEventListener('resize', () => { dotDirty = true; });
dock.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });

/* ================= modules: views and tabs ================= */
const views = $('#views');
const modState = {}; // id -> {tab, rendered:Set, ix, iw}
function tabsOf(m) { const def = registry.modules[m.id] || {}; return (def.tabs || m.tabs || []).map(t => Array.isArray(t) ? { id: t[0], name: t[1] } : t); }
function skeletonFor(i) {
  const r = k => `<div class="sk-row" data-asm><div class="sk a" style="--dl:${k * .08}s"></div><div class="sk b" style="--w:${[38, 52, 30, 46, 41, 27, 49][k % 7]}%;--dl:${k * .08 + .04}s"></div><div class="sk c" style="--dl:${k * .08 + .08}s"></div></div>`;
  return `<div class="sk-rows">${Array.from({ length: 6 + (i % 3) }, (_, k) => r(k)).join('')}</div>`;
}
function buildModule(m) {
  let s = $('#v-' + m.id);
  if (!s) { s = document.createElement('section'); s.className = 'view'; s.id = 'v-' + m.id; s.dataset.view = m.id; views.appendChild(s); }
  const def = registry.modules[m.id] || {}; const tabs = tabsOf(m);
  const sample = !(m.real || def.real) ? `<span class="chip warn" title="${SH.t('Not connected to the real engine yet: what you see is sample data and does not reflect your PC')}">${SH.t('Sample data')}</span>` : '';
  s.innerHTML = `<div class="mod"><header class="mhead" data-asm><div class="ttl"><h1>${esc(def.name || m.name)}${sample}</h1><p>${esc(def.desc || m.desc || '')}</p></div><div class="acts"></div></header>
    ${tabs.length > 1 ? `<nav class="subnav" data-asm role="tablist"><span class="ind"></span>${tabs.map((t, i) => `<button role="tab" data-tab="${t.id}"${i === 0 ? ' class="on"' : ''}>${esc(t.name)}<span class="bd" hidden></span></button>`).join('')}</nav>` : ''}
    <div class="tabs">${tabs.map((t, i) => `<div class="tab${i === 0 ? ' on' : ''}" data-tab="${t.id}" role="tabpanel"></div>`).join('')}</div></div>`;
  modState[m.id] = { tab: tabs[0] && tabs[0].id, rendered: new Set(), ix: new Spring(0, 300, 28), iw: new Spring(0, 300, 28), placed: false };
  const ctx = ctxFor(m);
  if (def.actions) { try { def.actions($('.acts', s), ctx); } catch (e) { console.error(e); } }
  const nav = $('.subnav', s);
  if (nav) nav.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(m.id, b.dataset.tab); });
}
function ctxFor(m) {
  return {
    mod: m, go, el: () => $('#v-' + m.id),
    tabEl: id => $(`#v-${m.id} .tab[data-tab="${id}"]`),
    setTab: id => setTab(m.id, id),
    setBadge(tabId, n) { const b = $(`#v-${m.id} .subnav [data-tab="${tabId}"] .bd`); if (!b) return; b.hidden = !n; tabDirty = true; if (n) { b.textContent = n; anim(b, [{ transform: 'scale(.4)' }, { transform: 'scale(1)' }], { d: 380, e: EASE.spring }); } },
  };
}
function renderTab(mid, tabId) {
  const ms = modState[mid]; const el = $(`#v-${mid} .tab[data-tab="${tabId}"]`); if (!el || ms.rendered.has(tabId)) return el;
  ms.rendered.add(tabId);
  const def = registry.modules[mid];
  if (def && def.renderTab) { try { def.renderTab(tabId, el, ctxFor(modById(mid))); } catch (e) { console.error(e); el.innerHTML = `<div class="empty"><b>${SH.t('This tab failed to load')}</b>${esc(e.message)}</div>`; } }
  else el.innerHTML = skeletonFor(tabId.length);
  return el;
}
function placeTabInd(mid, snap) {
  const ms = modState[mid]; const s = $('#v-' + mid); const b = s && $(`.subnav [data-tab="${ms.tab}"]`, s); if (!b) return;
  ms.ix.t = b.offsetLeft; ms.iw.t = b.offsetWidth; if (snap || !ms.placed) { ms.ix.set(ms.ix.t); ms.iw.set(ms.iw.t); ms.placed = true; }
}
/* the tab indicator only measures when the tab/view/size changes and only writes while it moves */
let tabDirty = true;
SH.on('view', () => { tabDirty = true; }); SH.on('tab', () => { tabDirty = true; }); SH.on('look', () => { tabDirty = true; });
addEventListener('resize', () => { tabDirty = true; });
tickers.add(dt => {
  const ms = modState[state.view]; if (!ms) return;
  if (tabDirty) { placeTabInd(state.view); tabDirty = false; ms.moving = true; }
  if (!ms.moving) return;
  const ind = $(`#v-${state.view} .subnav .ind`); if (!ind) return;
  ms.ix.step(dt); ms.iw.step(dt);
  const stretch = Math.min(28, Math.abs(ms.ix.vel) * .035);
  ind.style.width = (ms.iw.v + stretch).toFixed(2) + 'px'; ind.style.transform = `translateX(${(ms.ix.v - (ms.ix.vel > 0 ? 0 : stretch)).toFixed(2)}px)`;
  if (ms.ix.idle && ms.iw.idle) ms.moving = false;
});
function setTab(mid, tabId, quiet) {
  const ms = modState[mid]; if (!ms || ms.tab === tabId) return;
  const s = $('#v-' + mid); const tabs = tabsOf(modById(mid)); const oldI = tabs.findIndex(t => t.id === ms.tab), newI = tabs.findIndex(t => t.id === tabId);
  if (newI < 0) return;
  const def = registry.modules[mid] || {};
  const from = $(`.tab[data-tab="${ms.tab}"]`, s); const fresh = !ms.rendered.has(tabId); const to = renderTab(mid, tabId);
  if (def.leaveTab) try { def.leaveTab(ms.tab, from); } catch (e) { console.error(e); }
  const prev = ms.tab; ms.tab = tabId;
  $$('.subnav [data-tab]', s).forEach(b => b.classList.toggle('on', b.dataset.tab === tabId));
  const dir = newI > oldI ? 1 : -1;
  to.getAnimations().forEach(a => a.cancel()); to.style.transform = to.style.filter = to.style.opacity = '';
  to.classList.add('on');
  if (!quiet) {
    const a = anim(from, [{ opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }, { opacity: 0, transform: `translate3d(${-dir * 22}px,0,0) scale(.985)` }], { d: 180, e: EASE.out });
    a && a.finished.then(() => { if (ms.tab !== prev) from.classList.remove('on'); }).catch(() => {});
    anim(to, [{ opacity: 0, transform: `translate3d(${dir * 34}px,0,0) scale(.985)` }, { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }], { d: 460, delay: 30, e: EASE.glide });
    if (fresh) assemble(to, 80, 32);
  } else { from.classList.remove('on'); }
  if (def.enterTab) try { def.enterTab(tabId, to, ctxFor(modById(mid))); } catch (e) { console.error(e); }
  SH.emit('tab', { mod: mid, tab: tabId });
  if (!quiet) pushHist();
}

/* ================= history: back and forward (mouse side buttons, Alt+arrows) ================= */
const hist = [{ view: 'home', tab: null }]; let hIdx = 0, fromHist = false;
function pushHist() {
  if (fromHist) return;
  const e = { view: state.view, tab: modState[state.view] ? modState[state.view].tab : null }, cur = hist[hIdx];
  if (cur && cur.view === e.view && cur.tab === e.tab) return;
  hist.splice(hIdx + 1); hist.push(e); if (hist.length > 80) hist.shift(); hIdx = hist.length - 1;
}
function travel(d) {
  if (state.palOpen) { closePal(); return; } if (state.setOpen) { closeSettings(); return; }
  const i = hIdx + d; if (i < 0 || i >= hist.length) { const dk = $('.dk.on', dock); dk && anim(dk, [{ transform: 'translateX(0)' }, { transform: `translateX(${d * -4}px)` }, { transform: 'translateX(0)' }], { d: 260, keep: true }); return; }
  hIdx = i; const e = hist[i]; fromHist = true;
  try { if (e.view === state.view) { if (e.tab) setTab(e.view, e.tab); } else go(e.view, { tab: e.tab }); } finally { fromHist = false; }
}
SH.back = () => travel(-1); SH.forward = () => travel(1);
const ownsMouse = e => e.target.closest && e.target.closest('#v-tester .tab[data-tab="mouse"]');
addEventListener('mousedown', e => { if ((e.button === 3 || e.button === 4) && !ownsMouse(e)) e.preventDefault(); });
addEventListener('mouseup', e => {
  if (e.button !== 3 && e.button !== 4) return; if (ownsMouse(e)) return; e.preventDefault();
  if (document.querySelector('.cs-o.on')) { SH.closeComponent && SH.closeComponent(); return; }
  travel(e.button === 3 ? -1 : 1);
});
addEventListener('keydown', e => { if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); travel(e.key === 'ArrowLeft' ? -1 : 1); } });

/* ================= camera navigation ================= */
let navToken = 0; SH.homeAnimating = false;
const viewEl = n => $('#v-' + n);
function go(name, opts = {}) {
  if (name === 'settings') { openSettings(opts.section); return; }
  if (name === 'admin') { askAdmin(); return; }
  const m = modById(name); if (!m) return;
  if (name === state.view) { if (opts.tab) setTab(name, opts.tab); return; }
  const token = ++navToken; const fromName = state.view, from = viewEl(fromName), to = viewEl(name);
  const fromDef = registry.modules[fromName]; if (fromDef) { try { fromDef.leave && fromDef.leave(); fromDef.leaveTab && fromDef.leaveTab(modState[fromName].tab); } catch (e) { console.error(e); } }
  state.view = name; SH.emit('view', { from: fromName, to: name });
  $$('.dk', dock).forEach(b => b.classList.toggle('on', b.dataset.go === name));
  if (modState[name]) {
    /* returning to a module opens its main tab (unless another one is requested or we come from history) */
    const want = opts.tab || (fromHist ? null : (tabsOf(m)[0] || {}).id);
    if (want && want !== modState[name].tab) setTab(name, want, true);
    renderTab(name, modState[name].tab);
  }
  /* the incoming view starts clean: no leftovers from a previous exit (blur, scale, opacity) */
  to.getAnimations().forEach(a => a.cancel()); to.style.transform = to.style.filter = to.style.opacity = '';
  to.classList.add('is-on');
  const cam = S().camera && S().intensity !== 'min';
  let outA;
  if (fromName === 'home') {
    SH.homeAnimating = true;
    if (cam) { warp.t = 1; setTimeout(() => { warp.t = 0; }, 260 * motion()); }
    outA = anim(from, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${cam ? 1.9 : 1.05})` }], { d: cam ? 480 : 240, e: EASE.io });
    anim(to, [{ opacity: 1 }, { opacity: 1 }], { d: 1 }); assemble(to, cam ? 200 : 60);
  } else if (name === 'home') {
    SH.homeAnimating = true;
    if (cam) { warp.t = -.8; setTimeout(() => { warp.t = 0; }, 240 * motion()); }
    outA = anim(from, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], { d: 260, e: EASE.out });
    anim(to, [{ opacity: 0, transform: `scale(${cam ? 1.9 : 1.04})` }, { opacity: 1, transform: 'scale(1)' }], { d: cam ? 560 : 300, delay: 40, e: EASE.glide });
    SH.emit('home:return');
  } else {
    if (cam) { warp.t = .45; setTimeout(() => { warp.t = 0; }, 180 * motion()); }
    outA = anim(from, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${cam ? 1.18 : 1.03})` }], { d: 320, e: EASE.io });
    anim(to, [{ opacity: 1 }, { opacity: 1 }], { d: 1 }); assemble(to, 120);
  }
  const def = registry.modules[name];
  if (def) { try { def.enter && def.enter(); def.enterTab && def.enterTab(modState[name].tab, $(`#v-${name} .tab[data-tab="${modState[name].tab}"]`), ctxFor(m)); } catch (e) { console.error(e); } }
  if (outA) outA.finished.then(() => { if (token === navToken && state.view !== fromName) from.classList.remove('is-on'); if (token === navToken) SH.homeAnimating = false; }).catch(() => {});
  $$('.view.is-on').forEach(v => { if (v !== to && v !== from) v.classList.remove('is-on'); });
  pushHist();
}
SH.go = go;
const COMP_TAB = { cpu: 'cpu', gpu: 'gpu', ram: 'memory', ssd: 'disks', wifi: 'network', battery: 'battery', display: 'overview', audio: 'overview', sys: 'health' };
SH.openComponent = id => go('monitor', { tab: COMP_TAB[id] || 'overview' });
$('#brand').addEventListener('click', () => go('home')); $('#brand').title = SH.t('Go Home');

/* ================= command palette ================= */
const BUILTIN = [
  { t: SH.t('Check for new drivers'), go: 'drivers', tab: 'updates', ic: 'drivers' },
  { t: SH.t('Back up your drivers'), go: 'drivers', tab: 'backup', ic: 'download' },
  { t: SH.t('Uninstall a program'), go: 'remover', tab: 'programs', ic: 'remover' },
  { t: SH.t('Restore something from quarantine'), go: 'remover', tab: 'quarantine', ic: 'restore' },
  { t: SH.t('Update all programs'), go: 'updater', tab: 'overview', ic: 'updater' },
  { t: SH.t('Check for Windows updates'), go: 'updater', tab: 'windows', ic: 'windows' },
  { t: SH.t('What is taking up drive C:'), go: 'storage', tab: 'map', ic: 'storage' },
  { t: SH.t('Find duplicate files'), go: 'storage', tab: 'duplicates', ic: 'copy' },
  { t: SH.t('Clean temporary files'), go: 'optimizer', tab: 'clean', ic: 'broom' },
  { t: SH.t('Speed up Windows startup'), go: 'optimizer', tab: 'startup', ic: 'bolt' },
  { t: SH.t('Repair Windows'), go: 'optimizer', tab: 'repair', ic: 'wrench' },
  { t: SH.t('Check the GPU temperature'), go: 'monitor', tab: 'gpu', ic: 'temp' },
  { t: SH.t('See which programs use the most memory'), go: 'monitor', tab: 'processes', ic: 'ram' },
  { t: SH.t('Battery health'), go: 'monitor', tab: 'battery', ic: 'battery' },
  { t: SH.t('Test the keyboard'), go: 'tester', tab: 'keyboard', ic: 'keyboard' },
  { t: SH.t('Look for dead pixels'), go: 'tester', tab: 'screen', ic: 'display' },
  { t: SH.t('Create an automatic routine'), go: 'autopilot', tab: 'routines', ic: 'autopilot' },
  { t: SH.t('Turn on administrator mode'), go: 'admin', ic: 'shield' },
  { t: SH.t('Change the theme and colors'), go: 'settings', section: 'look', ic: 'palette' },
  { t: SH.t('Change the interface size'), go: 'settings', section: 'look', ic: 'sliders' },
  { t: SH.t('Change the animation intensity'), go: 'settings', section: 'motion', ic: 'sparkle' },
  { t: SH.t('Change the Home view'), go: 'settings', section: 'home', ic: 'layers' },
  { t: SH.t('Check for StellarHub updates'), go: 'settings', section: 'updates', ic: 'download' },
];
/* g is the group id (compared below); its name is translated when shown */
const GROUP = { Modules: SH.t('Modules'), Sections: SH.t('Sections'), Actions: SH.t('Actions') };
function paletteItems() {
  const list = [];
  MODS.forEach(m => list.push({ t: m.name, go: m.id, ic: m.icon, g: 'Modules' }));
  MODS.forEach(m => tabsOf(m).forEach(t => list.push({ t: t.name, path: m.name, go: m.id, tab: t.id, ic: m.icon, g: 'Sections' })));
  [...BUILTIN, ...registry.actions].forEach(a => list.push({ ...a, g: 'Actions' }));
  return list;
}
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let palList = [], palIdx = 0; const hlY = new Spring(0, 420, 30);
function renderPal(q) {
  const n = norm(q.trim()); const all = paletteItems();
  palList = n ? all.filter(i => n.split(/\s+/).every(w => norm(i.t + ' ' + (i.path || '')).includes(w))) : all.filter(i => i.g !== 'Sections');
  palList = palList.slice(0, 40); palIdx = 0; const res = $('#palRes');
  if (!palList.length) { res.innerHTML = `<div class="empty">${SH.t('Nothing matches “{q}”. Try “drivers”, “disk” or “clean”.', { q: esc(q) })}</div>`; return; }
  let html = '<div class="hl" id="palHl"></div>', g = '';
  palList.forEach((it, i) => { if (it.g !== g) { g = it.g; html += `<div class="grp">${GROUP[g] || g}</div>`; }
    html += `<button class="it" data-i="${i}"><span class="ic">${ic(it.ic)}</span>${it.path ? `<span class="path">${esc(it.path)}</span>` : ''}${esc(it.t)}<small>${it.g === 'Actions' ? SH.t('Run') : SH.t('Open')}</small></button>`; });
  res.innerHTML = html;
  $$('.it', res).forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translate3d(0,6px,0)' }, { opacity: 1, transform: 'translate3d(0,0,0)' }], { d: 260, delay: Math.min(i, 8) * 22 }));
  setPalIdx(0, true);
}
function setPalIdx(i, snap) {
  if (!palList.length) return; palIdx = (i + palList.length) % palList.length;
  const items = $$('#palRes .it'); items.forEach((el, k) => el.classList.toggle('on', k === palIdx));
  const el = items[palIdx]; hlY.t = el.offsetTop; if (snap) hlY.set(hlY.t);
  el.scrollIntoView({ block: 'nearest' });
}
tickers.add(dt => { if (!state.palOpen) return; const h = $('#palHl'); if (!h) return; hlY.step(dt); h.style.transform = `translateY(${hlY.v.toFixed(2)}px)`; });
function openPal() {
  if (state.setOpen) closeSettings();
  state.palOpen = true; const o = $('#palO'); o.classList.add('on');
  anim($('.scrim', o), [{ opacity: 0 }, { opacity: 1 }], { d: 220 });
  anim($('#pal'), [{ opacity: 0, transform: 'translate3d(0,-14px,0) scale(.95)', filter: 'blur(8px)' }, { opacity: 1, transform: 'translate3d(0,0,0) scale(1)', filter: 'blur(0px)' }], { d: 380, e: EASE.spring });
  const inp = $('#palIn'); inp.value = ''; renderPal(''); setTimeout(() => inp.focus(), 10);
}
function closePal() {
  if (!state.palOpen) return; state.palOpen = false; const o = $('#palO');
  anim($('.scrim', o), [{ opacity: 1 }, { opacity: 0 }], { d: 160 });
  const a = anim($('#pal'), [{ opacity: 1, transform: 'translate3d(0,0,0) scale(1)', filter: 'blur(0px)' }, { opacity: 0, transform: 'translate3d(0,-8px,0) scale(.97)', filter: 'blur(4px)' }], { d: 160 });
  a.finished.then(() => { if (!state.palOpen) o.classList.remove('on'); }).catch(() => {});
}
$('#searchBtn').addEventListener('click', openPal);
$('#palIn').addEventListener('input', e => renderPal(e.target.value));
$('#palRes').addEventListener('click', e => { const b = e.target.closest('.it'); if (b) runItem(palList[+b.dataset.i]); });
$('#palRes').addEventListener('pointermove', e => { const b = e.target.closest('.it'); if (b && +b.dataset.i !== palIdx) setPalIdx(+b.dataset.i); });
function runItem(it) { if (!it) return; closePal(); setTimeout(() => { if (it.run) it.run(); else go(it.go, { tab: it.tab, section: it.section }); }, 90 * motion()); }
SH.openPalette = openPal;

/* ================= settings ================= */
const ACCENTS = [['#FF7A66', '#9ED6FF', SH.t('Coral and ice')], ['#9ED6FF', '#FF9E7A', SH.t('Ice and coral')], ['#F4C26B', '#8FD3E8', SH.t('Amber')], ['#7FE0B4', '#FFB08A', SH.t('Mint')], ['#FF8FB1', '#A6E3FF', SH.t('Pink')], ['#C9D4E8', '#FF7A66', SH.t('Silver')]];
const ZOOMS = [['1', '100 %'], ['1.1', '110 %'], ['1.15', '115 %'], ['1.25', '125 %'], ['1.4', '140 %']];
/* language picker: flags drawn as small SVGs (no emoji, which Windows shows as letters) */
const STAR = (cx, cy, r, rot = 0) => { let d = ''; for (let i = 0; i < 10; i++) { const a = rot - Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .4 : r; d += (i ? 'L' : 'M') + (cx + rr * Math.cos(a)).toFixed(2) + ' ' + (cy + rr * Math.sin(a)).toFixed(2); } return d + 'Z'; };
const FLAGS = {
  en: () => { let s = ''; for (let i = 0; i < 7; i++) s += `<rect y="${(i * 20 / 7).toFixed(2)}" width="30" height="${(20 / 7).toFixed(2)}" fill="${i % 2 ? '#fff' : '#B22234'}"/>`;
    s += '<rect width="13" height="11.43" fill="#3C3B6E"/>'; for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) s += `<circle cx="${1.6 + c * 2.45}" cy="${1.6 + r * 2.7}" r=".55" fill="#fff"/>`; return s; },
  es: () => '<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>',
  pt: () => '<rect width="30" height="20" fill="#009C3B"/><path d="M3 10 15 2.6 27 10 15 17.4Z" fill="#FFDF00"/><circle cx="15" cy="10" r="4.6" fill="#002776"/><path d="M10.6 8.9c3-.9 6.2-.6 8.9.8" stroke="#fff" stroke-width=".9" fill="none"/>',
  it: () => '<rect width="10" height="20" fill="#009246"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#CE2B37"/>',
  fr: () => '<rect width="10" height="20" fill="#0055A4"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#EF4135"/>',
  zh: () => `<rect width="30" height="20" fill="#EE1C25"/><path d="${STAR(5.5, 5.5, 3.2)}" fill="#FFDE00"/>${[[11, 2.2, .6], [13, 4.4, 1.2], [13, 7.4, .2], [11, 9.4, .9]].map(([x, y, r]) => `<path d="${STAR(x, y, 1.05, r)}" fill="#FFDE00"/>`).join('')}`,
};
const flag = code => code === 'auto' ? `<span class="flag auto">${ic('globe')}</span>` : `<span class="flag"><svg viewBox="0 0 30 20" aria-hidden="true">${FLAGS[code]()}</svg></span>`;
function langPicker() {
  const L = SH.i18n, cur = S().language || 'auto';
  const sys = L.LANGS.find(l => l[0] === L.systemLang()) || L.LANGS[0];
  const tiles = [['auto', SH.t('Automatic'), SH.t('Same as Windows: {lang}', { lang: sys[1] })], ...L.LANGS.map(([c, own, eng]) => [c, own, SH.t(eng)])];
  return `<div class="langs">${tiles.map(([c, a, b]) => `<button class="lang${c === cur ? ' on' : ''}" data-lang="${c}">${flag(c)}<span><b>${a}</b><small>${b}</small></span>${ic('check')}</button>`).join('')}</div>`;
}
const SECTIONS = [['look', SH.t('Appearance'), 'palette'], ['background', SH.t('Background'), 'sparkle'], ['motion', SH.t('Animation'), 'play'], ['home', SH.t('Home'), 'home'], ['widget', SH.t('Widget'), 'monitor'], ['general', SH.t('General'), 'sliders'], ['tools', SH.t('Tools'), 'wrench'], ['data', SH.t('Data'), 'folder'], ['backups', SH.t('Backups and restore'), 'restore'], ['keys', SH.t('Shortcuts'), 'keyboard'], ['admin', SH.t('Administrator'), 'shield'], ['updates', SH.t('Updates'), 'download'], ['about', SH.t('About'), 'info']];
const seg = (key, opts) => `<div class="seg" data-key="${key}"><span class="ind"></span>${opts.map(([v, l]) => `<button data-v="${v}"${String(S()[key]) === v ? ' class="on"' : ''}>${l}</button>`).join('')}</div>`;
const tog = (key, label, sub) => `<div class="set inline"><div class="lbl"><div>${label}${sub ? `<span>${sub}</span>` : ''}</div></div><button class="toggle${S()[key] ? ' on' : ''}" data-key="${key}" aria-label="${label}"><i></i></button></div>`;
/* slider: live value, saved on release */
const rng = (key, label, sub, min, max, step, fmt) => `<div class="set"><div class="lbl"><div>${label}${sub ? `<span>${sub}</span>` : ''}</div><b class="rv" data-rv="${key}">${fmt(S()[key])}</b></div>
  <input type="range" class="rng" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${S()[key]}" style="--p:${(S()[key] - min) / (max - min) * 100}%"></div>`;
const RNG_FMT = { starCount: v => v == 0 ? SH.t('none') : SH.fmtInt(v), starSpeed: v => SH.fmt1(v) + '×', starBright: v => Math.round(v * 100) + '%', nebula: v => Math.round(v * 100) + '%', animSpeed: v => SH.fmt1(v) + '×', panelAlpha: v => Math.round(v * 100) + '%' };
const TOOLS = [['devmgmt', SH.t('Device Manager'), 'drivers'], ['services', SH.t('Services'), 'sliders'], ['eventvwr', SH.t('Event Viewer'), 'list'], ['taskschd', SH.t('Task Scheduler'), 'calendar'],
  ['diskmgmt', SH.t('Disk Management'), 'ssd'], ['taskmgr', SH.t('Task Manager'), 'monitor'], ['resmon', SH.t('Resource Monitor'), 'monitor'], ['msinfo32', SH.t('System Information'), 'info'],
  ['msconfig', SH.t('System Configuration'), 'gear'], ['regedit', SH.t('Registry Editor'), 'code'], ['sysdm', SH.t('System Properties'), 'windows'], ['perf', SH.t('Visual effects'), 'sparkle'],
  ['powercfg', SH.t('Power Options'), 'power'], ['ncpa', SH.t('Network Connections'), 'wifi'], ['appwiz', SH.t('Programs and Features'), 'package'], ['control', SH.t('Control Panel'), 'grid'],
  ['cleanmgr', SH.t('Disk Cleanup'), 'broom'], ['dfrgui', SH.t('Optimize Drives'), 'storage'], ['rstrui', SH.t('System Restore'), 'restore'], ['cmd', SH.t('Command Prompt'), 'code'], ['powershell', 'PowerShell', 'code']];
const INT_HINT = { max: SH.t('Everything moves: stars, camera flights and full transitions.'), normal: SH.t('Shorter animations and slower stars.'), min: SH.t('Brief transitions. The stars stand still.') };
/* sections that live in their own file register here: SH.settingsSections[id] = { html(), mount(el) } */
SH.settingsSections = SH.settingsSections || {};
function sectionHTML(id) {
  if (SH.settingsSections[id]) return SH.settingsSections[id].html();
  const st = S(), t = SH.t;
  switch (id) {
    case 'look': return `<h3>${t('Appearance')}</h3><p>${t('How StellarHub looks.')}</p>
      <div class="set"><div class="lbl">${t('Theme')}</div>${seg('theme', [['deep', t('Deep space')], ['dusk', t('Dusk')], ['eclipse', t('Eclipse')]])}</div>
      <div class="set"><div class="lbl">${t('Colors')}</div><div class="sw-row" id="swatches">${ACCENTS.map(([a, b, n]) => `<button class="swatch${st.accent === a && st.accent2 === b ? ' on' : ''}" style="--s:${a};--s2:${b}" data-a="${a}" data-b="${b}" aria-label="${n}" title="${n}"></button>`).join('')}
        <button class="swatch custom${ACCENTS.some(([a, b]) => st.accent === a && st.accent2 === b) ? '' : ' on'}" id="swCustom" style="--s:${st.accent};--s2:${st.accent2}" aria-label="${t('Custom colors')}" title="${t('Custom colors')}"><span>${ic('plus')}</span></button></div>
        <div class="cpick-row" id="cpickRow"${ACCENTS.some(([a, b]) => st.accent === a && st.accent2 === b) ? ' hidden' : ''}><span>${t('Primary')}</span><input type="color" data-color="accent" value="${st.accent}" aria-label="${t('Primary color')}"><span>${t('Secondary')}</span><input type="color" data-color="accent2" value="${st.accent2}" aria-label="${t('Secondary color')}"></div></div>
      <div class="set"><div class="lbl"><div>${t('Interface size')}<span>${t('Automatic picks the one that best fits your screen ({pct}%).', { pct: Math.round(autoZoom * 100) })}</span></div><button class="btn sm sec" data-act="autozoom">${ic('sparkle')}${t('Automatic')}</button></div>${seg('zoom', ZOOMS)}</div>
      <div class="set"><div class="lbl">${t('Density')}</div>${seg('density', [['comfortable', t('Comfortable')], ['compact', t('Compact')]])}</div>
      <div class="set"><div class="lbl">${t('Corners')}</div>${seg('corners', [['soft', t('Very round')], ['mid', t('Round')], ['sharp', t('Square')]])}</div>
      ${rng('panelAlpha', t('Solid panels'), t('Raise it so the stars show less behind the panels.'), 1, 2, .05, RNG_FMT.panelAlpha)}`;
    case 'background': return `<h3>${t('Background')}</h3><p>${t('The space behind everything.')}</p>
      ${tog('stars', t('Stardust'), t('The animated background.'))}
      ${rng('starCount', t('Number of stars'), '', 0, 900, 10, RNG_FMT.starCount)}
      ${rng('starSpeed', t('Drift speed'), t('How fast they move.'), 0, 4, .1, RNG_FMT.starSpeed)}
      ${rng('starBright', t('Brightness'), '', .2, 2, .05, RNG_FMT.starBright)}
      ${tog('twinkle', t('Twinkle'), t('The stars twinkle softly.'))}
      ${tog('shooting', t('Shooting stars'), t('Every now and then one goes by.'))}
      ${rng('nebula', t('Nebula'), t('The colored glow in the corners.'), 0, 2, .05, RNG_FMT.nebula)}`;
    case 'motion': return `<h3>${t('Animation')}</h3><p>${t('How much the interface moves.')}</p>
      <div class="set"><div class="lbl">${t('Intensity')}</div>${seg('intensity', [['max', t('Maximum')], ['normal', t('Normal')], ['min', t('Minimum')]])}<div class="hint" id="intHint">${INT_HINT[st.intensity]}</div></div>
      ${rng('animSpeed', t('Speed'), t('Lower means slower, more cinematic animations.'), .5, 2, .1, RNG_FMT.animSpeed)}
      ${tog('camera', t('Camera flights'), t('The zoom that flies through the scene when you switch modules.'))}
      ${tog('parallax', t('Mouse depth'), t('The layers shift slightly as you move the mouse.'))}
      ${tog('countUp', t('Counting numbers'), t('Figures count up to their value when they appear.'))}`;
    case 'home': return `<h3>${t('Home')}</h3><p>${t('What you see when you open StellarHub.')}</p>
      <div class="set"><div class="lbl">${t('PC view')}</div><div class="vcards" id="vcards">${variantCards()}</div></div>
      <div class="set"><div class="lbl"><div>${t('When the app opens')}<span>${t('Where you start each time.')}</span></div></div>${seg('startView', [['home', t('Home')], ['monitor', t('Live Monitor')], ['last', t('Where I left off')]])}</div>
      ${tog('quickActions', t('Quick actions'), t('The buttons in the Home header.'))}`;
    case 'widget': {
      const W = [['cpu', t('CPU usage')], ['cpuTemp', t('CPU temperature')], ['gpu', t('GPU usage')], ['gpuTemp', t('GPU temperature')], ['gpuPower', t('GPU power draw')], ['ram', t('Memory')], ['vram', t('Video memory')], ['down', t('Download')], ['up', t('Upload')], ['ping', t('Latency')], ['disk', t('Disk activity')]];
      const on = st.widgetStats;
      return `<h3>${t('Widget')}</h3><p>${t('A small always-on-top window with the stats you choose. Drag it wherever you like. Changes apply instantly.')}</p>
      <div class="set inline"><div class="lbl"><div>${t('Widget')}<span>${t('Also from Home, the top bar and the tray.')}</span></div></div><button class="toggle${SH.widgetOn ? ' on' : ''}" data-act="widget" aria-label="${t('Widget')}"><i></i></button></div>
      <div class="set"><div class="lbl"><div>${t('Size')}<span>${t('Small is a thin bar with the numbers; large adds charts. You can also switch it from the widget itself.')}</span></div></div>${seg('widgetMode', [['mini', t('Small')], ['full', t('Large')]])}</div>
      <div class="set"><div class="lbl">${t('Large layout')}</div>${seg('widgetLayout', [['grid', t('Grid')], ['row', t('Row')], ['list', t('List')]])}</div>
      <div class="set"><div class="lbl">${t('What it shows')}</div>
        ${W.map(([k, n]) => `<div class="set inline" style="padding:8px 0;border:0"><div class="lbl">${n}</div><button class="toggle${on.includes(k) ? ' on' : ''}" data-wstat="${k}" aria-label="${n}"><i></i></button></div>`).join('')}</div>
      <p class="set-note">${t('It opens with StellarHub if you left it open last time, and stays closed if you closed it.')}</p>`;
    }
    case 'general': return `<h3>${t('General')}</h3><p>${t('How the app behaves.')}</p>
      <div class="set"><div class="lbl"><div>${t('Language')}<span>${t('The whole app, the widget and the tray menu.')}</span></div></div>${langPicker()}</div>
      ${state.portable ? `<div class="set-note">${t('This is the portable version: it does not add itself to Windows startup, so it leaves nothing behind on the PC.')}</div>` : tog('startWithWindows', t('Open when Windows starts'), t('Starts hidden in the tray, with no window.'))}
      ${tog('trayOnClose', t('Close to the tray'), t('The X hides the window; StellarHub keeps running in the tray. To quit: right-click the icon > Quit.'))}
      ${tog('sounds', t('Sounds'), t('A soft sound when long tasks finish.'))}
      ${tog('confirmDanger', t('Confirm anything that cannot be undone'), t('Everything else always has an undo button.'))}
      <div class="set"><div class="lbl"><div>${t('Live data refresh rate')}<span>${t('Faster is smoother; slower uses less power.')}</span></div></div>${seg('teleRate', [['500', t('Fast')], ['1000', t('Normal')], ['2000', t('Saver')]])}</div>`;
    case 'tools': return `<h3>${t('Windows tools')}</h3><p>${t('The system tools that are usually hidden away, one click away.')}</p>
      <div class="tools">${TOOLS.map(([k, n, i]) => `<button class="tool" data-tool="${k}"><span class="ti">${ic(i)}</span>${n}</button>`).join('')}</div>`;
    case 'data': return `<h3>${t('Data')}</h3><p>${t('Your settings and the data StellarHub keeps on this PC.')}</p>
      <div class="set inline"><div class="lbl"><div>${t('Export settings')}<span>${t('A .json file to take them to another PC.')}</span></div></div><button class="btn sec" data-act="export">${ic('upload')}${t('Export')}</button></div>
      <div class="set inline"><div class="lbl"><div>${t('Import settings')}<span>${t('From a file you exported before.')}</span></div></div><button class="btn sec" data-act="import">${ic('download')}${t('Import')}</button></div>
      <div class="set inline"><div class="lbl"><div>${t('Data folder')}<span>${t('Settings, logs and quarantine.')}</span></div></div><button class="btn sec" data-act="datadir">${ic('folder')}${t('Open')}</button></div>
      <div class="set inline"><div class="lbl"><div>${t('Reset settings')}<span>${t('Puts everything back the way it came. You can undo it.')}</span></div></div><button class="btn danger" data-act="reset">${t('Reset')}</button></div>`;
    case 'keys': return `<h3>${t('Shortcuts')}</h3><p>${t('To get around without the mouse.')}</p>
      <div class="keys">${[['Ctrl K', t('Search for a tool or action')], ['Ctrl ,', t('Open settings')], [t('Ctrl 1 to 9'), t('Go to a module')], ['Alt ← / Alt →', t('Back and forward')], [t('Mouse side buttons'), t('Back and forward')], ['Esc', t('Close or go back Home')], [t('Double-click the top bar'), t('Maximize or restore')]].map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('')}</div>`;
    case 'admin': return `<h3>${t('Administrator')}</h3><p>${t('Installing drivers, cleaning system files and repairing Windows need administrator rights. Without them, StellarHub runs in limited mode.')}</p>
      <div class="set inline"><div class="lbl"><div>${t('Status')}<span>${state.admin ? t('StellarHub is running as administrator.') : t('You are in normal mode right now.')}</span></div></div>${state.admin ? `<span class="chip ok">${t('Administrator')}</span>` : `<button class="btn pri" data-act="admin">${t('Turn on')}</button>`}</div>
      ${tog('alwaysAdmin', t('Always open as administrator'), state.portable ? t('The portable version asks Windows each time it opens, because it leaves no scheduled task on the PC.') : t('Windows asks once when you turn it on; after that StellarHub opens as administrator without asking (like other tools, it uses a scheduled task).'))}
      ${tog('adminHints', t('Suggest administrator mode'), t('A subtle hint when a feature needs it.'))}`;
    case 'updates': return `<h3>${t('Updates')}</h3><p>${t('StellarHub updates itself from its GitHub repository.')}</p>
      <div class="set inline"><div class="lbl"><div>${t('Installed version')}<span>StellarHub ${state.version}${state.portable ? ' · ' + t('portable') : ''}</span></div></div><button class="btn sec" data-act="checkupd">${ic('updater')}${t('Check now')}</button></div>
      <div class="upd-state" id="updState"></div>
      ${tog('autoUpdate', t('Check for updates automatically'), t('When the app opens and every few hours. Only new features (like 1.2.0 or 2.0.0) are announced with a window; small fixes (like 1.2.3) wait here. StellarHub always asks before updating.'))}`;
    case 'about': return `<div class="about-h"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.2" style="fill:var(--accent)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-24 12 12)" style="stroke:var(--accent2)" stroke-width="1.4"/><circle cx="20.2" cy="8.3" r="1.5" style="fill:var(--accent2)"/></svg>
        <div><h3>StellarHub</h3><p>${t('Version {v}. The control center for your PC.', { v: state.version + (state.portable ? ' ' + t('(portable)') : '') })}</p></div></div>
      <div class="set inline"><div class="lbl"><div>${t('Created by')}<span>${t('Esteban Arosemena and Claude')}</span></div></div></div>
      <div class="set inline"><div class="lbl"><div>${t('Source code')}<span>${t('Free software under the GNU GPLv3 license.')} github.com/estebanarosemena/StellarHub</span></div></div><button class="btn sec" data-act="github">${ic('external')}${t('Open in GitHub')}</button></div>
      <div class="set"><div class="lbl"><div>${t('Languages')}<span>${t('How much code there is in each.')}</span></div></div><div id="langs" class="langs"><div class="sk" style="height:10px"></div></div></div>
      <div class="set inline"><div class="lbl"><div>${t('Built with')}<span>${t('Python, pywebview and WebView2; three.js for the 3D model; Unbounded and Onest fonts.')}</span></div></div></div>
      <div class="set inline"><div class="lbl"><div>${t('This PC')}<span>${esc(SH.PC.model)}, ${esc(SH.PC.os)}</span></div></div></div>`;
  }
  return '';
}
function variantCards() {
  const vs = Object.values(registry.variants);
  if (!vs.length) return `<div class="muted">${SH.t('No views installed yet.')}</div>`;
  return vs.map(v => `<button class="vcard${S().homeVariant === v.id ? ' on' : ''}" data-variant="${v.id}"><b>${esc(v.name)}</b><span>${esc(v.desc || '')}</span></button>`).join('');
}
SH.on('variant:registered', () => { const c = $('#vcards'); if (c) c.innerHTML = variantCards(); });
let secOn = 'look'; const secInd = new Spring(0, 380, 30);
const sheet = $('#sheet');
sheet.innerHTML = `<nav><h2>${SH.t('Settings')}</h2><span class="ind" id="secInd"></span>${SECTIONS.map(([id, n, i]) => `<button data-sec="${id}"${id === secOn ? ' class="on"' : ''}>${ic(i)}${n}</button>`).join('')}<div class="ver">StellarHub ${state.version}</div></nav>
  <div class="body" id="setBody"></div><button class="iconbtn x" data-close aria-label="${SH.t('Close')}">${ic('x')}</button>`;
function showSection(id, first) {
  secOn = id; $$('nav [data-sec]', sheet).forEach(b => b.classList.toggle('on', b.dataset.sec === id));
  const b = $(`nav [data-sec="${id}"]`, sheet); secInd.t = b.offsetTop; if (first) secInd.set(secInd.t);
  const body = $('#setBody'); body.innerHTML = `<div class="sec">${sectionHTML(id)}</div>`;
  $$('.sec > *', body).forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translate3d(14px,0,0)' }, { opacity: 1, transform: 'translate3d(0,0,0)' }], { d: 380, delay: 30 + i * 35, e: EASE.spring }));
  requestAnimationFrame(() => $$('.seg', body).forEach(s => placeSeg(s, true)));
  if (id === 'about') renderLangs();
  if (id === 'updates' && SH.selfUpdate) SH.selfUpdate.paintSettings($('#updState', body));
  const ext = SH.settingsSections[id]; if (ext && ext.mount) ext.mount($('.sec', body));
}
tickers.add(dt => { if (!state.setOpen) return; secInd.step(dt); $('#secInd').style.transform = `translateY(${secInd.v.toFixed(2)}px)`; });
sheet.addEventListener('click', e => {
  const sec = e.target.closest('[data-sec]'); if (sec) { if (sec.dataset.sec !== secOn) showSection(sec.dataset.sec); return; }
  const sb = e.target.closest('.seg button'); if (sb) { const s = sb.parentElement; if (sb.classList.contains('on')) return; $$('button', s).forEach(x => x.classList.toggle('on', x === sb)); placeSeg(s); applySetting(s.dataset.key, sb.dataset.v); return; }
  const ws = e.target.closest('.toggle[data-wstat]'); if (ws) {
    ws.classList.toggle('on'); const list = $$('.toggle[data-wstat]', sheet).filter(x => x.classList.contains('on')).map(x => x.dataset.wstat);
    if (!list.length) { ws.classList.add('on'); toast(SH.t('The widget needs at least one stat.')); return; }
    SH.setSetting('widgetStats', list); return;
  }
  const t = e.target.closest('.toggle[data-key]'); if (t) { t.classList.toggle('on'); applySetting(t.dataset.key, t.classList.contains('on')); return; }
  const swc = e.target.closest('#swCustom'); if (swc) {
    $$('.swatch', sheet).forEach(x => x.classList.toggle('on', x === swc)); const row = $('#cpickRow');
    if (row.hidden) { row.hidden = false; anim(row, [{ opacity: 0, transform: 'translate3d(0,-6px,0)' }, { opacity: 1, transform: 'none' }], { d: 320, e: EASE.spring }); }
    return;
  }
  const sw = e.target.closest('.swatch'); if (sw) { $$('.swatch', sheet).forEach(x => x.classList.toggle('on', x === sw)); SH.setSetting('accent', sw.dataset.a); SH.setSetting('accent2', sw.dataset.b); applyLook(); return; }
  const vc = e.target.closest('[data-variant]'); if (vc) { $$('[data-variant]', sheet).forEach(x => x.classList.toggle('on', x === vc)); applySetting('homeVariant', vc.dataset.variant); return; }
  const lb = e.target.closest('[data-lang]'); if (lb) { setLanguage(lb.dataset.lang, lb); return; }
  const tool = e.target.closest('[data-tool]'); if (tool) { SH.call('run_tool', tool.dataset.tool).then(r => r === undefined ? toast(SH.t('This only works inside the app.')) : !r && toast(SH.t('Windows could not open that tool.'))); return; }
  const act = e.target.closest('[data-act]'); if (act) runAct(act.dataset.act);
});
async function runAct(a) {
  if (a === 'admin') askAdmin(true);
  else if (a === 'checkupd') { const b = $('[data-act="checkupd"]'); if (SH.selfUpdate) { if (b) b.disabled = true; try { await SH.selfUpdate.check(true); } finally { if (b) b.disabled = false; } } }
  else if (a === 'github') { if (await SH.call('open_url', 'https://github.com/estebanarosemena/StellarHub') === undefined) window.open('https://github.com/estebanarosemena/StellarHub'); }
  else if (a === 'autozoom') {
    const v = String(autoZoom); const s = $('.seg[data-key="zoom"]', sheet);
    if (s) { $$('button', s).forEach(x => x.classList.toggle('on', x.dataset.v === v)); placeSeg(s); }
    SH.setSetting('zoom', 'auto'); computeAutoZoom(); applyZoom(); toast(SH.t('Automatic size: {pct}%.', { pct: Math.round(autoZoom * 100) })); /* 'auto' keeps adapting to the window */
  }
  else if (a === 'widget' && SH.toggleWidget) SH.toggleWidget();
  else if (a === 'datadir') { if (await SH.call('open_data_dir') === undefined) toast(SH.t('This only works inside the app.')); }
  else if (a === 'export') { const p = await SH.call('export_settings'); if (p) toast(SH.t('Settings exported.')); }
  else if (a === 'import') {
    const d = await SH.call('import_settings'); if (d === false) toast(SH.t('That file has no valid settings.'));
    else if (d) { Object.assign(state.settings, d); applyAll(); showSection(secOn); toast(SH.t('Settings imported.')); }
  } else if (a === 'reset') {
    const old = { ...state.settings }; await SH.call('reset_settings'); try { localStorage.removeItem('sh.settings'); } catch {}
    Object.keys(state.settings).forEach(k => delete state.settings[k]); Object.assign(state.settings, SH.DEFAULTS); applyAll(); showSection(secOn);
    toast(SH.t('Settings reset.'), { action: { label: SH.t('Undo'), run: async () => { await SH.call('settings_set', old); Object.assign(state.settings, old); applyAll(); showSection(secOn); } }, ms: 7000 });
  }
}
sheet.addEventListener('input', e => {
  const r = e.target.closest('.rng'); if (r) { const k = r.dataset.key, v = +r.value; r.style.setProperty('--p', (v - r.min) / (r.max - r.min) * 100 + '%');
    const lab = $(`[data-rv="${k}"]`, sheet); if (lab) lab.textContent = RNG_FMT[k](v); state.settings[k] = v; applyLook(); return; }
  const c = e.target.closest('input[data-color]'); if (c) { state.settings[c.dataset.color] = c.value; applyLook(); }
});
sheet.addEventListener('change', e => {
  const r = e.target.closest('.rng'); if (r) { state.settings[r.dataset.key] = undefined; SH.setSetting(r.dataset.key, +r.value); return; }
  const c = e.target.closest('input[data-color]'); if (c) { state.settings[c.dataset.color] = undefined; SH.setSetting(c.dataset.color, c.value); $$('.swatch', sheet).forEach(x => x.classList.remove('on')); }
});
function placeSeg(s, snap) {
  const on = $('button.on', s), ind = $('.ind', s); if (!on) return;
  ind.style.width = on.offsetWidth + 'px'; const x = on.offsetLeft - 3;
  if (snap || !ind.dataset.x) { ind.getAnimations().forEach(a => a.cancel()); ind.style.transform = `translateX(${x}px)`; ind.dataset.x = x; return; }
  anim(ind, [{ transform: `translateX(${ind.dataset.x}px) scaleX(1)` }, { transform: `translateX(${(+ind.dataset.x + x) / 2}px) scaleX(1.12)`, offset: .45 }, { transform: `translateX(${x}px) scaleX(1)` }], { d: 380 });
  ind.dataset.x = x;
}
SH.placeSeg = placeSeg;
/* a new language: save it, then reload the interface in it with a soft fade (the widget and the tray follow) */
async function setLanguage(code, btn) {
  const L = SH.i18n; if ((S().language || 'auto') === code) return;
  $$('.lang', sheet).forEach(x => x.classList.toggle('on', x === btn));
  state.settings.language = code; L.remember(code);
  await SH.call('settings_set', { language: code });
  if (L.resolve(code) === L.lang) return;
  try { sessionStorage.setItem('sh.reopenSettings', 'general'); } catch {}
  anim(document.body, [{ opacity: 1 }, { opacity: 0 }], { d: 220 }).finished.then(() => location.reload(), () => location.reload());
}
function applySetting(key, val) {
  if (key === 'zoom' || key === 'theme' || key === 'density' || key === 'language' || key === 'intensity') { SH.setSetting(key, val); }
  else SH.setSetting(key, val);
  if (key === 'intensity') { applyLook(); const h = $('#intHint'); if (h) { h.textContent = INT_HINT[val]; anim(h, [{ opacity: 0, transform: 'translate3d(0,4px,0)' }, { opacity: 1, transform: 'none' }], { d: 260 }); } }
  if (['theme', 'density', 'corners', 'twinkle', 'shooting', 'quickActions', 'countUp'].includes(key)) applyLook();
  if (key === 'zoom') applyZoom();
  if (key === 'startWithWindows') SH.call('set_autostart', !!val).then(r => { if (r === false) toast(SH.t('Windows did not allow changing automatic startup.')); });
  if (key === 'teleRate' && SH.tele.setRate) SH.tele.setRate(+val);
  /* turning it on in normal mode asks Windows once, right now (the elevated copy then sets up the task, and
     from then on it opens as administrator without asking); turning it off removes the task */
  if (key === 'alwaysAdmin') {
    if (val && !state.admin) askAdmin(true);
    else SH.call('set_always_admin', !!val).then(r => { if (r === false) toast(SH.t('Could not set up starting as administrator.')); });
  }
}
/* Automatic size: the largest zoom at which the layouts still have the room they are designed for, measured on
   the window itself (not the screen), so it adapts when the window is resized or moved to another monitor. */
const DESIGN_W = 1440, DESIGN_H = 820;
let autoZoom = 1, curZoom = 1;
function computeAutoZoom() {
  const w = innerWidth * curZoom, h = innerHeight * curZoom; // the window's size at 100 %
  autoZoom = [1.25, 1.15, 1.1, 1, .92, .85].find(z => w / z >= DESIGN_W && h / z >= DESIGN_H) || .85;
}
let zoomTimer = 0;
addEventListener('resize', () => {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    if (!isAutoZoom()) return;
    const before = autoZoom; computeAutoZoom();
    if (autoZoom !== before || autoZoom !== curZoom) applyZoom();
  }, 350);
});
const isAutoZoom = () => S().zoom === 'auto' || !ZOOMS.some(z => z[0] === String(S().zoom));
function applyZoom() {
  const z = isAutoZoom() ? autoZoom : +S().zoom;
  if (z === curZoom && SH.booted) return;
  curZoom = z; SH.call('set_zoom', z);
}
function applyLook() {
  const st = S(); ROOT.dataset.theme = st.theme; ROOT.dataset.density = st.density; ROOT.dataset.int = st.intensity; ROOT.dataset.corners = st.corners;
  ROOT.dataset.quick = st.quickActions ? 'on' : 'off';
  ROOT.style.setProperty('--f', SH.FACT[st.intensity] / (st.animSpeed || 1)); ROOT.style.setProperty('--accent', st.accent); ROOT.style.setProperty('--accent2', st.accent2);
  ROOT.style.setProperty('--pa', st.panelAlpha); ROOT.style.setProperty('--neb', st.nebula);
  if (stars.length !== st.starCount) makeStars(st.starCount);
  SH.emit('look');
}
function applyAll() { applyLook(); applyZoom(); }
function openSettings(section) {
  if (state.palOpen) closePal();
  state.setOpen = true; const o = $('#setO'); o.classList.add('on');
  anim($('.scrim', o), [{ opacity: 0 }, { opacity: 1 }], { d: 240 });
  anim(sheet, [{ opacity: 0, transform: 'translate3d(48px,0,0) scale(.97)', filter: 'blur(8px)' }, { opacity: 1, transform: 'translate3d(0,0,0) scale(1)', filter: 'blur(0px)' }], { d: 460, e: EASE.spring });
  requestAnimationFrame(() => showSection(section || secOn, true));
}
function closeSettings() {
  if (!state.setOpen) return; state.setOpen = false; const o = $('#setO');
  anim($('.scrim', o), [{ opacity: 1 }, { opacity: 0 }], { d: 200 });
  const a = anim(sheet, [{ opacity: 1, transform: 'translate3d(0,0,0)' }, { opacity: 0, transform: 'translate3d(36px,0,0)' }], { d: 220, e: EASE.io });
  a.finished.then(() => { if (!state.setOpen) o.classList.remove('on'); }).catch(() => {});
}
$('#gearBtn').addEventListener('click', () => state.setOpen ? closeSettings() : openSettings());
$$('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target.closest('[data-close]')) o.id === 'palO' ? closePal() : closeSettings(); }));

/* ================= administrator mode ================= */
const note = $('#adminNote'); let noteShown = false, lastHint = 0;
function showNote(reason) {
  if (state.admin || noteShown) return; noteShown = true; lastHint = Date.now();
  $('#noteReason').textContent = SH.t(reason || 'to install drivers, clean system files and repair Windows. Without it, StellarHub runs in limited mode.');
  note.classList.add('on');
  anim(note, [{ opacity: 0, transform: 'translate3d(0,-8px,0) scale(.94)', filter: 'blur(6px)' }, { opacity: 1, transform: 'translate3d(0,0,0) scale(1)', filter: 'blur(0px)' }], { d: 420, e: EASE.spring });
}
function hideNote() {
  if (!noteShown) return; noteShown = false; note.classList.remove('on');
  anim(note, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'translate3d(0,-6px,0) scale(.96)' }], { d: 180 });
  if ($('#noteNever').classList.contains('on')) SH.setSetting('adminHints', false);
}
/* modules call this before anything that needs elevation: it suggests without nagging (at most once every 10 min) */
SH.requireAdmin = reason => { if (state.admin) return true; if (S().adminHints && Date.now() - lastHint > 600000) showNote(reason); else toast(SH.t('This needs administrator mode.'), { action: { label: SH.t('Turn on'), run: () => askAdmin(true) } }); return false; };
async function askAdmin(direct) {
  if (state.admin) return; if (!direct && !noteShown) { showNote(); return; }
  hideNote();
  /* the permission becomes permanent (it can be turned off in Settings > Administrator) */
  state.settings.alwaysAdmin = true; await SH.call('settings_set', { alwaysAdmin: true });
  const r = await SH.call('relaunch_admin');
  if (r === true) toast(SH.t('Opening StellarHub as administrator…'));
  else if (r === false) toast(SH.t('Windows did not grant permission. You are still in normal mode.'));
  else { setAdmin(true); toast(SH.t('Administrator mode (simulated outside the app).')); }
}
function setAdmin(on) {
  state.admin = on; const pill = $('#modePill'); pill.classList.toggle('admin', on); const txt = $('#modeTxt');
  anim(txt, [{ opacity: 1, transform: 'none', filter: 'blur(0px)' }, { opacity: 0, transform: 'translate3d(0,-8px,0)', filter: 'blur(4px)' }], { d: 160 }).finished.then(() => {
    txt.textContent = on ? SH.t('Administrator mode') : SH.t('Normal mode');
    anim(txt, [{ opacity: 0, transform: 'translate3d(0,8px,0)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { d: 300, e: EASE.spring });
  }).catch(() => {});
  anim(pill, [{ transform: 'scale(1)' }, { transform: 'scale(1.08)', offset: .35 }, { transform: 'scale(1)' }], { d: 460 });
}
$('#modePill').addEventListener('click', () => { if (state.admin) { openSettings('admin'); return; } noteShown ? hideNote() : showNote(); });
$('#adminYes').addEventListener('click', () => askAdmin(true));
$('#adminNo').addEventListener('click', hideNote);
$('#noteNever').addEventListener('click', e => e.currentTarget.classList.toggle('on'));

/* ================= toasts ================= */
/* bottom right, at most 3 at a time; a repeated toast refreshes instead of stacking.
   Opening/closing the same thing (e.g. the widget) replaces the previous toast of the same group. */
const MAX_TOASTS = 3;
function toast(text, o = {}) {
  const box = $('#toasts'); const group = o.group || text;
  const same = [...box.children].find(x => x.dataset.group === group && !x.dataset.dead);
  if (same) {
    same.querySelector('span').textContent = text; clearTimeout(same._timer); same._timer = setTimeout(same._kill, o.ms || 3600);
    anim(same, [{ transform: 'scale(1)' }, { transform: 'scale(1.04)', offset: .4 }, { transform: 'scale(1)' }], { d: 320, keep: true });
    return;
  }
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.dataset.group = group;
  t.innerHTML = `<span>${esc(text)}</span>${o.action ? `<button class="btn sm">${esc(o.action.label)}</button>` : ''}`;
  if (o.action) $('button', t).addEventListener('click', () => { o.action.run(); kill(); });
  box.appendChild(t);
  anim(t, [{ opacity: 0, transform: 'translate3d(24px,0,0) scale(.94)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { d: 440, e: EASE.spring });
  function kill() { if (t.dataset.dead) return; t.dataset.dead = '1'; clearTimeout(t._timer);
    anim(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(24px,0,0) scale(.96)' }], { d: 220 }).finished.then(() => t.remove()).catch(() => t.remove()); }
  t._kill = kill; t._timer = setTimeout(kill, o.ms || 3600);
  const live = [...box.children].filter(x => !x.dataset.dead); if (live.length > MAX_TOASTS) live.slice(0, live.length - MAX_TOASTS).forEach(x => x._kill && x._kill());
}
async function renderLangs() {
  const el = $('#langs'); if (!el) return;
  const COL = { Python: '#3572A5', JavaScript: '#F1E05A', CSS: '#663399', HTML: '#E34C26' };
  const d = await SH.call('project_stats') || { JavaScript: 520000, CSS: 140000, Python: 60000, HTML: 14000 };
  const tot = Object.values(d).reduce((a, b) => a + b, 0) || 1; const rows = Object.entries(d).sort((a, b) => b[1] - a[1]);
  el.innerHTML = `<div class="lbar">${rows.map(([k, v]) => `<span style="flex:${v};background:${COL[k] || 'var(--mute)'}"></span>`).join('')}</div>
    <div class="llist">${rows.map(([k, v]) => `<span><i style="background:${COL[k] || 'var(--mute)'}"></i>${k} <b>${SH.fmt1(v / tot * 100)} %</b></span>`).join('')}</div>`;
  $$('.lbar span', el).forEach((s, i) => anim(s, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { d: 700, delay: i * 90, e: EASE.out }));
}
SH.toast = toast;

/* ================= keyboard ================= */
const ORDER = DOCK.filter(x => x !== '|');
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); state.palOpen ? closePal() : openPal(); return; }
  if ((e.ctrlKey || e.metaKey) && k === ',') { e.preventDefault(); state.setOpen ? closeSettings() : openSettings(); return; }
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(k)) { e.preventDefault(); const id = ORDER[+k - 1]; if (id) go(id); return; }
  if (e.key === 'Escape') { if (state.palOpen) closePal(); else if (state.setOpen) closeSettings(); else if (noteShown) hideNote(); else if (state.view !== 'home') go('home'); return; }
  if (state.palOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPalIdx(palIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPalIdx(palIdx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); runItem(palList[palIdx]); }
  }
});

/* ================= startup ================= */
/* the loading screen (index.html): says what is happening while it waits, and leaves once the app is ready.
   The first start waits for Windows to describe the hardware (it is saved for the next starts). */
const bootEl = document.getElementById('boot');
const bootMsg = text => { const m = document.getElementById('bootMsg'); if (m && m.textContent !== text) m.textContent = text; };
const bootTimers = [setTimeout(() => bootMsg(SH.t('Starting…')), 1500),
  setTimeout(() => bootMsg(SH.t('Getting to know your PC. The first start takes a little longer.')), 6000),
  setTimeout(() => bootMsg(SH.t('Almost there…')), 25000)];
function bootDone() {
  bootTimers.forEach(clearTimeout);
  if (!bootEl || !bootEl.isConnected) return;
  bootEl.classList.add('out'); bootEl.removeAttribute('aria-busy');
  setTimeout(() => bootEl.remove(), 500);
}
setTimeout(bootDone, 120000);  /* never leave it up for good, whatever happens */
SH.boot = async () => {
  computeAutoZoom();
  await SH.loadSettings();
  const [info, pc] = await Promise.all([SH.call('info'), SH.call('pc_info')]);
  if (pc && pc.components) { Object.assign(SH.PC, pc); SH.PC.real = true; }
  if (info) { state.version = info.version; state.portable = !!info.portable; if (info.admin) { state.admin = true; $('#modePill').classList.add('admin'); $('#modeTxt').textContent = SH.t('Administrator mode'); } }
  applyLook(); applyZoom();
  MODS.filter(m => m.id !== 'home').forEach(buildModule);
  SH.on('module:registered', def => { if (def.id !== 'home' && modById(def.id)) buildModule(modById(def.id)); });
  anim($('.top'), [{ opacity: 0, transform: 'translate3d(0,-10px,0)' }, { opacity: 1, transform: 'none' }], { d: 600, delay: 300 });
  anim(dock, [{ opacity: 0, transform: 'translateX(-50%) translate3d(0,30px,0) scale(.9)' }, { opacity: 1, transform: 'translateX(-50%) translate3d(0,0,0) scale(1)' }], { d: 800, delay: 900, e: EASE.spring });
  if (!state.admin && S().adminHints) setTimeout(() => showNote(), 4200);
  SH.emit('boot');
  SH.booted = true; requestAnimationFrame(() => SH.call('ui_ready'));  /* startup time goes to the log */
  bootDone();
  /* after switching language the page reloads: come back to where the user was */
  try { const sec = sessionStorage.getItem('sh.reopenSettings'); if (sec) { sessionStorage.removeItem('sh.reopenSettings'); setTimeout(() => openSettings(sec), 350); } } catch {}
  /* test routes: #drivers/all opens that tab, #drivers/* walks through all of them, #home=bento forces a Home view */
  const h = decodeURIComponent(location.hash.slice(1));
  const hv = h.match(/^home=(\w+)$/); if (hv) setTimeout(() => SH.setSetting('homeVariant', hv[1]), 50);
  SH.on('view', d => SH.setSetting('lastView', d.to));
  const sv = S().startView === 'last' ? S().lastView : S().startView;
  if (!h && sv && sv !== 'home' && modById(sv)) setTimeout(() => go(sv), 700);
  const hm = h.match(/^(\w+)(?:\/([\w*]+))?$/);
  if (hm && modById(hm[1]) && hm[1] !== 'home') setTimeout(() => {
    if (hm[2] === '*') { go(hm[1]); tabsOf(modById(hm[1])).forEach((t, i) => setTimeout(() => setTab(hm[1], t.id), 300 * i)); }
    else go(hm[1], { tab: hm[2] });
  }, 100);
};
})();
