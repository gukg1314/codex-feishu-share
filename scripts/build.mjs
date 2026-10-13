import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const [command, args] of [['node', ['node_modules/typescript/bin/tsc', '--noEmit']], ['node', ['node_modules/vite/bin/vite.js', 'build']]]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Build failed: ${command} ${args[0]}`);
}
for (const name of ['main', 'preload']) {
  rmSync(`${root}/dist/${name}`, { recursive: true, force: true });
  mkdirSync(`${root}/dist/${name}`, { recursive: true });
  cpSync(`${root}/src/${name}`, `${root}/dist/${name}`, { recursive: true });
}
console.log('[build] UI and Electron sources ready');
