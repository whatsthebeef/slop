import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import type { Result } from '../src/domain/errors.js';
import {
  DEFAULT_REVIEW_BOARD_SETTINGS,
  mergeReviewSettings,
  resolveReviewSettings,
  reviewSettingsOf,
} from '../src/domain/review-settings.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('review settings (domain)', () => {
  it('reads a missing or unrecognised stored key as its default', () => {
    expect(reviewSettingsOf({})).toEqual(DEFAULT_REVIEW_BOARD_SETTINGS);
    expect(reviewSettingsOf(null)).toEqual(DEFAULT_REVIEW_BOARD_SETTINGS);
    expect(reviewSettingsOf({ enabled: false, model: '  ' })).toMatchObject({
      enabled: false,
      model: null,
    });
  });

  it('a change leaves the keys it does not name, and can set the model and cap back to the default', () => {
    const current = {
      ...DEFAULT_REVIEW_BOARD_SETTINGS,
      model: 'm1',
      toolCap: 20,
      minSeverity: 'high' as const,
    };
    expect(mergeReviewSettings(current, { enabled: false })).toEqual({
      ...current,
      enabled: false,
    });
    expect(mergeReviewSettings(current, { model: null, toolCap: null })).toMatchObject({
      model: null,
      toolCap: null,
      minSeverity: 'high',
    });
    expect(mergeReviewSettings(current, { model: undefined })).toEqual(current);
  });

  it('resolves against the server model and adds the board paths to the merge policy ones', () => {
    const defaults = {
      defaultModel: 'server-model',
      mergePolicyIgnoredPaths: ['**/yarn.lock', 'docs/**'],
    };
    expect(resolveReviewSettings(DEFAULT_REVIEW_BOARD_SETTINGS, defaults)).toEqual({
      model: 'server-model',
      minSeverity: 'medium',
      ignoredPaths: ['**/yarn.lock', 'docs/**'],
      toolCap: null,
    });
    const own = {
      ...DEFAULT_REVIEW_BOARD_SETTINGS,
      model: 'mine',
      ignoredPaths: ['docs/**', 'gen/**'],
      toolCap: 5,
    };
    expect(resolveReviewSettings(own, defaults)).toMatchObject({
      model: 'mine',
      ignoredPaths: ['**/yarn.lock', 'docs/**', 'gen/**'],
      toolCap: 5,
    });
  });
});

describe('review settings on a board', () => {
  let boards: BoardService;
  let store: MemoryStore;
  let boardId: number;

  const settings = async () => unwrap(await boards.get(ADMIN, boardId)).board;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boards = new BoardService({ store, notifier: new RecordingNotifier() });
    boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'demo',
        repo: null,
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('starts on the defaults: reviewing on', async () => {
    expect((await settings()).review).toEqual(DEFAULT_REVIEW_BOARD_SETTINGS);
  });

  it('merges a partial change over what is stored and keeps the rest', async () => {
    unwrap(
      await boards.updateSettings(ADMIN, boardId, (await settings()).version, {
        review: { enabled: false, model: 'm1' },
      }),
    );
    unwrap(
      await boards.updateSettings(ADMIN, boardId, (await settings()).version, {
        review: { toolCap: 20, ignoredPaths: ['gen/**'] },
      }),
    );
    expect((await settings()).review).toEqual({
      enabled: false,
      model: 'm1',
      minSeverity: 'medium',
      ignoredPaths: ['gen/**'],
      toolCap: 20,
    });
    // Other settings leave the review settings alone.
    unwrap(
      await boards.updateSettings(ADMIN, boardId, (await settings()).version, {
        autoInvestigate: false,
      }),
    );
    expect((await settings()).review.enabled).toBe(false);
  });

  it('refuses invalid values and changes nothing', async () => {
    const version = (await settings()).version;
    const bad = [
      { model: '  ' },
      { minSeverity: 'urgent' as never },
      { ignoredPaths: ['ok/**', ' '] },
      { toolCap: 0 },
      { toolCap: 2.5 },
      { toolCap: 51 },
      { model: 'a b' },
      { model: 'm\n1' },
      { model: 'a'.repeat(201) },
      { ignoredPaths: Array.from({ length: 51 }, (_, i) => `p${String(i)}/**`) },
      { ignoredPaths: ['a'.repeat(201)] },
      { ignoredPaths: ['**/a/**/b/**/c/**/d/**/e/**/f/**'] },
    ];
    for (const review of bad)
      expect(
        (await boards.updateSettings(ADMIN, boardId, version, { review })).ok,
        JSON.stringify(review),
      ).toBe(false);
    expect((await settings()).version).toBe(version);
  });

  it('trims the model and the paths before storing them', async () => {
    unwrap(
      await boards.updateSettings(ADMIN, boardId, (await settings()).version, {
        review: { model: ' openai.gpt-oss-120b ', ignoredPaths: [' docs/** ', 'gen/**\t'] },
      }),
    );
    expect((await settings()).review).toMatchObject({
      model: 'openai.gpt-oss-120b',
      ignoredPaths: ['docs/**', 'gen/**'],
    });
  });

  it('accepts the limits themselves', async () => {
    const result = await boards.updateSettings(ADMIN, boardId, (await settings()).version, {
      review: { model: 'us.vendor.model-v1:0', ignoredPaths: ['a/**/b/**/c/**/d/**/e/**', 'x'.repeat(200)] },
    });
    expect(result.ok).toBe(true);
  });

  it('is for admins only', async () => {
    const result = await boards.updateSettings(DEV, boardId, (await settings()).version, {
      review: { enabled: false },
    });
    expect(result.ok).toBe(false);
  });
});
