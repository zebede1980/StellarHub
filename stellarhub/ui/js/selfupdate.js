/* StellarHub · its own updates. When the app opens (and every 6 hours) it asks GitHub for the latest release; if
   there is a newer one, a dialog shows both versions and what is new. "Update now" downloads it, checks it, installs
   it silently and reopens StellarHub where you were (engine/selfupdate.py does the work). */
'use strict';
(() => {
const { $, $$, anim, EASE, ic, esc, state } = SH;
const t = SH.t;
const REL = 'https://github.com/estebanarosemena/StellarHub/releases';
let box = null, running = false, timer = 0, info = null;

/* ---------- release notes: the little Markdown GitHub releases use ---------- */
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1');
}
function notesHTML(md) {
  const out = []; let list = false, skip = false;
  const close = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trimEnd();
    const h = l.match(/^#{1,4}\s+(.*)$/);
    if (h) { close(); skip = /install/i.test(h[1]) && !/fix/i.test(h[1]); if (!skip) out.push(`<h4>${inline(h[1].replace(/^[^\p{L}\p{N}]+/u, ''))}</h4>`); continue; }
    if (skip) continue;
    const li = l.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (/^\s+\S/.test(l) && list) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ' ' + inline(l.trim()) + '</li>'); continue; }
    close();
    if (!l.trim() || l.startsWith('>')) continue;
    out.push(`<p>${inline(l)}</p>`);
  }
  close();
  return out.join('');
}

/* ---------- the dialog ---------- */
const orb = `<svg viewBox="0 0 24 24" fill="none" class="su-logo"><path d="M1.8 12.6A10.2 3 0 0 1 22.2 12.6" transform="rotate(-20 12 12.6)" style="stroke:var(--accent2)" stroke-opacity=".55" stroke-width="1.3"/><circle cx="12" cy="12.6" r="5.2" style="fill:var(--accent)"/><path d="M22.2 12.6A10.2 3 0 0 1 1.8 12.6" transform="rotate(-20 12 12.6)" style="stroke:var(--accent2)" stroke-width="1.3"/><circle class="su-moon" cx="19.6" cy="4.4" r="1.5" style="fill:var(--accent2)"/></svg>`;
const mb = n => n ? (n / 1048576 >= 10 ? Math.round(n / 1048576) : SH.fmt1(n / 1048576)) + ' MB' : '';
const day = d => { const v = Date.parse(d); return isNaN(v) ? '' : new Date(v).toLocaleDateString(SH.i18n.locale, { day: 'numeric', month: 'long', year: 'numeric' }); };

function open(inf) {
  info = inf; close(true);
  box = document.createElement('div'); box.className = 'su-ov';
  box.innerHTML = `<div class="su-box pan" role="dialog" aria-modal="true" aria-labelledby="suTitle">
    <div class="su-hd"><div class="su-orb">${orb}</div><div class="su-ht">
      <span class="su-kick">${t('New version available')}</span>
      <h3 id="suTitle">${t('StellarHub {v} is here', { v: esc(inf.latest) })}</h3>
      <div class="su-vers"><span class="su-v old" title="${esc(t('Your version'))}">${esc(inf.current)}</span>${ic('chev')}<span class="su-v new" title="${esc(t('New version'))}">${esc(inf.latest)}</span>${inf.date ? `<em>${esc(day(inf.date))}</em>` : ''}</div></div>
      <button class="su-x" data-su="later" aria-label="${esc(t('Later'))}">${ic('x')}</button></div>
    <div class="su-body"><div class="su-notes">${notesHTML(inf.notes) || `<p class="muted">${t('Bug fixes and improvements.')}</p>`}</div></div>
    <div class="su-foot">${footMain(inf)}</div></div>`;
  document.body.appendChild(box);
  anim(box, [{ opacity: 0 }, { opacity: 1 }], { d: 220 });
  anim($('.su-box', box), [{ opacity: 0, transform: 'translate3d(0,18px,0) scale(.96)' }, { opacity: 1, transform: 'none' }], { d: 520, e: EASE.spring });
  $$('.su-notes > *', box).slice(0, 10).forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translate3d(0,6px,0)' }, { opacity: 1, transform: 'none' }], { d: 380, delay: 120 + i * 30, e: EASE.spring }));
  box.addEventListener('click', onClick);
  addEventListener('keydown', onKey, true);
  const go = $('[data-su="go"]', box); if (go) setTimeout(() => go.focus(), 60);
}
function footMain(inf) {
  const src = inf.mode === 'source';
  return `<div class="su-meta">${ic('shield')}<span>${src ? t('This copy runs from the source code, so it updates with git or a new download.')
    : `${inf.size ? `${mb(inf.size)} · ` : ''}${t('Downloaded from GitHub and checked before installing.')}<br>${t('Your settings stay as they are. StellarHub closes and opens again by itself.')}`}</span></div>
    <div class="su-acts"><button class="btn ghost" data-su="skip">${t('Skip this version')}</button><button class="btn sec" data-su="later">${t('Later')}</button>
    ${src ? `<button class="btn pri" data-su="page">${ic('external')}${t('Open the download page')}</button>` : `<button class="btn pri" data-su="go">${ic('download')}${t('Update now')}</button>`}</div>`;
}
function close(now) {
  removeEventListener('keydown', onKey, true);
  const b = box; box = null; if (!b) return;
  if (now) { b.remove(); return; }
  anim(b, [{ opacity: 1 }, { opacity: 0 }], { d: 180 }).finished.then(() => b.remove()).catch(() => b.remove());
}
function onKey(e) { if (e.key === 'Escape' && box && !running) { e.stopPropagation(); close(); } }
async function onClick(e) {
  const b = e.target.closest('[data-su]');
  if (!b) { if (e.target === box && !running) close(); return; }
  const a = b.dataset.su;
  if (a === 'later') { if (!running) close(); return; }
  if (a === 'skip') { SH.setSetting('skipVersion', info.latest); close(); SH.toast(t('StellarHub will not offer {v} again. You can still update from Settings.', { v: info.latest })); return; }
  if (a === 'page') { openPage(); return; }
  if (a === 'go') { start(); return; }
  if (a === 'cancel') { await SH.engine('selfupdate', 'cancel').catch(() => {}); return; }
  if (a === 'close') { running = false; close(); }
}
function openPage() { const url = (info && info.url) || REL; SH.call('open_url', url).then(r => { if (r === undefined) window.open(url); }); }

