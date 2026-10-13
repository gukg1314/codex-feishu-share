import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCli, run } from './prepare-cli.mjs';
import { prepareElectron } from './prepare-electron.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const product = 'codex分享飞书消息';
const bundleId = 'com.codexfeishushare.app';
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextReleaseVersion(record, directories = []) {
  if (!versionPattern.test(record)) throw new Error(`版本记录无效：${record}`);
  const versions = [record, ...directories.filter((name) => versionPattern.test(name))];
  const highest = versions.map((version) => version.split('.').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).at(-1);
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

export function artifactNames(version) {
  return [`${product}-${version}-mac-arm64.dmg`];
}

export function builderConfig(version, output) {
  if (!versionPattern.test(version)) throw new Error('打包版本无效');
  return {
    appId: bundleId,
    productName: product,
    buildVersion: version,
    asar: true,
    files: ['dist/**', 'package.json'],
    extraMetadata: { version, main: 'dist/main/main.cjs' },
    extraResources: [
      { from: 'bin/arm64/lark-cli', to: 'bin/lark-cli' },
      { from: 'bin/build-manifest.json', to: 'bin/build-manifest.json' },
      { from: 'hook/capture-hook.cjs', to: 'hook/capture-hook.cjs' },
      { from: 'assets/dock-icon.png', to: 'assets/dock-icon.png' },
      { from: 'assets/tray-iconTemplate.png', to: 'assets/tray-iconTemplate.png' },
      { from: 'assets/tray-iconTemplate@2x.png', to: 'assets/tray-iconTemplate@2x.png' },
      { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
      { from: 'node_modules/electron/LICENSE', to: 'licenses/Electron-LICENSE' },
      { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'licenses/LICENSES.chromium.html' },
    ],
    directories: { output },
    mac: {
      extendInfo: { LSUIElement: true },
      category: 'public.app-category.productivity',
      target: [{ target: 'dmg', arch: ['arm64'] }],
      artifactName: `${product}-\${version}-mac-arm64.\${ext}`,
      icon: 'assets/app.icns',
      identity: '-',
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
    },
    dmg: { title: product, sign: false },
  };
}

export async function publishArtifacts(staging, releaseRoot, version) {
  for (const name of artifactNames(version)) {
    const artifact = await stat(path.join(staging, name));
    if (!artifact.isFile() || artifact.size === 0) throw new Error(`缺少完整产物：${name}`);
  }
  const destination = path.join(releaseRoot, version);
  try { await stat(destination); throw new Error(`正式版本目录已存在：${destination}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // staging 和 release 在同一磁盘；完整 ARM64 DMG 验证后才发布目录。
  await rename(staging, destination);
  return artifactNames(version).map((name) => path.join(destination, name));
}

async function makeIcon(staging, signal) {
  const directory = path.join(staging, 'app.iconset');
  await mkdir(directory);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(root, 'assets/app-icon.png'), '--out', path.join(directory, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { signal });
    }
  }
  await run('/usr/bin/iconutil', ['-c', 'icns', directory, '-o', path.join(root, 'assets/app.icns')], { signal });
}

async function machArchitecture(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    if (bytesRead !== 8 || header.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`无效的 Mach-O：${file}`);
    const cpu = header.readUInt32LE(4);
    return cpu === 0x100000c ? 'arm64' : 'unknown';
  } finally { await handle.close(); }
}

async function validateApp(output, version) {
  const appName = `${product}.app`;
  const folders = await readdir(output, { withFileTypes: true });
  const unpacked = folders.find((item) => item.isDirectory() && item.name === 'mac-arm64');
  if (!unpacked) throw new Error('缺少 ARM64 App 目录');
  const app = path.join(output, unpacked.name, appName);
  const resources = path.join(app, 'Contents/Resources');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
  if (plist.CFBundleName !== product || plist.CFBundleDisplayName !== product || plist.CFBundleIdentifier !== bundleId || plist.CFBundleShortVersionString !== version || plist.CFBundleVersion !== version || plist.LSUIElement !== true) throw new Error('ARM64 App 的名称、版本、bundle ID 或后台启动设置不符');
  for (const file of ['app.asar', 'bin/lark-cli', 'bin/build-manifest.json', 'hook/capture-hook.cjs', 'assets/dock-icon.png', 'assets/tray-iconTemplate.png', 'assets/tray-iconTemplate@2x.png', 'THIRD_PARTY_NOTICES.md', 'licenses/Electron-LICENSE', 'licenses/LICENSES.chromium.html']) {
    const info = await stat(path.join(resources, file));
    if (!info.isFile() || !info.size) throw new Error(`App 缺少资源：${file}`);
  }
  const cli = path.join(resources, 'bin/lark-cli');
  if (((await stat(cli)).mode & 0o111) === 0 || await machArchitecture(cli) !== 'arm64') throw new Error('内置 CLI 架构或执行权限不符：ARM64');
  if (await machArchitecture(path.join(app, 'Contents/MacOS', plist.CFBundleExecutable)) !== 'arm64') throw new Error('Electron 架构不符：ARM64');
}

function assertToolchains() {
  if (process.platform !== 'darwin') throw new Error('DMG 打包请在 macOS 上运行');
  const node = process.versions.node.split('.').map(Number);
  if (node[0] < 22 || node[0] === 22 && node[1] < 12) throw new Error('请先安装 Node.js 22.12 或更高版本');
  let go;
  try { go = execFileSync('go', ['version'], { encoding: 'utf8' }); }
  catch { throw new Error('请先安装 Go 1.23 或更高版本'); }
  const match = /go(\d+)\.(\d+)/.exec(go);
  if (!match || Number(match[1]) < 1 || Number(match[1]) === 1 && Number(match[2]) < 23) throw new Error('请先安装 Go 1.23 或更高版本');
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.release-tmp`;
  try { await writeFile(temporary, contents); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function packageRelease() {
  assertToolchains();
  const releaseRoot = path.join(root, 'release');
  await mkdir(releaseRoot, { recursive: true });
  const lock = path.join(releaseRoot, '.package-lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有打包任务。确认任务已退出后删除锁目录：${lock}`);
    throw error;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const originals = new Map();
  let staging, version, published = false, updatingVersions = false;
  const logPath = path.join(releaseRoot, `package-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  async function log(message) { console.log(`[打包] ${message}`); await appendFile(logPath, `${new Date().toISOString()} ${message}\n`); }
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    for (const file of ['release-version.json', 'package.json', 'package-lock.json']) originals.set(file, await readFile(path.join(root, file), 'utf8'));
    const record = JSON.parse(originals.get('release-version.json'));
    const pkg = JSON.parse(originals.get('package.json'));
    const packageLock = JSON.parse(originals.get('package-lock.json'));
    if (pkg.version !== packageLock.version || pkg.version !== packageLock.packages[''].version) throw new Error('package.json 与锁文件版本不一致');
    const directories = (await readdir(releaseRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    version = nextReleaseVersion(record.version, directories);
    await log(`准备 ${version}，固定 CLI 1.0.72，目标 arm64`);
    staging = await mkdtemp(path.join(releaseRoot, '.staging-'));
    const signal = abort.signal;
    await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { signal });
    await prepareElectron({ signal });
    await run(process.execPath, [path.join(root, 'node_modules/esbuild/install.js')], { signal });
    await makeIcon(staging, signal);
    await prepareCli({ signal });
    await run('npm', ['run', 'build'], { signal });
    for (const file of ['dist/main/main.cjs', 'dist/preload/preload.cjs', 'dist/ui/index.html', 'hook/capture-hook.cjs']) if (!(await stat(path.join(root, file))).isFile()) throw new Error(`缺少构建入口：${file}`);
    const ready = path.join(staging, 'ready');
    await mkdir(ready);
    await log(`构建 arm64，App 名称 ${product}，版本元数据 ${version}`);
    const output = path.join(staging, 'arm64');
    const configPath = path.join(staging, 'builder-arm64.json');
    await writeFile(configPath, JSON.stringify(builderConfig(version, output), null, 2));
    const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    // 固定 ad-hoc 签名；忽略外部证书环境，避免意外使用开发者证书。
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_INSTALLER_LINK', 'CSC_INSTALLER_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete env[key];
    await run(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--mac', 'dmg', '--arm64', '--publish', 'never', '--config', configPath], { env, signal });
    await validateApp(output, version);
    const artifact = artifactNames(version)[0];
    const dmg = path.join(output, artifact);
    if ((await stat(dmg)).size === 0) throw new Error('DMG 为空：ARM64');
    await run('/usr/bin/hdiutil', ['verify', dmg], { signal });
    await rename(dmg, path.join(ready, artifact));
    await log('arm64 的 App 版本、资源、二进制架构及 DMG 结构检查完成');
    if (abort.signal.aborted) throw new Error('打包已取消');
    const files = await publishArtifacts(ready, releaseRoot, version);
    published = true;
    pkg.version = version;
    packageLock.version = version;
    packageLock.packages[''].version = version;
    updatingVersions = true;
    await atomicWrite(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    await atomicWrite(path.join(root, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`);
    await atomicWrite(path.join(root, 'release-version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
    await log(`${version} 完成，ARM64 DMG 已发布`);
    for (const file of files) console.log(file);
    console.log(`打包日志：${logPath}`);
    return files;
  } catch (error) {
    if (updatingVersions) for (const [file, source] of originals) await atomicWrite(path.join(root, file), source);
    if (published) await rm(path.join(releaseRoot, version), { recursive: true, force: true });
    await log(`失败：${error.message}；正式版本保持不变`);
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageRelease().catch((error) => { console.error(`[打包] ${error.message}`); process.exitCode = 1; });
}
