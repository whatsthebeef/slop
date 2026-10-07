import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRoutines, runInstructions } from '../src/routines.js';

describe('routine directory', () => {
  let dir = '';
  let routines: FileRoutines;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slop-routines-'));
    const file = join(dir, 'routines.json');
    await writeFile(
      file,
      JSON.stringify({
        'dev@example.com': { url: 'https://example.com/default', token: 'default' },
        'dev@example.com#16': { url: 'https://example.com/board-16', token: 'board-16' },
      }),
    );
    routines = new FileRoutines(file);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses a board's own routine when the developer has one for it", async () => {
    expect((await routines.secretFor('Dev@Example.com', 16))?.token).toBe('board-16');
  });

  it("falls back to the developer's default routine for other boards", async () => {
    expect((await routines.secretFor('dev@example.com', 15))?.token).toBe('default');
    expect((await routines.secretFor('dev@example.com'))?.token).toBe('default');
  });

  it('counts a board-only routine for that board and not for others', async () => {
    const file = join(dir, 'board-only.json');
    await writeFile(file, JSON.stringify({ 'po@example.com#16': { url: 'https://example.com/po-16', token: 'po-16' } }));
    const boardOnly = new FileRoutines(file);
    expect(await boardOnly.hasRoutine('po@example.com', 16)).toBe(true);
    expect(await boardOnly.hasRoutine('po@example.com', 15)).toBe(false);
  });

  it('has nothing for a developer without a routine', async () => {
    expect(await routines.secretFor('other@example.com', 16)).toBeNull();
  });
});

describe('routine run instructions', () => {
  const glob = { id: 's16b1', title: 'Fix sstor' };

  it("name the board's repository and say to stop if the session doesn't have it", () => {
    const text = runInstructions(glob, 'run-1', 'whatsthebeef/sessionator');
    expect(text).toContain('Repository: whatsthebeef/sessionator.');
    expect(text).toContain('report_failure');
    expect(text).toContain('git checkout -B s16b1 origin/s16b1');
  });

  it('leave the repository out for a board without one', () => {
    expect(runInstructions(glob, 'run-1', null)).not.toContain('Repository:');
  });
});
