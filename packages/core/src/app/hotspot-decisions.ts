import { hotspotCovered, hotspotHeadline, hotspotKey } from '../domain/decision-glob.js';
import { hotspotWindowFrom } from '../domain/hotspots.js';
import type { Hotspot } from '../domain/hotspots.js';
import type { Actor, Glob } from '../domain/types.js';
import type { Hint, Notifier, Store } from '../ports.js';
import { decisionGroup } from '../domain/group.js';
import { createDecisionInTx, DECISION_SYSTEM_ACTOR } from './decision-glob.js';
import type { CodeView } from './code-view.js';
import type { Llm } from './intake-service.js';
import { completeWithDeadline } from './llm-call.js';

/** Hotspot decisions raised in one run: the hottest files first, the rest wait for the next. */
const MAX_RAISED = 3;
/** The model gets at most this much of the file (characters), and this long to answer. */
const FILE_CHARS = 30_000;
const ANSWER_MS = 90_000;

const SYSTEM = [
  'You advise a team whose parallel work keeps conflicting in one file.',
  'Propose how to refactor the file so that parallel work lands in different files, from its structure and its recent conflicts.',
  'Answer in Markdown, at most 250 words: a short diagnosis, then the split as a list of new modules (name and what moves into it),',
  'then "Done when" lines a reviewer can check. Do not repeat the numbers you were given. Do not write code.',
].join(' ');

/** Said when every conflict fell within a day: one burst of related work, which may not recur. */
const burstNote = (hotspot: Hotspot): string =>
  hotspot.burst === true ? ' All of them fell within one day (a burst of related work), so weigh whether the file keeps conflicting or only did once.' : '';

/** Said when workstreams of one run conflicted on the file: parallel work inside a glob needs the split too. */
const workstreamNote = (hotspot: Hotspot): string[] =>
  hotspot.workstreamConflicts === undefined
    ? []
    : [`${String(hotspot.workstreamConflicts)} of them were integration conflicts between workstreams of the same glob.`];

/** What the proposal says when no model could draft one: the split is left to whoever picks the decision up. */
const fallbackProposal = (path: string): string =>
  [
    `\`${path}\` keeps conflicting because many globs change it at once.`,
    '',
    '## Proposal',
    '',
    '- Split it by responsibility, so that work on one concern edits one new module and the hot file only composes them.',
    '- Keep the public exports of the file unchanged, so callers need no edit.',
    '',
    'Done when: the file is shorter, each moved concern lives in its own module, and tests and type checks pass unchanged.',
  ].join('\n');

/**
 * Tells the human about conflict hotspots (spec, Conflict hotspots): each file that is hot, with no decision about it open, no
 * rejection inside the window and no refactor of it still open, gets a decision glob with a drafted refactor proposal. Accepting
 * it creates the refactor glob (`DecisionGlobService.decide`); rejecting it silences the file for the window.
 */
export class HotspotDecisions {
  constructor(
    private readonly deps: {
      store: Store;
      clock: { now(): string };
      notifier: Notifier;
      /** Absent, or failing: the proposal is a generic split of the file. */
      llm?: Llm;
      codeView?: Pick<CodeView, 'read'>;
    },
  ) {}

  /** Raises the decisions the hotspots call for at `now`; returns the new decisions' IDs. */
  async raise(boardId: number, hotspots: readonly Hotspot[], windowDays: number, now: string): Promise<string[]> {
    const from = hotspotWindowFrom(now, windowDays);
    const raised: string[] = [];
    for (const hotspot of hotspots) {
      if (raised.length >= MAX_RAISED) break;
      if (await this.covered(boardId, hotspot.path, from)) continue;
      const proposal = await this.proposal(boardId, hotspot);
      const headline = hotspotHeadline({ ...hotspot, globs: hotspot.globs.length, windowDays });
      const hints: Hint[] = [];
      const created = await this.deps.store.transaction(async (tx) => {
        // Checked again inside the write: a person may have decided the file's last decision meanwhile.
        const [decisions, works] = [await tx.listGlobs(boardId, { include: 'decisions', origins: ['hotspot'] }), await tx.listGlobs(boardId, {})];
        const byId = new Map<string, Glob>(works.map((g) => [g.id, g]));
        if (hotspotCovered(hotspot.path, decisions, (id) => byId.get(id), from) !== null) return null;
        const actor: Actor = { email: DECISION_SYSTEM_ACTOR, role: 'admin' };
        const result = await createDecisionInTx(tx, { clock: this.deps.clock }, {
          boardId,
          actor,
          title: headline,
          payload: `${headline}\n\n${proposal}\n\n## Conflicts\n\nGlobs that conflicted on it: ${hotspot.globs.join(', ')}.${hotspot.workstreamConflicts === undefined ? '' : ` ${String(hotspot.workstreamConflicts)} conflicts were between workstreams integrated within a glob.`}${burstNote(hotspot)}\n`,
          attributes: { scope: { kind: 'future_work', ref: null }, origin: { kind: 'hotspot', path: hotspot.path }, channel: 'mined', outcome: null },
          creationKey: hotspotKey(hotspot.path, now),
          group: decisionGroup({ scope: { kind: 'future_work', ref: null }, origin: { kind: 'hotspot', path: hotspot.path }, channel: 'mined', outcome: null }, null),
        });
        if (!result.ok) throw new Error(result.error.message);
        hints.push(...result.value.hints);
        return result.value.created ? result.value.glob.id : null;
      });
      for (const hint of hints) this.deps.notifier.publish(hint);
      if (created !== null) raised.push(created);
    }
    return raised;
  }

  private async covered(boardId: number, path: string, from: string): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const decisions = await tx.listGlobs(boardId, { include: 'decisions', origins: ['hotspot'] });
      if (decisions.length === 0) return false;
      const works = new Map((await tx.listGlobs(boardId, {})).map((g) => [g.id, g]));
      return hotspotCovered(path, decisions, (id) => works.get(id), from) !== null;
    });
  }

  /** The drafted refactor proposal (Markdown), or the generic one when there is no model or it fails. */
  private async proposal(boardId: number, hotspot: Hotspot): Promise<string> {
    const { llm, codeView } = this.deps;
    if (llm === undefined) return fallbackProposal(hotspot.path);
    try {
      const file = codeView === undefined ? null : await codeView.read(boardId, null, hotspot.path).catch(() => null);
      const body = file === null || file.binary ? '(the file could not be read)' : file.content.slice(0, FILE_CHARS);
      const answer = await completeWithDeadline(
        llm,
        {
          system: SYSTEM,
          prompt: [
            `File: ${hotspot.path}`,
            `Conflicts: ${String(hotspot.conflicts)} (${String(hotspot.real)} real) across ${hotspot.globs.join(', ')}.`,
            ...workstreamNote(hotspot),
            ...(hotspot.additive === undefined ? [] : [`${String(hotspot.additive)} were purely additive.${burstNote(hotspot)}`]),
            '',
            'Its content (cut if long):',
            body,
          ].join('\n'),
          maxTokens: 1200,
          spend: { boardId, source: 'decisions' },
        },
        ANSWER_MS,
      );
      return answer.trim() === '' ? fallbackProposal(hotspot.path) : answer.trim();
    } catch {
      return fallbackProposal(hotspot.path);
    }
  }
}
