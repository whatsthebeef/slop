// Runs the slop server and restarts it when server, core or catalog files change.
// Used by `scripts/dev.sh watch`. Usage: node scripts/dev-watch.mjs <server-dir> [node args...]
// Before each restart, SLOP_DEV_PRESTART (if set) runs, so dev.sh can snapshot the database
// before the server migrates new code.
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';

const [serverDir, ...nodeArgs] = process.argv.slice(2);
const root = resolve(serverDir, '../..');
const watched = ['apps/server/src', 'apps/server/drizzle', 'packages/core/src', 'catalog'].map((p) => resolve(root, p));
const args = [...nodeArgs, '--conditions=development', '--import', 'tsx', 'src/main.ts'];

let child;
let timer;
let starting = false;

function start(first) {
  if (!first && process.env.SLOP_DEV_PRESTART) {
    spawnSync(process.env.SLOP_DEV_PRESTART, { shell: true, stdio: 'inherit' });
  }
  console.log(`[watch] ${first ? 'starting' : 'restarting'} server`);
  child = spawn('node', args, { cwd: serverDir, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (!starting) console.log(`[watch] server exited (${signal ?? code}); waiting for a change`);
  });
}

function restart() {
  if (starting) return;
  starting = true;
  const begin = () => {
    starting = false;
    start(false);
  };
  if (child && child.exitCode === null && child.signalCode === null) {
    child.once('exit', begin);
    child.kill('SIGTERM');
  } else begin();
}

for (const dir of watched) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (file && /(^|[\\/])(node_modules|dist)([\\/]|$)/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(restart, 300);
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child?.kill(sig);
    process.exit(0);
  });
}
start(true);
