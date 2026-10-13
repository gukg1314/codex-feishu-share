'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const electron = require('electron');
const root = path.resolve(__dirname, '..');
const scenario = process.argv[2] || 'packaged';
const development = scenario === 'development';
if (!['packaged', 'login-startup', 'development'].includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-share-desktop-'));
const dataDir = path.join(tempDir, 'data');
const logDir = path.join(tempDir, 'logs');
const settingsFile = path.join(dataDir, 'settings.json');
const settingsShot = path.join(os.tmpdir(), `codex-share-settings-${process.pid}.png`);
const shareShot = path.join(os.tmpdir(), `codex-share-window-${process.pid}.png`);
const body = '## 合成桌面回归\n\n此文本仅用于本地窗口测试。';
const { digest, normalize } = require('../src/main/common.cjs');
const loginCalls = { get: 0, set: [] };
const activationPolicies = [];
const dockCalls = { setIcon: 0, show: 0 };
const externalUrls = [];
const trayImages = [];
const sendRequests = [];
let watcher;
let tempCleanupRegistered = false;
let loginSettings = scenario === 'login-startup'
  ? { openAtLogin: false, wasOpenedAtLogin: true }
  : { openAtLogin: false, wasOpenedAtLogin: false };

function withMockElectron() {
  const dock = {
    setIcon() { dockCalls.setIcon += 1; },
    show() { dockCalls.show += 1; },
  };
  const app = new Proxy(electron.app, {
    get(target, key) {
      if (key === 'isPackaged') return !development;
      if (key === 'dock') return dock;
      if (key === 'setActivationPolicy') return (policy) => activationPolicies.push(policy);
      if (key === 'getAppPath') return () => root;
      if (key === 'getVersion') return () => require('../package.json').version;
      if (key === 'getLoginItemSettings') return () => { loginCalls.get += 1; return { ...loginSettings }; };
      if (key === 'setLoginItemSettings') return (options) => {
        loginCalls.set.push({ ...options });
        loginSettings = options.openAtLogin
          ? { openAtLogin: false, status: 'requires-approval', wasOpenedAtLogin: false }
          : { openAtLogin: false, status: 'not-registered', wasOpenedAtLogin: false };
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const shell = new Proxy(electron.shell, {
    get(target, key) {
      if (key === 'openExternal') return async (url) => { externalUrls.push(url); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  class MockTray extends EventEmitter {
    constructor(image) { super(); this.image = image; trayImages.push(image); }
    setContextMenu() {}
    setToolTip() {}
  }
  const menu = { buildFromTemplate: (template) => template, setApplicationMenu() {} };
  const facade = new Proxy(electron, {
    get(target, key) {
      if (key === 'app') return app;
      if (key === 'shell') return shell;
      if (key === 'Tray') return MockTray;
      if (key === 'Menu') return menu;
      return Reflect.get(target, key, target);
    },
  });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return facade;
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
}

function stubRuntimeAndClipboard() {
  const hook = require('../src/main/hook.cjs');
  let runtimeCalls = 0;
  hook.updateRuntime = () => { runtimeCalls += 1; return path.join(tempDir, 'stub-launcher'); };
  const clipboard = require('../src/main/clipboard.cjs');
  clipboard.watchClipboard = (onEvent, onStatus) => {
    watcher = { onEvent, closed: false, ready: Promise.resolve(), close() { this.closed = true; } };
    onStatus('listening');
    return watcher;
  };
  return () => runtimeCalls;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(check, label, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await wait(25);
  }
  assert.fail(`timed out: ${label}`);
}
function evaluate(window, js) { return window.webContents.executeJavaScript(js, true); }
async function waitForDom(window, condition, label) {
  await waitFor(() => evaluate(window, `(() => (${condition}))()`), label);
}
async function ipcError(window, method, value) {
  return evaluate(window, `window.electron.${method}(${JSON.stringify(value)}).then(() => 'resolved').catch((error) => error.message)`);
}
async function setSearch(window, value) {
  await evaluate(window, `(() => { const input = document.querySelector('#lark-share-recipient-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function click(window, selector) { await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`); }
async function clickText(window, text) {
  await evaluate(window, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
function mainLogEntries() {
  const file = path.join(logDir, 'app.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
async function waitForLogEvent(event, count = 1) {
  await waitFor(() => mainLogEntries().filter((entry) => entry.event === event).length >= count, `${event} logged`);
}
async function assertNoShareFeedback(window, label) {
  await waitForDom(window, '!document.querySelector("[role=dialog]")', `${label} dialog hidden`);
  const feedback = await evaluate(window, `(() => ({ alert: !!document.querySelector('[role="alert"]'), text: document.body.textContent }))()`);
  assert.equal(feedback.alert, false, `${label} has no error UI`);
  assert.equal(feedback.text.trim(), '', `${label} leaves no feedback text`);
}
function writeCapture(filename, text, turnId) {
  fs.writeFileSync(path.join(dataDir, 'captures', filename), JSON.stringify({
    text, turnId, capturedAt: new Date().toISOString(), sha256: digest(text), copySha256: digest(normalize(text)),
  }));
}
function recordImage(image, file) { fs.writeFileSync(file, image.toPNG()); }
function registerTempCleanup() {
  if (tempCleanupRegistered) return;
  electron.app.on('will-quit', () => fs.rmSync(tempDir, { recursive: true, force: true }));
  tempCleanupRegistered = true;
}
function alphaBounds(image) {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  assert.equal(pixels.length, width * height * 4, 'PNG bitmap dimensions match its decoded size');
  let left = width, top = height, right = -1, bottom = -1, occupied = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3] === 0) continue;
    occupied += 1; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return { width, height, left, top, right, bottom, occupancy: occupied / (width * height) };
}
function assertOpaqueWhiteAppIcon(nativeImage) {
  const icon = nativeImage.createFromPath(path.join(root, 'assets/app-icon.png'));
  assert.equal(icon.isEmpty(), false);
  const { width, height } = icon.getSize();
  const pixels = icon.toBitmap();
  assert.equal(pixels.length, width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
  assert.equal(pixels[offset + 3], 255, 'app icon PNG is fully opaque');
  }
  for (const offset of [0, (width - 1) * 4, (height * width - width) * 4, pixels.length - 4]) {
    assert.ok([...pixels.subarray(offset, offset + 3)].every((channel) => channel >= 250), 'app icon corners are white');
    assert.equal(pixels[offset + 3], 255, 'app icon corners are opaque');
  }
  return { width, height };
}

async function run() {
  withMockElectron();
  const runtimeCalls = stubRuntimeAndClipboard();
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });
  fs.mkdirSync(path.join(dataDir, 'captures'), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ reviewMarker: 'retained' }));
  fs.writeFileSync(path.join(dataDir, 'captures', 'synthetic.json'), JSON.stringify({
    text: body, turnId: 'desktop-regression', capturedAt: new Date().toISOString(),
    sha256: digest(body), copySha256: digest(normalize(body)),
  }));
  const { start } = require('../src/main/main.cjs');
  const lark = {
    authStatus: async () => ({ status: 'logged-out' }), saveConfig: async () => ({}),
    login: async () => ({ status: 'pending' }), logout: async () => ({}),
    searchContacts: async (query) => query === 'synthetic' ? [{ openId: 'ou_test1', name: '合成联系人', department: '本地测试' }] : [],
    searchChats: async () => [],
    send: (payload, key) => new Promise((resolve, reject) => sendRequests.push({ payload, key, resolve, reject })),
    dispose() {},
  };
  const shownRecords = [];
  const mainResult = await start({ dataDir, logDir, lark, onShare(current) { shownRecords.push(current.record.text); } });
  registerTempCleanup();
  const settings = mainResult.settingsWindow;
  const share = mainResult.shareWindow;
  assert.equal(runtimeCalls(), 1, 'normal startup updates the local runtime through its stub');
  assert.equal(mainResult.state.desktop.hideDock, true, 'Dock hiding defaults to enabled');
  assert.equal(mainResult.state.desktop.openAtLogin, false, 'login startup defaults to disabled');
  assert.equal(mainResult.state.desktop.loginAvailable, !development, 'login setting follows packaged macOS availability');
  assert.deepEqual(activationPolicies, ['accessory'], 'hidden Dock applies accessory activation at startup');
  if (development) assert.equal(loginCalls.get, 0, 'development avoids the system login-item API');
  else assert.ok(loginCalls.get > 0, 'packaged app reads login-item state');
  assert.equal(settings.isVisible(), scenario !== 'login-startup', 'an unconfigured login launch remains silent');
  assert.equal(share.isVisible(), false);

  if (scenario === 'login-startup') {
    assert.ok(fs.readFileSync(path.join(logDir, 'app.jsonl'), 'utf8').includes('"openedAtLogin":true'));
    assert.equal(fs.readFileSync(path.join(logDir, 'app.jsonl'), 'utf8').includes('settings_opened'), false);
    return { runtimeCalls: runtimeCalls(), silent: true };
  }

  await waitForDom(settings, "document.querySelector('#hide-dock') && document.querySelector('#open-at-login')", 'settings rendered');
  const settingsFacts = await evaluate(settings, `(() => {
    const cards = [...document.querySelectorAll('.settings-card')];
    const modules = document.querySelector('.settings-modules');
    return {
      size: { width: innerWidth, height: innerHeight }, columns: getComputedStyle(modules).gridTemplateColumns.split(' ').length,
      bodyScroll: document.body.scrollHeight > document.body.clientHeight,
      mainScroll: document.querySelector('main.settings-page').scrollHeight > document.querySelector('main.settings-page').clientHeight,
      cardCount: cards.length, hideDock: document.querySelector('#hide-dock').checked,
      openAtLogin: document.querySelector('#open-at-login').checked, loginDisabled: document.querySelector('#open-at-login').disabled,
      status: document.querySelector('#login-item-status').textContent.trim(),
    };
  })()`);
  assert.deepEqual({ width: settings.getBounds().width, height: settings.getBounds().height }, { width: 1180, height: 850 });
  assert.equal(settingsFacts.size.width, 1180);
  assert.equal(settingsFacts.columns, 3);
  assert.equal(settingsFacts.bodyScroll, false);
  assert.equal(settingsFacts.mainScroll, false);
  assert.equal(settingsFacts.cardCount, 3);
  assert.equal(settingsFacts.hideDock, true);
  assert.equal(settingsFacts.openAtLogin, false);
  assert.equal(settingsFacts.loginDisabled, development);
  if (!development) assert.equal(settingsFacts.status, '已关闭', 'missing macOS status falls back to not-registered');
  if (scenario === 'packaged') recordImage(await settings.capturePage(), settingsShot);

  assert.match(await ipcError(settings, 'setHideDock', 'true'), /程序坞设置无效/, 'Dock IPC rejects non-boolean input');
  assert.match(await ipcError(settings, 'setOpenAtLogin', 1), /登录自启设置无效/, 'login IPC rejects non-boolean input');
  const wrongSender = await ipcError(share, 'setHideDock', false);
  assert.match(wrongSender, /设置窗口操作/, 'share renderer cannot change settings');

  await click(settings, '#hide-dock');
  await waitFor(() => mainResult.state.desktop.hideDock === false, 'Dock setting saved');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { reviewMarker: 'retained', hideDock: false });
  assert.equal(mainResult.state.desktop.openAtLogin, false, 'Dock changes leave login setting untouched');
  assert.equal(loginCalls.set.length, 0);
  await waitForDom(settings, '!document.querySelector("#hide-dock").disabled', 'Dock setting action finished');
  settings.hide();
  electron.app.emit('activate', {}, false);
  await waitFor(() => settings.isVisible(), 'regular activation opens settings');
  await click(settings, '#hide-dock');
  await waitFor(() => mainResult.state.desktop.hideDock === true, 'Dock setting restored');
  assert.deepEqual(activationPolicies, ['accessory', 'regular', 'accessory']);
  await waitForDom(settings, '!document.querySelector("#hide-dock").disabled', 'settings action finished');

  if (development) {
    assert.match(await ipcError(settings, 'setOpenAtLogin', true), /安装正式 App/);
    await evaluate(settings, 'window.electron.openLoginSettings()');
    await wait(50);
    assert.equal(loginCalls.get, 0);
    assert.equal(loginCalls.set.length, 0);
    assert.equal(externalUrls.length, 0);
    assert.equal(settingsFacts.loginDisabled, true);
    return { runtimeCalls: runtimeCalls(), loginUnavailable: true };
  }

  await click(settings, '#open-at-login');
  await waitFor(() => mainResult.state.desktop.loginStatus === 'requires-approval', 'approval status read from mock OS');
  assert.equal(mainResult.state.desktop.openAtLogin, true);
  assert.deepEqual(loginCalls.set, [{ openAtLogin: true }]);
  await waitForDom(settings, "document.querySelector('#login-item-status').textContent.includes('等待 macOS 允许')", 'approval notice');
  await waitForDom(settings, '!document.querySelector("#open-at-login").disabled', 'login setting action finished');
  await clickText(settings, '打开 macOS 登录项设置');
  await waitFor(() => externalUrls.includes('x-apple.systempreferences:com.apple.LoginItems-Settings.extension'), 'mock login settings opened');
  loginSettings = { openAtLogin: true, wasOpenedAtLogin: false };
  settings.emit('focus');
  await waitFor(() => mainResult.state.desktop.loginStatus === 'enabled', 'focus refreshes missing status from mock OS');
  assert.equal(mainResult.state.desktop.openAtLogin, true);
  await waitForDom(settings, "document.querySelector('#login-item-status').textContent.includes('已开启')", 'enabled status refreshed');
  await waitForDom(settings, '!document.querySelector("#open-at-login").disabled', 'focus refresh completed');
  await click(settings, '#open-at-login');
  await waitFor(() => mainResult.state.desktop.loginStatus === 'not-registered', 'login startup disabled');
  assert.equal(mainResult.state.desktop.openAtLogin, false);
  assert.deepEqual(loginCalls.set, [{ openAtLogin: true }, { openAtLogin: false }]);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hideDock, true, 'login setting does not rewrite saved Dock setting');
  const policyCountBeforeShare = activationPolicies.length;
  assert.equal(dockCalls.show, 0, 'showing settings does not call Dock.show');

  watcher.onEvent({ foreground: 'com.openai.codex', text: body, sequence: 1 });
  await waitFor(() => share.isVisible(), 'share window shown');
  await waitForDom(share, "document.querySelector('#lark-share-dialog-title')", 'share content rendered');
  await waitForDom(share, "document.querySelector('#lark-share-recipient-search')", 'share controls ready');
  assert.equal(settings.isVisible(), false, 'sharing hides settings');
  if (scenario === 'packaged') recordImage(await share.capturePage(), shareShot);
  const shareFacts = await evaluate(share, `(() => {
    const card = document.querySelector('[role="dialog"][aria-labelledby="lark-share-dialog-title"]');
    const rect = card.getBoundingClientRect();
    return {
      width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight, background: getComputedStyle(card).backgroundColor,
      overlayCount: document.querySelectorAll('[data-app-modal-overlay="true"]').length,
      extraXCount: document.querySelectorAll('button[aria-label*="关闭"], button[aria-label="清空搜索"]').length,
      searchHeight: document.querySelector('#lark-share-recipient-search').getBoundingClientRect().height,
    };
  })()`);
  assert.ok(Math.abs(shareFacts.left) <= 1 && Math.abs(shareFacts.top) <= 1
    && Math.abs(shareFacts.right - shareFacts.viewportWidth) <= 1
    && Math.abs(shareFacts.bottom - shareFacts.viewportHeight) <= 1, 'white share content fills the native window');
  assert.equal(shareFacts.width, 600);
  assert.equal(shareFacts.background, 'rgb(255, 255, 255)');
  assert.equal(shareFacts.overlayCount, 0);
  assert.equal(shareFacts.extraXCount, 0);
  assert.equal(shareFacts.searchHeight, 40);
  await clickText(share, '取消');
  await waitFor(() => !share.isVisible(), 'cancel closes share');
  assert.equal(settings.isVisible(), false, 'cancel does not restore settings');

  watcher.onEvent({ foreground: 'com.openai.codex', text: body, sequence: 2 });
  await waitFor(() => share.isVisible(), 'second share shown');
  await setSearch(share, 'synthetic');
  await waitForDom(share, "document.querySelector('#lark-share-recipient-results').textContent.includes('合成联系人')", 'mock contact search');
  await click(share, 'input[aria-label="选择合成联系人"]');
  await clickText(share, '确认');
  await waitFor(() => sendRequests.length === 1, 'mock send called');
  await waitFor(() => !share.isVisible(), 'share window hides while send is pending');
  await assertNoShareFeedback(share, 'pending send');
  assert.equal(settings.isVisible(), false, 'pending send leaves settings hidden');
  assert.equal(sendRequests[0].payload.text, body);
  assert.deepEqual({ kind: sendRequests[0].payload.recipient.kind, id: sendRequests[0].payload.recipient.id }, { kind: 'user', id: 'ou_test1' });
  assert.equal(typeof sendRequests[0].key, 'string');
  assert.ok(sendRequests[0].key.length > 0);

  const sharesBeforeBusyCopy = shownRecords.length;
  const busyCopyBody = '发送期间复制的另一条合成回复。';
  writeCapture('busy-copy.json', busyCopyBody, 'desktop-regression-busy-copy');
  mainResult.index.load('busy-copy.json');
  watcher.onEvent({ foreground: 'com.openai.codex', text: busyCopyBody, sequence: 3 });
  const duplicate = await ipcError(share, 'sendLarkShareMessage', { recipient: { kind: 'user', id: 'ou_test1' }, text: body });
  assert.match(duplicate, /待发消息已变化/);
  assert.equal(sendRequests.length, 1, 'a repeated IPC call does not start another send');
  assert.equal(shownRecords.length, sharesBeforeBusyCopy, 'a copy during send does not replace the active message');
  assert.equal(mainResult.matcher.busy, true, 'matcher remains locked until the send finishes');
  assert.equal(share.isVisible(), false, 'copy during send does not reopen the window');

  const syntheticToken = 'access_token=synthetic-send-token';
  sendRequests[0].reject(new Error(`synthetic send failure: ${body} ${syntheticToken}`));
  await waitForLogEvent('send_finished');
  await assertNoShareFeedback(share, 'failed send');
  assert.equal(settings.isVisible(), false, 'failed send leaves settings hidden');
  assert.equal(mainResult.matcher.busy, false, 'failed send releases the matcher');
  assert.equal(share.isVisible(), false, 'failed send remains hidden after completion');
  assert.equal(shownRecords.length, sharesBeforeBusyCopy, 'copy during send remains discarded after completion');
  const failedSend = mainLogEntries().find((entry) => entry.event === 'send_failed');
  assert.ok(failedSend?.reason.includes('synthetic send failure'), 'failure log keeps a safe reason');
  assert.equal(JSON.stringify(failedSend).includes(body), false, 'failure log excludes the message body');
  assert.equal(JSON.stringify(failedSend).includes(syntheticToken), false, 'failure log excludes the token');

  watcher.onEvent({ foreground: 'com.openai.codex', text: body, sequence: 4 });
  await waitFor(() => share.isVisible(), 'new share shown after failed send');
  assert.equal(shownRecords.at(-1), body, 'the next copy opens the original captured message');
  await setSearch(share, 'synthetic');
  await waitForDom(share, "document.querySelector('#lark-share-recipient-results').textContent.includes('合成联系人')", 'new share contact search');
  await click(share, 'input[aria-label="选择合成联系人"]');
  await clickText(share, '确认');
  await waitFor(() => sendRequests.length === 2, 'mock send after failed send');
  await waitFor(() => !share.isVisible(), 'share window hides while second send is pending');
  assert.equal(sendRequests[1].payload.text, body);
  assert.ok(sendRequests[1].key !== sendRequests[0].key, 'a new share gets a new idempotency key');
  sendRequests[1].resolve({ messageId: 'synthetic-message-id' });
  await waitForLogEvent('send_finished', 2);
  await assertNoShareFeedback(share, 'successful send');
  assert.equal(settings.isVisible(), false, 'success leaves settings hidden');

  watcher.onEvent({ foreground: 'com.openai.codex', text: body, sequence: 5 });
  await waitFor(() => share.isVisible(), 'share shown for invalid recipient check');
  const invalidRecipient = await ipcError(share, 'sendLarkShareMessage', { recipient: { kind: 'user', id: 'invalid' }, text: body });
  assert.match(invalidRecipient, /接收对象无效/);
  await waitFor(() => !share.isVisible(), 'invalid recipient hides share');
  await assertNoShareFeedback(share, 'invalid recipient');
  await waitForLogEvent('send_finished', 3);
  assert.ok(mainLogEntries().some((entry) => entry.event === 'send_rejected' && entry.code === 'invalid_recipient'), 'invalid recipient is logged');
  assert.equal(mainResult.matcher.busy, false, 'invalid recipient releases the matcher');
  assert.equal(sendRequests.length, 2, 'invalid recipient never reaches Lark send');

  const tooLongBody = '长'.repeat(24001);
  writeCapture('send-too-long.json', tooLongBody, 'desktop-regression-too-long');
  mainResult.index.load('send-too-long.json');
  watcher.onEvent({ foreground: 'com.openai.codex', text: tooLongBody, sequence: 6 });
  await waitFor(() => share.isVisible(), 'share shown for message length check');
  const tooLong = await ipcError(share, 'sendLarkShareMessage', { recipient: { kind: 'user', id: 'ou_test1' }, text: tooLongBody });
  assert.match(tooLong, /超过 24,000 个字符/);
  await waitFor(() => !share.isVisible(), 'oversized message hides share');
  await assertNoShareFeedback(share, 'oversized message');
  await waitForLogEvent('send_finished', 4);
  assert.ok(mainLogEntries().some((entry) => entry.event === 'send_rejected' && entry.code === 'message_too_long'), 'oversized message is logged');
  assert.equal(mainResult.matcher.busy, false, 'oversized message releases the matcher');
  assert.equal(sendRequests.length, 2, 'oversized message never reaches Lark send');

  watcher.onEvent({ foreground: 'com.openai.codex', text: body, sequence: 7 });
  await waitFor(() => share.isVisible(), 'a later copy works after validation failures');
  await clickText(share, '取消');
  await waitFor(() => !share.isVisible(), 'final share can still be canceled');
  assert.equal(activationPolicies.length, policyCountBeforeShare, 'opening windows never changes Dock policy');
  assert.equal(dockCalls.show, 0);

  const mainLog = fs.readFileSync(path.join(logDir, 'app.jsonl'), 'utf8');
  assert.equal(mainLog.includes(body), false, 'application log excludes the message body');
  assert.equal(mainLog.includes(busyCopyBody), false, 'application log excludes the busy copied body');
  assert.equal(mainLog.includes(tooLongBody), false, 'application log excludes the oversized body');
  assert.equal(mainLog.includes(syntheticToken), false, 'application log excludes the token');
  const nativeImage = electron.nativeImage;
  const appIconSize = assertOpaqueWhiteAppIcon(nativeImage);
  const tray1File = path.join(root, 'assets/tray-iconTemplate.png');
  const tray2File = path.join(root, 'assets/tray-iconTemplate@2x.png');
  const tray1Image = nativeImage.createFromBuffer(fs.readFileSync(tray1File), { scaleFactor: 1 });
  const tray2Image = nativeImage.createFromBuffer(fs.readFileSync(tray2File), { scaleFactor: 1 });
  const tray1 = alphaBounds(tray1Image);
  const tray2 = alphaBounds(tray2Image);
  assert.deepEqual({ width: tray2.width, height: tray2.height }, { width: tray1.width * 2, height: tray1.height * 2 }, 'Retina template PNG dimensions double the 1x file');
  const tray1Bounds = { width: tray1.right - tray1.left + 1, height: tray1.bottom - tray1.top + 1 };
  const tray2Bounds = { width: tray2.right - tray2.left + 1, height: tray2.bottom - tray2.top + 1 };
  assert.ok(Math.abs(tray2Bounds.width - tray1Bounds.width * 2) <= 2 && Math.abs(tray2Bounds.height - tray1Bounds.height * 2) <= 2, 'template content keeps its occupied area at Retina scale');
  assert.ok(Math.abs(tray1.occupancy - tray2.occupancy) < 0.04, '1x and 2x template occupancy stays consistent');
  assert.deepEqual(trayImages.length, 1);
  assert.deepEqual(trayImages[0].getScaleFactors().sort(), [1, 2], 'menu bar icon registers 1x and Retina representations');
  assert.equal(trayImages[0].isTemplateImage(), true);
  assert.equal(dockCalls.setIcon, 1);
  assert.equal(watcher.closed, false, 'watcher remains active until app shutdown');
  return {
    runtimeCalls: runtimeCalls(), settingsFacts, shareFacts, appIconSize,
    tray1: { width: tray1.width, height: tray1.height, occupiedWidth: tray1Bounds.width, occupiedHeight: tray1Bounds.height },
    tray2: { width: tray2.width, height: tray2.height, occupiedWidth: tray2Bounds.width, occupiedHeight: tray2Bounds.height },
    settingsScreenshot: settingsShot, shareScreenshot: shareShot,
  };
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify({ scenario, ...result }, null, 2)}\n`);
  electron.app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  registerTempCleanup();
  electron.app.once('will-quit', () => electron.app.exit(1));
  electron.app.quit();
});
