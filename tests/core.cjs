'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-share-core-'));
const knownFixtureSha256 = '169afc349b667727f3f923a7a6fae64952bdd056db35a25d2aad7e91ec08ca3c';
const syntheticOnly = process.argv.includes('--synthetic');
const fixtureArgument = process.argv.indexOf('--fixture');
const fixturePath = fixtureArgument >= 0
  ? path.resolve(process.argv[fixtureArgument + 1] || '')
  : path.join(root, '../feishu/codex-share-verification/runtime/captures/7a22d0c792415bed62b27c01e357325a1c49d23b3a7d0f4763d5b9b8fbde2c61.json');
const syntheticFixtureText = '**合成测试回复**\n\n|列|值|\n|---|---|\n|中文|保留|\n\n```js\nconst answer = "ok";\n```';
function loadFixture() {
  if (!syntheticOnly && fixtureArgument >= 0 && !fs.existsSync(fixturePath)) throw new Error('指定的 --fixture 文件不存在');
  if (!syntheticOnly && fs.existsSync(fixturePath)) {
    const value = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const text = typeof value.last_assistant_message === 'string' ? value.last_assistant_message : value.text;
    const sha256 = crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
    assert.equal(sha256, knownFixtureSha256, 'real fixture body and known SHA-256 must remain unchanged');
    return { text, sha256, source: 'real' };
  }
  return {
    text: syntheticFixtureText,
    sha256: crypto.createHash('sha256').update(syntheticFixtureText, 'utf8').digest('hex'),
    source: 'synthetic',
  };
}
const fixture = loadFixture();
const fixtureText = fixture.text;
const fixtureEvent = {
  hook_event_name: 'Stop',
  session_id: 'fixture-session',
  turn_id: 'fixture-turn',
  last_assistant_message: fixtureText,
};
const { normalize, digest, createLog } = require(path.join(root, 'src/main/common.cjs'));
const { CaptureIndex, Matcher } = require(path.join(root, 'src/main/captures.cjs'));
const { updateRuntime, installHook } = require(path.join(root, 'src/main/hook.cjs'));
const { createLarkService } = require(path.join(root, 'src/main/lark.cjs'));

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function runHook(dataDir, event) {
  return spawnSync(process.execPath, [path.join(root, 'hook/capture-hook.cjs'), '--data-dir', dataDir], {
    input: JSON.stringify(event), encoding: 'utf8', timeout: 5000,
  });
}

function jsonLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(check, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function main() {
  assert.equal(digest(fixtureText), fixture.sha256);

  const captureData = path.join(tempRoot, 'hook-data');
  const success = runHook(captureData, fixtureEvent);
  assert.equal(success.status, 0);
  assert.equal(success.stdout, '{}\n');
  const capturesDir = path.join(captureData, 'captures');
  let captureFiles = fs.readdirSync(capturesDir).filter((name) => name.endsWith('.json'));
  assert.equal(captureFiles.length, 1);
  const capturePath = path.join(capturesDir, captureFiles[0]);
  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.ok(captured.text === fixtureText, 'Hook preserves the fixture body');
  assert.equal(captured.sha256, fixture.sha256);
  assert.equal(captured.copySha256, digest(normalize(fixtureText)));
  assert.equal(mode(capturesDir), 0o700);
  assert.equal(mode(capturePath), 0o600);

  assert.equal(runHook(captureData, fixtureEvent).stdout, '{}\n');
  assert.equal(runHook(captureData, { ...fixtureEvent, last_assistant_message: 'replacement must not overwrite' }).stdout, '{}\n');
  captureFiles = fs.readdirSync(capturesDir).filter((name) => name.endsWith('.json'));
  assert.equal(captureFiles.length, 1, 'same session-turn must deduplicate');
  assert.ok(JSON.parse(fs.readFileSync(capturePath, 'utf8')).text === fixtureText, 'same session-turn does not overwrite the captured body');
  for (const emptyEvent of [
    { hook_event_name: 'Stop', session_id: 'empty-session', turn_id: 'empty-turn' },
    { ...fixtureEvent, session_id: 'blank-session', turn_id: 'blank-turn', last_assistant_message: ' \r\n\t ' },
  ]) {
    const result = runHook(captureData, emptyEvent);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{}\n');
  }
  const hookLog = fs.readFileSync(path.join(captureData, 'logs/hook.jsonl'), 'utf8');
  assert.equal(mode(path.join(captureData, 'logs/hook.jsonl')), 0o600);
  assert.equal(hookLog.includes(fixtureText), false, 'Hook logs must not contain message bodies');

  assert.equal(normalize(' \r\nA  \r\n\tB \t\n '), 'A  \n\tB');
  const log = () => {};
  const index = new CaptureIndex(capturesDir, log, () => {});
  assert.ok(index.match(fixtureText.replace(/\n/g, '\r\n'))?.text === fixtureText, 'CRLF copy matches the unchanged fixture');
  assert.ok(index.match('partial reply') === undefined, 'partial text does not match');
  assert.ok(index.match('ordinary clipboard text') === undefined, 'ordinary text does not match');
  const internalWhitespaceChange = syntheticOnly
    ? fixtureText.replace(/(\S)(\S)/u, '$1  $2')
    : fixtureText.replace('Codex 自带', 'Codex  自带');
  assert.ok(index.match(internalWhitespaceChange) === undefined, 'internal whitespace is unchanged');

  const matched = [];
  let now = 100;
  const matcher = new Matcher(index, (record, timing) => matched.push({ record, timing }), () => now);
  matcher.observe({ foreground: 'com.openai.codex', text: fixtureText, sequence: 1 });
  assert.equal(matched.length, 1);
  assert.equal(matcher.busy, true);
  now += 10;
  matcher.observe({ foreground: 'com.openai.codex', text: fixtureText, sequence: 2 });
  assert.equal(matched.length, 1, 'busy sharing must freeze the matched message');
  matcher.release();
  now += 10;
  matcher.observe({ foreground: 'com.openai.codex', text: fixtureText, sequence: 3 });
  assert.equal(matched.length, 2, 'a later repeated copy with a new sequence may match');
  assert.equal(matched[1].timing.sequence, 3);
  matcher.clear();

  let available = false;
  now = 1000;
  const earlyMatches = [];
  const earlyMatcher = new Matcher({ match: () => available ? captured : undefined }, (_record, timing) => earlyMatches.push(timing), () => now);
  earlyMatcher.observe({ foreground: 'com.openai.codex', text: fixtureText, sequence: 4 });
  now = 1240;
  available = true;
  earlyMatcher.retry();
  assert.equal(earlyMatches.length, 1);
  assert.equal(earlyMatches[0].cacheWaitMs, 240);
  earlyMatcher.clear();

  available = false;
  now = 2000;
  const expiredMatches = [];
  const expiredMatcher = new Matcher({ match: () => available ? captured : undefined }, (record) => expiredMatches.push(record), () => now);
  expiredMatcher.observe({ foreground: 'com.openai.codex', text: fixtureText, sequence: 5 });
  await delay(520);
  now = 2521;
  available = true;
  expiredMatcher.retry();
  assert.equal(expiredMatches.length, 0, 'expired candidates must not match later');

  available = false;
  now = 3000;
  const departedMatches = [];
  const departedMatcher = new Matcher({ match: () => available ? captured : undefined }, (record) => departedMatches.push(record), () => now);
  departedMatcher.observe({ foreground: 'com.openai.codex', text: fixtureText, sequence: 6 });
  departedMatcher.observe({ foreground: 'com.apple.finder', text: fixtureText, sequence: 7 });
  available = true;
  departedMatcher.retry();
  assert.equal(departedMatches.length, 0, 'leaving Codex must discard the candidate');
  departedMatcher.clear();
  index.close();

  const dataDir = path.join(tempRoot, 'runtime-data');
  const runtimeLog = [];
  const launcher = updateRuntime(dataDir, '/tmp/Codex.app/Contents/MacOS/Codex', '/tmp/Codex.app/Contents/Resources/hook/capture-hook.cjs', (...args) => runtimeLog.push(args));
  const runtimeFile = path.join(dataDir, 'runtime.json');
  assert.equal(launcher, path.join(dataDir, 'hook/capture.command'));
  assert.equal(mode(path.dirname(launcher)), 0o700);
  assert.equal(mode(launcher), 0o700);
  assert.equal(mode(runtimeFile), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')), {
    electronPath: '/tmp/Codex.app/Contents/MacOS/Codex',
    hookPath: '/tmp/Codex.app/Contents/Resources/hook/capture-hook.cjs',
  });
  const launcherText = fs.readFileSync(launcher, 'utf8');
  assert.match(launcherText, /\/usr\/bin\/plutil -extract electronPath/);
  assert.match(launcherText, /ELECTRON_RUN_AS_NODE=1/);

  const codexHome = path.join(tempRoot, 'codex-config');
  fs.mkdirSync(codexHome);
  const hooksFile = path.join(codexHome, 'hooks.json');
  const originalHooks = {
    other: 'preserved',
    hooks: {
      Stop: [{ matcher: 'existing', hooks: [{ type: 'command', command: '/usr/local/bin/other', timeout: 7 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/start' }] }],
    },
  };
  fs.writeFileSync(hooksFile, JSON.stringify(originalHooks), { mode: 0o600 });
  installHook({ codexHome, launcher, log: (...args) => runtimeLog.push(args) });
  const installedHooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.equal(installedHooks.other, 'preserved');
  assert.deepEqual(installedHooks.hooks.SessionStart, originalHooks.hooks.SessionStart);
  assert.equal(installedHooks.hooks.Stop[0].hooks[0].command, '/usr/local/bin/other');
  assert.equal(installedHooks.hooks.Stop[1].hooks[0].command, "'" + launcher + "'");
  assert.equal(mode(hooksFile), 0o600);
  const backup = fs.readdirSync(codexHome).find((name) => name.startsWith('hooks.json.backup-'));
  assert.ok(backup);
  assert.equal(mode(path.join(codexHome, backup)), 0o600);
  const brokenHome = path.join(tempRoot, 'broken-codex-config');
  fs.mkdirSync(brokenHome);
  const brokenFile = path.join(brokenHome, 'hooks.json');
  fs.writeFileSync(brokenFile, '{broken', { mode: 0o600 });
  assert.throws(() => installHook({ codexHome: brokenHome, launcher, log }), /无法解析/);
  assert.equal(fs.readFileSync(brokenFile, 'utf8'), '{broken');
  assert.equal(fs.readdirSync(brokenHome).filter((name) => name.includes('.backup-')).length, 0);

  const callsFile = path.join(tempRoot, 'mock-calls.jsonl');
  const mockCli = path.join(tempRoot, 'mock-lark-cli');
  fs.writeFileSync(mockCli, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const chunks = [];
const present = (key) => Object.prototype.hasOwnProperty.call(process.env, key);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
  const call = {
    args,
    stdin: chunks.join(''),
    cwd: process.cwd(),
    configDir,
    inheritedCredentialKeysPresent: ['LARKSUITE_CLI_HOST_SECRET', 'LARK_HOST_KEY', 'FEISHU_HOST_TOKEN', 'OPENCLAW_HOST_TOKEN', 'HERMES_HOST_TOKEN'].filter(present),
  };
  fs.appendFileSync(process.env.MOCK_CALLS_FILE, JSON.stringify(call) + '\n');
  const output = (value, code) => { process.stdout.write(JSON.stringify(value) + '\n'); process.exit(code || 0); };
  if (args[0] === 'config' && args[1] === 'init') {
    const appId = args[args.indexOf('--app-id') + 1];
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ apps: [{ name: 'codex-share', appId, brand: 'feishu' }] }), { mode: 0o600 });
    return output({ ok: true });
  }
  if (args[0] === 'auth' && args[1] === 'status') return output({ ok: true, identities: { user: { verified: true, available: true, userName: 'Mock User', scope: 'contact:user:search im:chat:read' } } });
  if (args[0] === 'auth' && args[1] === 'login' && args.includes('--device-code')) return output({ ok: true, event: 'authorization_complete' });
  if (args[0] === 'auth' && args[1] === 'login') return output({ ok: true, verification_url: 'https://mock.feishu.example/authorize', device_code: 'mock-device-code', expires_in: 600 });
  if (args[0] === 'auth' && args[1] === 'logout') return output({ ok: true, loggedOut: true });
  if (args[0] === 'contact' && args[1] === '+search-user') return output({ ok: true, data: { users: [
    { open_id: 'ou_person1', localized_name: '张三', is_activated: true },
    { open_id: 'ou_person1', localized_name: '张三重复', is_activated: true },
    { open_id: 'ou_disabled', localized_name: '已停用', is_activated: false },
    { open_id: 'bad-id', localized_name: '无效标识', is_activated: true },
    { open_id: 'ou_no_name', localized_name: '  ', is_activated: true },
  ] } });
  if (args[0] === 'im' && args[1] === '+chat-search') return output({ ok: true, data: { chats: [
    { chat_id: 'oc_group1', name: '项目群', chat_status: 'normal', external: true },
    { chat_id: 'oc_group1', name: '重复群', chat_status: 'normal' },
    { chat_id: 'oc_archived', name: '已归档', chat_status: 'archived' },
    { chat_id: 'invalid', name: '无效标识', chat_status: 'normal' },
  ] } });
  if (args[0] === 'im' && args[1] === '+messages-send') {
    const control = JSON.parse(fs.readFileSync(path.join(configDir, 'mock-mode.json'), 'utf8'));
    if (control.send === 'nonzero') {
      process.stderr.write(JSON.stringify({ error: { message: 'access_token=mock-cli-token' } }));
      return process.exit(9);
    }
    if (control.send === 'unconfirmed') return output({ ok: true, data: {} });
    return output({ ok: true, data: { message_id: 'mock-message-id' } });
  }
  return output({ ok: false, error: { message: 'unexpected mock command' } }, 2);
});
`, { mode: 0o700 });
  fs.chmodSync(mockCli, 0o700);
  const configDir = path.join(tempRoot, 'private-lark-config');
  const appLogDir = path.join(tempRoot, 'app-logs');
  const calls = () => jsonLines(callsFile);
  const sensitiveEnv = {
    LARKSUITE_CLI_HOST_SECRET: 'host-cli-sentinel',
    LARK_HOST_KEY: 'host-lark-sentinel',
    FEISHU_HOST_TOKEN: 'host-feishu-sentinel',
    OPENCLAW_HOST_TOKEN: 'host-openclaw-sentinel',
    HERMES_HOST_TOKEN: 'host-hermes-sentinel',
    MOCK_CALLS_FILE: callsFile,
  };
  const priorEnv = new Map(Object.keys(sensitiveEnv).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(sensitiveEnv)) process.env[key] = value;
  const authUpdates = [];
  const service = createLarkService({
    binary: mockCli,
    configDir,
    log: createLog(appLogDir),
    onAuthState: (state) => authUpdates.push(state),
  });
  try {
    assert.equal(mode(configDir), 0o700);
    const saved = await service.saveConfig({ appId: 'cli_Test123', appSecret: 'secret-for-test-only' });
    assert.equal(saved.configured, true);
    assert.equal(saved.status, 'error');
    assert.deepEqual(saved.missingScopes, ['im:message.send_as_user', 'im:message']);
    const configText = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
    assert.match(configText, /cli_Test123/);
    assert.equal(configText.includes('secret-for-test-only'), false);
    const configCall = calls().find((call) => call.args[0] === 'config');
    assert.ok(configCall.stdin === 'secret-for-test-only\n', 'app secret is passed through stdin');
    assert.equal(configCall.args.includes('secret-for-test-only'), false, 'app secret must travel through stdin');

    const pending = await service.login();
    assert.equal(pending.status, 'pending');
    assert.equal(pending.url, 'https://mock.feishu.example/authorize');
    await waitFor(() => calls().some((call) => call.args.includes('--device-code')) && authUpdates.filter((state) => state.status === 'error').length >= 2,
      'device-code authorization should finish in the background');
    const loginStart = calls().find((call) => call.args[0] === 'auth' && call.args[1] === 'login' && !call.args.includes('--device-code'));
    const loginPoll = calls().find((call) => call.args.includes('--device-code'));
    assert.ok(loginStart.args.includes('--no-wait'));
    assert.ok(loginPoll.args.includes('mock-device-code'));

    const contactQuery = '张'.repeat(49) + '😀' + 'tail';
    const contacts = await service.searchContacts(contactQuery);
    assert.deepEqual(contacts, [{ openId: 'ou_person1', name: '张三', department: undefined }]);
    const contactCall = calls().find((call) => call.args[0] === 'contact');
    assert.equal(contactCall.args[contactCall.args.indexOf('--query') + 1], '张'.repeat(49) + '😀');

    const chatQuery = '群'.repeat(63) + '😀' + '尾';
    const chats = await service.searchChats(chatQuery);
    assert.deepEqual(chats, [{ kind: 'chat', id: 'oc_group1', name: '项目群', detail: '外部群聊', avatarUrl: undefined }]);
    const chatCall = calls().find((call) => call.args[0] === 'im' && call.args[1] === '+chat-search');
    assert.equal(chatCall.args[chatCall.args.indexOf('--query') + 1], '群'.repeat(63) + '😀');

    fs.writeFileSync(path.join(configDir, 'mock-mode.json'), JSON.stringify({ send: 'success' }));
    const markdown = '# 标题\n\n**原文** <at id=ou_person1>张三</at>\n\n```js\nconst x = 1;\n```';
    const request = { recipient: { kind: 'user', id: 'ou_person1' }, text: '  ' + markdown + '  ' };
    const sent = await service.send(request, 'same-message-key');
    assert.equal(sent.messageId, 'mock-message-id');
    let sendCalls = calls().filter((call) => call.args[1] === '+messages-send');
    const firstSend = sendCalls.at(-1);
    const contentArg = firstSend.args[firstSend.args.indexOf('--content') + 1];
    assert.ok(JSON.stringify(JSON.parse(contentArg)) === JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown }]] } }),
      'post payload preserves original Markdown and mentions');
    assert.ok(firstSend.args.includes('--msg-type') && firstSend.args[firstSend.args.indexOf('--msg-type') + 1] === 'post');
    assert.ok(firstSend.args.includes('--user-id') && firstSend.args.includes('ou_person1'));
    assert.ok(firstSend.args[firstSend.args.indexOf('--idempotency-key') + 1] === 'same-message-key', 'CLI receives the idempotency key');

    fs.writeFileSync(path.join(configDir, 'mock-mode.json'), JSON.stringify({ send: 'unconfirmed' }));
    await assert.rejects(service.send(request, 'same-message-key'), (error) => error.unconfirmed === true);
    sendCalls = calls().filter((call) => call.args[1] === '+messages-send');
    assert.ok(sendCalls.at(-1).args[sendCalls.at(-1).args.indexOf('--idempotency-key') + 1] === 'same-message-key', 'retry reuses the idempotency key');
    assert.ok(sendCalls.at(-2).args[sendCalls.at(-2).args.indexOf('--idempotency-key') + 1] === 'same-message-key', 'original request carries the idempotency key');

    fs.writeFileSync(path.join(configDir, 'mock-mode.json'), JSON.stringify({ send: 'nonzero' }));
    await assert.rejects(service.send(request, 'failed-send-key'));
    const beforeInvalid = calls().length;
    await assert.rejects(service.send({ recipient: { kind: 'user', id: 'oc_wrong_kind' }, text: 'bad target' }, 'invalid-target-key'), /收件人标识无效/);
    assert.equal(calls().length, beforeInvalid, 'invalid targets must be rejected before invoking the CLI');

    fs.writeFileSync(path.join(configDir, 'mock-mode.json'), JSON.stringify({ send: 'success' }));
    const chatSent = await service.send({ recipient: { kind: 'chat', id: 'oc_group1' }, text: '群消息' }, 'chat-message-key');
    assert.equal(chatSent.messageId, 'mock-message-id');
    const chatSend = calls().filter((call) => call.args[1] === '+messages-send').at(-1);
    assert.ok(chatSend.args.includes('--chat-id') && chatSend.args.includes('oc_group1'));

    const boundaryText = '火'.repeat(24000);
    assert.equal((await service.send({ recipient: { kind: 'user', id: 'ou_person1' }, text: boundaryText }, 'max-length-key')).messageId, 'mock-message-id');
    const beforeTooLong = calls().length;
    await assert.rejects(service.send({ recipient: { kind: 'user', id: 'ou_person1' }, text: boundaryText + '火' }, 'too-long-key'), /24,000/);
    assert.equal(calls().length, beforeTooLong, 'over-limit content must not reach the CLI');

    const loggedOut = await service.logout();
    assert.equal(loggedOut.status, 'logged-out');
    const logoutCall = calls().find((call) => call.args[0] === 'auth' && call.args[1] === 'logout');
    assert.ok(logoutCall.args.includes('--json'));

    for (const call of calls()) {
      assert.deepEqual(call.args.slice(-2), ['--profile', 'codex-share']);
      assert.equal(call.cwd, fs.realpathSync(configDir));
      assert.equal(call.configDir, configDir);
      assert.deepEqual(call.inheritedCredentialKeysPresent, []);
    }
    const appLog = fs.readFileSync(path.join(appLogDir, 'app.jsonl'), 'utf8');
    for (const privateValue of ['secret-for-test-only', 'mock-device-code', 'mock-cli-token', fixtureText, markdown]) {
      assert.equal(appLog.includes(privateValue), false, 'application logs must exclude message bodies and credentials');
    }
    assert.equal(mode(path.join(appLogDir, 'app.jsonl')), 0o600);
  } finally {
    service.dispose();
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const { nextReleaseVersion, artifactNames, builderConfig, publishArtifacts } = await import(path.join(root, 'scripts/package-release.mjs'));
  const releaseTemp = path.join(tempRoot, 'release-test');
  const versionDirs = path.join(releaseTemp, 'existing');
  fs.mkdirSync(path.join(versionDirs, '1.2.9'), { recursive: true });
  fs.mkdirSync(path.join(versionDirs, '2.0.8'), { recursive: true });
  fs.mkdirSync(path.join(versionDirs, '2.0.10-rc1'), { recursive: true });
  const existingVersions = fs.readdirSync(versionDirs).filter((name) => fs.statSync(path.join(versionDirs, name)).isDirectory());
  assert.equal(nextReleaseVersion('1.0.0', existingVersions), '2.0.9');
  const config = builderConfig('2.0.9', path.join(releaseTemp, 'arm64'));
  assert.equal(config.buildVersion, '2.0.9');
  assert.equal(config.extraMetadata.version, '2.0.9');
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(config.mac.identity, '-');
  assert.deepEqual(config.extraResources.filter((resource) => resource.from.startsWith('bin/')), [
    { from: 'bin/arm64/lark-cli', to: 'bin/lark-cli' },
    { from: 'bin/build-manifest.json', to: 'bin/build-manifest.json' },
  ]);
  assert.equal(config.productName, 'codex分享飞书消息');
  assert.equal(config.dmg.title, 'codex分享飞书消息');
  assert.equal(config.mac.extendInfo.LSUIElement, true);
  assert.deepEqual(config.extraResources.filter((resource) => resource.from.startsWith('assets/')), [
    { from: 'assets/dock-icon.png', to: 'assets/dock-icon.png' },
    { from: 'assets/tray-iconTemplate.png', to: 'assets/tray-iconTemplate.png' },
    { from: 'assets/tray-iconTemplate@2x.png', to: 'assets/tray-iconTemplate@2x.png' },
  ]);
  assert.deepEqual(artifactNames('2.0.9'), ['codex分享飞书消息-2.0.9-mac-arm64.dmg']);

  const releaseRoot = path.join(releaseTemp, 'published');
  const staged = path.join(releaseTemp, 'complete-staging');
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.mkdirSync(staged, { recursive: true });
  for (const name of artifactNames('2.0.9')) fs.writeFileSync(path.join(staged, name), 'temporary placeholder; not a disk image');
  const published = await publishArtifacts(staged, releaseRoot, '2.0.9');
  assert.equal(published.length, 1);
  assert.deepEqual(published.map((file) => path.basename(file)), artifactNames('2.0.9'));
  assert.ok(published.every((file) => fs.statSync(file).size > 0));
  assert.equal(fs.existsSync(staged), false);

  const incomplete = path.join(releaseTemp, 'incomplete-staging');
  const incompleteRoot = path.join(releaseTemp, 'incomplete-release');
  fs.mkdirSync(incompleteRoot, { recursive: true });
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, artifactNames('2.0.10')[0]), '');
  await assert.rejects(publishArtifacts(incomplete, incompleteRoot, '2.0.10'), /缺少完整产物/);
  assert.equal(fs.existsSync(path.join(incompleteRoot, '2.0.10')), false);
  assert.ok(fs.existsSync(incomplete));

  const oldStaging = path.join(releaseTemp, 'old-staging');
  const oldRoot = path.join(releaseTemp, 'old-release');
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.mkdirSync(oldStaging, { recursive: true });
  for (const name of artifactNames('2.0.11')) fs.writeFileSync(path.join(oldStaging, name), 'temporary placeholder');
  const oldDestination = path.join(oldRoot, '2.0.11');
  fs.mkdirSync(oldDestination, { recursive: true });
  fs.writeFileSync(path.join(oldDestination, 'keep.txt'), 'original');
  await assert.rejects(publishArtifacts(oldStaging, oldRoot, '2.0.11'), /正式版本目录已存在/);
  assert.equal(fs.readFileSync(path.join(oldDestination, 'keep.txt'), 'utf8'), 'original');

  const { CLI_SOURCE, applyPinnedPatches } = await import(path.join(root, 'scripts/prepare-cli.mjs'));
  const patchManifest = JSON.parse(fs.readFileSync(path.join(root, 'patches/lark-cli.json'), 'utf8'));
  const sourceCandidates = [
    path.join(root, '.cache', 'cli-' + CLI_SOURCE.commit),
    path.join(root, '.cache', 'lark-inspect', 'cli-' + CLI_SOURCE.commit),
  ];
  let sourceRoot = sourceCandidates.find((candidate) => patchManifest.every((patch) => fs.existsSync(path.join(candidate, patch.file))));
  if (!sourceRoot) {
    const archive = path.join(root, '.cache', 'lark-cli-' + CLI_SOURCE.commit + '.tar.gz');
    assert.ok(fs.existsSync(archive), '缺少固定 CLI 源码缓存；请先运行 npm run cli:prepare');
    sourceRoot = path.join(tempRoot, 'cli-source');
    fs.mkdirSync(sourceRoot, { recursive: true });
    const unpacked = spawnSync('tar', ['-xzf', archive, '-C', sourceRoot, '--strip-components=1'], { encoding: 'utf8' });
    assert.ok(unpacked.status === 0, 'fixed CLI source archive extracts in the test temp directory');
    assert.ok(patchManifest.every((patch) => fs.existsSync(path.join(sourceRoot, patch.file))), 'extracted CLI source contains all pinned patch files');
  }
  const patchCopy = path.join(tempRoot, 'cli-patch-copy');
  for (const patch of patchManifest) {
    const source = path.join(sourceRoot, patch.file);
    const original = fs.readFileSync(source);
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), patch.sha256);
    const destination = path.join(patchCopy, patch.file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, original);
  }
  const originalConsoleLog = console.log;
  let patchedHashes;
  try {
    console.log = () => {};
    patchedHashes = await applyPinnedPatches(patchCopy);
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(Object.keys(patchedHashes).length, 3);
  const keychainSource = fs.readFileSync(path.join(patchCopy, 'internal/keychain/keychain.go'), 'utf8');
  assert.match(keychainSource, /LarkCliService = "codex-feishu-share"/);
  const sendSource = fs.readFileSync(path.join(patchCopy, 'shortcuts/im/im_messages_send.go'), 'utf8');
  assert.equal((sendSource.match(/msgType == "post" && runtime\.Str\("content"\) == ""/g) || []).length, 2);
  const logoutSource = fs.readFileSync(path.join(patchCopy, 'cmd/auth/logout.go'), 'utf8');
  assert.equal(logoutSource.includes('larkauth.RevokeToken'), false);
  assert.equal(logoutSource.includes('f.HttpClient()'), false);

  process.stdout.write('core assertions passed (' + fixture.source + ' fixture)\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
