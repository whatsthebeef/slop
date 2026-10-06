// Runs a command and restarts it when files under the watched directories change.
// Usage: node scripts/dev-watch.mjs [--before "<shell command>"] <dir>,<dir>... -- <command> [args]
// The --before command runs ahead of every restart (dev.sh uses it to snapshot the database
// when the change brought a new migration).
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';

const argv = process.argv.slice(2);
let before = '';
if (argv[0] === '--before') {
  before = argv[1] ?? '';
  argv.splice(0, 2);
}
const split = argv.indexOf('--');
const dirs = (argv[0] ?? '').split(',').filter(Boolean);
const command = argv.slice(split + 1);
if (split < 1 || command.length === 0) {
  console.error('Usage: dev-watch.mjs [--before cmd] <dir>,<dir> -- <command> [args]');
  process.exit(2);
}

const ignored = /(^|[\\/])(node_modules|dist|\.git|\.reviews)([\\/]|$)/;
let child = null;
let timer = null;
let restarting = false;

function run() {
  child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (!restarting) console.log(`[watch] server exited (${signal ?? code}); waiting for a change`);
    child = null;
  });
}

function restart(file) {
  restarting = true;
  const start = () => {
    console.log(`[watch] ${file} changed; restarting`);
    if (before) spawnSync(before, { shell: true, stdio: 'inherit' });
    restarting = false;
    run();
  };
  if (child) {
    child.once('exit', start);
    child.kill('SIGTERM');
  } else {
    start();
  }
}

for (const dir of dirs) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file || ignored.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      restart(`${dir}/${file}`);
    }, 300);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child?.kill(sig);
    process.exit(0);
  });
}

run();
