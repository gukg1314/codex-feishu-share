const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const index = process.argv.indexOf('--data-dir');
const dataDir = index >= 0 ? process.argv[index + 1] : path.join(os.homedir(), 'Library/Application Support/CodexFeishuShare');
const logDir = index >= 0 ? path.join(dataDir, 'logs') : path.join(os.homedir(), 'Library/Logs/CodexFeishuShare');
function log(event, fields) {
  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const file = path.join(logDir, 'hook.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
  } catch { }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const text = event.last_assistant_message;
    if (event.hook_event_name !== 'Stop' || typeof text !== 'string' || !text.trim()) {
      log('hook_ignored', { reason: 'empty_or_non_stop' });
    } else {
      if (typeof event.session_id !== 'string' || typeof event.turn_id !== 'string') throw new Error('missing_ids');
      const record = {
        sessionId: event.session_id, turnId: event.turn_id, text,
        sha256: hash(text), copySha256: hash(text.replace(/\r\n/g, '\n').trim()), capturedAt: new Date().toISOString(),
      };
      const directory = path.join(dataDir, 'captures');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      const file = path.join(directory, `${hash(`${record.sessionId}/${record.turnId}`)}.json`);
      if (!fs.existsSync(file)) {
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        fs.renameSync(temporary, file);
        log('hook_captured', { turnId: record.turnId, chars: [...text].length, sha256: record.sha256 });
      }
    }
  } catch (error) { log('hook_failed', { code: error.code || 'invalid_event' }); }
  process.stdout.write('{}\n');
});
