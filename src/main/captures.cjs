const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { normalize, digest, privateDirectory } = require('./common.cjs');
class CaptureIndex {
  constructor(directory, log, onUpdate) {
    this.directory = directory;
    this.log = log;
    this.records = new Map();
    this.byHash = new Map();
    privateDirectory(directory);
    for (const file of fs.readdirSync(directory)) this.load(file);
    log('cache_loaded', { replies: this.records.size });
    this.watcher = fs.watch(directory, (_event, filename) => {
      if (!filename?.endsWith('.json')) return;
      if (this.load(filename)) onUpdate();
    });
  }
  load(filename) {
    if (!filename.endsWith('.json')) return false;
    const previous = this.records.get(filename);
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.directory, filename), 'utf8'));
      if (typeof record.text !== 'string' || !normalize(record.text) || typeof record.turnId !== 'string' || typeof record.capturedAt !== 'string' || record.sha256 !== digest(record.text) || record.copySha256 !== digest(normalize(record.text))) throw new Error('invalid_capture');
      if (previous) this.byHash.get(previous.copySha256)?.delete(filename);
      this.records.set(filename, record);
      if (!this.byHash.has(record.copySha256)) this.byHash.set(record.copySha256, new Map());
      this.byHash.get(record.copySha256).set(filename, record);
      this.log('cache_updated', { turnId: record.turnId, chars: [...record.text].length, sha256: record.sha256 });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' && previous) {
        this.records.delete(filename);
        this.byHash.get(previous.copySha256)?.delete(filename);
      }
      this.log('cache_read_failed', { code: error.code || 'invalid_capture' });
      return false;
    }
  }
  match(raw) {
    const value = normalize(raw);
    const matches = this.byHash.get(digest(value));
    return matches && [...matches.values()].find((record) => normalize(record.text) === value);
  }
  latestTime() { return [...this.records.values()].map((record) => record.capturedAt).sort().at(-1); }
  close() { this.watcher.close(); }
}
class Matcher {
  constructor(index, onMatch, clock = () => performance.now()) {
    this.index = index;
    this.onMatch = onMatch;
    this.clock = clock;
    this.candidate = null;
    this.busy = false;
  }
  observe({ foreground, text, sequence }, detectedAt = this.clock()) {
    if (foreground !== 'com.openai.codex') { this.clear(); return; }
    if (this.busy || typeof text !== 'string') return;
    this.clear();
    this.candidate = { text, sequence, detectedAt };
    this.expiry = setTimeout(() => this.clear(), 500);
    this.retry();
  }
  retry() {
    if (!this.candidate || this.busy) return;
    const candidate = this.candidate;
    const cacheWaitMs = this.clock() - candidate.detectedAt;
    if (cacheWaitMs > 500) { this.clear(); return; }
    const record = this.index.match(candidate.text);
    if (!record) return;
    this.clear();
    this.busy = true;
    this.onMatch(record, { detectedAt: candidate.detectedAt, cacheWaitMs, sequence: candidate.sequence });
  }
  clear() { clearTimeout(this.expiry); this.candidate = null; }
  release() { this.clear(); this.busy = false; }
}
module.exports = { CaptureIndex, Matcher };
