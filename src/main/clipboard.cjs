const { spawn } = require('node:child_process');
const readline = require('node:readline');
// One AppKit process supplies sequence, foreground and text; never logs clipboard text.
const script = `ObjC.import('AppKit'); ObjC.import('Foundation');
var last = Number($.NSPasteboard.generalPasteboard.changeCount);
var lastApp = '';
function emit(value) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
emit({ ready: true, sequence: last });
while (true) {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var foreground = front.isNil() ? '' : ObjC.unwrap(front.bundleIdentifier);
  var sequence = Number($.NSPasteboard.generalPasteboard.changeCount);
  if (sequence !== last) {
    var value = { sequence: sequence, foreground: foreground };
    if (foreground === 'com.openai.codex') {
      var text = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
      value.text = text.isNil() ? '' : ObjC.unwrap(text);
    }
    emit(value);
    last = sequence;
  } else if (foreground !== lastApp) emit({ sequence: sequence, foreground: foreground });
  lastApp = foreground;
  // NSWorkspace refreshes its foreground cache when the main run loop handles notifications.
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.025));
}`;
function watchClipboard(onEvent, onStatus, log, { benchmark = false } = {}) {
  const source = benchmark ? script.replace("if (foreground === 'com.openai.codex')", 'if (true)').replace('foreground: foreground', "foreground: 'com.openai.codex'") : script;
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  let lastForeground, lastSequence;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  log('observer_starting', { intervalMs: 25 });
  child.on('error', (error) => { log('observer_failed', { code: error.code }); onStatus('error'); readyReject(error); });
  child.stderr.on('data', () => log('observer_stderr', { status: 'diagnostic_available' }));
  child.on('exit', (code, signal) => {
    log('observer_exit', { code, signal, expected: closed });
    if (!closed) { onStatus('error'); readyReject(new Error('剪贴板观察器已退出。')); }
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const value = JSON.parse(line);
      if (value.ready) { lastSequence = value.sequence; log('observer_ready'); onStatus('listening'); readyResolve(); }
      else {
        if (value.foreground !== lastForeground) {
          lastForeground = value.foreground;
          log('observer_foreground_changed', { foreground: value.foreground, sequence: value.sequence });
        }
        if (value.sequence !== lastSequence) {
          lastSequence = value.sequence;
          log('observer_clipboard_changed', { foreground: value.foreground, sequence: value.sequence });
        }
        onEvent(value);
      }
    } catch { log('observer_output_invalid'); }
  });
  return { ready, close() { closed = true; child.kill(); } };
}
module.exports = { watchClipboard };
