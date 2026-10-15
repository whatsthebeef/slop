import type { AtfIntegration } from './types.js';

/**
 * What the server's own configuration lets push-mode ATF start. Board settings only choose among these: a board admin
 * can't make slop start a project or assume a role the operator didn't list.
 */
export interface AtfPushPolicy {
  /** CodeBuild project names slop may start: exact names, or a prefix ending in `*`. Empty: push mode is off. */
  readonly projects: readonly string[];
  /** AWS account IDs whose roles slop may assume. Empty: no role can be assumed. */
  readonly roleAccounts: readonly string[];
}

/** No allow-list: push mode is off. */
export const ATF_PUSH_OFF: AtfPushPolicy = { projects: [], roleAccounts: [] };

const projectAllowed = (project: string, projects: readonly string[]): boolean =>
  projects.some((p) => (p.endsWith('*') ? project.startsWith(p.slice(0, -1)) : project === p));

/** The account ID in a role ARN (`arn:aws:iam::<account>:role/...`), or null for anything else. */
export const roleAccount = (roleArn: string): string | null => /^arn:aws:iam::(\d{12}):role\//.exec(roleArn)?.[1] ?? null;

/** Why push mode may not use this setting, in plain words, or null when the server's allow-list permits it. */
export const atfPushRefusal = (atf: AtfIntegration, policy: AtfPushPolicy): string | null => {
  if (policy.projects.length === 0) {
    return 'ATF push mode is off: the server has no allow-listed CodeBuild projects (ATF_PUSH_ALLOWED_PROJECTS)';
  }
  if (!projectAllowed(atf.project, policy.projects)) {
    return `CodeBuild project ${atf.project} is not on the server's push allow-list`;
  }
  if (atf.roleArn !== undefined) {
    const account = roleAccount(atf.roleArn);
    if (account === null || !policy.roleAccounts.includes(account)) {
      return `Role ${atf.roleArn} is not in an account on the server's push allow-list (ATF_PUSH_ALLOWED_ROLE_ACCOUNTS)`;
    }
  }
  return null;
};

/** The same push target: what a board admin may leave as it is. */
export const samePushTarget = (a: AtfIntegration | null | undefined, b: AtfIntegration | null | undefined): boolean =>
  a?.mode === 'push' &&
  b?.mode === 'push' &&
  a.region === b.region &&
  a.project === b.project &&
  a.roleArn === b.roleArn;
