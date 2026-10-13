const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { privateDirectory, atomicJSON, createLog, digest } = require('./common.cjs');
const { CaptureIndex, Matcher } = require('./captures.cjs');
const { watchClipboard } = require('./clipboard.cjs');
const { updateRuntime, installHook, defaultCodexHome } = require('./hook.cjs');
const { createLarkService, sanitizeError } = require('./lark.cjs');
const title = () => 'codex分享飞书消息';
async function start(options = {}) {
  const dataDir = options.dataDir || path.join(os.homedir(), 'Library/Application Support/CodexFeishuShare');
  const logDir = options.logDir || path.join(os.homedir(), 'Library/Logs/CodexFeishuShare');
  app.setPath('userData', dataDir);
  privateDirectory(dataDir);
  const log = createLog(logDir);
  app.setName(title());
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let shareWindow, settingsWindow, tray, observer, index, matcher;
  let current = null, quitting = false;
  let lark;
  app.on('before-quit', () => {
    quitting = true; observer?.close(); index?.close(); matcher?.clear(); lark?.dispose?.();
  });
  let rendererReadyResolve;
  const rendererReady = new Promise((resolve) => { rendererReadyResolve = resolve; });
  const settingsFile = path.join(dataDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') log('settings_read_failed', { code: 'invalid_settings' }); }
  const state = {
    version: app.getVersion(), appId: settings.appId || '', configured: Boolean(settings.appId),
    auth: { status: settings.appId ? 'logged-out' : 'unconfigured' },
    hook: { installed: Boolean(settings.hookInstalled), codexHome: settings.codexHome || defaultCodexHome() },
    listener: { status: 'starting' },
    desktop: { hideDock: settings.hideDock !== false, openAtLogin: false, loginStatus: 'not-registered', loginAvailable: app.isPackaged && process.platform === 'darwin' },
  };
  function applyDockPolicy() {
    if (process.platform === 'darwin') app.setActivationPolicy(state.desktop.hideDock ? 'accessory' : 'regular');
    log('dock_policy_changed', { hideDock: state.desktop.hideDock });
  }
  function refreshLoginSettings() {
    if (!state.desktop.loginAvailable) return;
    const login = app.getLoginItemSettings();
    state.desktop.openAtLogin = login.openAtLogin || login.status === 'requires-approval';
    state.desktop.loginStatus = login.status || (login.openAtLogin ? 'enabled' : 'not-registered');
    return login;
  }
  applyDockPolicy();
  function publish() {
    for (const window of [shareWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('state', state);
    if (tray) tray.setContextMenu(Menu.buildFromTemplate([
      { label: state.listener.status === 'listening' ? '正常监听' : state.listener.status === 'starting' ? '监听启动中' : '监听异常：请查看诊断日志', enabled: false },
      { label: '设置', click: () => openSettings('tray-menu') }, { label: '退出', click: () => app.quit() },
    ]));
  }
  function openSettings(reason) {
    settingsWindow?.show(); settingsWindow?.focus();
    log('settings_opened', { reason, visible: Boolean(settingsWindow?.isVisible()) });
  }
  function activate(reason) {
    if (state.desktop.hideDock || current?.phase === 'sending') { log('activation_ignored', { reason }); return; }
    if (current?.phase === 'sharing') { shareWindow.show(); shareWindow.focus(); }
    else openSettings(reason);
  }
  app.on('second-instance', () => activate('second-instance'));
  app.on('activate', (_event, hasVisibleWindows) => { if (!hasVisibleWindows) activate('dock-activate'); });
  await app.whenReady();
  const openedAtLogin = Boolean(refreshLoginSettings()?.wasOpenedAtLogin);
  log('desktop_startup', { ...state.desktop, openedAtLogin });
  const root = app.getAppPath();
  const resources = app.isPackaged ? process.resourcesPath : root;
  const uiFile = path.join(root, 'dist/ui/index.html');
  const hookPath = path.join(resources, 'hook/capture-hook.cjs');
  const binary = app.isPackaged ? path.join(resources, 'bin/lark-cli') : path.join(root, 'bin/arm64/lark-cli');
  let launcher;
  if (!options.benchmark) launcher = updateRuntime(dataDir, process.execPath, hookPath, log, logDir);
  lark = options.lark || createLarkService({
    binary, configDir: path.join(dataDir, 'lark-cli'), log,
    onAuthState(auth) { state.auth = auth; publish(); },
  });
  function secureWindow(window) {
    window.on('page-title-updated', (event) => { event.preventDefault(); window.setTitle(title()); });
    window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); openExternal(url); });
    window.webContents.on('render-process-gone', (_event, details) => {
      log('renderer_gone', { reason: details.reason });
      state.listener = { status: 'error', error: '界面进程已退出，请退出并重新启动软件。' }; publish();
    });
  }
  function openExternal(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'feishu.cn' || parsed.hostname.endsWith('.feishu.cn') || parsed.hostname === 'larksuite.com' || parsed.hostname.endsWith('.larksuite.com'))) {
        shell.openExternal(url).catch(() => log('external_open_failed'));
      }
    } catch { log('external_url_rejected'); }
  }
  const preferences = { preload: path.join(root, 'dist/preload/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
  shareWindow = new BrowserWindow({ width: 600, height: 700, useContentSize: true, show: false, paintWhenInitiallyHidden: true, title: title(), backgroundColor: '#ffffff', webPreferences: preferences });
  settingsWindow = new BrowserWindow({ width: 1180, height: 850, show: false, title: title(), backgroundColor: '#f4f5f7', webPreferences: preferences });
  secureWindow(shareWindow); secureWindow(settingsWindow);
  function hideShare() {
    if (current?.phase === 'sending') return;
    shareWindow.webContents.send('share', null);
    shareWindow.hide(); current = null; matcher.release();
    log('share_closed', { settingsVisible: settingsWindow.isVisible() });
  }
  shareWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); hideShare(); } });
  settingsWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); settingsWindow.hide(); log('settings_hidden', { reason: 'close' }); } });
  settingsWindow.on('focus', () => { refreshLoginSettings(); publish(); });
  function fitShare(height = 660) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const contentHeight = Math.min(Math.max(320, Math.round(height)), area.height - 60);
    shareWindow.setContentSize(Math.min(600, area.width - 32), contentHeight);
    const bounds = shareWindow.getBounds();
    shareWindow.setPosition(Math.round(area.x + (area.width - bounds.width) / 2), Math.round(area.y + (area.height - bounds.height) / 2));
  }
  function showRecord(record, timing) {
    current = { id: randomUUID(), record, timing, phase: 'sharing' };
    if (settingsWindow.isVisible()) { settingsWindow.hide(); log('settings_hidden', { reason: 'share' }); }
    fitShare();
    shareWindow.webContents.send('share', { id: current.id, text: record.text });
    shareWindow.show(); shareWindow.focus();
    log('share_shown', { shareId: current.id, turnId: record.turnId, sha256: record.sha256, chars: [...record.text].length, cacheWaitMs: timing.cacheWaitMs, detectToShowMs: performance.now() - timing.detectedAt });
    options.onShare?.(current);
  }
  index = new CaptureIndex(path.join(dataDir, 'captures'), log, () => {
    state.hook.capturedAt = index.latestTime(); publish(); matcher.retry();
  });
  state.hook.capturedAt = index.latestTime();
  matcher = new Matcher(index, showRecord);
  const allowed = (event, kind) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许此调用。');
    if (kind === 'share' && event.sender !== shareWindow.webContents) throw new Error('不允许此调用。');
    if (kind === 'settings' && event.sender !== settingsWindow.webContents) throw new Error('请在设置窗口操作。');
    if (event.sender !== shareWindow.webContents && event.sender !== settingsWindow.webContents) throw new Error('不允许此调用。');
  };
  function handle(channel, kind, callback) { ipcMain.handle(channel, (event, value) => { allowed(event, kind); return callback(value); }); }
  function listen(channel, kind, callback) {
    ipcMain.on(channel, (event, value) => { try { allowed(event, kind); callback(value); } catch { log('ipc_rejected', { channel }); } });
  }
  handle('get-settings', null, () => { refreshLoginSettings(); return state; });
  handle('set-hide-dock', 'settings', (value) => {
    if (typeof value !== 'boolean') throw new Error('程序坞设置无效。');
    const next = { ...settings, hideDock: value };
    atomicJSON(settingsFile, next); settings = next;
    state.desktop.hideDock = value; applyDockPolicy(); publish(); return state;
  });
  handle('set-open-at-login', 'settings', (value) => {
    if (typeof value !== 'boolean') throw new Error('登录自启设置无效。');
    if (!state.desktop.loginAvailable) throw new Error('请安装正式 App 后设置登录自启。');
    try {
      app.setLoginItemSettings({ openAtLogin: value });
      refreshLoginSettings();
      log('login_item_changed', { requested: value, openAtLogin: state.desktop.openAtLogin, status: state.desktop.loginStatus });
      publish(); return state;
    } catch (error) { log('login_item_change_failed', { requested: value, code: error.code || 'system_error' }); throw error; }
  });
  listen('open-login-settings', 'settings', () => {
    if (!state.desktop.loginAvailable) return;
    log('login_settings_opened');
    shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension').catch(() => log('login_settings_open_failed'));
  });
  handle('save-config', 'settings', async (value) => {
    if (!value || typeof value.appId !== 'string' || typeof value.appSecret !== 'string') throw new Error('请输入应用 ID 和密钥。');
    await lark.saveConfig(value);
    settings.appId = value.appId.trim(); atomicJSON(settingsFile, settings);
    state.appId = settings.appId; state.configured = true;
    state.auth = await lark.authStatus(); publish(); return state;
  });
  handle('login', 'settings', async () => { state.auth = await lark.login(); publish(); return state; });
  handle('logout', 'settings', async () => { await lark.logout(); state.auth = await lark.authStatus(); publish(); return state; });
  handle('install-hook', 'settings', (value) => {
    if (!value || typeof value.codexHome !== 'string') throw new Error('请填写 Codex 配置目录。');
    installHook({ codexHome: value.codexHome, launcher, log });
    settings.codexHome = value.codexHome; settings.hookInstalled = true; atomicJSON(settingsFile, settings);
    state.hook = { ...state.hook, installed: true, codexHome: value.codexHome }; publish(); return state;
  });
  const query = (value) => { if (typeof value !== 'string' || value.length > 10000) throw new Error('搜索内容无效。'); return value; };
  handle('search-contacts', 'share', (value) => lark.searchContacts(query(value)));
  handle('search-chats', 'share', (value) => lark.searchChats(query(value)));
  handle('send-message', 'share', async (value) => {
    if (!current || current.phase !== 'sharing' || !value || value.text !== current.record.text) {
      log('send_rejected', { shareId: current?.id, code: 'stale_or_busy' });
      throw new Error('待发消息已变化，请重新复制完整回复。');
    }
    const sendCurrent = current;
    const requestId = randomUUID();
    const chars = [...sendCurrent.record.text.trim()].length;
    sendCurrent.phase = 'sending';
    shareWindow.hide(); shareWindow.webContents.send('share', null);
    log('share_hidden', { shareId: sendCurrent.id, reason: 'send', settingsVisible: settingsWindow.isVisible() });
    try {
      const recipient = value.recipient;
      if (!recipient || !['user', 'chat'].includes(recipient.kind) || typeof recipient.id !== 'string' || !(recipient.kind === 'user' ? /^ou_[A-Za-z0-9]+$/ : /^oc_[A-Za-z0-9]+$/).test(recipient.id)) {
        log('send_rejected', { shareId: sendCurrent.id, code: 'invalid_recipient' });
        throw new Error('接收对象无效。');
      }
      if (chars > 24000) {
        log('send_rejected', { shareId: sendCurrent.id, code: 'message_too_long', chars });
        throw new Error('回复超过 24,000 个字符，无法作为单条消息发送。');
      }
      log('send_started', { shareId: sendCurrent.id, requestId, chars, sha256: digest(sendCurrent.record.text), kind: recipient.kind });
      const result = await lark.send({ recipient: { ...recipient }, text: sendCurrent.record.text }, requestId);
      log('send_confirmed', { shareId: sendCurrent.id, requestId }); return result;
    } catch (error) {
      const reason = sanitizeError(error.message, [sendCurrent.record.text, ...sendCurrent.record.text.split('\n').filter(Boolean)]);
      log('send_failed', { shareId: sendCurrent.id, requestId, errorCode: error.code, unconfirmed: Boolean(error.unconfirmed),
        missingScopes: error.missingScopes || [], reason });
      throw new Error(reason);
    } finally {
      current = null; matcher.release();
      log('send_finished', { shareId: sendCurrent.id, settingsVisible: settingsWindow.isVisible() });
    }
  });
  listen('open-settings', null, () => openSettings('user'));
  listen('close-share', 'share', hideShare);
  listen('resize-share', 'share', (value) => { if (current?.phase === 'sharing' && Number.isFinite(value?.height)) fitShare(value.height); });
  listen('rendered', 'share', (value) => {
    if (value?.shareId === 'preload') { log('share_preloaded'); rendererReadyResolve(); return; }
    if (!current || value?.shareId !== current.id) return;
    const result = { shareId: current.id, visible: shareWindow.isVisible(), cacheWaitMs: current.timing.cacheWaitMs, detectToPaintMs: performance.now() - current.timing.detectedAt };
    log('share_rendered', result); options.onRendered?.(result, current);
  });
  const dock = nativeImage.createFromPath(path.join(resources, 'assets/dock-icon.png'));
  if (!dock.isEmpty()) app.dock?.setIcon(dock);
  const trayImage = nativeImage.createEmpty();
  for (const [scaleFactor, file] of [[1, 'tray-iconTemplate.png'], [2, 'tray-iconTemplate@2x.png']]) {
    trayImage.addRepresentation({ scaleFactor, buffer: fs.readFileSync(path.join(resources, 'assets', file)) });
  }
  trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  log('tray_icon_loaded', { ...trayImage.getSize(), scales: trayImage.getScaleFactors(), template: trayImage.isTemplateImage() });
  tray.setToolTip(title()); tray.on('click', () => openSettings('tray-click')); publish();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: title(), submenu: [{ label: '设置', click: () => openSettings('app-menu') }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  await Promise.all([shareWindow.loadFile(uiFile), settingsWindow.loadFile(uiFile, { query: { view: 'settings' } })]);
  let readyTimer;
  try {
    await Promise.race([rendererReady, new Promise((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error('renderer_not_ready')), 10000); })]);
  } finally { clearTimeout(readyTimer); }
  observer = watchClipboard((event) => matcher.observe(event), (status) => {
    if (status === 'error') matcher.clear();
    state.listener = { status, ...(status === 'error' ? { error: '剪贴板监听异常，请退出并重新启动软件，查看诊断日志。' } : {}) }; publish();
  }, log, { benchmark: Boolean(options.benchmark) });
  await observer.ready;
  log('app_ready', { name: app.getName(), version: app.getVersion(), architecture: process.arch, replies: index.records.size });
  if (!options.benchmark) {
    if (!state.configured && !openedAtLogin) openSettings('first-setup');
    if (state.configured) lark.authStatus().then((auth) => { state.auth = auth; publish(); }).catch(() => { state.auth = { status: 'error', error: '无法检查登录状态，请在设置重新登录。' }; publish(); });
  }
  app.on('window-all-closed', () => { /* Windows hide on close; only the Quit menu ends the app. */ });
  return { dataDir, shareWindow, settingsWindow, index, matcher, state, log, hideShare, close: () => app.quit() };
}
if (require.main === module) start().catch((error) => {
  const log = createLog(path.join(os.homedir(), 'Library/Logs/CodexFeishuShare'));
  log('app_start_failed', { code: error.code || 'startup_failed' });
  app.quit();
});
module.exports = { start };
