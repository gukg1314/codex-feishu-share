import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const CLI_SOURCE = Object.freeze({
  version: '1.0.72',
  commit: '4a56748bfa941ff0ee0bfec92e65acac427732b0',
  archiveSha256: 'c8d26dcbbdee1aedaa0d42c8055429b0275a8e70f1c69b891f568e7ff17c61d7',
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 失败（${signal ?? code}）`)));
  });
}

export async function applyPinnedPatches(directory) {
  const patches = JSON.parse(await readFile(path.join(root, 'patches/lark-cli.json'), 'utf8'));
  const prepared = [];
  for (const patch of patches) {
    const file = path.join(directory, patch.file);
    let source = await readFile(file, 'utf8');
    if (sha256(source) !== patch.sha256) throw new Error(`CLI 源码与固定版本不符：${patch.file}`);
    for (const replacement of patch.replacements) {
      const pieces = source.split(replacement.before);
      if (pieces.length - 1 !== replacement.count) throw new Error(`CLI 补丁位置不符：${patch.file}`);
      source = pieces.join(replacement.after);
    }
    prepared.push({ file, source, relative: patch.file, sha256: sha256(source) });
  }
  // 全部原文件和替换次数验证后才写入，避免半套补丁被构建。
  for (const patch of prepared) await writeFile(patch.file, patch.source);
  console.log(`[CLI] ${prepared.length} 个固定补丁已应用（含仅本地退出）`);
  return Object.fromEntries(prepared.map((item) => [item.relative, item.sha256]));
}

export async function prepareCli(options = {}) {
  const cache = path.join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, `lark-cli-${CLI_SOURCE.commit}.tar.gz`);
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    console.log(`[CLI] 下载固定源码 ${CLI_SOURCE.commit}`);
    const response = await fetch(`https://codeload.github.com/larksuite/cli/tar.gz/${CLI_SOURCE.commit}`, { signal: options.signal ?? AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`CLI 源码下载失败：HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== CLI_SOURCE.archiveSha256) throw new Error('CLI 下载 SHA-256 不符，停止构建');
    await writeFile(`${archive}.tmp`, bytes);
    await rename(`${archive}.tmp`, archive);
  }
  if (sha256(bytes) !== CLI_SOURCE.archiveSha256) throw new Error('CLI 缓存 SHA-256 不符，请删除损坏缓存后重试');
  const source = await mkdtemp(path.join(cache, 'cli-source-'));
  try {
    await run('/usr/bin/tar', ['-xzf', archive, '-C', source, '--strip-components=1'], { signal: options.signal });
    const patchedSources = await applyPinnedPatches(source);
    const directory = path.join(root, 'bin', 'arm64');
    await mkdir(directory, { recursive: true });
    const binary = path.join(directory, 'lark-cli');
    const temporary = `${binary}.tmp`;
    const binaries = {};
    console.log(`[CLI] 构建 darwin/arm64，固定版本 ${CLI_SOURCE.version}`);
    try {
      await run('go', ['build', '-buildvcs=false', '-trimpath', '-ldflags', `-s -w -X github.com/larksuite/cli/internal/build.Version=${CLI_SOURCE.version}`, '-o', temporary, '.'], {
        cwd: source,
        env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64', GOTOOLCHAIN: 'local' },
        signal: options.signal,
      });
      await chmod(temporary, 0o755);
      binaries.arm64 = { sha256: sha256(await readFile(temporary)), goarch: 'arm64' };
      await rename(temporary, binary);
    } finally { await rm(temporary, { force: true }); }
    const manifest = { ...CLI_SOURCE, patchedSources, binaries };
    await writeFile(path.join(root, 'bin/build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('[CLI] 构建完成，源码及二进制校验记录：bin/build-manifest.json');
    return manifest;
  } finally { await rm(source, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareCli().catch((error) => {
    console.error(`[CLI] ${error.message}`);
    process.exitCode = 1;
  });
}
