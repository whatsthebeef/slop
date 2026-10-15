import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '../../..');
const files = ['.github/workflows/checks.yml', 'catalog/scripts/checks.yml'];
// A merge_group event has no pull_request object, so this draft guard evaluates true for it.
const draftGuard = "${{ github.event_name == 'push' || !github.event.pull_request.draft }}";

describe.each(files)('%s', (file) => {
  const wf = parse(readFileSync(resolve(root, file), 'utf8')) as {
    on: Record<string, { types?: string[] } | undefined>;
    jobs: Record<string, { if?: string }>;
  };

  it('runs on merge_group checks_requested', () => {
    expect(wf.on.merge_group?.types).toEqual(['checks_requested']);
  });

  it('skips no job for a merge group', () => {
    for (const job of Object.values(wf.jobs)) {
      expect(job.if === undefined || job.if === draftGuard).toBe(true);
    }
  });
});
