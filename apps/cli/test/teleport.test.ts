import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideTeleport,
  encodeProjectDir,
  hasLocalConversation,
  sessionIdOf,
} from '../src/teleport.js';

const run = { sessionUrl: 'https://claude.ai/code/session_01ABC', routineOwner: 'Me@Example.com' };

describe('decideTeleport', () => {
  it('teleports an owned routine session when there is no local conversation', () => {
    expect(decideTeleport({ run, me: 'me@example.com', hasLocalConversation: false })).toEqual({
      teleport: true,
      session: 'session_01ABC',
    });
  });

  it('does not teleport with a local conversation, another owner, no session or no run', () => {
    expect(decideTeleport({ run, me: 'me@example.com', hasLocalConversation: true }).teleport).toBe(
      false,
    );
    expect(
      decideTeleport({ run, me: 'you@example.com', hasLocalConversation: false }).teleport,
    ).toBe(false);
    expect(
      decideTeleport({
        run: { routineOwner: 'me@example.com' },
        me: 'me@example.com',
        hasLocalConversation: false,
      }).teleport,
    ).toBe(false);
    expect(
      decideTeleport({ run: null, me: 'me@example.com', hasLocalConversation: false }).teleport,
    ).toBe(false);
  });

  it('--teleport forces it when there is a session; --no-teleport never does', () => {
    expect(
      decideTeleport({ run, me: 'you@example.com', hasLocalConversation: true, force: 'teleport' })
        .teleport,
    ).toBe(true);
    expect(
      decideTeleport({ run: null, me: 'a', hasLocalConversation: false, force: 'teleport' })
        .teleport,
    ).toBe(false);
    expect(
      decideTeleport({
        run,
        me: 'me@example.com',
        hasLocalConversation: false,
        force: 'no-teleport',
      }).teleport,
    ).toBe(false);
  });
});

describe('local conversations', () => {
  it('encodes a directory like Claude Code does', () => {
    expect(encodeProjectDir('/home/user/my_repo.x')).toBe('-home-user-my-repo-x');
    expect(sessionIdOf('session_01X')).toBe('session_01X');
  });

  it('finds a conversation under the projects directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'slop-home-'));
    expect(await hasLocalConversation(home, '/work/s1t4')).toBe(false);
    const dir = join(home, '.claude', 'projects', encodeProjectDir('/work/s1t4'));
    await mkdir(dir, { recursive: true });
    expect(await hasLocalConversation(home, '/work/s1t4')).toBe(false);
    await writeFile(join(dir, 'abc.jsonl'), '{}\n');
    expect(await hasLocalConversation(home, '/work/s1t4')).toBe(true);
  });
});
