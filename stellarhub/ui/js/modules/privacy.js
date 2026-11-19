/* StellarHub · Privacy & Security: what can see you, what is open and how well Windows protects you.
   Real engine: stellarhub/engine/privacy.py. Outside the app it shows sample data shaped like what Python returns.
   Every area loads in parallel (jobs for the slow ones), the last result is cached by the engine so reopening is
   instant, and each change is backed up first and can be undone. */
'use strict';
(() => {
const { $, $$, anim, EASE, ic, esc, state } = SH;
const t = SH.t;
const wait = ms => new Promise(r => setTimeout(r, ms));
const LOC = (SH.i18n && SH.i18n.locale) || 'en-US';
const NOW = () => Date.now() / 1000;

SH.icons.add({
  pvpin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  pvpuzzle: '<path d="M9 4.5a2 2 0 0 1 4 0V6h4v4h1.5a2 2 0 0 1 0 4H17v5H6v-4h1.5a2 2 0 0 0 0-4H6V6h3z"/>',
  pvtask: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="m9 14.5 2 2 4-4"/>',
  pvhook: '<path d="M7 3v10a5 5 0 0 0 10 0v-2"/><path d="m14 13 3-3 3 3"/>',
  pvreg: '<path d="M4 5.5h7v5H4zM13 5.5h7v5h-7zM4 13.5h7v5H4z"/><path d="M15 15.5h3M16.5 14v3"/>',
  pvsvc: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  pvundo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  pvscan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
  pvport: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7.5 10.5h.01M11 10.5h.01M14.5 10.5h.01M7 17.5v2.5M17 17.5v2.5"/>',
  pvfile: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h4"/>',
  pvradar: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 18 6"/>',
});

/* ================= sample data (the shape Python returns) ================= */
const H = 3600, DAY = 86400;
const iso = s => new Date((NOW() - s) * 1000).toISOString();
const F = (id, area, sev, w, title, desc, extra = {}) => ({ id, area, sev, w, title, desc, tab: area, ...extra });
const TRACK0 = [
  ['adid', 'ads', 'Advertising ID', 'Apps get an ID that lets them show you ads based on what you do in them.', true, 2],
  ['tailored', 'ads', 'Tailored experiences', 'Microsoft uses your diagnostic data to show you tips, ads and recommendations.', true, 1.5],
  ['langlist', 'ads', 'Websites see your language list', 'Websites can read the languages you use to show local content. It also helps tell you apart from others.', true, .5],
  ['syncads', 'ads', 'Promotions in File Explorer', 'File Explorer shows notices from Microsoft, such as OneDrive and Microsoft 365 offers.', false, .5],
  ['lockfacts', 'ads', 'Fun facts and tips on the lock screen', 'The lock screen shows tips, facts and promotions picked by Microsoft.', true, .5],
  ['diag', 'diag', 'Optional diagnostic data', 'Besides the required data, Windows sends Microsoft which websites you visit and how you use apps.', true, 2, true],
  ['activity', 'diag', 'Activity history', 'Windows keeps a history of the apps, files and websites you open on this PC.', true, 1, true],
  ['launch', 'diag', 'App launch tracking', 'Windows records which apps you open to improve Start and search results.', true, 1],
  ['feedback', 'diag', 'Feedback requests', 'Windows asks you from time to time what you think of it.', false, .5],
  ['startrec', 'start', 'Recommendations in Start', 'Start shows tips, shortcuts and new apps that Microsoft recommends.', true, 1],
  ['settingsads', 'start', 'Suggested content in Settings', 'The Settings app shows suggestions and offers for Microsoft products.', true, 1],
  ['tips', 'start', 'Tips and suggestions', 'Notifications with tips, tricks and suggestions while you use Windows.', false, 1],
  ['welcome', 'start', 'Welcome screens after updates', 'After some updates Windows shows what is new and suggests finishing setting up your device.', true, .5],
  ['bing', 'start', 'Web results in Start search', 'What you type in Start search is also sent to Bing to show web results.', true, 1.5],
  ['searchhist', 'start', 'Search history on this device', 'Windows remembers what you searched for to improve suggestions.', true, .5],
  ['cloudsearch', 'start', 'Search your online accounts', 'Start search includes content from your Microsoft account, such as OneDrive and Outlook.', true, .5],
  ['speech', 'input', 'Online speech recognition', 'Your voice is sent to Microsoft to be recognized when you dictate or talk to apps.', false, 1],
  ['inking', 'input', 'Inking and typing personalization', 'Windows learns words you write and type, and your contacts, to build a personal dictionary.', true, 1],
  ['typing', 'input', 'Typing insights', 'Windows keeps statistics of your typing, such as words per minute and corrections.', true, .5],
  ['location', 'loc', 'Location for apps', 'Apps you allow can see where you are. Weather, Maps and Find my device need it.', true, 0],
];
const PAGES = { adid: 'privacy-general', tailored: 'privacy-feedback', diag: 'privacy-feedback', activity: 'privacy-activityhistory', bing: 'search-permissions', speech: 'privacy-speech', inking: 'privacy-speechtyping', location: 'privacy-location', startrec: 'personalization-start', tips: 'notifications' };
const GROUPS = { ads: t('Ads and promotions'), diag: t('Diagnostics and activity'), start: t('Start, search and Settings'), input: t('Speech, inking and typing'), loc: t('Location') };
function sampleData() {
  const n = NOW();
  const app = (key, name, pub, start, len, extra = {}) => ({ key, kind: key.startsWith('np|') ? 'np' : 'pkg', name, pub, start: start == null ? null : n - start, stop: start == null ? null : n - start + len, active: false, value: key.startsWith('pkg|') ? 'Allow' : null, icon: null, path: extra.path || '', gone: false, ...extra });
  const cap = (id, name, page, primary, apps, o = {}) => ({ id, name, page: 'ms-settings:' + page, primary, apps, user: 'Allow', device: 'Allow', desktop: 'Allow', ...o });
  const mic = [app('np|discord', 'Discord', 'Discord Inc.', 14 * 60, 0, { active: true, stop: null, path: 'C:\\Users\\you\\AppData\\Local\\Discord\\app-1.0.9205\\Discord.exe' }),
    app('pkg|MSTeams_8wekyb3d8bbwe', 'Microsoft Teams', 'Microsoft Corporation', 2 * H, 38 * 60),
    app('np|brave', 'Brave', 'Brave Software, Inc.', 26 * H, 12 * 60, { path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' }),
    app('np|obs', 'OBS Studio', 'OBS Project', 3 * DAY, 95 * 60, { path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' }),
    app('pkg|Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe', t('Sound Recorder'), 'Microsoft Corporation', 20 * DAY, 3 * 60),
    app('pkg|Microsoft.WindowsCamera_8wekyb3d8bbwe', t('Camera'), 'Microsoft Corporation', null, 0, { value: 'Deny' })];
  const cam = [app('pkg|MSTeams_8wekyb3d8bbwe', 'Microsoft Teams', 'Microsoft Corporation', 2 * H, 38 * 60),
    app('np|brave', 'Brave', 'Brave Software, Inc.', 26 * H, 11 * 60, { path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' }),
    app('pkg|Microsoft.WindowsCamera_8wekyb3d8bbwe', t('Camera'), 'Microsoft Corporation', 6 * DAY, 2 * 60),
    app('np|zoom', 'Zoom Workplace', 'Zoom Video Communications, Inc.', 12 * DAY, 52 * 60, { path: 'C:\\Users\\you\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe' }),
    app('np|obs', 'OBS Studio', 'OBS Project', 3 * DAY, 95 * 60, { path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' })];
  const loc = [app('pkg|Microsoft.BingWeather_8wekyb3d8bbwe', t('Weather'), 'Microsoft Corporation', 5 * H, 2),
    app('np|brave', 'Brave', 'Brave Software, Inc.', 2 * DAY, 1, { path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' }),
    app('pkg|Microsoft.WindowsMaps_8wekyb3d8bbwe', t('Maps'), 'Microsoft Corporation', 9 * DAY, 20),
    app('np|svchost', t('Find my device'), 'Microsoft Corporation', 1 * DAY, 4),
    app('pkg|Microsoft.WindowsAlarms_8wekyb3d8bbwe', t('Clock'), 'Microsoft Corporation', null, 0)];
  const perms = { caps: [cap('webcam', t('Camera'), 'privacy-webcam', true, cam), cap('microphone', t('Microphone'), 'privacy-microphone', true, mic), cap('location', t('Location'), 'privacy-location', true, loc),
    cap('graphicsCaptureProgrammatic', t('Screen capture'), 'privacy-graphicscaptureprogrammatic', false, [app('pkg|Microsoft.ScreenSketch_8wekyb3d8bbwe', t('Snipping Tool'), 'Microsoft Corporation', 1 * DAY, 40)]),
    cap('contacts', t('Contacts'), 'privacy-contacts', false, [app('pkg|microsoft.windowscommunicationsapps_8wekyb3d8bbwe', 'Outlook', 'Microsoft Corporation', 15 * DAY, 3)]),
    cap('picturesLibrary', t('Pictures'), 'privacy-pictures', false, [app('pkg|Microsoft.Windows.Photos_8wekyb3d8bbwe', t('Photos'), 'Microsoft Corporation', null, 0)]),
    cap('documentsLibrary', t('Documents'), 'privacy-documents', false, []), cap('appointments', t('Calendar'), 'privacy-calendar', false, [])], missing: [], now: n };
  perms.findings = [F('recent-webcam', 'permissions', 'info', 0, t('{n} apps used: {cap}, this week', { n: 3, cap: t('Camera') }), 'Microsoft Teams, Brave, ' + t('Camera') + '.', { uri: 'ms-settings:privacy-webcam' })];
  perms.passed = [];
  const tracking = { items: TRACK0.map(([id, g, name, desc, on, w, admin]) => ({ id, g, name: t(name), desc: t(desc), on, rec: id === 'location' ? null : 'off', w, admin: !!admin, locked: false, page: 'ms-settings:' + (PAGES[id] || 'privacy-general'), note: id === 'bing' ? t('Takes effect after you sign out or restart File Explorer.') : '' })),
    groups: GROUPS, admin: false, history: [{ id: 's1', t: n - 3 * DAY, label: t('{name}: turned off', { name: t('Advertising ID') }), kind: 'reg', area: 'tracking', undone: false }] };
  tracking.items.find(i => i.id === 'adid').on = false;
  const protection = { admin: false, av: [{ name: 'Microsoft Defender Antivirus', on: true, uptodate: true, defender: true }],
    defender: { active: true, mode: 'Normal', rt: true, sig: iso(5 * H), sigDays: 0, quick: iso(3 * DAY), quickDays: 3, full: iso(41 * DAY), tamper: true, version: '4.18.25100.9' },
    firewall: { profiles: [{ name: 'Domain', on: true }, { name: 'Private', on: true }, { name: 'Public', on: true }], third: [] },
    uac: 'default', secureBoot: true, tpm: { present: true, ok: true, version: '2.0' }, bitlocker: 'off', hvci: false, lsa: true,
    smartscreen: { apps: 'on', edge: 'on', store: 'on' }, sac: 'off', patch: { kb: 'KB5072033', date: iso(9 * DAY), days: 9, security: true } };
  protection.findings = [
    F('bitlocker', 'protection', 'warn', 6, t("Your system drive isn't encrypted"), t('If someone takes your PC or its drive, they can read your files. Turn on device encryption or BitLocker in Settings.'), { uri: 'ms-settings:deviceencryption' }),
    F('hvci', 'protection', 'warn', 4, t('Memory integrity is off'), t('It blocks malicious drivers from reaching the heart of Windows. Turn it on in Windows Security > Device security.'), { uri: 'windowsdefender://coreisolation' })];
  protection.passed = [t('Antivirus on and up to date: {names}', { names: 'Microsoft Defender Antivirus' }), t('Windows Firewall on for every network'), t('User Account Control at the recommended level'), t('Secure Boot on'), t('TPM security chip {v}', { v: '2.0' }), t('SmartScreen warns you about unknown apps'), t('Security updates installed {n} days ago', { n: 9 })];
  const L = (proto, port, scope, name, o = {}) => ({ proto, port, addr: scope === 'all' ? '0.0.0.0' : scope === 'local' ? '127.0.0.1' : '192.168.1.34', scope, pid: 1000 + port % 900, name, path: '', svc: [], known: null, system: false, ...o });
  const network = {
    listen: [L('TCP', 57621, 'all', 'Spotify.exe'), L('TCP', 27036, 'all', 'steam.exe'), L('TCP', 7680, 'all', 'svchost.exe', { svc: ['DoSvc'], system: true }),
      L('TCP', 135, 'all', 'svchost.exe', { svc: ['RpcEptMapper', 'RpcSs'], system: true, known: 'RPC' }), L('TCP', 445, 'all', 'System', { system: true, known: 'SMB' }),
      L('TCP', 5040, 'all', 'svchost.exe', { svc: ['CDPSvc'], system: true }), L('UDP', 5353, 'all', 'brave.exe'), L('UDP', 1900, 'all', 'svchost.exe', { svc: ['SSDPSRV'], system: true }),
      L('TCP', 49664, 'all', 'lsass.exe', { system: true }), L('TCP', 3000, 'local', 'node.exe'), L('TCP', 9100, 'local', 'NVIDIA Web Helper.exe'), L('TCP', 27060, 'local', 'steam.exe'), L('TCP', 6463, 'local', 'Discord.exe')],
    apps: [{ name: 'brave.exe', path: '', pids: [8120], n: 24, public: 24, remotes: [{ ip: '142.250.200.110', port: 443, public: true }, { ip: '104.18.32.47', port: 443, public: true }, { ip: '151.101.1.140', port: 443, public: true }] },
      { name: 'steam.exe', path: '', pids: [5520], n: 9, public: 9, remotes: [{ ip: '155.133.248.39', port: 27019, public: true }, { ip: '23.62.226.170', port: 443, public: true }] },
      { name: 'Discord.exe', path: '', pids: [9216], n: 6, public: 6, remotes: [{ ip: '162.159.135.234', port: 443, public: true }] },
      { name: 'svchost.exe', path: '', pids: [1964], n: 5, public: 4, remotes: [{ ip: '20.199.120.85', port: 443, public: true }, { ip: '192.168.1.1', port: 53, public: false }] },
      { name: 'Spotify.exe', path: '', pids: [7004], n: 4, public: 4, remotes: [{ ip: '35.186.224.25', port: 443, public: true }] },
      { name: 'OneDrive.exe', path: '', pids: [6612], n: 3, public: 3, remotes: [{ ip: '13.107.42.12', port: 443, public: true }] }],
    tmpUdp: 64, wifi: { connected: true, ssid: 'Home-5G', auth: 'WPA2-Personal', cipher: 'AES-CCMP', level: 'good', signal: 82, category: 'private' },
    hosts: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', readable: true, total: 3, blocks: 3, flagged: 0, entries: [
      { line: 23, ip: '0.0.0.0', host: 'ads.example-tracker.com', kind: 'block', level: 'info' }, { line: 24, ip: '0.0.0.0', host: 'telemetry.example-tracker.com', kind: 'block', level: 'info' }, { line: 25, ip: '127.0.0.1', host: 'license.example-app.com', kind: 'block', level: 'info' }] } };
  network.findings = [F('listen', 'network', 'info', 4, t('{n} apps accept connections from other devices', { n: 2 }), 'Spotify.exe, steam.exe. ' + t('Normal for games, sync and remote-access apps; check you know them.'))];
  network.passed = [t('Hosts file without suspicious redirects'), t('Wi-Fi protected with {auth}', { auth: 'WPA2-Personal' })];
  const P = (o) => ({ exe: '', cmd: '', pub: '', sig: 'valid', missing: false, risk: 'low', why: [], on: true, can: null, ...o });
  const persistence = { admin: false, hooksOk: true, items: [
    P({ id: 'task|\\Microsoft\\Windows\\Maintenance\\SysHealthCheck', kind: 'task', name: 'SysHealthCheck', exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cmd: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA…', where: '\\Microsoft\\Windows\\Maintenance\\SysHealthCheck', pub: 'Microsoft Windows', risk: 'high', why: [t("Hides among Windows' own tasks"), t('Runs a script or Windows tool, not a program of its own'), t('Hidden, encoded or downloaded command')], trigger: t('At sign-in'), can: 'task' }),
    P({ id: 'ext|Google Chrome|Default|coupon', kind: 'ext', name: 'Coupon Finder Plus', cmd: 'kpbjdgbnmlpkcfnceigmgnhaaoboklkf', where: 'Google Chrome', browser: 'Google Chrome', sig: null, risk: 'high', why: [t('Can read and change everything on every website'), t('Sensitive permissions: {list}', { list: 'cookies, webRequest' }), t('Not installed from the browser\'s store')], perms: ['<all_urls>', 'cookies', 'webRequest', 'tabs', 'storage'], store: false, version: '3.2.1' }),
    P({ id: 'task|\\Updater_5f2', kind: 'task', name: 'Updater_5f2', exe: 'C:\\Users\\you\\AppData\\Local\\Temp\\upd_5f2.exe', cmd: '"C:\\Users\\you\\AppData\\Local\\Temp\\upd_5f2.exe" /silent', where: '\\Updater_5f2', sig: 'unsigned', risk: 'high', why: [t('Runs from a temporary folder'), t('Not digitally signed'), t('Unknown publisher')], trigger: t('At sign-in'), can: 'task' }),
    P({ id: 'ext|Brave|Default|ublock', kind: 'ext', name: 'uBlock Origin', cmd: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', where: 'Brave', browser: 'Brave', sig: null, risk: 'medium', why: [t('Can read and change everything on every website'), t('Sensitive permissions: {list}', { list: 'webNavigation, webRequest' })], perms: ['<all_urls>', 'webNavigation', 'webRequest', 'storage', 'contextMenus'], store: true, version: '1.62.0' }),
    P({ id: 'ext|Microsoft Edge|Default|bitwarden', kind: 'ext', name: 'Bitwarden Password Manager', cmd: 'jbkfoedolllekgbhcbcoahefnbanhhlh', where: 'Microsoft Edge', browser: 'Microsoft Edge', sig: null, risk: 'medium', why: [t('Can read and change everything on every website'), t('Sensitive permissions: {list}', { list: 'webRequest' })], perms: ['<all_urls>', 'tabs', 'contextMenus', 'storage', 'webRequest', 'idle'], store: true, version: '2025.10.1' }),
    P({ id: 'service|OldVpnHelper', kind: 'service', name: 'OldVPN Helper Service', exe: 'C:\\Program Files\\OldVPN\\vpnhelper.exe', cmd: '"C:\\Program Files\\OldVPN\\vpnhelper.exe"', where: 'OldVpnHelper', sig: null, missing: true, risk: 'medium', why: [t('Points to a file that no longer exists')], trigger: t('At startup') }),
    P({ id: 'run|HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce|CleanupSetup', kind: 'run', name: 'CleanupSetup', exe: 'C:\\Windows\\System32\\cmd.exe', cmd: '"C:\\Windows\\System32\\cmd.exe" /c del "C:\\ProgramData\\Setup\\*.tmp"', where: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', pub: 'Microsoft Windows', risk: 'medium', why: [t('Runs a script or Windows tool, not a program of its own')], trigger: t('Once, at the next sign-in'), user: t('All users') }),
    P({ id: 'task|\\GoogleUpdaterTaskSystem', kind: 'task', name: 'GoogleUpdaterTaskSystem140.0.7339.0', exe: 'C:\\Program Files (x86)\\Google\\GoogleUpdater\\140.0.7339.0\\updater.exe', cmd: '"C:\\Program Files (x86)\\Google\\GoogleUpdater\\140.0.7339.0\\updater.exe" --wake --system', where: '\\GoogleUpdaterTaskSystem140.0.7339.0', pub: 'Google LLC', trigger: t('On a schedule or event'), can: 'task' }),
    P({ id: 'task|\\MicrosoftEdgeUpdateTaskMachineUA', kind: 'task', name: 'MicrosoftEdgeUpdateTaskMachineUA', exe: 'C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe', cmd: '"C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe" /ua /installsource scheduler', where: '\\MicrosoftEdgeUpdateTaskMachineUA', pub: 'Microsoft Corporation', trigger: t('On a schedule or event'), can: 'task' }),
    P({ id: 'task|\\OneDrive Reporting Task', kind: 'task', name: 'OneDrive Reporting Task', exe: 'C:\\Users\\you\\AppData\\Local\\Microsoft\\OneDrive\\OneDriveStandaloneUpdater.exe', cmd: '"C:\\Users\\you\\AppData\\Local\\Microsoft\\OneDrive\\OneDriveStandaloneUpdater.exe" /reporting', where: '\\OneDrive Reporting Task', pub: 'Microsoft Corporation', trigger: t('On a schedule or event'), can: 'task' }),
    P({ id: 'task|\\Adobe Acrobat Update Task', kind: 'task', name: 'Adobe Acrobat Update Task', exe: 'C:\\Program Files (x86)\\Common Files\\Adobe\\ARM\\1.0\\AdobeARM.exe', cmd: '"C:\\Program Files (x86)\\Common Files\\Adobe\\ARM\\1.0\\AdobeARM.exe"', where: '\\Adobe Acrobat Update Task', pub: 'Adobe Inc.', trigger: t('At sign-in'), can: 'task', on: false }),
    P({ id: 'service|brave', kind: 'service', name: 'Brave Update Service (brave)', exe: 'C:\\Program Files (x86)\\BraveSoftware\\Update\\BraveUpdate.exe', cmd: '"C:\\Program Files (x86)\\BraveSoftware\\Update\\BraveUpdate.exe" /svc', where: 'brave', pub: 'Brave Software, Inc.', trigger: t('At startup') }),
    P({ id: 'service|NVDisplay.ContainerLocalSystem', kind: 'service', name: 'NVIDIA Display Container LS', exe: 'C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispi.inf_amd64\\Display.NvContainer\\NVDisplay.Container.exe', cmd: '', where: 'NVDisplay.ContainerLocalSystem', pub: 'NVIDIA Corporation', trigger: t('At startup') }),
    P({ id: 'service|Steam Client Service', kind: 'service', name: 'Steam Client Service', exe: 'C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe', cmd: '"C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe" /RunAsService', where: 'Steam Client Service', pub: 'Valve Corp.', trigger: t('At startup') }),
    P({ id: 'ext|Google Chrome|Default|docs', kind: 'ext', name: 'Google Docs Offline', cmd: 'ghbmnnjooekpmoecnnnilnnbdlolhkhi', where: 'Google Chrome', browser: 'Google Chrome', sig: null, perms: ['alarms', 'storage', 'unlimitedStorage'], store: true, version: '1.92.1' }),
    P({ id: 'ext|Firefox|default-release|darkreader', kind: 'ext', name: 'Dark Reader', cmd: 'addon@darkreader.org', where: 'Firefox', browser: 'Firefox', sig: null, perms: ['storage', 'tabs', 'theme'], store: true, version: '4.9.96' }),
  ] };
  persistence.counts = ['task', 'service', 'run', 'hook', 'ext'].reduce((o, k) => (o[k] = persistence.items.filter(e => e.kind === k).length, o), {});
  persistence.findings = [F('persist-high', 'persistence', 'bad', 16, t('{n} things start by themselves and look suspicious', { n: 3 }), 'SysHealthCheck, Coupon Finder Plus, Updater_5f2. ' + t('Check what they are; you can disable them and undo it later.')),
    F('persist-med', 'persistence', 'info', 4, t('{n} auto-starts worth a look', { n: 4 }), t('{list} and {n} more', { list: 'uBlock Origin, Bitwarden Password Manager, OldVPN Helper Service', n: 1 }) + '. ' + t("Usually harmless, but they're unsigned, run scripts or have broad access."))];
  persistence.passed = [t('Sign-in and program launch hooks at Windows defaults')];
  recalcTracking(tracking);
  return { protection, permissions: perms, network, tracking, persistence };
}
const nameList = (l, k = 3) => l.length <= k ? l.join(', ') : t('{list} and {n} more', { list: l.slice(0, k).join(', '), n: l.length - k });
/* the same rule as tracking_findings in the engine (used after changes in sample mode) */
function recalcTracking(tr) {
  const sharing = tr.items.filter(i => i.on && i.rec === 'off' && !i.locked);
  if (!sharing.length) { tr.findings = []; tr.passed = [t('Windows shares only what it needs')]; return; }
  const w = Math.min(12, Math.round(sharing.reduce((a, i) => a + (i.w || 1), 0) * 10) / 10);
  const names = nameList(sharing.map(i => i.name));
  tr.findings = [F('tracking', 'tracking', w >= 4 ? 'warn' : 'info', w, sharing.length === 1 ? t('Windows shares more than it needs: 1 setting') : t('Windows shares more than it needs: {n} settings', { n: sharing.length }),
    t("{names}. Turning them off doesn't break anything and can be undone.", { names }), { fix: { kind: 'tracking', arg: sharing.map(i => i.id), label: t('Turn off {n}', { n: sharing.length }), admin: sharing.some(i => i.admin) } })];
  tr.passed = [];
}

/* ================= data: cached first, then fresh, all areas in parallel ================= */
const AREAS = ['protection', 'permissions', 'network', 'tracking', 'persistence'];
const AREA_N = { protection: t('Protection'), permissions: t('App permissions'), network: t('Network'), tracking: t('Tracking'), persistence: t('Auto-starts') };
const AREA_IC = { protection: 'shield', permissions: 'eye', network: 'globe', tracking: 'pvradar', persistence: 'bolt' };
const D = {}, TS = {}, ERR = {}, BUSY = {};
let REAL = false, started = false, SAMPLE = null;
const realP = SH.apiReady.then(a => (REAL = !!a));
const subs = new Set();
const notify = a => subs.forEach(fn => { try { fn(a); } catch (e) { console.error('privacy', a, e); } });
const on = fn => (subs.add(fn), fn);
function setData(area, data, stale) {
  if (!data) return;
  D[area] = data; TS[area] = stale ? (stale.t || NOW()) : NOW(); D[area]._stale = !!stale; delete ERR[area];
  notify(area);
}
async function eng(fn, ...a) {
  const r = await SH.engine('privacy', fn, ...a);
  if (r && r.needAdmin) { SH.requireAdmin(t('to change this Windows setting.')); const e = new Error(t('Needs administrator mode')); e.needAdmin = true; throw e; }
  return r;
}
const LOADERS = {
  protection: () => SH.job('privacy', 'protection'),
  persistence: () => SH.job('privacy', 'persistence'),
  tracking: () => SH.engine('privacy', 'tracking_read'),
  network: () => SH.engine('privacy', 'network'),
  async permissions() {
    const r = await SH.engine('privacy', 'permissions');
    if (r && r.missing && r.missing.length) {
      SH.job('privacy', 'perm_details', [r.missing]).then(map => { if (!map || !D.permissions) return; D.permissions.caps.forEach(c => c.apps.forEach(a => { const m = map[a.key]; if (m) { a.name = m.name || a.name; a.icon = m.icon || a.icon; a.pub = m.pub || a.pub; } })); notify('permissions'); }).catch(() => {});
    }
    return r;
  },
};
function load(area) {
  if (BUSY[area]) return BUSY[area];
  notify(area + ':busy');
  const p = (REAL ? LOADERS[area]() : wait({ protection: 1300, permissions: 520, network: 900, tracking: 380, persistence: 1900 }[area] + Math.random() * 300).then(() => (SAMPLE ||= sampleData())[area]))
    .then(r => { if (r) setData(area, r); })
    .catch(e => { console.error('privacy', area, e); ERR[area] = e.message || String(e); notify(area); })
    .finally(() => { delete BUSY[area]; notify(area + ':idle'); });
  BUSY[area] = p; return p;
}
async function start(force) {
  if (started && !force) return; started = true;
  if (await realP) {
    if (!force) { try { const c = await SH.engine('privacy', 'cached'); if (c) { AREAS.forEach(a => { if (c[a] && c[a].data && !D[a]) setData(a, c[a].data, c[a]); }); } } catch (e) { console.error(e); } }
  }
  AREAS.forEach(a => load(a));
}
const loading = a => !!BUSY[a];
const has = a => !!D[a];

/* ================= helpers ================= */
const RTF = (() => { try { return new Intl.RelativeTimeFormat(LOC, { numeric: 'auto' }); } catch { return null; } })();
function ago(ts) {
  if (!ts) return '—';
  const s = ts - NOW(), a = Math.abs(s);
  if (a < 45) return t('just now');
  const [u, k] = a < 3600 ? ['minute', 60] : a < DAY ? ['hour', 3600] : a < DAY * 30 ? ['day', DAY] : a < DAY * 365 ? ['month', DAY * 30] : ['year', DAY * 365];
  return RTF ? RTF.format(Math.round(s / k), u) : new Date(ts * 1000).toLocaleDateString(LOC);
}
const isoTs = s => { const v = s ? Date.parse(s) : NaN; return isNaN(v) ? null : v / 1000; };
function dur(sec) { if (sec == null || sec < 0) return '—'; if (sec < 60) return Math.max(1, Math.round(sec)) + ' s'; if (sec < 3600) return Math.round(sec / 60) + ' min'; return SH.fmt1(sec / 3600) + ' h'; }
const SEV = { bad: 0, warn: 1, info: 2 };
const sortF = l => [...l].sort((a, b) => (SEV[a.sev] ?? 3) - (SEV[b.sev] ?? 3) || (b.w || 0) - (a.w || 0));
const findings = () => sortF(AREAS.flatMap(a => (D[a] && D[a].findings) || []).filter(f => !String(f.id).startsWith('inuse-')));
const passed = () => AREAS.flatMap(a => (D[a] && D[a].passed) || []);
const lost = a => ((D[a] && D[a].findings) || []).reduce((s, f) => s + Math.max(0, +f.w || 0), 0);
const score = () => Math.max(5, Math.min(100, Math.round(100 - AREAS.reduce((s, a) => s + lost(a), 0))));
const fill = a => Math.max(.05, 1 - Math.min(1, lost(a) / 30));
const tone = a => lost(a) >= 15 ? 'bad' : lost(a) >= 4 ? 'warn' : 'ok';
const avatar = (name, icon, cls = 'pv-av') => icon ? `<span class="${cls}"><img src="${esc(icon)}" alt=""></span>` : `<span class="${cls} l">${esc((String(name || '?').replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase())}</span>`;
const skelRows = (n, cls = '') => `<div class="sk-rows pv-sk ${cls}">${Array.from({ length: n }, (_, i) => `<div class="sk-row"><div class="sk a" style="--dl:${i * .08}s"></div><div class="sk b" style="--w:${[46, 34, 52, 30, 41, 38, 49][i % 7]}%;--dl:${i * .08 + .04}s"></div><div class="sk c" style="--dl:${i * .08 + .08}s"></div></div>`).join('')}</div>`;
const openUri = u => { if (!u) return; (REAL ? SH.engine('privacy', 'open_uri', u) : Promise.resolve(undefined)).then(r => { if (r === undefined || r === false) SH.toast(t('This opens Windows Settings from inside the app.')); }).catch(e => SH.toast(e.message)); };
const logAct = (txt, o) => { if (REAL) SH.logActivity(txt, o); };
const openLoc = p => { if (!p) return; if (!REAL) { SH.toast(t('This opens File Explorer from inside the app.')); return; } SH.engine('privacy', 'open_location', p).then(ok => { if (!ok) SH.toast(t('That file is no longer there.')); }).catch(e => SH.toast(e.message)); };
/* fade the content in when the data changes from skeleton to real; a quiet refresh otherwise */
function paintInto(el, html, fresh) {
  el.innerHTML = html;
  if (fresh) anim(el, [{ opacity: 0, transform: 'translate3d(0,10px,0)', filter: 'blur(5px)' }, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { d: 420, e: EASE.spring });
}
const stamp = a => TS[a] ? (D[a] && D[a]._stale ? t('from {when}, updating…', { when: ago(TS[a]) }) : t('updated {when}', { when: ago(TS[a]) })) : t('checking…');
let modCtx = null;
const errBox = a => `<div class="empty"><b>${t("Couldn't read from Windows")}</b>${esc(ERR[a] || '')}<div style="margin-top:14px"><button class="btn sec" data-retry="${a}">${ic('restore')}${t('Try again')}</button></div></div>`;
document.addEventListener('click', e => { const b = e.target.closest('#v-privacy [data-retry]'); if (b) load(b.dataset.retry); });

/* ================= actions: fixes and undo ================= */
async function applyFix(f) {
  const fx = f.fix; if (!fx) return null;
  let arg = fx.arg;
  if (fx.kind === 'tracking' && !state.admin && D.tracking) {
    const adm = new Set(D.tracking.items.filter(i => i.admin).map(i => i.id)); arg = (arg || []).filter(id => !adm.has(id));
    if (!arg.length) { SH.requireAdmin(t('to change this Windows setting.')); return null; }
  } else if (fx.admin && !state.admin) { SH.requireAdmin(t('to change this Windows setting.')); return null; }
  if (!REAL) {
    await wait(450);
    if (fx.kind === 'tracking') { D.tracking.items.forEach(i => { if (arg.includes(i.id)) i.on = false; }); recalcTracking(D.tracking); setData('tracking', D.tracking); }
    else { const d = D[f.area]; d.findings = d.findings.filter(x => x.id !== f.id); d.passed = [...(d.passed || []), f.title]; setData(f.area, d); }
    return { ok: true, backup: 'sample', label: fx.kind === 'tracking' ? t('{n} privacy settings turned off', { n: arg.length }) : f.title, sample: { f, arg } };
  }
  const r = await eng('fix', fx.kind, arg || null);
  if (r && r.tracking) setData('tracking', r.tracking); else load(f.area);
  return r;
}
async function undo(r, area) {
  if (!r) return;
  if (!REAL) {
    const s = r.sample; if (s && s.f.fix.kind === 'tracking') { D.tracking.items.forEach(i => { if (s.arg.includes(i.id)) i.on = true; }); recalcTracking(D.tracking); setData('tracking', D.tracking); }
    else if (s) { const d = D[s.f.area]; d.findings.push(s.f); d.passed = (d.passed || []).filter(x => x !== s.f.title); setData(s.f.area, d); }
    SH.toast(t('Undone.')); return;
  }
  try { const u = await eng('undo', r.backup); if (u.tracking) setData('tracking', u.tracking); else if (area || u.area) load(area || u.area); SH.toast(t('Undone: {what}', { what: u.label || '' })); }
  catch (e) { SH.toast(e.message); }
}
const undoToast = (label, r, area) => SH.toast(label, { action: { label: t('Undo'), run: () => undo(r, area) } });

/* ================= Overview ================= */
/* The overview's centerpiece is a radar (Super Optimizer has a score ring; this one must not look like it):
   one sector per area, a slow sweep, and a blip per finding that pings when the sweep passes over it. The worse
   the finding, the closer to the center. The score is a segmented gauge under it. */
const RC = 120, RR = [38, 66, 94, 112];
const SECT = 360 / AREAS.length;
const polar = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [+(RC + r * Math.cos(a)).toFixed(2), +(RC + r * Math.sin(a)).toFixed(2)]; };
const wedge = (a0, a1, r) => { const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r); return `M${RC} ${RC}L${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}Z`; };
const sweepMs = () => { const f = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--f')) || 1; return 4200 * f + 1400; };
function radarSVG() {
  return `<svg viewBox="0 0 240 240" class="pv-radar" aria-hidden="true">
    <defs><linearGradient id="pvSw" gradientUnits="userSpaceOnUse" x1="${polar(0, 112)[0]}" y1="${polar(0, 112)[1]}" x2="${polar(48, 112)[0]}" y2="${polar(48, 112)[1]}">
      <stop offset="0" style="stop-color:var(--accent2)" stop-opacity="0"/><stop offset="1" style="stop-color:var(--accent2)" stop-opacity=".34"/></linearGradient>
      <radialGradient id="pvRg"><stop offset="0" style="stop-color:var(--accent2)" stop-opacity=".09"/><stop offset="1" style="stop-color:var(--accent2)" stop-opacity="0"/></radialGradient></defs>
    <circle cx="${RC}" cy="${RC}" r="${RR[3]}" fill="url(#pvRg)"/>
    ${AREAS.map((a, i) => `<path class="sec" data-sec="${a}" d="${wedge(i * SECT + 1.5, (i + 1) * SECT - 1.5, RR[3])}"/>`).join('')}
    ${RR.map((r, i) => `<circle cx="${RC}" cy="${RC}" r="${r}" class="rg${i === 3 ? ' out' : ''}"/>`).join('')}
    ${AREAS.map((a, i) => { const [x, y] = polar(i * SECT, RR[3]); return `<line x1="${RC}" y1="${RC}" x2="${x}" y2="${y}" class="sp"/>`; }).join('')}
    <circle cx="${RC}" cy="${RC}" r="117" class="tick"/>
    <g class="sweep"><path d="${wedge(0, 48, 112)}" fill="url(#pvSw)"/><line x1="${RC}" y1="${RC}" x2="${polar(48, 112)[0]}" y2="${polar(48, 112)[1]}" class="edge"/></g>
    <g class="blips"></g>
    <circle cx="${RC}" cy="${RC}" r="3" class="hub"/></svg>
    ${AREAS.map((a, i) => { const [x, y] = polar(i * SECT + SECT / 2, 129); return `<button class="pv-rl" data-sec="${a}" data-gotab="${a}" style="left:${(x / 240 * 100).toFixed(2)}%;top:${(y / 240 * 100).toFixed(2)}%" title="${esc(AREA_N[a])}" aria-label="${esc(AREA_N[a])}">${ic(AREA_IC[a])}</button>`; }).join('')}`;
}
/* where each finding sits: its area's sector, spread evenly; bad near the center, info near the edge */
function blipsFor() {
  const R = { bad: 30, warn: 58, info: 86 };
  return AREAS.flatMap((a, i) => {
    const fs = has(a) ? sortF(((D[a] && D[a].findings) || []).filter(f => !String(f.id).startsWith('inuse-'))) : [];
    return fs.slice(0, 6).map((f, j, l) => ({ a, f, deg: i * SECT + SECT * (j + 1) / (l.length + 1), r: (R[f.sev] || 86) + (j % 2 ? 7 : 0) }));
  });
}
function paintBlips() {
  const g = ovEl && $('.pv-radar .blips', ovEl); if (!g) return;
  const bl = blipsFor(), sig = bl.map(b => b.f.id + b.f.sev).join('|'); if (g.dataset.sig === sig) return; g.dataset.sig = sig;
  /* each ping is timed so it fires when the sweep's edge reaches the blip */
  const P = sweepMs(), sw = $('.pv-radar .sweep', ovEl), a0 = sw && sw.getAnimations()[0], cur = a0 ? (+a0.currentTime || 0) % P : 0;
  g.innerHTML = bl.map((b, k) => { const [x, y] = polar(b.deg, b.r), hit = ((b.deg - 48 + 720) % 360) / 360 * P, d = ((hit - cur) % P + P) % P;
    return `<g class="blip ${b.f.sev}" data-gotab="${b.f.tab || b.a}" style="--k:${k}"><title>${esc(b.f.title)}</title><circle cx="${x}" cy="${y}" r="10" class="halo" style="animation-delay:${Math.round(d)}ms;animation-duration:${Math.round(P)}ms;transform-origin:${x}px ${y}px"/><circle cx="${x}" cy="${y}" r="4.2" class="dot" style="transform-origin:${x}px ${y}px"/></g>`; }).join('');
}
function startSweep() {
  const sw = ovEl && $('.pv-radar .sweep', ovEl); if (!sw) return;
  sw.getAnimations().forEach(a => a.cancel());
  if (state.settings.intensity === 'min') return;
  sw.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: sweepMs(), iterations: Infinity });
  const g = $('.pv-radar .blips', ovEl); if (g) { delete g.dataset.sig; paintBlips(); }
}
/* the score as a gauge of 20 cells */
const GAUGE_N = 20;
const gaugeHTML = () => `<div class="pv-gauge" id="pvGauge">${Array.from({ length: GAUGE_N }, () => '<i></i>').join('')}</div>`;
const LIVE_CAPS = [['webcam', 'camera', t('Camera')], ['microphone', 'mic', t('Microphone')], ['location', 'pvpin', t('Location')]];
function liveHTML() {
  const caps = D.permissions ? D.permissions.caps : null;
  return LIVE_CAPS.map(([id, icn, n]) => {
    const c = caps && caps.find(x => x.id === id); const act = c ? c.apps.filter(a => a.active) : [];
    const sub = !caps ? '<span class="sk" style="display:block;height:8px;width:60%;margin-top:6px"></span>' : act.length ? esc(t('In use by {app}', { app: act.map(a => a.name).join(', ') })) : c && c.user === 'Deny' ? t('Blocked for all apps') : t('Not in use');
    return `<button class="pv-live${act.length ? ' on' : ''}" data-cap="${id}" title="${esc(n)}"><span class="pv-li">${ic(icn)}${act.length ? '<i class="pv-pulse"></i>' : ''}</span><span class="pv-lt"><b>${n}</b><span>${sub}</span></span></button>`;
  }).join('');
}
function findingRow(f) {
  const fx = f.fix, needAdm = fx && fx.admin && !state.admin && !(fx.kind === 'tracking');
  return `<div class="pv-f ${f.sev}" data-f="${esc(f.id)}"><span class="pv-fi">${ic(f.sev === 'bad' ? 'alert' : f.sev === 'warn' ? 'info' : AREA_IC[f.area] || 'info')}</span>
    <div class="pv-ft"><b>${esc(f.title)}</b><span>${esc(f.desc)}</span></div>
    <div class="pv-fa">${fx ? `<button class="btn sm pri" data-fix="${esc(f.id)}">${fx.kind === 'tracking' ? ic('pvradar') : ic('wrench')}${esc(fx.label || t('Fix'))}</button>${needAdm ? `<span class="chip warn pv-adm">${t('administrator')}</span>` : ''}` : f.uri ? `<button class="btn sm sec" data-uri="${esc(f.uri)}">${ic('external')}${t('Open')}</button>` : ''}<button class="btn sm ghost" data-gotab="${f.tab || f.area}">${t('Review')}</button></div></div>`;
}
let ovEl = null, ovMode = 'list', passOpen = false;
function ovState() {
  const pending = AREAS.filter(a => !has(a));
  const fs = findings(), sc = score(), fixes = fs.filter(f => f.fix);
  if (pending.length === AREAS.length) return { title: t('Checking your PC…'), sub: t('Read-only: nothing changes while we look.') };
  const title = pending.length ? t('Checking your PC…') : sc >= 90 ? t('Well protected') : sc >= 75 ? t('Good, with a few things to look at') : sc >= 55 ? t('Some things need your attention') : t('Your PC needs attention');
  const sub = !fs.length ? t('Everything we checked is fine. Nothing to do.') : fixes.length ? (fixes.length === 1 ? t('1 fix can be applied safely, and undone.') : t('{n} fixes can be applied safely, and undone.', { n: fixes.length })) : t('Nothing can be fixed automatically; open each one to see what to do.');
  return { title, sub, fixes };
}
function renderOverview(el, ctx) {
  ovEl = el; el.classList.add('fill');
  el.innerHTML = `<div class="pv-ov">
    <div class="pan pv-ovl" data-asm>
      <div class="pv-lives" id="pvLive">${liveHTML()}</div>
      <div class="pv-rw">${radarSVG()}</div>
      <div class="pv-sc"><b id="pvScore">0</b><span><em id="pvScoreL">${t('checking…')}</em>${gaugeHTML()}</span></div>
      <div class="pv-st" id="pvSt"></div><div class="pv-sub muted" id="pvSub"></div>
      <button class="btn pri lg pv-cta" id="pvFixAll" disabled>${ic('sparkle')}<span>${t('Fix what is safe')}</span></button>
    </div>
    <div class="pan pv-ovr" data-asm><div id="pvRight"></div></div></div>`;
  el.addEventListener('click', async e => {
    const tb = e.target.closest("[data-gotab]"); if (tb) { ctx.setTab(tb.dataset.gotab); return; }
    const cp = e.target.closest('[data-cap]'); if (cp) { selCap = cp.dataset.cap; ctx.setTab('permissions'); paintPerm(); return; }
    const u = e.target.closest('[data-uri]'); if (u) { openUri(u.dataset.uri); return; }
    if (e.target.closest('#pvPass')) { passOpen = !passOpen; const p = $('.pv-pass', el); if (p) { p.classList.toggle('open', passOpen); if (passOpen) setTimeout(() => { const r = $('#pvRight', el); r.scrollTo({ top: r.scrollHeight, behavior: state.settings.intensity === 'min' ? 'auto' : 'smooth' }); }, 200); } return; }
    const fb = e.target.closest('[data-fix]'); if (fb) {
      const f = findings().find(x => x.id === fb.dataset.fix); if (!f) return; fb.disabled = true;
      try { const r = await applyFix(f); if (r) { undoToast(r.label || t('Fixed'), r, f.area); logAct(r.label || f.title, { ic: 'privacy', go: 'privacy', tab: 'overview' }); } }
      catch (err) { if (!err.needAdmin) SH.toast(err.message); } finally { fb.disabled = false; }
      return;
    }
    if (e.target.closest('#pvFixAll')) { showPlan(); return; }
    if (e.target.closest('#pvPlanNo')) { ovMode = 'list'; paintOverview(true); return; }
    if (e.target.closest('#pvPlanGo')) { runPlan(); return; }
    const ck = e.target.closest('.pv-plan .check'); if (ck && !ck.disabled) ck.classList.toggle('on');
  });
  paintOverview(true); startSweep();
  on(a => { if (AREAS.includes(a) || a === 'live') { if (ovMode === 'list') paintOverview(false); else paintRadar(); const lv = $('#pvLive', el); if (lv) lv.innerHTML = liveHTML(); } });
  rendered.overview = () => paintOverview(false);
}
function paintRadar() {
  if (!ovEl) return;
  AREAS.forEach(a => { const tn = has(a) ? tone(a) : 'pend';
    [$(`.pv-radar .sec[data-sec="${a}"]`, ovEl), $(`.pv-rl[data-sec="${a}"]`, ovEl)].forEach(el => { if (el) el.dataset.t = tn; }); });
  const done = AREAS.filter(has).length, rd = $('.pv-radar', ovEl);
  rd.classList.toggle('scanning', AREAS.some(loading) || done < AREAS.length);
  paintBlips();
  const sc = $('#pvScore', ovEl); const target = done ? score() : 0;
  if (+sc.dataset.v !== target) SH.countUp(sc, target, 700);
  $('#pvScoreL', ovEl).textContent = done === AREAS.length ? t('Protection level, out of 100') : t('checking…');
  const lit = done === AREAS.length ? Math.round(target / (100 / GAUGE_N)) : 0, tn = target >= 75 ? 'ok' : target >= 55 ? 'warn' : 'bad';
  $$('#pvGauge i', ovEl).forEach((c, k) => { const on = k < lit; if (c.classList.contains('on') !== on || c.dataset.t !== tn) { c.style.transitionDelay = `${(on ? k : GAUGE_N - k) * 22}ms`; c.classList.toggle('on', on); c.dataset.t = tn; } });
}
function paintOverview(first) {
  if (!ovEl) return;
  paintRadar();
  const st = ovState(); $('#pvSt', ovEl).textContent = st.title; $('#pvSub', ovEl).textContent = st.sub;
  const btn = $('#pvFixAll', ovEl), nfix = (st.fixes || []).length; btn.disabled = !nfix; $('span', btn).textContent = nfix ? t('Fix what is safe ({n})', { n: nfix }) : t('Fix what is safe');
  const right = $('#pvRight', ovEl);
  const fs = findings(), ps = passed(), pending = AREAS.filter(a => !has(a));
  const upd = AREAS.filter(has).length ? Math.min(...AREAS.filter(has).map(a => TS[a])) : null;
  const live = AREAS.some(a => D[a] && D[a]._stale) || pending.length;
  const head = `<h4 class="pan-h">${t('What we found')} <em>${live ? t('checking…') : upd ? t('updated {when}', { when: ago(upd) }) : ''}</em></h4>`;
  const pend = pending.map(a => ERR[a] ? `<div class="pv-f info"><span class="pv-fi">${ic(AREA_IC[a])}</span><div class="pv-ft"><b>${AREA_N[a]}</b><span>${esc(t("Couldn't read from Windows"))}: ${esc(ERR[a])}</span></div><div class="pv-fa"><button class="btn sm ghost" data-retry="${a}">${t('Try again')}</button></div></div>`
    : `<div class="pv-f pend"><span class="pv-fi">${ic(AREA_IC[a])}</span><div class="pv-ft"><b>${esc(t('Checking: {area}', { area: AREA_N[a] }))}</b><span class="sk" style="display:block;height:9px;width:${36 + (a.length * 7) % 30}%;margin-top:8px"></span></div></div>`).join('');
  const ok = !fs.length && !pending.length ? `<div class="pv-allok">${ic('shield')}<div><b>${t('Everything is fine')}</b><span>${t('No problems found in protection, permissions, network, tracking or auto-starts.')}</span></div></div>` : '';
  const pass = ps.length ? `<div class="pv-pass${passOpen ? ' open' : ''}"><button class="pv-ph" id="pvPass">${ic('check')}<span>${ps.length === 1 ? t('1 check passed') : t('{n} checks passed', { n: ps.length })}</span>${ic('chevd')}</button><div class="pv-pl"><div>${ps.map(p => `<span class="pv-pi">${ic('check')}${esc(p)}</span>`).join('')}</div></div></div>` : '';
  const html = `${head}<div class="pv-fl">${ok}${fs.map(findingRow).join('')}${pend}</div>${pass}`;
  if (right.dataset.sig === html) return;
  right.dataset.sig = html; right.innerHTML = html;
  /* rows that just arrived slide in; the ones already there stay put */
  $$('.pv-f', right).forEach((r, i) => { const k = (r.dataset.f || '') + (r.classList.contains('pend') ? ':p' : ''); if (!first && !seenF.has(k) && !r.classList.contains('pend')) anim(r, [{ opacity: 0, transform: 'translate3d(12px,0,0)' }, { opacity: 1, transform: 'none' }], { d: 420, delay: i * 30, e: EASE.spring }); seenF.add(k); });
}
const seenF = new Set();
function showPlan() {
  const fs = findings().filter(f => f.fix); if (!fs.length) return; ovMode = 'plan';
  const right = $('#pvRight', ovEl);
  paintInto(right, `<h4 class="pan-h">${t("Here's what will change")} <em>${t('each change is backed up first')}</em></h4>
    <div class="pv-plan">${fs.map(f => { const adm = f.fix.admin && !state.admin && f.fix.kind !== 'tracking'; return `<div class="pv-ps${adm ? ' dis' : ''}" data-f="${esc(f.id)}"><button class="check${adm ? '' : ' on'}"${adm ? ' disabled' : ''} aria-label="${esc(f.title)}">${ic('check')}</button><div class="pv-ft"><b>${esc(f.title)}</b><span>${esc(f.desc)}</span></div>${adm ? `<span class="chip warn">${t('administrator')}</span>` : ''}</div>`; }).join('')}</div>
    <div class="pv-pa"><button class="btn pri lg" id="pvPlanGo">${ic('check')}${t('Apply')}</button><button class="btn ghost" id="pvPlanNo">${t('Cancel')}</button><span class="faint">${t('You can undo everything from the notification or from Tracking.')}</span></div>`, true);
  $$('.pv-ps', right).forEach((r, i) => anim(r, [{ opacity: 0, transform: 'translate3d(14px,0,0)' }, { opacity: 1, transform: 'none' }], { d: 380, delay: 40 + i * 45, e: EASE.spring }));
}
async function runPlan() {
  const right = $('#pvRight', ovEl);
  const ids = $$('.pv-ps', right).filter(r => $('.check', r).classList.contains('on')).map(r => r.dataset.f);
  const fs = findings().filter(f => ids.includes(f.id)); const done = [];
  $('#pvPlanGo', right).disabled = true;
  for (const f of fs) { const row = $(`.pv-ps[data-f="${CSS.escape(f.id)}"]`, right); row && row.classList.add('run');
    try { const r = await applyFix(f); if (r) { done.push([r, f.area]); row && row.classList.add('done'); } } catch (e) { row && row.classList.add('fail'); if (!e.needAdmin) SH.toast(e.message); }
    row && row.classList.remove('run'); }
  ovMode = 'list'; paintOverview(true);
  if (done.length) {
    SH.toast(done.length === 1 ? t('1 change applied.') : t('{n} changes applied.', { n: done.length }), { action: { label: t('Undo'), run: async () => { for (const [r, a] of done.reverse()) await undo(r, a); } } });
    logAct(t('Privacy fixes applied'), { sub: done.map(([r]) => r.label).join(', '), ic: 'privacy', go: 'privacy', tab: 'overview' });
  }
}

/* ================= App permissions ================= */
const CAP_IC = { webcam: 'camera', microphone: 'mic', location: 'pvpin', contacts: 'user', appointments: 'calendar', documentsLibrary: 'folder', picturesLibrary: 'folder', videosLibrary: 'folder', musicLibrary: 'folder', broadFileSystemAccess: 'folder', graphicsCaptureProgrammatic: 'display', graphicsCaptureWithoutBorder: 'display', userNotificationListener: 'bell', radios: 'wifi', bluetooth: 'wifi', bluetoothSync: 'wifi', userAccountInformation: 'user', email: 'file', chat: 'file', systemAIModels: 'sparkle', gazeInput: 'eye', phoneCall: 'mic', phoneCallHistory: 'clock', userDataTasks: 'list', appDiagnostics: 'gear' };
const VAL = { Allow: ['ok', t('Allowed')], Deny: ['', t('Denied')], Prompt: ['warn', t('Asks')] };
let selCap = 'webcam', permEl = null, showAllCaps = false;
function capSub(c) {
  const used = c.apps.filter(a => a.start).sort((a, b) => b.start - a.start);
  const n = c.apps.length;
  if (!n) return t('No app has asked');
  const apps = n === 1 ? t('1 app') : t('{n} apps', { n });
  return used.length ? t('{apps} · last used {when}', { apps, when: ago(used[0].start) }) : t('{apps} · never used', { apps });
}
function renderPermissions(el) {
  permEl = el; el.classList.add('fill');
  el.innerHTML = `<div class="pv-pm"><div class="pan pv-pml" data-asm><h4 class="pan-h">${t('What apps can use')}</h4><div class="pv-caps" id="pvCaps"></div></div>
    <div class="pan pv-pmr" data-asm id="pvCapD"></div></div>`;
  el.addEventListener('click', e => {
    const c = e.target.closest('.pv-cap'); if (c) { if (c.dataset.cap === selCap) return; selCap = c.dataset.cap; $$('.pv-cap', el).forEach(x => x.classList.toggle('on', x === c)); paintCapDetail(true); return; }
    if (e.target.closest('#pvMoreCaps')) { showAllCaps = !showAllCaps; paintPerm(); return; }
    const u = e.target.closest('[data-uri]'); if (u) { openUri(u.dataset.uri); return; }
    const l = e.target.closest('[data-loc]'); if (l) openLoc(l.dataset.loc);
  });
  paintPerm(true);
  on(a => { if (a === 'permissions' || a === 'live' || a === 'permissions:busy') paintPerm(); });
}
function paintPerm(first) {
  if (!permEl) return;
  const box = $('#pvCaps', permEl);
  if (!has('permissions')) { box.innerHTML = ERR.permissions ? errBox('permissions') : skelRows(6, 'tight'); paintCapDetail(); return; }
  const caps = D.permissions.caps, main = caps.filter(c => c.primary || c.apps.some(a => a.start)), rest = caps.filter(c => !main.includes(c) && c.apps.length);
  const capRow = c => { const act = c.apps.some(a => a.active); return `<button class="pv-cap${c.id === selCap ? ' on' : ''}${act ? ' live' : ''}" data-cap="${esc(c.id)}"><span class="pv-ci">${ic(CAP_IC[c.id] || 'sliders')}${act ? '<i class="pv-pulse"></i>' : ''}</span><span class="pv-ct"><b>${esc(c.name)}</b><span>${esc(act ? t('In use now') : capSub(c))}</span></span>${c.user === 'Deny' ? `<span class="chip">${t('Off')}</span>` : ''}</button>`; };
  const html = main.map(capRow).join('') + (rest.length ? `<button class="pv-more" id="pvMoreCaps">${showAllCaps ? t('Show less') : t('{n} more with apps', { n: rest.length })}${ic(showAllCaps ? 'chevd' : 'chev')}</button>${showAllCaps ? rest.map(capRow).join('') : ''}` : '');
  if (box.dataset.sig !== html) { const fresh = !box.dataset.sig; box.dataset.sig = html; paintInto(box, html, fresh && !first); }
  if (!caps.some(c => c.id === selCap)) selCap = caps[0] && caps[0].id;
  paintCapDetail();
}
function paintCapDetail(animate) {
  const el = permEl && $('#pvCapD', permEl); if (!el) return;
  if (!has('permissions')) { if (!el.dataset.sk) { el.dataset.sk = 1; el.innerHTML = `<div class="pv-ch"><span class="pv-big sk"></span><div style="flex:1"><div class="sk" style="height:16px;width:30%"></div><div class="sk" style="height:10px;width:50%;margin-top:10px"></div></div></div>${skelRows(5)}`; } return; }
  delete el.dataset.sk;
  const c = D.permissions.caps.find(x => x.id === selCap); if (!c) { el.innerHTML = ''; return; }
  const act = c.apps.filter(a => a.active);
  const st = (v, yes, no) => v === 'Deny' ? `<span class="pv-dot off"></span>${no}` : `<span class="pv-dot"></span>${yes}`;
  const head = `<div class="pv-ch"><span class="pv-big">${ic(CAP_IC[c.id] || 'sliders')}</span><div class="pv-cht"><b>${esc(c.name)}</b>
      <span>${c.device === 'Deny' ? `<span class="pv-dot off"></span>${t('Turned off for the whole device')}` : `${st(c.user, t('Apps can ask for it'), t('Off for apps'))}${c.desktop != null ? `<i class="pv-sep"></i>${st(c.desktop, t('Desktop apps can use it'), t('Off for desktop apps'))}` : ''}`}</span></div>
      <button class="btn sec" data-uri="${esc(c.page)}">${ic('external')}${t('Manage in Windows Settings')}</button></div>`;
  const banner = act.length ? `<div class="pv-now">${ic(CAP_IC[c.id] || 'eye')}<i class="pv-pulse"></i><div><b>${esc(t('In use now by {app}', { app: act.map(a => a.name).join(', ') }))}</b><span>${esc(act[0].start ? t('In use for {time}', { time: dur(NOW() - act[0].start) }) : '')}</span></div></div>` : '';
  const row = a => {
    const v = VAL[a.kind === 'np' ? (c.desktop || 'Allow') : a.value]; const len = a.active ? NOW() - (a.start || NOW()) : a.start && a.stop ? a.stop - a.start : null;
    const sub = a.kind === 'np' ? (a.gone ? t('Desktop app, no longer installed') : (a.pub ? esc(a.pub) + ' · ' : '') + t('Desktop app')) : (a.pub ? esc(a.pub) + ' · ' : '') + t('Store app');
    return `<div class="pv-ar${a.active ? ' live' : ''}${a.gone ? ' gone' : ''}">${avatar(a.name, a.icon)}<div class="pv-at"><b>${esc(a.name)}</b><span title="${esc(a.path || '')}">${sub}</span></div>
      <span class="pv-aw">${a.active ? `<span class="pv-inuse"><i class="pv-pulse"></i>${t('In use now')}</span>` : a.start ? esc(ago(a.start)) : `<span class="faint">${t('Never used')}</span>`}</span>
      <span class="pv-ad">${len != null && a.start ? esc(dur(len)) : '<span class="faint">—</span>'}</span>
      <span class="pv-av2">${v ? `<span class="chip ${v[0]}">${v[1]}</span>` : '<span class="faint">—</span>'}</span>
      <span class="pv-ax">${a.path && !a.gone ? `<button class="iconbtn" data-loc="${esc(a.path)}" title="${t('Open file location')}" aria-label="${t('Open file location')}">${ic('folder')}</button>` : ''}</span></div>`;
  };
  const list = c.apps.length ? `<div class="pv-acols"><span>${t('App')}</span><span>${t('Last used')}</span><span>${t('Duration')}</span><span>${t('Access')}</span><span></span></div><div class="pv-alist">${c.apps.map(row).join('')}</div>`
    : `<div class="pv-empty">${ic('check')}<div><b>${t('No app has used it')}</b><span>${t('When an app asks for it, it will show up here with the time it used it.')}</span></div></div>`;
  const html = head + banner + list;
  if (el.dataset.sig === html) return; el.dataset.sig = html;
  paintInto(el, html, animate);
  if (animate) $$('.pv-ar', el).slice(0, 12).forEach((r, i) => anim(r, [{ opacity: 0, transform: 'translate3d(0,8px,0)' }, { opacity: 1, transform: 'none' }], { d: 360, delay: 40 + i * 28, e: EASE.spring }));
  if (REAL) fillNpIcons(c);
}
const iconAsk = new Set();
function fillNpIcons(c) {
  const need = c.apps.filter(a => a.kind === 'np' && !a.icon && a.path && !a.gone && !iconAsk.has(a.path)).map(a => a.path); if (!need.length) return;
  need.forEach(p => iconAsk.add(p));
  SH.engine('privacy', 'icons', need).then(m => { if (!m) return; let any = false; D.permissions.caps.forEach(cc => cc.apps.forEach(a => { if (m[a.path]) { a.icon = m[a.path]; any = true; } })); if (any) paintCapDetail(); }).catch(() => {});
}
/* live "in use now": a light poll while the module is on screen */
let liveTimer = 0;
function liveTick() {
  clearTimeout(liveTimer);
  if (state.view !== 'privacy' || !REAL || !has('permissions')) { liveTimer = setTimeout(liveTick, 3000); return; }
  SH.engine('privacy', 'perm_live').then(r => {
    if (!r || !D.permissions) return;
    const act = new Map(r.active.map(x => [x.cap + '|' + x.key, x]));
    let changed = false;
    D.permissions.caps.forEach(c => c.apps.forEach(a => { const hit = act.get(c.id + '|' + a.key), was = a.active; a.active = !!hit; if (hit && hit.start) a.start = hit.start; if (was && !a.active) { a.stop = r.now; } if (was !== a.active) changed = true; }));
    if (changed) { notify('live'); badges(); }
  }).catch(() => {}).finally(() => { liveTimer = setTimeout(liveTick, 2500); });
}

/* ================= Protection ================= */
let protEl = null, scan = null;
const PROF = { Domain: t('Domain network'), Private: t('Private network'), Public: t('Public network') };
const UAC = [['never', t('Never notify')], ['nodim', t('Notify, no dimming')], ['default', t('Notify (recommended)')], ['always', t('Always notify')]];
function protCard(id, icn, title, chip, body, foot = '', cls = '') {
  return `<div class="pan pv-pc ${cls}" data-card="${id}"><div class="pv-pch"><span class="ri">${ic(icn)}</span><b>${title}</b>${chip}</div><div class="pv-pcb">${body}</div>${foot ? `<div class="pv-pcf">${foot}</div>` : ''}</div>`;
}
const chipOf = (tone, txt) => `<span class="chip ${tone}">${txt}</span>`;
const line = (label, val, tone = '') => `<div class="pv-ln"><span>${label}</span><b class="${tone}">${val}</b></div>`;
const openBtn = (uri, txt) => `<button class="btn ghost sm" data-uri="${esc(uri)}">${ic('external')}${txt || t('Open in Windows Security')}</button>`;
function renderProtection(el) {
  protEl = el;
  el.innerHTML = `<div class="pv-pr" id="pvProt"></div>`;
  el.addEventListener('click', e => {
    const u = e.target.closest('[data-uri]'); if (u) { openUri(u.dataset.uri); return; }
    if (e.target.closest('#pvScan')) { quickScan(); return; }
    if (e.target.closest('#pvScanX')) { scan && scan.p && scan.p.cancel && scan.p.cancel(); scan && (scan.stop = true); return; }
    const fb = e.target.closest('[data-fixk]'); if (fb) { const f = ((D.protection || {}).findings || []).find(x => x.fix && x.fix.kind === fb.dataset.fixk); if (f) { fb.disabled = true; applyFix(f).then(r => { if (r) undoToast(r.label, r, 'protection'); }).catch(err => { if (!err.needAdmin) SH.toast(err.message); }).finally(() => { fb.disabled = false; }); } }
  });
  paintProt(true);
  on(a => { if (a === 'protection') paintProt(); });
}
function paintProt(first) {
  const box = protEl && $('#pvProt', protEl); if (!box) return;
  if (!has('protection')) { box.innerHTML = ERR.protection ? errBox('protection') : `<div class="pv-pgrid">${Array.from({ length: 6 }, (_, i) => `<div class="pan pv-pc sk-card"><div class="pv-pch"><span class="ri sk"></span><div class="sk" style="height:12px;width:40%"></div></div>${skelRows(3, 'tight')}</div>`).join('')}</div>`; return; }
  const P = D.protection, d = P.defender || {}, fw = P.firewall || {}, ss = P.smartscreen || {};
  const fixBtn = (k, label, adm) => `<button class="btn sm pri" data-fixk="${k}">${ic('wrench')}${label}</button>${adm && !state.admin ? `<span class="chip warn">${t('administrator')}</span>` : ''}`;
  const act = (P.av || []).filter(a => a.on);
  /* antivirus */
  const avRows = (P.av || []).map(a => `<div class="pv-avr${a.on ? '' : ' off'}"><span class="pv-dot${a.on ? '' : ' off'}"></span><div><b>${esc(a.name === 'Windows Defender' ? 'Microsoft Defender' : a.name)}</b><span>${a.on ? (a.uptodate ? t('Active and up to date') : t('Active, definitions out of date')) : a.defender && act.length ? t('On standby: another antivirus is protecting you') : t('Off')}</span></div>${a.on ? chipOf(a.uptodate ? 'ok' : 'warn', a.uptodate ? t('Protecting') : t('Update')) : ''}</div>`).join('') || `<p class="muted">${t('Windows Security did not report any antivirus.')}</p>`;
  const sc = scan && scan.on;
  const defLines = d.active ? `<div class="pv-lns">${line(t('Real-time protection'), d.rt ? t('On') : t('Off'), d.rt ? 'ok' : 'bad')}${line(t('Virus definitions'), d.sig ? ago(isoTs(d.sig)) : '—', (d.sigDays || 0) > 7 ? 'warn' : '')}${line(t('Last quick scan'), d.quick ? ago(isoTs(d.quick)) : t('Never'))}${line(t('Tamper protection'), d.tamper ? t('On') : t('Off'), d.tamper ? 'ok' : 'warn')}</div>
    <div class="pv-scan${sc ? ' run' : ''}" id="pvScanBox">${sc ? `<div class="pv-scb"><b>${t('Quick scan running…')}</b><span class="faint" id="pvScanT">${esc(scan.txt || '')}</span><div class="pv-ind"><span></span></div></div><button class="btn ghost sm" id="pvScanX">${ic('stop')}${t('Cancel')}</button>` : `<button class="btn sec" id="pvScan">${ic('pvscan')}${t('Quick scan')}</button><span class="faint">${t('Checks the places malware usually hides. A few minutes; you can keep working.')}</span>`}</div>` : '';
  const avChip = act.length ? chipOf('ok', t('Protected')) : chipOf('bad', t('Not protected'));
  const cards = [];
  cards.push(protCard('av', 'shield', t('Virus and threat protection'), avChip, `<div class="pv-avs">${avRows}</div>${defLines}`, openBtn('windowsdefender://threat'), 'wide'));
  const fwOff = (fw.profiles || []).filter(p => !p.on);
  cards.push(protCard('fw', 'globe', t('Firewall'), fwOff.length && !(fw.third || []).length ? chipOf('bad', t('Partly off')) : chipOf('ok', t('On')),
    `${(fw.profiles || []).map(p => `<div class="pv-ln"><span>${PROF[p.name] || esc(p.name)}</span><b class="${p.on ? 'ok' : 'bad'}">${p.on ? t('On') : t('Off')}</b></div>`).join('')}${(fw.third || []).length ? `<p class="pv-note">${esc(t('{name} also filters connections.', { name: fw.third.join(', ') }))}</p>` : ''}`,
    (fwOff.length && !(fw.third || []).length ? fixBtn('firewall', t('Turn on'), true) : '') + openBtn('windowsdefender://network')));
  const ui = UAC.findIndex(u => u[0] === P.uac);
  cards.push(protCard('uac', 'user', t('User Account Control'), P.uac === 'default' || P.uac === 'always' ? chipOf('ok', t('Recommended')) : P.uac ? chipOf(P.uac === 'off' || P.uac === 'never' ? 'bad' : 'warn', P.uac === 'off' ? t('Off') : t('Low')) : '',
    `<p class="pv-d">${t('Asks you before a program makes changes that need administrator rights.')}</p><div class="pv-uac">${UAC.map((u, i) => `<span class="${i === ui ? 'on' : ''}${i <= ui ? ' f' : ''}"><i></i><em>${u[1]}</em></span>`).join('')}</div>${P.uac === 'off' ? `<p class="pv-note bad">${t('Turned off completely: every program runs with full rights.')}</p>` : ''}`,
    (P.uac && P.uac !== 'default' && P.uac !== 'always' ? fixBtn('uac', t('Set to recommended'), true) : '')));
  const yes = (v, a = t('On'), b = t('Off')) => v == null ? ['', '—'] : v ? ['ok', a] : ['warn', b];
  const sb = yes(P.secureBoot), hv = yes(P.hvci), ls = yes(P.lsa);
  const tp = P.tpm ? (P.tpm.present ? ['ok', P.tpm.version ? 'TPM ' + P.tpm.version : t('Present')] : ['warn', t('Not found')]) : ['', '—'];
  const devBad = [P.secureBoot, P.hvci].filter(v => v === false).length + (P.tpm && !P.tpm.present ? 1 : 0);
  cards.push(protCard('dev', 'cpu', t('Device security'), devBad ? chipOf('warn', devBad === 1 ? t('1 off') : t('{n} off', { n: devBad })) : chipOf('ok', t('All on')),
    `${line(t('Secure Boot'), sb[1], sb[0])}${line(t('Security chip (TPM)'), tp[1], tp[0])}${line(t('Memory integrity'), hv[1], hv[0])}${line(t('Local Security Authority protection'), ls[1], ls[0])}${P.secureBoot === false ? `<p class="pv-note">${t('Secure Boot is turned on in the BIOS/UEFI settings, not from Windows.')}</p>` : ''}`,
    openBtn('windowsdefender://devicesecurity')));
  const BL = { on: ['ok', t('Encrypted')], encrypting: ['ok', t('Encrypting…')], suspended: ['warn', t('Paused')], decrypting: ['warn', t('Decrypting…')], off: ['warn', t('Not encrypted')] };
  const bl = BL[P.bitlocker] || ['', t('Unknown')];
  cards.push(protCard('enc', 'lock', t('Drive encryption'), chipOf(bl[0], bl[1]),
    `<div class="pv-encb"><b class="${bl[0]}">${bl[1]}</b><span>${P.bitlocker === 'off' ? t('If your PC or its drive is lost or stolen, anyone can read your files.') : P.bitlocker ? t('Your files stay unreadable without your sign-in or recovery key.') : t("Windows didn't say whether the drive is encrypted.")}</span></div>`,
    openBtn('ms-settings:deviceencryption', t('Open encryption settings'))));
  const S = v => v === 'off' ? ['warn', t('Off')] : v === 'on' ? ['ok', t('On')] : ['', '—'];
  const sa = S(ss.apps), se = S(ss.edge), sst = S(ss.store);
  const SAC = { on: ['ok', t('On')], eval: ['', t('Evaluating')], off: ['', t('Off')] }; const sac = SAC[P.sac] || ['', '—'];
  cards.push(protCard('rep', 'eye', t('Reputation protection'), [ss.apps, ss.edge].includes('off') ? chipOf('warn', t('Partly off')) : chipOf('ok', t('On')),
    `${line(t('Check apps and files'), sa[1], sa[0])}${line(t('SmartScreen in Microsoft Edge'), se[1], se[0])}${line(t('SmartScreen for Store apps'), sst[1], sst[0])}${line(t('Smart App Control'), sac[1], sac[0])}`,
    (ss.apps === 'off' && !ss.appsManaged ? fixBtn('smartscreen', t('Turn on'), true) : ss.edge === 'off' && !ss.edgeManaged ? fixBtn('edgess', t('Turn on'), false) : '') + openBtn('windowsdefender://appbrowser')));
  const pa = P.patch; const pd = pa && pa.days;
  const pt = pd == null ? ['', '—'] : pd > 60 ? ['bad', t('Behind')] : pd > 35 ? ['warn', t('Due')] : ['ok', t('Up to date')];
  cards.push(protCard('wu', 'updater', t('Security updates'), chipOf(pt[0], pt[1]),
    `<div class="pv-encb"><b class="${pt[0]}">${pd == null ? '—' : pd <= 1 ? t('Recently') : esc(t('{n} days ago', { n: pd }))}</b><span>${pa ? esc(t('Last update installed: {kb}', { kb: pa.kb || '—' })) : t('No update history found.')}</span></div>`,
    openBtn('ms-settings:windowsupdate', t('Open Windows Update'))));
  const html = `<div class="pv-pgrid">${cards.join('')}</div>`;
  if (box.dataset.sig === html) return; const fresh = !box.dataset.sig; box.dataset.sig = html;
  paintInto(box, html, fresh && !first);
  if (fresh) $$('.pv-pc', box).forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translate3d(0,12px,0) scale(.98)' }, { opacity: 1, transform: 'none' }], { d: 460, delay: i * 40, e: EASE.spring }));
}
async function quickScan() {
  if (scan && scan.on) return;
  scan = { on: true, txt: t('Starting…'), t0: Date.now() }; paintProt();
  const tick = setInterval(() => { const el = protEl && $('#pvScanT', protEl); if (el) el.textContent = `${scan.txt} · ${dur((Date.now() - scan.t0) / 1000)}`; }, 1000);
  try {
    let r;
    if (REAL) { scan.p = SH.job('privacy', 'quick_scan', [], { onProgress: m => { if (m.text) scan.txt = m.text; }, onLog: l => { if (l.length) scan.txt = l[l.length - 1].slice(0, 80); } }); r = await scan.p; }
    else { for (let i = 0; i < 8 && !scan.stop; i++) { scan.txt = [t('Memory'), t('Startup items'), t('System folders'), t('Downloads')][i % 4]; await wait(700); } r = { threats: 0, seconds: 6 }; if (scan.stop) throw Object.assign(new Error('cancelled'), { cancelled: true }); }
    SH.toast(r && r.threats ? t('Quick scan finished: {n} threats found. Open Windows Security to deal with them.', { n: r.threats }) : t('Quick scan finished: no threats found.'));
    logAct(t('Quick scan with Microsoft Defender'), { sub: r && r.threats ? t('{n} threats', { n: r.threats }) : t('No threats'), ic: 'shield', go: 'privacy', tab: 'protection' });
    if (REAL) load('protection'); else D.protection.defender.quick = new Date().toISOString();
  } catch (e) { if (!e.cancelled) SH.toast(e.message); else SH.toast(t('Scan cancelled.')); }
  finally { clearInterval(tick); scan = null; paintProt(); }
}

/* ================= Network ================= */
let netEl = null, netFilter = 'open', netTimer = 0, openApp = null;
const SCOPE = { all: ['acc', t('All networks')], lan: ['warn', t('This network')], local: ['', t('This PC only')] };
function renderNetwork(el) {
  netEl = el; el.classList.add('fill');
  el.innerHTML = `<div class="pv-net"><div class="pan pv-nt" data-asm id="pvNetTop"></div>
    <div class="pv-ng"><div class="pan pv-np" data-asm><div class="pv-th"><h4>${t('Listening ports')}<em id="pvPortN"></em></h4><div class="seg" id="pvNetF"><span class="ind"></span><button data-v="open" class="on">${t('Open to others')}</button><button data-v="all">${t('All')}</button></div></div>
      <div class="pv-pcols"><span>${t('App')}</span><span>${t('Port')}</span><span>${t('Who can connect')}</span></div><div class="pv-plist" id="pvPorts"></div></div>
      <div class="pan pv-na" data-asm><div class="pv-th"><h4>${t('Connections by app')}<em id="pvAppN"></em></h4></div><div class="pv-alist2" id="pvApps"></div></div>
      <div class="pv-nside"><div class="pan pv-wifi" data-asm id="pvWifi"></div><div class="pan pv-hosts" data-asm id="pvHosts"></div></div></div></div>`;
  requestAnimationFrame(() => SH.placeSeg($('#pvNetF', el), true));
  el.addEventListener('click', e => {
    const sb = e.target.closest('#pvNetF button'); if (sb) { if (sb.dataset.v === netFilter) return; netFilter = sb.dataset.v; $$('#pvNetF button', el).forEach(b => b.classList.toggle('on', b === sb)); SH.placeSeg($('#pvNetF', el)); paintNet(true); return; }
    const ap = e.target.closest('.pv-napp'); if (ap) { openApp = openApp === ap.dataset.app ? null : ap.dataset.app; $$('.pv-napp', el).forEach(x => x.classList.toggle('open', x.dataset.app === openApp)); return; }
    if (e.target.closest('#pvNetRef')) { load('network'); return; }
    const l = e.target.closest('[data-loc]'); if (l) openLoc(l.dataset.loc);
  });
  paintNet();
  on(a => { if (a.startsWith('network')) { paintNet(); if (a === 'network') fillNetIcons(); } });
}
function paintNet(animate) {
  if (!netEl) return;
  const top = $('#pvNetTop', netEl), N = D.network;
  if (!N) {
    if (ERR.network) { top.innerHTML = errBox('network'); return; }
    if (!top.dataset.sk) { top.dataset.sk = 1; top.innerHTML = `<div class="pv-nstats">${Array.from({ length: 4 }, () => '<div><div class="sk" style="height:22px;width:48px"></div><div class="sk" style="height:9px;width:90px;margin-top:9px"></div></div>').join('')}</div>`;
      $('#pvPorts', netEl).innerHTML = skelRows(6, 'tight'); $('#pvApps', netEl).innerHTML = skelRows(5, 'tight'); $('#pvWifi', netEl).innerHTML = skelRows(2, 'tight'); $('#pvHosts', netEl).innerHTML = skelRows(2, 'tight'); }
    return;
  }
  delete top.dataset.sk;
  const exp = N.listen.filter(x => x.scope !== 'local'), own = exp.filter(x => !x.system), conns = N.apps.reduce((a, x) => a + x.n, 0);
  const topHtml = `<div class="pv-nstats"><div><b class="big ${own.length ? 'warn' : ''}">${own.length}</b><span>${t('Your apps open to others')}</span></div><div><b class="big">${exp.length - own.length}</b><span>${t('Windows services open to others')}</span></div>
    <div><b class="big">${N.listen.length - exp.length}</b><span>${t('Only reachable from this PC')}</span></div><div><b class="big">${conns}</b><span>${esc(t('Connections from {n} apps', { n: N.apps.length }))}</span></div></div>
    <div class="pv-nref"><span class="pv-livetag"><i></i>${t('Live')}</span><span class="faint">${esc(stamp('network'))}</span><button class="btn ghost sm" id="pvNetRef"${loading('network') ? ' disabled' : ''}>${ic('updater')}${t('Refresh')}</button></div>`;
  if (top.dataset.sig !== topHtml) { top.dataset.sig = topHtml; top.innerHTML = topHtml; }
  const rows = (netFilter === 'open' ? exp : N.listen);
  $('#pvPortN', netEl).textContent = String(rows.length);
  const portRow = x => { const s = SCOPE[x.scope]; return `<div class="pv-port${x.system ? ' sys' : ''}"><div class="pv-pn">${avatar(x.name, x.icon, 'pv-av sm')}<div class="pv-at"><b>${esc(x.name)}</b><span>${x.svc && x.svc.length ? esc(x.svc.join(', ')) : x.system ? t('Part of Windows') : esc(t('Process {pid}', { pid: x.pid }))}</span></div></div>
    <span class="pv-pp"><b>${x.port}</b><em>${x.proto}</em>${x.known ? `<span class="chip">${esc(x.known)}</span>` : ''}</span><span class="pv-ps2">${x.scope === 'all' && x.system ? `<span class="chip">${s[1]}</span>` : `<span class="chip ${s[0]}">${s[1]}</span>`}</span></div>`; };
  const ph = rows.length ? rows.map(portRow).join('') : `<div class="pv-empty">${ic('check')}<div><b>${t('Nothing is open to other devices')}</b><span>${t('Every listening port is only reachable from this PC.')}</span></div></div>`;
  const pl = $('#pvPorts', netEl); if (pl.dataset.sig !== ph) { const fresh = !pl.dataset.sig || animate; pl.dataset.sig = ph; paintInto(pl, ph, fresh); }
  $('#pvAppN', netEl).textContent = String(N.apps.length);
  const ah = N.apps.length ? N.apps.map(a => `<div class="pv-napp${openApp === a.name ? ' open' : ''}" data-app="${esc(a.name)}"><div class="pv-nar">${avatar(a.name, a.icon, 'pv-av sm')}<div class="pv-at"><b>${esc(a.name)}</b><span>${esc(a.n === 1 ? t('1 connection') : t('{n} connections', { n: a.n }))}${a.public ? ' · ' + esc(t('{n} to the internet', { n: a.public })) : ''}</span></div><span class="pv-bar"><i style="transform:scaleX(${Math.min(1, a.n / Math.max(...N.apps.map(x => x.n))).toFixed(3)})"></i></span>${ic('chevd')}</div>
    <div class="pv-nad"><div><div class="pv-nadi">${a.remotes.map(r => `<span><i class="${r.public ? 'pub' : ''}"></i>${esc(r.ip)}<em>:${r.port}</em><small>${r.public ? t('Internet') : t('Local network')}</small></span>`).join('')}${a.n > a.remotes.length ? `<span class="faint">${esc(t('and {n} more', { n: a.n - a.remotes.length }))}</span>` : ''}</div></div></div></div>`).join('')
    : `<div class="pv-empty">${ic('check')}<div><b>${t('No app is connected right now')}</b><span>${t('Connections to the internet show up here as they happen.')}</span></div></div>`;
  const al = $('#pvApps', netEl); if (al.dataset.sig !== ah) { const fresh = !al.dataset.sig; al.dataset.sig = ah; paintInto(al, ah, fresh); }
  const w = N.wifi || {};
  const WL = { good: ['ok', t('Secure')], weak: ['warn', t('Weak')], open: ['bad', t('No password')] };
  const wl = WL[w.level] || ['', '—'];
  const CAT = { public: t('Public network'), private: t('Private network'), domain: t('Domain network') };
  const wh = `<div class="pv-pch"><span class="ri">${ic('wifi')}</span><b>Wi-Fi</b>${w.connected ? chipOf(wl[0], wl[1]) : ''}</div>${w.connected ? `<div class="pv-lns">${line(t('Network'), esc(w.ssid || t('Hidden by Windows')))}${line(t('Security'), esc(w.auth === 'Open' ? t('None (open)') : [w.auth, w.cipher].filter(Boolean).join(' · ') || '—'), wl[0])}${w.category ? line(t('Profile'), CAT[w.category] || esc(w.category)) : ''}</div>${w.category === 'public' ? `<p class="pv-note">${t('Public profile: other devices on this network cannot see your PC.')}</p>` : w.category === 'private' ? `<p class="pv-note">${t('Private profile: devices on this network can find your PC. Use it only at home or work.')}</p>` : ''}` : `<p class="muted pv-d">${w.denied ? t('Windows hides the Wi-Fi details from apps without location access.') : t('Not connected to Wi-Fi.')}</p>`}`;
  const we = $('#pvWifi', netEl); if (we.dataset.sig !== wh) { we.dataset.sig = wh; we.innerHTML = wh; }
  const h = N.hosts || {}; const flagged = (h.entries || []).filter(e => e.level !== 'info');
  const LV = { bad: 'bad', warn: 'warn', info: '' };
  const hh = `<div class="pv-pch"><span class="ri">${ic('pvfile')}</span><b>${t('Hosts file')}</b>${h.readable === false ? '' : flagged.some(e => e.level === 'bad') ? chipOf('bad', t('Redirects')) : flagged.length ? chipOf('warn', t('Review')) : chipOf('ok', t('Looks fine'))}</div>
    <p class="pv-d">${!h.total ? t('No custom entries: every site goes to its real address.') : esc(h.total === 1 ? t('1 custom entry; {b} of them block sites.', { b: h.blocks }) : t('{n} custom entries; {b} of them block sites.', { n: h.total, b: h.blocks }))}</p>
    ${(h.entries || []).length ? `<div class="pv-hl">${h.entries.slice(0, 30).map(e => `<div class="pv-he ${LV[e.level]}"><b>${esc(e.host)}</b><span>${e.kind === 'block' ? t('blocked') : '→ ' + esc(e.ip)}</span></div>`).join('')}</div>` : ''}
    ${h.path ? `<button class="btn ghost sm" data-loc="${esc(h.path)}">${ic('folder')}${t('Open file location')}</button>` : ''}`;
  const he = $('#pvHosts', netEl); if (he.dataset.sig !== hh) { he.dataset.sig = hh; he.innerHTML = hh; }
}
const netIcons = {}, netAsk = new Set();
function fillNetIcons() {
  const N = D.network; if (!REAL || !N) return;
  const all = [...N.listen, ...N.apps];
  let any = false; all.forEach(x => { if (x.path && netIcons[x.path] && !x.icon) { x.icon = netIcons[x.path]; any = true; } });
  const need = [...new Set(all.filter(x => x.path && !x.icon && !netAsk.has(x.path)).map(x => x.path))].slice(0, 40);
  if (any) paintNet();
  if (!need.length) return; need.forEach(p => netAsk.add(p));
  SH.engine('privacy', 'icons', need).then(m => { if (!m) return; Object.assign(netIcons, m); fillNetIcons(); }).catch(() => {});
}
function netTick() {
  clearTimeout(netTimer);
  const vis = state.view === 'privacy' && netEl && netEl.classList.contains('on');
  if (vis && REAL && !loading('network') && TS.network && NOW() - TS.network > 5) load('network');
  netTimer = setTimeout(netTick, 6000);
}

/* ================= Tracking ================= */
let trEl = null;
const SAMPLE_UNDO = {};
function renderTracking(el) {
  trEl = el; el.classList.add('fill');
  el.innerHTML = `<div class="pv-tr"><div class="pv-trl"><div class="pan pv-trh" data-asm id="pvTrH"></div><div class="pan pv-trb" data-asm><div class="pv-trs" id="pvTrList"></div></div></div>
    <div class="pan pv-trr" data-asm><h4 class="pan-h">${t('Your changes')}<em>${t('backed up before each change')}</em></h4><div class="pv-hist" id="pvHist"></div>
      <p class="pv-note faint">${t('StellarHub saves the previous value of every setting before changing it, so each change can be undone, even after a restart.')}</p></div></div>`;
  el.addEventListener('click', async e => {
    const tg = e.target.closest('.toggle[data-tr]'); if (tg) { toggleTrack(tg); return; }
    const u = e.target.closest('[data-uri]'); if (u) { openUri(u.dataset.uri); return; }
    const hu = e.target.closest('[data-undo]'); if (hu) { hu.disabled = true; if (!REAL) { const h = D.tracking.history.find(x => x.id === hu.dataset.undo); if (h) { h.undone = true; (SAMPLE_UNDO[h.id] || (() => { D.tracking.items.find(i => i.id === 'adid').on = true; }))(); } recalcTracking(D.tracking); setData('tracking', D.tracking); SH.toast(t('Undone.')); return; }
      try { const r = await eng('undo', hu.dataset.undo); if (r.tracking) setData('tracking', r.tracking); else { if (r.area) load(r.area); load('tracking'); } SH.toast(t('Undone: {what}', { what: r.label || '' })); } catch (err) { hu.disabled = false; if (!err.needAdmin) SH.toast(err.message); } return; }
    if (e.target.closest('#pvTrAll')) { const f = (D.tracking.findings || []).find(x => x.fix); if (!f) return; const b = e.target.closest('#pvTrAll'); b.disabled = true;
      try { const r = await applyFix(f); if (r) { undoToast(r.label, r, 'tracking'); logAct(r.label, { ic: 'privacy', go: 'privacy', tab: 'tracking' }); } } catch (err) { if (!err.needAdmin) SH.toast(err.message); } finally { b.disabled = false; } }
  });
  paintTrack(true);
  on(a => { if (a === 'tracking') paintTrack(); });
}
async function toggleTrack(tg) {
  const it = D.tracking.items.find(i => i.id === tg.dataset.tr); if (!it || it.locked) return;
  if (it.admin && !state.admin) { SH.requireAdmin(t('to change this Windows setting.')); return; }
  const want = !it.on; tg.classList.toggle('on', want); tg.disabled = true;
  try {
    let r;
    if (REAL) { r = await eng('tracking_set', [it.id], want); setData('tracking', r); }
    else { await wait(220); it.on = want; const h = { id: 's' + Date.now(), t: NOW(), label: want ? t('{name}: turned on', { name: it.name }) : t('{name}: turned off', { name: it.name }), kind: 'reg', area: 'tracking', undone: false };
      D.tracking.history.unshift(h); recalcTracking(D.tracking); setData('tracking', D.tracking); r = { label: h.label, backup: h.id, sample: null };
      r.sampleUndo = () => { it.on = !want; h.undone = true; recalcTracking(D.tracking); setData('tracking', D.tracking); }; SAMPLE_UNDO[h.id] = () => { it.on = !want; }; }
    SH.toast(r.label, { action: { label: t('Undo'), run: async () => { if (!REAL) { r.sampleUndo(); SH.toast(t('Undone.')); return; } await undo(r, 'tracking'); } } });
  } catch (e) { tg.classList.toggle('on', !want); if (!e.needAdmin) SH.toast(e.message); }
  finally { tg.disabled = false; }
}
function paintTrack(first) {
  if (!trEl) return;
  const list = $('#pvTrList', trEl), head = $('#pvTrH', trEl), hist = $('#pvHist', trEl);
  if (!has('tracking')) { if (ERR.tracking) { list.innerHTML = errBox('tracking'); return; } list.innerHTML = skelRows(7); head.innerHTML = `<div class="sk" style="height:18px;width:40%"></div><div class="sk" style="height:10px;width:60%;margin-top:10px"></div>`; hist.innerHTML = skelRows(2, 'tight'); return; }
  const T = D.tracking, rec = T.items.filter(i => i.rec === 'off'), sharing = rec.filter(i => i.on && !i.locked);
  const f = (T.findings || []).find(x => x.fix);
  const hh = `<div class="pv-trn"><b class="big">${sharing.length}<small>/ ${rec.length}</small></b><div><b>${!sharing.length ? t('Windows shares only what it needs') : sharing.length === 1 ? t('1 setting shares data that Windows works fine without') : t('{n} settings share data that Windows works fine without', { n: sharing.length })}</b><span>${t('These are Windows’ own settings. Turning them off changes nothing else, and each change can be undone.')}</span></div></div>
    <div class="pv-tra">${f ? `<button class="btn pri" id="pvTrAll">${ic('pvradar')}${esc(f.fix.label)}</button>` : `<span class="chip ok">${ic('check')}${t('All recommended settings are off')}</span>`}<button class="btn ghost sm" data-uri="ms-settings:privacy">${ic('external')}${t('Windows privacy settings')}</button></div>`;
  if (head.dataset.sig !== hh) { head.dataset.sig = hh; head.innerHTML = hh; }
  const groups = T.groups || GROUPS;
  const row = i => `<div class="pv-tg${i.on ? ' on' : ''}${i.locked ? ' locked' : ''}" data-id="${i.id}"><div class="pv-ttx"><b>${esc(i.name)}${i.rec === 'off' && i.on ? `<span class="pv-rec">${t('recommended off')}</span>` : ''}</b><span>${esc(i.desc)}</span>
      ${i.locked || (i.admin && !state.admin) || i.note ? `<span class="pv-tchips">${i.locked ? `<span class="chip">${t('Managed by your organization')}</span>` : ''}${i.admin && !state.admin && !i.locked ? `<span class="chip warn">${t('administrator')}</span>` : ''}${i.note ? `<span class="faint">${esc(i.note)}</span>` : ''}</span>` : ''}</div>
      ${i.page ? `<button class="iconbtn" data-uri="${esc(i.page)}" title="${t('Open in Windows Settings')}" aria-label="${t('Open in Windows Settings')}">${ic('external')}</button>` : '<span></span>'}
      <button class="toggle${i.on ? ' on' : ''}" data-tr="${i.id}"${i.locked ? ' disabled' : ''} aria-label="${esc(i.name)}"><i></i></button></div>`;
  const lh = Object.keys(groups).filter(g => T.items.some(i => i.g === g)).map(g => `<div class="pv-tgr"><h4 class="pv-gh">${esc(groups[g])}<em>${T.items.filter(i => i.g === g && i.on && i.rec === 'off').length || ''}</em></h4>${T.items.filter(i => i.g === g).map(row).join('')}</div>`).join('');
  if (list.dataset.sig !== lh) {
    const fresh = !list.dataset.sig; list.dataset.sig = lh;
    if (fresh) paintInto(list, lh, !first);
    else { /* keep the rows (and the toggles' own transitions): only update state */
      const tmp = document.createElement('div'); tmp.innerHTML = lh;
      $$('.pv-tg', tmp).forEach(n => { const o = $(`.pv-tg[data-id="${n.dataset.id}"]`, list); if (!o) return; if (o.outerHTML !== n.outerHTML) { o.className = n.className; $('.pv-ttx', o).innerHTML = $('.pv-ttx', n).innerHTML; const tg = $('.toggle', o); tg.classList.toggle('on', n.classList.contains('on')); } });
      $$('.pv-gh em', list).forEach((em, i) => { const n = $$('.pv-gh em', tmp)[i]; if (n) em.textContent = n.textContent; });
    }
  }
  const hs = T.history || [];
  const histH = hs.length ? hs.map(h => `<div class="pv-hi${h.undone ? ' undone' : ''}"><span class="pv-hd"></span><div><b>${esc(h.label || '')}</b><span>${esc(ago(h.t))}${h.undone ? ' · ' + t('undone') : ''}</span></div>${h.undone ? '' : `<button class="btn ghost sm" data-undo="${esc(h.id)}">${ic('pvundo')}${t('Undo')}</button>`}</div>`).join('')
    : `<div class="pv-empty sm">${ic('pvundo')}<div><b>${t('No changes yet')}</b><span>${t('What you change here shows up in this list, ready to undo.')}</span></div></div>`;
  if (hist.dataset.sig !== histH) { hist.dataset.sig = histH; hist.innerHTML = histH; }
}

/* ================= Auto-starts ================= */
let psEl = null, psKind = 'all', psQ = '', psOpen = null, psConfirm = null;
const KIND = { task: ['pvtask', t('Scheduled task')], service: ['pvsvc', t('Service')], run: ['pvreg', t('Registry')], ext: ['pvpuzzle', t('Browser extension')], hook: ['pvhook', t('System hook')] };
const RISK = { high: ['bad', t('Suspicious')], medium: ['warn', t('Review')], low: ['ok', t('Looks fine')] };
const KINDS = [['all', t('All')], ['task', t('Tasks')], ['service', t('Services')], ['run', t('Registry')], ['ext', t('Extensions')], ['hook', t('System hooks')]];
function renderPersistence(el) {
  psEl = el; el.classList.add('fill');
  el.innerHTML = `<div class="pv-ps0"><div class="pan pv-pst" data-asm id="pvPsTop"></div>
    <div class="pan pv-psl" data-asm><div class="pv-th"><div class="seg pv-kseg" id="pvPsK"><span class="ind"></span>${KINDS.map(([k, n]) => `<button data-k="${k}"${k === psKind ? ' class="on"' : ''}>${n}<em data-n="${k}"></em></button>`).join('')}</div>
      <label class="field pv-q">${ic('search')}<input id="pvPsQ" placeholder="${t('Search by name or path')}" aria-label="${t('Search by name or path')}"></label></div>
      <div class="pv-pscols"><span>${t('Name')}</span><span>${t('When it runs')}</span><span>${t('Risk')}</span><span></span></div><div class="pv-pslist" id="pvPsList"></div>
      <div class="pv-psf faint">${ic('info')}<span>${t('Regular startup apps are in Super Optimizer > Startup. Here you see what runs without showing up there.')}</span><button class="btn ghost sm" data-goopt>${t('Open Startup')}</button></div></div></div>`;
  requestAnimationFrame(() => SH.placeSeg($('#pvPsK', el), true));
  $('#pvPsQ', el).addEventListener('input', e => { psQ = e.target.value.trim().toLowerCase(); paintPs(); });
  el.addEventListener('click', async e => {
    const kb = e.target.closest('#pvPsK button'); if (kb) { if (kb.dataset.k === psKind) return; psKind = kb.dataset.k; $$('#pvPsK button', el).forEach(b => b.classList.toggle('on', b === kb)); SH.placeSeg($('#pvPsK', el)); paintPs(true); return; }
    if (e.target.closest('[data-goopt]')) { SH.go('optimizer', { tab: 'startup' }); return; }
    const l = e.target.closest('[data-loc]'); if (l) { openLoc(l.dataset.loc); return; }
    const dis = e.target.closest('[data-dis]'); if (dis) { psAct(dis.dataset.dis, dis); return; }
    if (e.target.closest('[data-cancel]')) { psConfirm = null; paintPs(); return; }
    const rk = e.target.closest('[data-rk]'); if (rk) { psKind = 'all'; psQ = ''; $('#pvPsQ', el).value = ''; $$('#pvPsK button', el).forEach(b => b.classList.toggle('on', b.dataset.k === 'all')); SH.placeSeg($('#pvPsK', el)); psRisk = psRisk === rk.dataset.rk ? null : rk.dataset.rk; paintPs(true); return; }
    const r = e.target.closest('.pv-pr0'); if (r && !e.target.closest('button')) { const it = r.parentElement; psOpen = psOpen === it.dataset.id ? null : it.dataset.id; $$('.pv-pit', el).forEach(x => x.classList.toggle('open', x.dataset.id === psOpen)); }
  });
  paintPs();
  on(a => { if (a.startsWith('persistence')) paintPs(); });
}
let psRisk = null;
async function psAct(id, btn) {
  const e = D.persistence.items.find(x => x.id === id); if (!e) return;
  if (psConfirm !== id) { psConfirm = id; paintPs(); return; }
  const want = !e.on; btn.disabled = true;
  try {
    let r;
    if (REAL) r = await eng('persist_set', e.sid || e.id, want, e.name);
    else { await wait(300); r = { label: want ? t('{name}: enabled', { name: e.name }) : t('{name}: disabled', { name: e.name }), backup: 'sample' }; }
    e.on = want; psConfirm = null; paintPs();
    SH.toast(r.label, { action: { label: t('Undo'), run: async () => { if (REAL) { try { await eng('undo', r.backup); } catch (err) { if (!err.needAdmin) SH.toast(err.message); return; } } e.on = !want; paintPs(); SH.toast(t('Undone.')); } } });
    logAct(r.label, { ic: 'privacy', go: 'privacy', tab: 'persistence' });
  } catch (err) { btn.disabled = false; if (!err.needAdmin) SH.toast(err.message); }
}
function paintPs(animate) {
  if (!psEl) return;
  const top = $('#pvPsTop', psEl), list = $('#pvPsList', psEl);
  if (!has('persistence')) {
    if (ERR.persistence) { list.innerHTML = errBox('persistence'); return; }
    if (!list.dataset.sk) { list.dataset.sk = 1; top.innerHTML = `<div class="pv-pss">${Array.from({ length: 3 }, () => '<div><div class="sk" style="height:24px;width:40px"></div><div class="sk" style="height:9px;width:80px;margin-top:9px"></div></div>').join('')}<div class="pv-psload"><div class="pv-spin"></div><span>${t('Reading tasks, services, the registry and browser extensions, and checking signatures…')}</span></div></div>`; list.innerHTML = skelRows(7); }
    return;
  }
  delete list.dataset.sk;
  const P = D.persistence, items = P.items;
  const cnt = r => items.filter(e => e.risk === r).length;
  const th = `<div class="pv-pss">${['high', 'medium', 'low'].map(r => `<button class="pv-rk ${RISK[r][0]}${psRisk === r ? ' on' : ''}" data-rk="${r}"><b class="big">${cnt(r)}</b><span>${RISK[r][1]}</span></button>`).join('')}
    <div class="pv-psx"><b>${cnt('high') ? t('Some things start by themselves that are worth checking') : t('Nothing suspicious starts by itself')}</b><span>${t('Read-only: nothing is changed unless you disable it, and that can be undone.')}</span><span class="faint">${esc(stamp('persistence'))}</span></div></div>`;
  if (top.dataset.sig !== th) { top.dataset.sig = th; top.innerHTML = th; }
  KINDS.forEach(([k]) => { const em = $(`[data-n="${k}"]`, psEl); if (em) em.textContent = k === 'all' ? items.length : (P.counts && P.counts[k]) || items.filter(e => e.kind === k).length || ''; });
  let rows = items.filter(e => (psKind === 'all' || e.kind === psKind) && (!psRisk || e.risk === psRisk));
  if (psQ) rows = rows.filter(e => [e.name, e.pub, e.cmd, e.where, e.browser].some(v => String(v || '').toLowerCase().includes(psQ)));
  const SIG = { valid: ['ok', t('Signed')], unsigned: ['warn', t('Not signed')], invalid: ['bad', t('Invalid signature')] };
  const row = e => {
    const k = KIND[e.kind] || ['dots', e.kind], rk = RISK[e.risk], sg = SIG[e.sig];
    const sub = [e.pub || (e.kind === 'ext' ? '' : t('Unknown publisher')), e.kind === 'ext' ? e.where : k[1], e.user && e.user !== t('You') ? e.user : ''].filter(Boolean).join(' · ');
    const conf = psConfirm === e.id;
    const actBtns = `${e.exe && !e.missing ? `<button class="btn ghost sm" data-loc="${esc(e.exe)}">${ic('folder')}${t('Open location')}</button>` : e.path ? `<button class="btn ghost sm" data-loc="${esc(e.path)}">${ic('folder')}${t('Open location')}</button>` : ''}
      ${e.can ? (conf ? `<span class="pv-conf">${e.on ? t('Disable it? It will stop starting by itself.') : t('Enable it again?')}</span><button class="btn sm ${e.on ? 'danger' : 'pri'}" data-dis="${esc(e.id)}">${e.on ? t('Disable') : t('Enable')}</button><button class="btn ghost sm" data-cancel>${t('Cancel')}</button>`
        : `<button class="btn sm sec" data-dis="${esc(e.id)}">${e.on ? ic('power') + t('Disable') : ic('play') + t('Enable')}</button>`) : ''}`;
    return `<div class="pv-pit ${e.risk}${psOpen === e.id ? ' open' : ''}${e.on ? '' : ' off'}" data-id="${esc(e.id)}"><div class="pv-pr0">
      ${e.icon ? avatar(e.name, e.icon, 'pv-av sm') : `<span class="pv-av sm k">${ic(k[0])}</span>`}<div class="pv-at"><b>${esc(e.name)}${e.on ? '' : ` <span class="chip">${t('Disabled')}</span>`}${e.normal ? ` <span class="chip">${t('In Startup apps')}</span>` : ''}</b><span>${esc(sub)}</span></div>
      <span class="pv-pw">${esc(e.trigger || (e.kind === 'ext' ? (e.on ? t('While the browser is open') : t('Turned off in the browser')) : ''))}</span>
      <span class="pv-pk"><span class="chip ${rk[0]}">${rk[1]}</span></span><span class="pv-chev">${ic('chevd')}</span></div>
      <div class="pv-pd"><div><div class="pv-pdi">
        ${e.why && e.why.length ? `<ul class="pv-why">${e.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : `<p class="pv-why ok">${ic('check')}${e.kind === 'ext' ? t('Installed from the store and asks only for ordinary permissions.') : t('Signed by its publisher and runs from a normal place.')}</p>`}
        ${e.cmd ? `<div class="pv-cmd"><span>${e.kind === 'ext' ? t('Extension ID') : t('Command')}</span><code>${esc(e.cmd)}</code></div>` : ''}
        <div class="pv-meta">${e.where && e.kind !== 'ext' ? `<span><em>${t('Location')}</em>${esc(e.where)}</span>` : ''}${sg ? `<span><em>${t('Signature')}</em><b class="${sg[0]}">${sg[1]}</b></span>` : ''}${e.version ? `<span><em>${t('Version')}</em>${esc(e.version)}</span>` : ''}${e.perms && e.perms.length ? `<span class="wide"><em>${t('Permissions')}</em>${e.perms.slice(0, 14).map(p => `<i>${esc(p)}</i>`).join('')}</span>` : ''}</div>
        <div class="pv-pacts">${actBtns}</div></div></div></div></div>`;
  };
  const lh = rows.length ? rows.map(row).join('') : `<div class="pv-empty">${ic('check')}<div><b>${psQ || psRisk || psKind !== 'all' ? t('Nothing matches') : t('Nothing starts by itself outside the usual places')}</b><span>${psQ || psRisk || psKind !== 'all' ? t('Try another filter or search.') : t('No extra tasks, services, registry entries or extensions were found.')}</span></div></div>`;
  if (list.dataset.sig !== lh) { const fresh = !list.dataset.sig || animate; list.dataset.sig = lh; paintInto(list, lh, fresh); }
}

/* ================= module registration ================= */
const rendered = {};
function badges() {
  if (!modCtx) return;
  const P = D.permissions; modCtx.setBadge('permissions', P ? P.caps.reduce((a, c) => a + c.apps.filter(x => x.active).length, 0) : 0);
  const S = D.persistence; modCtx.setBadge('persistence', S ? S.items.filter(e => e.risk === 'high' && e.on).length : 0);
}
on(a => { if (AREAS.includes(a)) badges(); });
SH.module({
  id: 'privacy', real: true,
  actions(el, ctx) {
    modCtx = ctx;
    el.innerHTML = `<button class="btn ghost" data-a="again">${ic('pvscan')}${t('Check again')}</button>`;
    el.addEventListener('click', e => { if (!e.target.closest('[data-a="again"]')) return; AREAS.forEach(a => load(a)); SH.toast(t('Checking again…')); });
    on(a => { const b = $('[data-a="again"]', el); if (b && (a.endsWith(':busy') || a.endsWith(':idle'))) b.disabled = AREAS.some(loading); });
  },
  renderTab(tab, el, ctx) {
    start();
    ({ overview: renderOverview, permissions: renderPermissions, protection: renderProtection, network: renderNetwork, tracking: renderTracking, persistence: renderPersistence })[tab](el, ctx);
  },
  enter() { start(); liveTick(); netTick(); badges(); },
  leave() { clearTimeout(liveTimer); clearTimeout(netTimer); },
  enterTab(tab, el) {
    if (tab === 'overview' && el) { const r = $('.pv-radar', el); if (r) anim(r, [{ transform: 'scale(.9)', opacity: .4 }, { transform: 'none', opacity: 1 }], { d: 620, e: EASE.spring }); if (rendered.overview) rendered.overview(); startSweep(); }
    if (tab === 'network' && REAL && TS.network && NOW() - TS.network > 4) load('network');
    if (tab === 'permissions' && REAL && TS.permissions && NOW() - TS.permissions > 20) load('permissions');
  },
});
SH.actions.add([
  { t: t('Check my privacy and security'), go: 'privacy', tab: 'overview', ic: 'privacy' },
  { t: t('Which apps used my camera or microphone'), go: 'privacy', tab: 'permissions', ic: 'camera' },
  { t: t('Turn off Windows tracking and ads'), go: 'privacy', tab: 'tracking', ic: 'pvradar' },
  { t: t('Open ports and network connections'), go: 'privacy', tab: 'network', ic: 'globe' },
  { t: t('Scan for threats with Microsoft Defender'), go: 'privacy', tab: 'protection', ic: 'shield' },
  { t: t('What starts by itself'), go: 'privacy', tab: 'persistence', ic: 'bolt' },
]);
})();
