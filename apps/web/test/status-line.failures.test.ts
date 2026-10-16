import { describe, expect, it } from 'vitest';
import { statusLine } from '@slop/core';
import { NOW } from '../../../packages/core/test/fixtures';
import { failedChecks, view } from './helpers/glob-views';

describe('needs_pairing failure', () => {
  it('says which decision needs a person, and falls back to the reason', () => {
    const failed = (decision?: string) =>
      view({
        status: 'failed',
        list: 'doing',
        failure: {
          reason: 'Gave up',
          at: NOW,
          kind: 'needs_pairing',
          ...(decision === undefined ? {} : { decision }),
        },
      });
    expect(JSON.stringify(statusLine(failed('Which storage to use?'), NOW))).toContain(
      'Needs a person: Which storage to use?',
    );
    expect(JSON.stringify(statusLine(failed(), NOW))).toContain('Needs a person: Gave up');
  });
});

describe('provisioning failure', () => {
  it('shows the reason and fix first, ahead of every other problem', () => {
    const reason =
      "Couldn't create branch s1t1 on acme/app: the slop GitHub App can't see that repo. Install it on the repo, or add the repo to its access, then Start over.";
    const g = view({
      status: 'failed',
      provisioning: 'failed',
      failure: { reason, at: NOW, kind: 'provisioning' },
      headChecks: failedChecks,
    });
    const line = statusLine(g, NOW);
    expect(line).toMatchObject({ kind: 'provisioning', full: reason });
    expect(line?.tip).not.toContain('the routine run failed');
  });
});
