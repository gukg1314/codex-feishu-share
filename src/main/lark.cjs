'use strict';

// Contact/chat filtering and the post payload follow tech-cc-hub.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROFILE = 'codex-share';
const REQUIRED_SCOPES = ['contact:user:search', 'im:chat:read', 'im:message.send_as_user', 'im:message'];
const SEND_LIMIT = 24000;
const textValue = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scopesFrom = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : [])
  .filter(scope => typeof scope === 'string' && /^[a-z][a-z0-9_.:-]{0,100}$/.test(scope));

function parseJson(raw) {
  const value = raw.trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  for (const candidate of [value, start >= 0 && end > start ? value.slice(start, end + 1) : '']) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function sanitizeError(value, sensitive = []) {
  let safe = typeof value === 'string' ? value : '';
  for (const secret of sensitive.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[已隐藏]');
    safe = safe.split(JSON.stringify(secret).slice(1, -1)).join('[已隐藏]');
  }
  return safe
    .replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|device[_-]?code|app[_-]?secret|client[_-]?secret|authorization)\b["']?\s*[:=]\s*["']?[^\s,}"']+/gi, '[凭据已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[凭据已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 600).trim();
}

function cliError(payload, fallback, sensitive, unconfirmed = false) {
  const error = isRecord(payload?.error) ? payload.error : {};
  const detail = sanitizeError(error.message || payload?.message, sensitive);
  const code = typeof error.code === 'number' ? error.code : undefined;
  const missingScopes = scopesFrom(error.missing_scopes || payload?.missing_scopes || payload?.missing);
  const result = new Error([fallback, detail, code === undefined ? '' : `错误码：${code}`,
    missingScopes.length ? `缺少权限：${missingScopes.join('、')}，请去设置补充授权。` : ''].filter(Boolean).join(' '));
  result.code = code;
  result.missingScopes = missingScopes;
  result.unconfirmed = unconfirmed;
  return result;
}

function privateEnv(configDir) {
  const env = { ...process.env };
  // Providers and workspace routing must never inherit the host's account.
  for (const key of Object.keys(env)) {
    if (/^(?:LARKSUITE_CLI_|LARK_|FEISHU_|OPENCLAW_|HERMES_)/i.test(key)) delete env[key];
  }
  return { ...env, LARKSUITE_CLI_CONFIG_DIR: configDir,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    LARKSUITE_CLI_REMOTE_META: 'off' };
}

