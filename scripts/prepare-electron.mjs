import { createRequire } from 'node:module';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './prepare-cli.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

export async function prepareElectron({ signal } = {}) {
  if (process.platform !== 'darwin') throw new Error('Electron 运行时准备仅支持 macOS');
  const { version } = require('electron/package.json');
  const checksums = require('electron/checksums.json');
  const { downloadArtifact } = require('@electron/get');
  console.log(`[Electron] 准备锁定运行时 ${version}/${process.arch}`);
  const archive = await downloadArtifact({ version, artifactName: 'electron', platform: 'darwin', arch: process.arch, checksums });
  const directory = path.join(root, 'node_modules/electron/dist');
  // macOS ditto avoids the npm installer's silent JS extraction failure.
  await run('/usr/bin/ditto', ['-x', '-k', archive, directory], { signal });
  const relative = 'Electron.app/Contents/MacOS/Electron';
  if (!(await stat(path.join(directory, relative))).isFile() || (await readFile(path.join(directory, 'version'), 'utf8')).trim().replace(/^v/, '') !== version) {
    throw new Error('Electron 运行时文件或版本不完整，停止打包');
  }
  await writeFile(path.join(root, 'node_modules/electron/path.txt'), relative);
  console.log(`[Electron] 运行时 ${version} 已校验并解压`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareElectron().catch((error) => { console.error(`[Electron] ${error.message}`); process.exitCode = 1; });
}
