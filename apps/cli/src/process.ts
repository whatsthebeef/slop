import { spawn } from 'node:child_process';
import { SlopError } from './errors.js';

/** Runs a program with the terminal's stdio (claude); tests inject a fake so nothing is launched. */
export interface Runner {
  /** Resolves with the exit code. */
  run(command: string, args: readonly string[], cwd: string): Promise<number>;
}

export const systemRunner: Runner = {
  run: (command, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { cwd, stdio: 'inherit' });
      child.once('error', (error) =>
        reject(new SlopError(`could not run ${command}: ${error.message}`)),
      );
      child.once('close', (code) => resolve(code ?? 1));
    }),
};
