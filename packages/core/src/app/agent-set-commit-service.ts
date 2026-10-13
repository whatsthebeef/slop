import { agentSetManifest, AGENT_SET_MANIFEST_PATH, managedRepoFiles } from '../domain/agent-set.js';
import type { RepoFile } from '../domain/agent-set.js';
import { ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import * as machine from '../domain/machine.js';
import type { Context, Transition } from '../domain/machine.js';
import { formatId, letterOf } from '../domain/ids.js';
import type { Board, Glob } from '../domain/types.js';
import type { AgentSetRepo, Clock, Hint, Notifier, Store, Tx } from '../ports.js';
import { addArtifact } from './artifact-service.js';
import { DECISION_SYSTEM_ACTOR } from './decision-glob.js';
import type { KnowledgeService } from './knowledge-service.js';

/** The creation key prefix of a board's "Agent set vN" globs: `agent-set:<board>:<n>`, n counting them. */
export const agentSetKeyPrefix = (boardId: number): string => `agent-set:${String(boardId)}:`;

/** The title of the glob that brings the repo to agent-set version `version`. */
export const agentSetGlobTitle = (version: number): string => `Agent set v${String(version)}`;

const PLAN = `# Agent set

Slop opened this glob because the board's agent set changed (an approved learning, or a new catalog version) and the repo's \`.claude/\` is behind.

- Slop's GitHub App commits the agents, commands and hooks of the current set to this branch, and \`.claude/slop-agent-set.json\` with its version. When the set changes again before this merges, the newer set is committed to the same branch and the title follows.
- Review the diff against the committed version, then merge. Nobody edits these files by hand here: change the agent set through the Knowledge page, and slop commits it again.
- Settings, \`.mcp.json\` and CLAUDE.md are merged into a checkout by \`sstor init\`; slop doesn't commit them.
`;

/** What the commit job does next for a board (see `AgentSetCommitService.prepare`). */
export type AgentSetPrepared =
  /** Nothing to do: no board or repo, or the repo already holds the board's version and no glob is open. */
  | { readonly kind: 'dropped' }
  /** The glob's branch doesn't exist yet. */
  | { readonly kind: 'waiting'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly glob: Glob;
      readonly board: Board;
      readonly version: number;
      /** The files to commit, the manifest included. */
      readonly files: readonly RepoFile[];
    };

/** Whether the glob still can take a commit: not signed off, and its PR neither merged nor closed unmerged. */
export const isAgentSetGlobOpen = (glob: Glob): boolean => glob.status !== 'signed_off' && glob.pr?.state !== 'merged' && glob.pr?.state !== 'closed';

/** The board's agent-set globs, oldest first. */
const agentSetGlobs = async (tx: Tx, boardId: number): Promise<Glob[]> =>
  (await tx.findGlobsByCreationKeyPrefix(boardId, agentSetKeyPrefix(boardId))).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

class GlobMoved extends Error {}

/**
 * Slop's own "Agent set vN" glob (one open per board): finds or opens it, keeps its title on the board's version, and
 * renders the files the commit job puts on its branch. The job is `commit_agent_set`, queued on every agent-set bump.
 */
export class AgentSetCommitService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      knowledge: Pick<KnowledgeService, 'agentSetForDownload'>;
      repo: AgentSetRepo;
    },
  ) {}

  async prepare(boardId: number): Promise<AgentSetPrepared> {
    const board = await this.deps.store.transaction((tx) => tx.getBoard(boardId));
    if (board === null || (board.repo ?? '') === '') return { kind: 'dropped' };
    const committed = await this.deps.repo.committedVersion(board);
    const set = await this.deps.knowledge.agentSetForDownload(boardId);
    if (!set.ok) return { kind: 'dropped' };
    const version = set.value.version;
    const hints: Hint[] = [];
    const glob = await this.deps.store.transaction(async (tx) => {
      hints.length = 0;
      return this.openGlob(tx, board, version, committed, hints);
    });
    for (const hint of hints) this.deps.notifier.publish(hint);
    if (glob === null) return { kind: 'dropped' };
    if (glob.provisioning !== 'ok') {
      return { kind: 'waiting', reason: `Waiting for the branch of ${glob.id}${glob.provisioning === 'failed' ? ' (its provisioning failed)' : ''}` };
    }
    const managed = managedRepoFiles(set.value.files);
    const manifest: RepoFile = {
      path: AGENT_SET_MANIFEST_PATH,
      content: agentSetManifest(boardId, version, managed, this.deps.clock.now()),
      executable: false,
    };
    return { kind: 'ready', glob, board, version, files: [...managed, manifest] };
  }

  /** The ID of the board's open "Agent set vN" glob, for the Knowledge page; null when there is none. */
  async openGlobId(boardId: number): Promise<string | null> {
    return this.deps.store.transaction(async (tx) => (await agentSetGlobs(tx, boardId)).filter(isAgentSetGlobOpen).at(-1)?.id ?? null);
  }

  /** The board's open agent-set glob with its title on `version`, opened when there is none and the repo is behind. */
  private async openGlob(tx: Tx, board: Board, version: number, committed: number | null, hints: Hint[]): Promise<Glob | null> {
    const prefix = agentSetKeyPrefix(board.id);
    const all = await agentSetGlobs(tx, board.id);
    const open = all.filter(isAgentSetGlobOpen).at(-1);
    if (open === undefined) {
      if (committed !== null && committed >= version) return null;
      const created = await this.create(tx, board, version, `${prefix}${String(all.length + 1)}`);
      if (!created.ok) throw new Error(created.error.message);
      hints.push({ kind: 'glob.changed', boardId: board.id, globId: created.value.id, version: created.value.version }, { kind: 'board.kb', boardId: board.id });
      return created.value;
    }
    if (open.title === agentSetGlobTitle(version)) return open;
    // The title follows the board's version; the plan says nothing version-specific, so it stays.
    const step = machine.changeFields(open, { title: agentSetGlobTitle(version) }, board, this.context());
    if (!step.ok) throw new Error(step.error.message);
    const next = await this.write(tx, open, step.value);
    hints.push({ kind: 'glob.changed', boardId: board.id, globId: next.id, version: next.version }, { kind: 'board.kb', boardId: board.id });
    return next;
  }

  /**
   * Opens the glob as slop itself: a same in Doing, picked up by slop so its branch is provisioned and no routine
   * run starts. It has no real member behind it, so it skips `GlobService.create` (as decision globs do).
   */
  private async create(tx: Tx, board: Board, version: number, creationKey: string): Promise<Result<Glob>> {
    const ctx = this.context();
    const letter = letterOf('task');
    const id = formatId(board.id, letter, await tx.nextNumber(board.id, letter));
    const created = machine.create(
      {
        id,
        boardId: board.id,
        title: agentSetGlobTitle(version),
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
      },
      board,
      ctx,
    );
    if (!created.ok) return created;
    const glob = { ...created.value.glob, version: 1 };
    if (!(await tx.insertGlob(glob, creationKey))) throw new Error(`Glob ID collision for ${glob.id}`);
    await tx.appendEvents(created.value.events);
    await tx.enqueueEffects(created.value.effects);
    await addArtifact(tx, this.deps.clock, glob, DECISION_SYSTEM_ACTOR, {
      kind: 'plan',
      label: '',
      content: PLAN,
      link: null,
      commitSha: null,
      runId: null,
      agentSetVersion: null,
      reviewStats: null,
      by: 'sessionator',
    });
    const picked = machine.pickUp(glob, ctx, board, { takeOver: false });
    if (!picked.ok) return picked;
    return ok(await this.write(tx, glob, picked.value));
  }

  private async write(tx: Tx, before: Glob, step: Transition): Promise<Glob> {
    if (!step.changed) return before;
    const next = { ...step.glob, version: before.version + 1 };
    if (!(await tx.updateGlob(next, before.version))) throw new GlobMoved(before.id);
    await tx.appendEvents(step.events);
    await tx.enqueueEffects(step.effects);
    return next;
  }

  /** Slop acting as an admin of the board; it never starts a run. */
  private context(): Context {
    return {
      actor: { email: DECISION_SYSTEM_ACTOR, role: 'admin' },
      now: this.deps.clock.now(),
      newRunId: () => {
        throw new Error('The agent-set glob never starts a run');
      },
      routineOwnerFor: () => '',
    };
  }
}
