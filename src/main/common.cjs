const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const normalize = (text) => text.replace(/\r\n/g, '\n').trim();
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
function atomicJSON(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}
function createLog(directory, filename = 'app.jsonl') {
  privateDirectory(directory);
  const file = path.join(directory, filename);
  return (event, fields = {}) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
    } catch { /* Logging must not interrupt capture or sending. */ }
  };
}
module.exports = { normalize, digest, privateDirectory, atomicJSON, createLog };
