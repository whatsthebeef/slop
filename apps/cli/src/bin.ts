import { setTimeout as sleep } from 'node:timers/promises';
import { isatty } from 'node:tty';
import { openInBrowser } from './auth.js';
import { defaultConfigSources, findGitRoot, loadSettings } from './config.js';
import { systemGit } from './git.js';
import { claudeHasMcpServer } from './init.js';
import { EXIT_FAILURE, main } from './main.js';
import { defaultTokenStore } from './token-store.js';
import { describeError } from './util.js';

function log(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

// The `slop` executable: wires the real environment into main().
try {
  process.exitCode = await main(process.argv.slice(2), {
    settings: loadSettings(defaultConfigSources()),
    store: await defaultTokenStore(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    // Not process.stdin.isTTY: that is undefined at runtime (despite its type) for a pipe or file.
    canPrompt: isatty(0),
    openBrowser: openInBrowser,
    log,
    stdout: (text) => process.stdout.write(text),
    gitRoot: () => findGitRoot(process.cwd()),
    isMcpServerConfigured: claudeHasMcpServer,
    git: systemGit,
    sleep: (ms) => sleep(ms),
  });
} catch (error) {
  // Reading the config files or finding the token store failed before any command ran.
  log(`slop: ${describeError(error)}`);
  process.exitCode = EXIT_FAILURE;
}