function createLarkService({ binary, configDir, log = () => {}, onAuthState = () => {} }) {
  if (!path.isAbsolute(binary) || !path.isAbsolute(configDir)) throw new Error('飞书 CLI 与配置目录必须使用绝对路径。');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  const children = new Set();
  let authState = { status: 'unconfigured', configured: false };
  let generation = 0;
  let authChild;

  function configured() {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
      const app = Array.isArray(config.apps) ? config.apps.find(app => app.name === PROFILE) : undefined;
      return { configured: Boolean(textValue(app?.appId)), appId: textValue(app?.appId) };
    } catch (error) {
      if (error.code === 'ENOENT') return { configured: false };
      throw new Error('本软件的飞书配置无法读取，请在设置重新保存配置。');
    }
  }

  function setAuth(next) {
    authState = next;
    log('lark-auth-state', { status: next.status, missingScopes: next.missingScopes || [] });
    onAuthState({ ...next });
    return { ...next };
  }

  function cancelLogin() {
    generation += 1;
    if (authChild) authChild.kill('SIGTERM');
    authChild = undefined;
  }

  function invoke(action, args, { stdin = '', sensitive = [], timeout = 15000, polling = false } = {}) {
    const requestId = randomUUID();
    const started = Date.now();
    const fallback = `飞书${action}失败。`;
    log('lark-cli-start', { action, requestId, timeoutMs: timeout });
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let output = '';
      let errors = '';
      let settled = false;
      const finish = (error, payload, exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child) children.delete(child);
        if (child === authChild) authChild = undefined;
        log(error ? 'lark-cli-failed' : 'lark-cli-finished', { action, requestId,
          elapsedMs: Date.now() - started, exitCode, errorCode: error?.code,
          unconfirmed: Boolean(error?.unconfirmed), missingScopes: error?.missingScopes || [] });
        if (error) reject(error); else resolve(payload);
      };
      try {
        child = spawn(binary, [...args, '--profile', PROFILE], {
          env: privateEnv(configDir), cwd: configDir, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        });
      } catch {
        finish(new Error('内置飞书 CLI 无法启动，请准备 CLI 或重新安装软件。'));
        return;
      }
      children.add(child);
      if (polling || action === '发起授权') authChild = child;
      child.on('error', () => finish(new Error('内置飞书 CLI 无法启动，请准备 CLI 或重新安装软件。')));
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const collect = (chunk, stderr) => {
        if (settled) return;
        if (stderr) errors += chunk.toString('utf8'); else output += chunk.toString('utf8');
        if (output.length + errors.length > 2 * 1024 * 1024) {
          child.kill('SIGTERM');
          finish(cliError(null, `${fallback}CLI 返回数据过大。`, [], action === '发送消息'));
        }
      };
      child.stdout.on('data', chunk => collect(chunk, false));
      child.stderr.on('data', chunk => collect(chunk, true));
      child.on('close', code => {
        if (settled) return;
        const payload = parseJson(output);
        const errorPayload = parseJson(errors);
        if (code !== 0 && !(polling && payload?.event === 'authorization_complete')) {
          finish(cliError(errorPayload || payload, fallback, sensitive), undefined, code);
        } else if (!payload || payload.ok === false) {
          finish(cliError(payload || errorPayload, `${fallback}未取得有效确认数据。`, sensitive,
            action === '发送消息'), undefined, code);
        } else {
          finish(null, payload, code);
        }
      });
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(cliError(null, action === '发送消息'
          ? '飞书发送等待超过 15 秒，结果未确认。请检查后重试，同一消息会沿用原幂等键。'
          : `飞书${action}超时，请稍后重试。`, [], action === '发送消息'));
      }, timeout);
      child.stdin.end(stdin);
    });
  }

  async function authStatus() {
    const current = generation;
    try {
      const config = configured();
      if (!config.configured) return setAuth({ status: 'unconfigured', ...config });
      if (authState.status === 'pending') return { ...authState, ...config };
      const payload = await invoke('检查授权', ['auth', 'status', '--json', '--verify']);
      if (current !== generation) return { ...authState };
      const user = isRecord(payload.identities?.user) ? payload.identities.user : {};
      const userName = textValue(user.userName);
      if (user.verified === true && user.available === true) {
        const granted = new Set(scopesFrom(user.scope));
        const missingScopes = REQUIRED_SCOPES.filter(scope => !granted.has(scope));
        return setAuth({ ...config, status: missingScopes.length ? 'error' : 'authenticated', userName,
          missingScopes, ...(missingScopes.length ? { error: '本人已登录，但业务权限不足。请去设置补充授权。' } : {}) });
      }
      return setAuth({ ...config, status: user.status === 'verify_failed' ? 'error' : 'logged-out',
        userName, ...(user.status === 'verify_failed' ? { error: '本人授权验证失败，请重新登录或检查网络。' } : {}) });
    } catch (error) {
      if (current !== generation) return { ...authState };
      return setAuth({ ...authState, status: 'error', url: undefined, error: error.message,
        missingScopes: error.missingScopes || [] });
    }
  }

  async function saveConfig(input) {
    const appId = textValue(input?.appId);
    const appSecret = textValue(input?.appSecret);
    if (!appId || !/^cli_[a-zA-Z0-9]+$/.test(appId)) throw new Error('请输入有效的飞书 App ID（cli_ 开头）。');
    if (!appSecret || /[\r\n\u0000]/.test(appSecret)) throw new Error('请输入有效的飞书 App Secret。');
    cancelLogin();
    try {
      await invoke('保存配置', ['config', 'init', '--name', PROFILE, '--app-id', appId,
        '--app-secret-stdin', '--brand', 'feishu'], { stdin: `${appSecret}\n`, sensitive: [appSecret] });
      setAuth({ status: 'logged-out', configured: true, appId });
      return authStatus();
    } catch (error) {
      setAuth({ ...authState, status: 'error', url: undefined, error: error.message });
      throw error;
    }
  }

  async function completeLogin(deviceCode, expiresIn, current) {
    try {
      const payload = await invoke('完成授权', ['auth', 'login', '--device-code', deviceCode, '--json'], {
        polling: true, timeout: Math.min(expiresIn * 1000 + 15000, 615000), sensitive: [deviceCode],
      });
      if (current !== generation) return;
      if (payload.event !== 'authorization_complete') throw new Error('飞书未确认本人授权完成，请重新登录。');
      authState = { ...authState, status: 'logged-out', url: undefined };
      await authStatus();
    } catch (error) {
      if (current !== generation) return;
      setAuth({ ...authState, status: 'error', url: undefined, error: error.message,
        missingScopes: error.missingScopes || [] });
    }
  }

  async function login() {
    if (authState.status === 'pending') return { ...authState };
    const config = configured();
    if (!config.configured) throw new Error('请先保存本软件的飞书 App ID 和 App Secret。');
    cancelLogin();
    const current = generation;
    setAuth({ status: 'pending', ...config });
    try {
      const payload = await invoke('发起授权', ['auth', 'login', '--scope', REQUIRED_SCOPES.join(' '), '--no-wait', '--json']);
      if (current !== generation) throw new Error('本次登录已取消。');
      const url = typeof payload.verification_url === 'string' ? payload.verification_url : '';
      const deviceCode = textValue(payload.device_code);
      let validUrl = false;
      try { validUrl = new URL(url).protocol === 'https:'; } catch {}
      if (!validUrl || !deviceCode) throw new Error('飞书未返回有效的授权链接，请重新登录。');
      const expiresIn = Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? payload.expires_in : 600;
      const next = setAuth({ status: 'pending', ...config, url });
      // Return the URL to the settings page before starting the long poll.
      setImmediate(() => { if (current === generation) void completeLogin(deviceCode, expiresIn, current); });
      return next;
    } catch (error) {
      if (current === generation) setAuth({ status: 'error', ...config, error: error.message,
        missingScopes: error.missingScopes || [] });
      throw error;
    }
  }

  async function logout() {
    cancelLogin();
    const config = configured();
    if (!config.configured) return setAuth({ status: 'unconfigured', ...config });
    try {
      const payload = await invoke('退出登录', ['auth', 'logout', '--json']);
      if (payload.ok !== true || typeof payload.loggedOut !== 'boolean') throw new Error('飞书未确认本地退出，请重新检查授权状态。');
      return setAuth({ status: 'logged-out', ...config });
    } catch (error) {
      setAuth({ status: 'error', ...config, error: error.message });
      throw error;
    }
  }

  function requireConfig() {
    if (!configured().configured) throw new Error('请先在设置保存飞书配置并完成本人授权。');
  }

  async function searchContacts(query) {
    const normalized = Array.from(typeof query === 'string' ? query.trim() : '').slice(0, 50).join('');
    if (!normalized) return [];
    requireConfig();
    // 保留现有搜索的部门信息，另取头像并按 open_id 对应。
    const avatarLookup = invoke('获取人员头像', ['api', 'GET', '/open-apis/search/v1/user',
      '--params', JSON.stringify({ query: normalized, page_size: 200 }), '--as', 'user', '--format', 'json'],
      { timeout: 5000, sensitive: [normalized] }).catch(() => undefined);
    const payload = await invoke('搜索人员', ['contact', '+search-user', '--query', normalized,
      '--as', 'user', '--format', 'json'], { timeout: 6000, sensitive: [normalized] });
    if (payload.ok !== true) throw new Error('飞书人员搜索未取得有效确认。');
    const avatarPayload = await avatarLookup;
    const avatars = new Map();
    for (const user of Array.isArray(avatarPayload?.data?.users) ? avatarPayload.data.users : []) {
      const openId = textValue(user?.open_id);
      const avatarUrl = textValue(user?.avatar?.avatar_72);
      if (openId && avatarUrl?.startsWith('https://')) avatars.set(openId, avatarUrl);
    }
    const contacts = [];
    const seen = new Set();
    for (const user of Array.isArray(payload.data?.users) ? payload.data.users : []) {
      const openId = textValue(user?.open_id);
      const name = textValue(user?.localized_name);
      if (!openId || !/^ou_[a-zA-Z0-9]+$/.test(openId) || !name || user.is_activated === false || seen.has(openId)) continue;
      seen.add(openId);
      contacts.push({ openId, name, department: textValue(user.department), avatarUrl: avatars.get(openId) });
      if (contacts.length === 20) break;
    }
    log('lark-contact-search-results', { count: contacts.length, avatars: contacts.filter(contact => contact.avatarUrl).length });
    return contacts;
  }

  async function searchChats(query) {
    const normalized = Array.from(typeof query === 'string' ? query.trim() : '').slice(0, 64).join('');
    if (!normalized) return [];
    requireConfig();
    const payload = await invoke('搜索群聊', ['im', '+chat-search', '--query', normalized,
      '--page-size', '10', '--as', 'user', '--format', 'json'], { timeout: 6000, sensitive: [normalized] });
    if (payload.ok !== true) throw new Error('飞书群聊搜索未取得有效确认。');
    const recipients = [];
    const seen = new Set();
    for (const chat of Array.isArray(payload.data?.chats) ? payload.data.chats : []) {
      const id = textValue(chat?.chat_id);
      const name = textValue(chat?.name);
      if (!id || !/^oc_[a-zA-Z0-9]+$/.test(id) || !name || chat.chat_status !== 'normal' || seen.has(id)) continue;
      seen.add(id);
      recipients.push({ kind: 'chat', id, name, detail: chat.external === true ? '外部群聊' : '群聊', avatarUrl: textValue(chat.avatar) });
      if (recipients.length === 10) break;
    }
    return recipients;
  }

  async function send(input, idempotencyKey) {
    const kind = input?.recipient?.kind;
    const id = textValue(input?.recipient?.id);
    const text = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!id || !(kind === 'user' && /^ou_[a-zA-Z0-9]+$/.test(id) || kind === 'chat' && /^oc_[a-zA-Z0-9]+$/.test(id))) {
      throw new Error('飞书收件人标识无效，请重新选择。');
    }
    if (!text) throw new Error('没有可发送的消息内容。');
    const length = Array.from(text).length;
    if (length > SEND_LIMIT) throw new Error('消息超过 24,000 字，暂时无法作为单条飞书消息发送。');
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(idempotencyKey)) throw new Error('发送请求标识无效，请重新打开分享窗口。');
    requireConfig();
    const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } });
    log('lark-send-request', { kind, chars: length, requestId: idempotencyKey });
    const payload = await invoke('发送消息', ['im', '+messages-send', kind === 'user' ? '--user-id' : '--chat-id', id,
      '--msg-type', 'post', '--content', content, '--as', 'user', '--idempotency-key', idempotencyKey], {
      sensitive: [text, content, ...text.split('\n').filter(Boolean)], timeout: 15000,
    });
    const data = isRecord(payload.data) ? payload.data : payload;
    const messageId = textValue(data.message_id);
    if (payload.ok === false || !messageId) throw cliError(null, '飞书未返回成功消息标识，发送结果未确认。请检查后重试。', [], true);
    log('lark-send-confirmed', { requestId: idempotencyKey, chars: length });
    return { messageId, chatId: textValue(data.chat_id) };
  }

  return { saveConfig, login, logout, authStatus, searchContacts, searchChats, send,
    dispose() { cancelLogin(); for (const child of children) child.kill('SIGTERM'); } };
}

module.exports = { createLarkService, REQUIRED_SCOPES, sanitizeError };
