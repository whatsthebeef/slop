import type { Glob } from '@slop/core';
import type { CodeHost } from '../../src/codehost.js';

/**
 * The one fake `CodeHost` the server tests share: every method has a harmless default, so a new `CodeHost` method
 * is added here and nowhere else. Tests override what they need, either by subclassing (to keep state beside the
 * overrides) or with `fakeCodeHost({ ... })`.
 */
export class FakeCodeHost implements CodeHost {
  readonly configured: boolean = true;

  connection: CodeHost['connection'] = () => Promise.resolve({ configured: true, connected: true, installUrl: null, appName: null });
  provision: CodeHost['provision'] = (_repo: unknown, glob: Glob) => Promise.resolve({ branch: glob.id, pr: { number: 1, headSha: 'abcdef0123456789' } });
  openDraftPr: CodeHost['openDraftPr'] = () => Promise.resolve(null);
  syncLabels: CodeHost['syncLabels'] = () => Promise.resolve();
  closePr: CodeHost['closePr'] = () => Promise.resolve();
  deleteBranch: CodeHost['deleteBranch'] = () => Promise.resolve();
  reopenPr: CodeHost['reopenPr'] = () => Promise.resolve('reopened');
  mergeState: CodeHost['mergeState'] = () => Promise.resolve({ sha: 'abcdef0123456789', state: 'passed' });
  completedCheckRun: CodeHost['completedCheckRun'] = () => Promise.resolve(null);
  readFile: CodeHost['readFile'] = () => Promise.resolve(null);
  listFiles: CodeHost['listFiles'] = () => Promise.resolve([]);
  commitFiles: CodeHost['commitFiles'] = () => Promise.resolve({ parent: null, files: [] });
  markReady: CodeHost['markReady'] = () => Promise.resolve({ wasDraft: true, sha: 'abcdef0123456789' });
  conflictState: CodeHost['conflictState'] = () => Promise.resolve('clean');
  conflictFiles: CodeHost['conflictFiles'] = () => Promise.resolve([]);
  behindBase: CodeHost['behindBase'] = () => Promise.resolve({ behindBy: 0, files: [] });
  commentOnce: CodeHost['commentOnce'] = () => Promise.resolve('posted');
  diffSummary: CodeHost['diffSummary'] = () => Promise.resolve({ changedLines: 0, files: [] });
  commitDiffSummary: CodeHost['commitDiffSummary'] = () => Promise.resolve({ changedLines: 0, files: [] });
  headOf: CodeHost['headOf'] = () => Promise.resolve(null);
  commitChecks: CodeHost['commitChecks'] = () => Promise.resolve({ state: 'passed', failure: null });
  cancelledChecks: CodeHost['cancelledChecks'] = () => Promise.resolve([]);
  rerequestCheck: CodeHost['rerequestCheck'] = () => Promise.resolve();
  updateBranch: CodeHost['updateBranch'] = () => Promise.resolve('up_to_date');
  squashMerge: CodeHost['squashMerge'] = () => Promise.resolve({ outcome: 'merged', sha: 'm1' });
  revertCommit: CodeHost['revertCommit'] = () => Promise.resolve('reverted');
}

/** A fake host with `overrides` in place of the defaults. */
export const fakeCodeHost = (overrides: Partial<CodeHost> = {}): CodeHost => Object.assign(new FakeCodeHost(), overrides);
