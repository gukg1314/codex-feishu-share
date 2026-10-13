const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { app, clipboard, nativeImage } = require('electron');

if (!process.versions.electron) {
  process.stderr.write('请从工程目录运行：npx electron tests/window-benchmark.cjs\n');
  process.exitCode = 2;
} else {
  const project = path.resolve(__dirname, '..');
  app.getAppPath = () => project;
  const appVersion = require(path.join(project, 'package.json')).version;
  app.getVersion = () => appVersion;
  const hookPath = path.join(project, 'hook/capture-hook.cjs');
  const fixturePathArg = process.argv.indexOf('--fixture');
  const fixturePath = path.resolve(project, fixturePathArg >= 0 ? process.argv[fixturePathArg + 1] : '../feishu/codex-share-verification/runtime/captures');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-window-'));
  const dataDir = path.join(tempDir, 'app-data');
  const logDir = path.join(tempDir, 'logs');
  const syntheticAppId = 'cli_benchmark_only';
  const syntheticAppSecret = 'synthetic-secret-for-ui';
  const syntheticAuthUrl = 'https://mock.feishu.example/authorize?synthetic=1';
  const settingsScreenshot = path.join(os.tmpdir(), `codex-feishu-settings-${process.pid}.png`);
  const affectedOnly = process.argv.includes('--affected-only');
  const summary = {
    benchmarkMode: affectedOnly
      ? 'real Electron BrowserWindow UI and clipboard recovery checks; timing samples skipped'
      : 'real Electron BrowserWindow + real macOS pasteboard + 25ms JXA observer',
    version: appVersion,
    foreground: 'benchmark adapter forces com.openai.codex; real foreground recognition not tested',
    paintMeasure: 'clipboard writer start to visible + renderer double requestAnimationFrame callback; not compositor pixels or mouse-click latency',
    ui: { mockOnly: true, network: false, credentials: false },
    samples: [],
    failures: [],
  };
  let originalClipboard;
  let clipboardReadError;
  let restoreClipboard;
  let cleanupStarted = false;
  let mainResult;
  let activeRender;
  let shareIds = [];
  let sendRequests = [];
  let authStatusCalls = 0;
  let appExitCode = 0;
  let finalizing = false;

  function snapshotClipboard() {
    try {
      const formats = clipboard.availableFormats();
      const textFormats = ['text/plain', 'public.utf8-plain-text', 'NSStringPboardType'];
      const htmlFormats = ['text/html', 'public.html', 'Apple HTML pasteboard type'];
      const imageFormats = ['image/png', 'public.png', 'Apple PNG pasteboard type', 'public.tiff', 'NeXT TIFF v4.0 pasteboard type', 'NSTIFFPboardType'];
      if (formats.some((format) => htmlFormats.includes(format))) {
        throw new Error('剪贴板 HTML 暂不支持基准：Electron macOS 写入会添加 charset 前缀，无法严格恢复');
      }
      const unsupported = formats.filter((format) => ![...textFormats, ...imageFormats].includes(format));
      if (unsupported.length) throw new Error(`无法安全恢复剪贴板格式：${unsupported.join(', ')}`);
      const data = {};
      if (formats.some((format) => textFormats.includes(format))) data.text = clipboard.readText();
      if (formats.some((format) => imageFormats.includes(format))) data.image = clipboard.readImage();
      if (data.image?.isEmpty()) throw new Error('剪贴板图片无法保存在内存中');
      originalClipboard = { formats, data };
      summary.clipboard = { originalFormats: formats };
    } catch (error) {
      clipboardReadError = error.code || error.message;
      summary.clipboard = { snapshot: `failed: ${clipboardReadError}` };
    }
  }

  app.on('before-quit', (event) => {
    if (!cleanupStarted || finalizing) return;
    event.preventDefault();
    finalizing = true;
    void (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (restoreClipboard && originalClipboard !== undefined) {
        try {
          if (Object.keys(originalClipboard.data).length) clipboard.write(originalClipboard.data);
          else clipboard.clear();
          const restoredFormats = clipboard.availableFormats();
          if (originalClipboard.data.text !== undefined && clipboard.readText() !== originalClipboard.data.text) throw new Error('剪贴板文本未恢复');
          const image = originalClipboard.data.image;
          let imageSize, imagePixelsMatch;
          if (image) {
            const restored = clipboard.readImage();
            imageSize = image.getSize();
            imagePixelsMatch = imageSize.width === restored.getSize().width && imageSize.height === restored.getSize().height && image.toBitmap().equals(restored.toBitmap());
            if (!imagePixelsMatch) throw new Error('剪贴板图片像素未恢复');
          }
          summary.clipboard = { originalFormats: originalClipboard.formats, restoredFormats, imageSize, imagePixelsMatch, restore: 'restored from memory' };
        } catch (error) {
          summary.clipboard = { restore: `failed: ${error.code || error.message}` };
          summary.failures.push(`clipboard_restore: ${error.code || error.message}`);
        }
      } else if (!summary.clipboard) summary.clipboard = { restore: 'not needed; no clipboard write completed' };
      try { fs.rmSync(tempDir, { recursive: true, force: true }); }
      catch (error) { summary.failures.push(`temp_cleanup: ${error.code || error.message}`); }
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      app.exit(appExitCode || (summary.failures.length ? 1 : 0));
    })();
  });

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function fail(label, error) {
    summary.failures.push(`${label}: ${error.code || error.message || String(error)}`);
  }
  function runHook(text, turnId = randomUUID()) {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [hookPath, '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 || !output.includes('{}')) return reject(new Error(`hook_exit_${code}: ${stderr.slice(0, 200)}`));
        const record = fs.readdirSync(path.join(dataDir, 'captures'))
          .map((file) => JSON.parse(fs.readFileSync(path.join(dataDir, 'captures', file), 'utf8')))
          .find((item) => item.turnId === turnId);
        if (!record || record.text !== text) return reject(new Error('hook_capture_missing_or_changed'));
        resolve(record);
      });
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'window-benchmark', turn_id: turnId, last_assistant_message: text }));
    });
  }
  function writeClipboard(value) {
    const startedAt = performance.now();
    clipboard.writeText(value);
    return startedAt;
  }
  function addFixture() {
    const files = fs.statSync(fixturePath).isDirectory()
      ? fs.readdirSync(fixturePath).filter((file) => file.endsWith('.json')).map((file) => path.join(fixturePath, file))
      : [fixturePath];
    const records = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    const fixture = records.find((record) => record.copySha256 === '169afc349b667727f3f923a7a6fae64952bdd056db35a25d2aad7e91ec08ca3c')
      || records.sort((a, b) => b.text.length - a.text.length)[0];
    assert.ok(fixture && typeof fixture.text === 'string' && fixture.text.length >= 100, '本地验证 fixture 可读');
    return fixture.text;
  }
  function mockLark() {
    return {
      authStatus: async () => { authStatusCalls += 1; return { status: 'logged-out' }; },
      saveConfig: async () => ({}), login: async () => ({ status: 'pending', url: syntheticAuthUrl }), logout: async () => ({}),
      searchContacts: async (query) => {
        if (query === 'old') { await wait(900); return [{ openId: 'ou_old', name: 'Old Person', department: '测试' }]; }
        if (query === 'new') { await wait(30); return [
          { openId: 'ou_fresh1', name: 'Fresh Person', department: '测试' },
          { openId: 'ou_fresh2', name: 'Second Person', department: '测试' },
        ]; }
        return [];
      },
      searchChats: async (query) => query === 'new'
        ? [{ kind: 'chat', id: 'oc_mock1', name: '模拟群聊', detail: '3 人' }]
        : [],
      send: (payload, key) => new Promise((resolve, reject) => sendRequests.push({ payload, key, resolve, reject })),
      dispose() {},
    };
  }
  function renderPromise(timeoutMs = 3000) {
    let timer;
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('render_timeout')), timeoutMs);
      activeRender = (result) => { clearTimeout(timer); resolve({ result, renderedAt: performance.now() }); };
    });
    return promise.finally(() => { activeRender = null; });
  }
  async function renderedClipboardWrite(text, afterWrite) {
    const rendered = renderPromise();
    restoreClipboard = true;
    try {
      const startedAt = await writeClipboard(text);
      await afterWrite?.();
      const paint = await rendered;
      return { ...paint, startedAt };
    } catch (error) {
      activeRender = null;
      rendered.catch(() => {});
      throw error;
    }
  }
  async function evaluate(js) { return mainResult.shareWindow.webContents.executeJavaScript(js, true); }
  async function waitLogEvent(event, count) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const file = path.join(logDir, 'app.jsonl');
      const entries = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      if (entries.filter((entry) => entry.event === event).length >= count) return;
      await wait(25);
    }
    throw new Error(`log_timeout:${event}`);
  }
  async function assertNoShareFeedback(label) {
    const hiddenDeadline = Date.now() + 3000;
    while (mainResult.shareWindow.isVisible() && Date.now() < hiddenDeadline) await wait(25);
    assert.equal(mainResult.shareWindow.isVisible(), false, `${label}: share window is hidden`);
    await waitDom("!document.querySelector('[role=dialog]')", `${label}: share dialog unmounted`);
    const feedback = await evaluate("({ alert: !!document.querySelector('[role=alert]'), text: document.body.textContent })");
    assert.equal(feedback.alert, false, `${label}: no error UI`);
    assert.equal(feedback.text.trim(), '', `${label}: no feedback text`);
  }
  async function waitDom(condition, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`(() => (${condition}))()`)) return;
      await wait(25);
    }
    throw new Error(`ui_timeout:${label}`);
  }
  async function setSearch(value) {
    return evaluate(`(() => { const input = document.querySelector('#lark-share-recipient-search'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  async function clickRecipient(name) {
    return evaluate(`document.querySelector('input[aria-label="选择${name}"]').click()`);
  }
  async function clickTab(name) {
    return evaluate(`Array.from(document.querySelectorAll('button[role="tab"]')).find((button) => button.textContent.trim() === ${JSON.stringify(name)}).click()`);
  }
  async function measureSample(kind, text, lateHook) {
    try {
      mainResult.hideShare();
      const paintPromise = renderedClipboardWrite(text, lateHook);
      const paint = await paintPromise;
      assert.equal(paint.result.visible, true, 'share window is visible at renderer callback');
      const durationMs = paint.renderedAt - paint.startedAt;
      summary.samples.push({ kind, durationMs: Number(durationMs.toFixed(2)), cacheWaitMs: Number(paint.result.cacheWaitMs.toFixed(2)), detectToPaintMs: Number(paint.result.detectToPaintMs.toFixed(2)), visible: true });
      mainResult.hideShare();
    } catch (error) {
      fail(`sample_${summary.samples.length + 1}_${kind}`, error);
      summary.samples.push({ kind, error: error.code || error.message });
      mainResult.hideShare();
      await wait(550);
    }
  }
  async function runUiChecks(fixtureText) {
    const first = await renderedClipboardWrite(fixtureText);
    const firstId = shareIds.at(-1);
    try {
      const facts = await evaluate(`(() => { const card = document.querySelector('[role="dialog"][aria-labelledby="lark-share-dialog-title"]'); const tabs = [...document.querySelectorAll('button[role="tab"]')]; const search = document.querySelector('#lark-share-recipient-search'); const results = document.querySelector('#lark-share-recipient-results'); const rect = card.getBoundingClientRect(); return { width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, background: getComputedStyle(card).backgroundColor, overlayCount: document.querySelectorAll('[data-app-modal-overlay="true"]').length, closeButtonCount: document.querySelectorAll('button[aria-label*="关闭"], button[aria-label="清空搜索"]').length, radius: getComputedStyle(card).borderTopLeftRadius, defaultTab: tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent.trim(), searchHeight: search.getBoundingClientRect().height, resultHeight: results.getBoundingClientRect().height }; })()`);
      assert.equal(facts.width, 600, '分享卡片最大宽度为 600 CSS px');
      assert.ok(Math.abs(facts.left) <= 1 && Math.abs(facts.top) <= 1
        && Math.abs(facts.right - facts.viewportWidth) <= 1
        && Math.abs(facts.bottom - facts.viewportHeight) <= 1, '白底内容铺满窗口且没有外部缝隙');
      assert.equal(facts.background, 'rgb(255, 255, 255)', '分享内容使用纯白背景');
      assert.equal(facts.overlayCount, 0, '分享窗口没有覆盖层');
      assert.equal(facts.closeButtonCount, 0, '空搜索时没有多余的 X 按钮');
      assert.equal(facts.radius, '0px', '分享卡片边缘没有圆角缝隙');
      assert.equal(facts.defaultTab, '人员', '每次新分享默认人员页');
      assert.equal(facts.searchHeight, 40, '搜索框高度为 40px');
      assert.ok(facts.resultHeight >= 240 && facts.resultHeight <= 410, '结果区高度在 240–410px');

      await setSearch('old'); await wait(220); await setSearch('new');
      await waitDom("document.querySelector('#lark-share-recipient-results').textContent.includes('Fresh Person')", 'latest search results');
      await wait(950);
      assert.equal(await evaluate("document.querySelector('#lark-share-recipient-results').textContent.includes('Old Person')"), false, '旧搜索结果不能覆盖新结果');
      await clickRecipient('Fresh Person');
      await clickRecipient('Second Person');
      await waitDom("document.querySelectorAll('#lark-share-recipient-results input[type=checkbox]:checked').length === 1", 'single recipient selection');
      assert.equal(await evaluate("document.body.textContent.includes('已选择：1 个')"), true, '只能保留一个选中项');
      await clickTab('群聊');
      await waitDom("document.querySelector('button[role=tab][aria-selected=true]').textContent.includes('群聊')", 'chat tab');
      assert.equal(await evaluate("document.body.textContent.includes('已选择：0 个')"), true, '切换 Tab 清空选择');
      await clickRecipient('模拟群聊');
      await waitDom("document.body.textContent.includes('已选择：1 个')", 'chat selection');
      await clickTab('人员');
      await waitDom("document.body.textContent.includes('已选择：0 个')", 'selection clears on tab switch');
      await clickRecipient('Fresh Person');
      await waitDom("document.body.textContent.includes('已选择：1 个')", 'select send recipient');

      await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === '确认').click()");
      await assertNoShareFeedback('pending send');
      assert.equal(sendRequests.length, 1, 'mock send invoked once');
      assert.equal(sendRequests[0].payload.text, fixtureText, 'send uses the captured body');
      assert.deepEqual({ kind: sendRequests[0].payload.recipient.kind, id: sendRequests[0].payload.recipient.id }, { kind: 'user', id: 'ou_fresh1' });
      sendRequests[0].reject(new Error('模拟发送失败'));
      await waitLogEvent('send_finished', 1);
      await assertNoShareFeedback('failed send');

      const second = await renderedClipboardWrite(fixtureText);
      assert.notEqual(shareIds.at(-1), firstId, 'a new copy gets a new share ID after failure');
      const reset = await evaluate("({ query: document.querySelector('#lark-share-recipient-search').value, tab: document.querySelector('button[role=tab][aria-selected=true]').textContent.trim(), selected: document.body.textContent.includes('已选择：0 个') })");
      assert.deepEqual(reset, { query: '', tab: '人员', selected: true }, 'new share resets search, tab, and selection');
      await setSearch('new');
      await waitDom("document.querySelector('#lark-share-recipient-results').textContent.includes('Fresh Person')", 'recipient search after failure');
      await clickRecipient('Fresh Person');
      await waitDom("document.body.textContent.includes('已选择：1 个')", 'select recipient after failure');
      await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === '确认').click()");
      await assertNoShareFeedback('pending successful send');
      assert.equal(sendRequests.length, 2, 'new share can start a send after failure');
      assert.equal(sendRequests[1].payload.text, fixtureText, 'new send uses the captured body');
      sendRequests[1].resolve({ messageId: 'mock-message-id' });
      await waitLogEvent('send_finished', 2);
      await assertNoShareFeedback('successful send');
      summary.ui = { mockOnly: true, network: false, credentials: false, mockSendCalls: sendRequests.length, authStatusCalls };
      mainResult.hideShare();
      void first; void second;
    } catch (error) {
      fail('ui_checks', error);
      mainResult.hideShare();
    }
  }

  async function runSettingsChecks() {
    const window = mainResult.settingsWindow;
    const settingsConsole = [];
    window.webContents.on('console-message', (event, _level, message) => {
      const text = typeof message === 'string' ? message : event?.message;
      if (typeof text === 'string') settingsConsole.push(text);
    });
    window.show();
    const evaluateSettings = (js) => window.webContents.executeJavaScript(js, true);
    const waitSettings = async (condition, label) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (await evaluateSettings(`(() => (${condition}))()`)) return;
        await wait(25);
      }
      throw new Error(`settings_ui_timeout:${label}`);
    };
    await waitSettings("document.querySelector('#app-config-title')", 'initial settings render');
    await evaluateSettings(`(() => { const input = document.querySelector('input[type="password"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(syntheticAppSecret)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluateSettings("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('登录飞书')).click()");
    await waitSettings("document.querySelector('img[alt=\"飞书本人授权二维码\"]')?.naturalWidth === 180 && document.querySelector('[role=status]')", 'pending QR and notice');
    const bounds = window.getBounds();
    assert.deepEqual({ width: bounds.width, height: bounds.height }, { width: 1180, height: 850 }, 'settings window defaults to 1180×850 including the title bar');
    const facts = await evaluateSettings(`(() => {
      const main = document.querySelector('main.settings-page');
      const cards = [...document.querySelectorAll('.settings-card')];
      const save = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存配置');
      const buttons = [...document.querySelectorAll('.settings-card button')];
      const qr = document.querySelector('img[alt="飞书本人授权二维码"]');
      const modules = document.querySelector('.settings-modules');
      const saveRect = save.getBoundingClientRect();
      return {
        title: document.querySelector('h1')?.textContent.trim(),
        cards: cards.map((card) => { const rect = card.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; }),
        columns: getComputedStyle(modules).gridTemplateColumns.split(' ').length,
        bodyScroll: document.body.scrollHeight > document.body.clientHeight,
        mainScroll: main.scrollHeight > main.clientHeight,
        mainBottom: main.getBoundingClientRect().bottom,
        qr: { width: qr?.getBoundingClientRect().width, height: qr?.getBoundingClientRect().height, naturalWidth: qr?.naturalWidth, naturalHeight: qr?.naturalHeight },
        noticeVisible: Boolean(document.querySelector('[role="status"]')?.getClientRects().length),
        saveVisible: saveRect.width > 0 && saveRect.height > 0 && saveRect.top >= 0 && saveRect.bottom <= innerHeight,
        buttonStyles: buttons.map((button) => { const style = getComputedStyle(button); return { background: style.backgroundColor, color: style.color }; }),
      };
    })()`);
    assert.equal(facts.title?.startsWith('codex分享飞书消息'), true);
    assert.equal(facts.cards.length, 3, 'three settings cards render');
    assert.equal(facts.columns, 3, 'three cards render in three side-by-side columns');
    assert.ok(facts.cards.every((card) => card.top === facts.cards[0].top && card.bottom <= facts.mainBottom), 'all three cards stay on the same visible row');
    assert.equal(facts.bodyScroll, false, 'settings body has no vertical scroll');
    assert.equal(facts.mainScroll, false, 'settings main has no vertical scroll');
    assert.deepEqual(facts.qr, { width: 180, height: 180, naturalWidth: 180, naturalHeight: 180 }, 'pending authorization QR remains 180×180');
    assert.equal(facts.noticeVisible, true, 'login notice remains visible with pending authorization');
    assert.equal(facts.saveVisible, true, 'save button remains visible in the first card');
    assert.equal(new Set(facts.buttonStyles.map((style) => style.background)).size, 1, 'settings action buttons use one background color');
    assert.equal(new Set(facts.buttonStyles.map((style) => style.color)).size, 1, 'settings action buttons use one text color');
    assert.notEqual(facts.buttonStyles[0].color, 'rgb(255, 255, 255)', 'settings button text remains visible');
    assert.equal(settingsConsole.some((message) => [syntheticAppId, syntheticAppSecret, syntheticAuthUrl].some((secret) => message.includes(secret))), false, 'settings state and credentials are not logged to the renderer console');
    const appLog = fs.existsSync(path.join(logDir, 'app.jsonl')) ? fs.readFileSync(path.join(logDir, 'app.jsonl'), 'utf8') : '';
    assert.equal([syntheticAppId, syntheticAppSecret, syntheticAuthUrl].some((secret) => appLog.includes(secret)), false, 'settings state and credentials are not logged to the app log');
    const screenshot = await window.capturePage();
    fs.writeFileSync(settingsScreenshot, screenshot.toPNG());
    summary.settings = {
      width: bounds.width, height: bounds.height, cardCount: facts.cards.length, columns: facts.columns,
      bodyScroll: facts.bodyScroll, mainScroll: facts.mainScroll, qrWidth: facts.qr.width, qrHeight: facts.qr.height,
      noticeVisible: facts.noticeVisible, saveVisible: facts.saveVisible,
      buttonColorsMatch: new Set(facts.buttonStyles.map((style) => style.background)).size === 1 && new Set(facts.buttonStyles.map((style) => style.color)).size === 1,
      screenshot: settingsScreenshot,
    };
    mainResult.hideShare();
  }

  async function run() {
    try {
      const fixtureText = addFixture();
      await app.whenReady();
      snapshotClipboard();
      if (clipboardReadError) throw new Error(`clipboard_snapshot_failed:${clipboardReadError}`);
      const longText = `⟦synthetic test body⟧\n# 合成性能正文\n\n${'这是一段仅用于窗口计时的合成 Markdown 正文。\n'.repeat(180)}`;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ appId: syntheticAppId, codexHome: '/tmp/codex-share-benchmark-home' }), { mode: 0o600 });
      await runHook(fixtureText);
      if (!affectedOnly) await runHook(longText);
      const { start } = require('../dist/main/main.cjs');
      mainResult = await start({ dataDir, logDir, benchmark: true, lark: mockLark(),
        onShare(current) { shareIds.push(current.id); },
        onRendered(result) { activeRender?.(result); },
      });
      summary.startup = 'ok';
      assert.equal(mainResult.shareWindow.getTitle(), 'codex分享飞书消息', 'share window title uses the fixed product name');
      assert.equal(mainResult.settingsWindow.getTitle(), 'codex分享飞书消息', 'settings window title uses the fixed product name');
      const iconPaths = {
        app: path.join(project, 'assets/app-icon.png'),
        dock: path.join(project, 'assets/dock-icon.png'),
        tray: path.join(project, 'assets/tray-iconTemplate.png'),
      };
      const icons = Object.fromEntries(Object.entries(iconPaths).map(([name, file]) => [name, nativeImage.createFromPath(file)]));
      for (const [name, icon] of Object.entries(icons)) assert.equal(icon.isEmpty(), false, `${name} icon loads`);
      const traySize = icons.tray.getSize();
      const resizedTray = icons.tray.resize({ height: 18 });
      const trayRatio = traySize.width / traySize.height;
      const resizedTrayRatio = resizedTray.getSize().width / resizedTray.getSize().height;
      assert.ok(Math.abs(trayRatio - resizedTrayRatio) < 0.01, 'tray icon resize preserves source aspect ratio');
      summary.icons = {
        app: icons.app.getSize(), dock: icons.dock.getSize(), tray: traySize, trayResize: resizedTray.getSize(),
        trayAspectRatioPreserved: Math.abs(trayRatio - resizedTrayRatio) < 0.01,
      };
      await wait(50);

      if (affectedOnly) {
        summary.timing = 'skipped with --affected-only';
      } else {
        for (let i = 0; i < 8; i += 1) await measureSample('same-fixture-repeat', fixtureText);
        for (let i = 0; i < 7; i += 1) await measureSample('synthetic-long-body', longText);
        for (let i = 0; i < 5; i += 1) {
          const earlyText = `⟦synthetic early-copy sample ${i + 1}⟧\nHook arrives 60ms after the pasteboard write.`;
          await measureSample('early-copy-hook-late-60ms', earlyText, async () => {
            await wait(60);
            await runHook(earlyText);
          });
        }
        const valid = summary.samples.filter((sample) => Number.isFinite(sample.durationMs));
        const sorted = valid.map((sample) => sample.durationMs).sort((a, b) => a - b);
        summary.timing = {
          expectedSamples: 20, measuredSamples: valid.length,
          p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
          maxMs: sorted.length ? sorted.at(-1) : null,
          allAtMost500Ms: valid.length === 20 && valid.every((sample) => sample.durationMs <= 500),
          cacheWaitMs: summary.samples.map((sample) => sample.cacheWaitMs ?? null),
          byKind: ['same-fixture-repeat', 'synthetic-long-body', 'early-copy-hook-late-60ms'].map((kind) => {
            const group = valid.filter((sample) => sample.kind === kind).map((sample) => sample.durationMs).sort((a, b) => a - b);
            return { kind, count: group.length, p95Ms: group.length ? group[Math.ceil(group.length * 0.95) - 1] : null, maxMs: group.length ? group.at(-1) : null };
          }),
        };
        if (!summary.timing.allAtMost500Ms) fail('timing_threshold', new Error('not all 20 measured samples completed within 500ms'));
      }
      await runUiChecks(fixtureText);
      await runSettingsChecks();
      if (authStatusCalls !== 0) fail('benchmark_auth_guard', new Error(`authStatus called ${authStatusCalls} times`));
      summary.ui.authStatusCalls = authStatusCalls;
    } catch (error) {
      summary.startup ||= 'failed';
      fail('benchmark_run', error);
      appExitCode = 1;
    } finally {
      cleanupStarted = true;
      if (mainResult) mainResult.close(); else app.quit();
    }
  }

  void run();
}
