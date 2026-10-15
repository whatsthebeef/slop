import { describe, expect, it } from 'vitest';
import { statusLine } from '../src/lib/status-line';
import { positionOf } from '../src/lib/position';
import { NOW } from '../../../packages/core/test/fixtures';
import { prOpen, view } from './helpers/glob-views';

describe('merge conflict stall', () => {
  const files = Array.from(
    { length: 8 },
    (_, i) => `apps/web/src/components/long/path/file${String(i)}.tsx`,
  );
  const conflict = { base: 'main', files, since: 's1t2', at: NOW };
  const stalled = () =>
    prOpen({
      status: 'failed',
      list: 'doing',
      failure: { reason: `Merge conflict with main in ${files.join(', ')}`, at: NOW, conflict },
    });

  it('keeps the card to a short line and the glob view to the full reason', () => {
    const line = statusLine(stalled(), NOW);
    expect(line).toMatchObject({
      kind: 'failure',
      text: 'stalled · merge conflict',
      conflict: true,
    });
    expect(line?.full).toContain(files[0]);
  });

  it('puts no file paths in the position chip', () => {
    const position = positionOf(stalled(), NOW);
    expect(position?.holder).toBe('stalled');
    expect(position?.text).toBe('stalled: merge conflict');
    expect(position?.tip).not.toContain('file0');
  });

  it('says a flagged conflict in a few words, without the files', () => {
    const line = statusLine(prOpen({ conflict }), NOW);
    expect(line).toMatchObject({ kind: 'stuck', text: 'conflicts with main', conflict: true });
  });

  it('leaves other failures as they were', () => {
    const g = view({ status: 'failed', failure: { reason: 'Routine run failed: boom', at: NOW } });
    expect(statusLine(g, NOW)?.conflict).toBeUndefined();
    expect(statusLine(g, NOW)?.text).toBe('Routine run failed: boom');
  });
});
