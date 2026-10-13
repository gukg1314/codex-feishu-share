const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicJSON, privateDirectory } = require('./common.cjs');
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
function updateRuntime(dataDir, electronPath, hookPath, log, logDir = path.join(dataDir, 'logs')) {
  privateDirectory(path.join(dataDir, 'hook'));
  atomicJSON(path.join(dataDir, 'runtime.json'), { electronPath, hookPath });
  const runtime = quote(path.join(dataDir, 'runtime.json'));
  const failureLog = quote(path.join(logDir, 'hook.jsonl'));
  const launcher = path.join(dataDir, 'hook', 'capture.command');
  fs.writeFileSync(launcher, `#!/bin/sh\nRUNTIME=${runtime}\nfail() { printf '{"event":"hook_launcher_failed"}\\n' >> ${failureLog}; printf '{}\\n'; exit 0; }\nELECTRON=$(/usr/bin/plutil -extract electronPath raw -o - "$RUNTIME" 2>/dev/null) || fail\nHOOK=$(/usr/bin/plutil -extract hookPath raw -o - "$RUNTIME" 2>/dev/null) || fail\nELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$HOOK" || fail\n`, { mode: 0o700 });
  fs.chmodSync(launcher, 0o700);
  log('hook_runtime_updated');
  return launcher;
}
function installHook({ codexHome, launcher, log }) {
  if (typeof codexHome !== 'string' || !codexHome.trim() || !path.isAbsolute(codexHome)) throw new Error('请填写 Codex 配置目录的绝对路径。');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const file = path.join(codexHome, 'hooks.json');
  let config = { hooks: {} };
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('hooks.json 无法解析，未覆盖原文件。请先修复配置。'); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks))) || (config.hooks?.Stop && !Array.isArray(config.hooks.Stop))) {
    throw new Error('Hook 配置结构异常，未覆盖原文件。');
  }
  config.hooks ||= {};
  const command = quote(launcher);
  const definition = { hooks: [{ type: 'command', command, timeout: 10 }] };
  const previous = config.hooks.Stop || [];
  if (previous.some((entry) => !entry || !Array.isArray(entry.hooks))) throw new Error('Stop Hook 结构异常，未覆盖原文件。');
  config.hooks.Stop = previous.map((entry) => ({ ...entry, hooks: entry.hooks.filter((hook) => hook.command !== command) })).filter((entry) => entry.hooks.length);
  config.hooks.Stop.push(definition);
  if (fs.existsSync(file)) {
    const backup = `${file}.backup-${Date.now()}`;
    fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
  }
  atomicJSON(file, config);
  log('hook_installed', { status: 'awaiting_trust_and_capture' });
}
function defaultCodexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
module.exports = { updateRuntime, installHook, defaultCodexHome };
