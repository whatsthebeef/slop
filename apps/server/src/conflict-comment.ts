import type { Glob, MergeConflict } from '@slop/core';

/** Marks the comment for one conflict, so a retried effect doesn't post it twice. */
export const conflictCommentMarker = (glob: Pick<Glob, 'id'>, requestedAt: string): string =>
  `<!-- slop:resolve-conflict ${glob.id} ${requestedAt} -->`;

const describe = (glob: Pick<Glob, 'id' | 'title' | 'summary'>): string =>
  `- ${glob.id}: ${glob.title}\n${glob.summary.trim() === '' ? '' : `\n${glob.summary.trim().replace(/^/gm, '  ')}\n`}`;

/**
 * The PR comment that asks the Claude GitHub App to resolve a conflict: both globs' intent, the files, and what to do.
 * `merged` is the glob whose merge caused the conflict, when slop knows it.
 */
export const conflictCommentBody = (
  glob: Pick<Glob, 'id' | 'title' | 'summary'>,
  merged: Pick<Glob, 'id' | 'title' | 'summary'> | null,
  conflict: MergeConflict,
  marker: string,
): string =>
  [
    `@claude this PR conflicts with \`${conflict.base}\`. Please resolve it on this branch.`,
    '',
    'This PR:',
    describe(glob),
    ...(merged === null ? [] : ['Merged into the base branch, causing the conflict:', describe(merged), '']),
    conflict.files.length === 0
      ? 'GitHub did not say which files conflict.'
      : `Files changed on both sides:\n${conflict.files.map((f) => `- \`${f}\``).join('\n')}`,
    '',
    'Instructions:',
    `1. Merge \`origin/${conflict.base}\` into this branch (\`git fetch origin ${conflict.base} && git merge origin/${conflict.base}\`); do not rebase or reset the branch.`,
    "2. Resolve the conflicts keeping both sides' intent.",
    '3. Run lint, the type check and the tests.',
    '4. Commit the merge and push it to this branch.',
    '',
    marker,
  ].join('\n');