/* ---------- progress ---------- */
const STEPS = [['download', 'download', t('Download')], ['verify', 'shield', t('Check')], ['install', 'layers', t('Install')], ['reopen', 'updater', t('Reopen')]];
function progressView() {
  $('.su-body', box).innerHTML = `<div class="su-prog">
    <div class="su-steps">${STEPS.map(([id, i, n]) => `<div class="su-step" data-st="${id}"><span>${ic(i)}</span><b>${n}</b></div>`).join('<i class="su-link"></i>')}</div>
    <div class="su-bar"><span id="suBar"></span></div><div class="su-now" id="suNow">${t('Getting ready…')}</div></div>`;
  $('.su-foot', box).innerHTML = `<div class="su-meta">${ic('info')}<span id="suHint">${t('When it is installed, StellarHub closes and opens again by itself.')}</span></div><div class="su-acts"><button class="btn ghost" data-su="cancel">${t('Cancel')}</button></div>`;
  anim($('.su-prog', box), [{ opacity: 0, transform: 'translate3d(0,10px,0)' }, { opacity: 1, transform: 'none' }], { d: 420, e: EASE.spring });
}
function stepTo(id) {
  const k = STEPS.findIndex(s => s[0] === id);
  $$('.su-step', box).forEach((el, i) => { el.classList.toggle('done', i < k); el.classList.toggle('on', i === k); });
  $$('.su-link', box).forEach((el, i) => el.classList.toggle('done', i < k));
}
function bar(p, indet) { const s = $('#suBar', box); if (!s) return; s.parentElement.classList.toggle('indet', !!indet); if (!indet) s.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})`; }
function failView(text) {
  running = false; if (!box) return;
  $('.su-body', box).innerHTML = `<div class="su-fail">${ic('alert')}<div><b>${t('The update could not be installed')}</b><span>${esc(text)}</span></div></div>`;
  $('.su-foot', box).innerHTML = `<div class="su-meta"></div><div class="su-acts"><button class="btn sec" data-su="page">${ic('external')}${t('Open the download page')}</button><button class="btn pri" data-su="close">${t('Close')}</button></div>`;
}
const WHY = { hash: () => t("The download did not match the fingerprint published with the release, so it was not installed. Try again later."),
  admin: () => t('Installing for all users needs administrator rights.'), source: () => t('This copy runs from the source code.') };

async function start() {
  if (running) return; running = true;
  progressView(); stepTo('download'); bar(0, true);
  let r;
  try { r = await SH.engine('selfupdate', 'start'); } catch (e) { failView(e.message); return; }
  if (!r || !r.ok) { failView((r && r.error) || t('The updater did not start.')); return; }
  if (r.mode === 'uac') $('#suHint', box).textContent = t('Windows may ask for permission once.');
  const at = r.at || Date.now() / 1000; let last = Date.now(), lastSt = '';
  const poll = async () => {
    if (!running || !box) return;
    let s = null; try { s = await SH.engine('selfupdate', 'state'); } catch {}
    const fresh = s && s.ts && s.ts >= at - 1;
    if (fresh && s.st !== lastSt) { lastSt = s.st; last = Date.now(); }
    if (fresh) {
      if (s.st === 'checking') { bar(0, true); $('#suNow', box).textContent = t('Getting ready…'); }
      else if (s.st === 'download') { stepTo('download'); bar(s.total ? s.got / s.total : 0, !s.total); last = Date.now();
        $('#suNow', box).textContent = s.total ? t('Downloading, {got} of {total}', { got: mb(s.got) || '0 MB', total: mb(s.total) }) : t('Downloading…'); }
      else if (s.st === 'verify') { stepTo('verify'); bar(1); $('#suNow', box).textContent = t('Checking the download…'); }
      else if (s.st === 'ready') { finish(s.ver); return; }
      else if (s.st === 'uptodate') { running = false; close(); SH.toast(t('You are on the latest version.')); return; }
      else if (s.st === 'cancelled') { running = false; close(); SH.toast(t('Update cancelled.')); return; }
      else if (s.st === 'failed') { failView((WHY[s.why] || (() => s.error || t('Something went wrong.')))()); return; }
    }
    if (Date.now() - last > 90000) { failView(t('The updater stopped answering. Try again later.')); return; }
    setTimeout(poll, 400);
  };
  setTimeout(poll, 400);
}
async function finish(ver) {
  stepTo('install'); bar(1, true);
  $('#suNow', box).textContent = t('Installing {v}. StellarHub will open again in a moment…', { v: ver });
  const c = $('[data-su="cancel"]', box); if (c) c.disabled = true;
  try { await SH.engine('selfupdate', 'finish', ver, state.view || 'home'); } catch (e) { failView(e.message); return; }
  setTimeout(() => SH.call('quit'), 900);
}

/* ---------- checking ---------- */
/* 'major' (X.0.0), 'minor' (x.Y.0) or 'patch' (x.y.Z): what changed between the installed version and the new one */
function kindOf(cur, next) {
  const a = String(cur || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0), b = String(next || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  return b[0] !== a[0] ? 'major' : b[1] !== a[1] ? 'minor' : 'patch';
}
let last = null;
async function check(manual) {
  let r;
  try { r = await SH.engine('selfupdate', 'check'); } catch (e) { if (manual) SH.toast(e.message); return null; }
  if (r === undefined) { if (manual) SH.toast(t('This only works inside the app.')); return null; }  /* sample mode */
  last = r; paintSettings();
  if (!r.ok) { if (manual) SH.toast(t("Couldn't reach GitHub. Check your connection and try again.")); return r; }
  if (!r.newer) { if (manual) SH.toast(t('You are on the latest version.')); return r; }
  /* on its own, StellarHub only interrupts for new features; a small fix waits in Settings > Updates */
  if (manual || (kindOf(r.current, r.latest) !== 'patch' && state.settings.skipVersion !== r.latest)) { if (!box) open(r); }
  return r;
}
async function afterUpdate() {
  let n; try { n = await SH.engine('selfupdate', 'after_update'); } catch { return; }
  if (!n) return;
  if (n.ok) {
    SH.toast(t('StellarHub was updated to {v}', { v: n.to }), { action: { label: t("What's new"), run: () => SH.call('open_url', `${REL}/tag/v${n.to}`) } });
    if (n.route && n.route !== 'home' && SH.MODS.some(m => m.id === n.route)) setTimeout(() => SH.go(n.route), 500);
  } else SH.toast(t("The update to {v} couldn't be installed. You are still on {now}.", { v: n.to, now: n.now }));
}
/* Settings > Updates: what is waiting (a small fix doesn't open the window, so this is where it shows up) */
let setEl = null;
function paintSettings(el) {
  if (el) setEl = el; const box2 = setEl; if (!box2 || !box2.isConnected) return;
  if (el && !last) { check(false); }
  const r = last;
  if (!r || !r.ok || !r.newer) { box2.innerHTML = r && r.ok ? `<div class="upd-ok">${ic('check')}<span>${t('You are on the latest version.')}</span></div>` : ''; return; }
  const k = kindOf(r.current, r.latest);
  box2.innerHTML = `<div class="upd-new ${k}">${ic(k === 'patch' ? 'info' : 'sparkle')}<div><b>${k === 'patch' ? t('Minor update {v} available', { v: esc(r.latest) }) : t('New version {v} available', { v: esc(r.latest) })}</b><span>${k === 'patch' ? t('Small fixes. StellarHub does not interrupt you for these.') : t('New features and fixes.')}</span></div><button class="btn pri sm" data-upd-open>${t('See and update')}</button></div>`;
  $('[data-upd-open]', box2).addEventListener('click', () => open(r));
}
SH.on('boot', () => {
  setTimeout(afterUpdate, 900);
  const auto = () => { if (state.settings.autoUpdate !== false) check(false); };
  setTimeout(auto, 3500);
  clearInterval(timer); timer = setInterval(auto, 6 * 3600 * 1000);
});
/* for screenshots in the browser (sample mode) */
const demo = () => open({ current: '0.4.0', latest: '0.5.0', date: new Date().toISOString(), size: 20355523, mode: 'task',
  notes: '### ✦ New\n\n- **Updates by themselves**: StellarHub checks GitHub when it opens.\n- A radar in Privacy & Security.\n\n### ⚙ Fixes\n\n- App Hangar no longer waits forever when an installer leaves a process running.\n- The keyboard test no longer reports chatter when you type fast.' });
SH.selfUpdate = { check, open, demo, paintSettings, kindOf, progressDemo: () => { demo(); running = true; progressView(); stepTo('download'); bar(.42); $('#suNow', box).textContent = t('Downloading, {got} of {total}', { got: '8.2 MB', total: '19 MB' }); } };
})();
