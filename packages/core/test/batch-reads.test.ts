import { describe, expect, it } from 'vitest';
import type { Artifact } from '../src/domain/knowledge.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';

const artifact = (globId: string, kind: Artifact['kind'], label: string, content: string): Omit<Artifact, 'id' | 'version'> => ({
  globId,
  kind,
  label,
  content,
  link: null,
  commitSha: null,
  provenance: { by: 'human', actor: 'dev@example.com', runId: null, agentSetVersion: null },
  createdAt: NOW,
});

describe('MemoryStore batch reads', () => {
  it('returns the latest artifact per glob, kind and label, of the asked globs and kinds', async () => {
    const store = new MemoryStore();
    const latest = await store.transaction(async (tx) => {
      await tx.insertArtifact(artifact('s1k1', 'plan', '', 'v1'));
      await tx.insertArtifact(artifact('s1k1', 'plan', '', 'v2'));
      await tx.insertArtifact(artifact('s1k1', 'draft', '', 'draft'));
      await tx.insertArtifact(artifact('s1k2', 'plan', '', 'other'));
      return tx.latestArtifacts(['s1k1'], ['plan']);
    });
    expect(latest.map((a) => [a.globId, a.version, a.content])).toEqual([['s1k1', 2, 'v2']]);
  });

  it('reports each queued effect as a pending job with no attempts, the newest per glob and kind', async () => {
    const store = new MemoryStore();
    const jobs = await store.transaction(async (tx) => {
      await tx.enqueueEffects([
        { kind: 'reconcile_pr', globId: 's1t1', generation: 1 },
        { kind: 'reconcile_pr', globId: 's1t1', generation: 2 },
        { kind: 'refresh_checks', globId: 's1t2', generation: 1 },
      ]);
      return tx.latestOutboxJobs(['s1t1'], ['reconcile_pr']);
    });
    expect(jobs).toEqual([{ id: expect.any(Number) as number, globId: 's1t1', kind: 'reconcile_pr', state: 'pending', attempts: 0, lastError: null, runAfter: expect.any(String) as string }]);
    // The newest is the second reconcile queued.
    const queued = store.state.outboxJobs.filter((j) => j.kind === 'reconcile_pr');
    expect(queued.map((j) => j.effect)).toEqual([expect.objectContaining({ generation: 1 }), expect.objectContaining({ generation: 2 })]);
    expect(jobs[0]?.id).toBe(queued[1]?.id);
  });
});
