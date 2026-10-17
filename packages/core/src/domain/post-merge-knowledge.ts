import { isAgentSetGlob } from './agent-set.js';
import { isHumanCategory } from './types.js';
import type { Glob } from './types.js';
import { matchesGlob } from './sub-gate.js';

/** Facts submitted for one merged glob, at most. The model is asked for the most important ones; any more are dropped. */
export const MAX_POST_MERGE_FACTS = 5;
/** Sections named in one drift sub, at most. */
export const MAX_DRIFT_SECTIONS = 8;
/** A fact's statement and evidence, and a drift's change quote, are cut to this many characters. */
export const MAX_POST_MERGE_TEXT = 1_200;

/** The KB documents a fact can be routed to: `suggestedTarget` of the learning. */
export const FACT_TARGETS = ['architecture', 'operations'] as const;
export type FactTarget = (typeof FACT_TARGETS)[number];

/** Why the pass did nothing for a glob. */
export type PostMergeSkip = 'human glob' | 'agent set' | 'docs only' | 'no files';

const DOC_EXTENSION = /\.(md|mdx|txt|rst)$/i;

/** A merge that changes only documentation: nothing architectural or operational changed (the docs are the change). */
export const isDocsOnly = (files: readonly string[]): boolean =>
  files.length > 0 && files.every((f) => DOC_EXTENSION.test(f) || f.startsWith('docs/'));

/** Why a merged glob gets no post-merge pass, or null when it does: slop's own agent-set glob, human work, a docs-only or file-less merge. */
export const postMergeSkip = (
  glob: Pick<Glob, 'title' | 'implementer' | 'category' | 'type'>,
  files: readonly string[],
): PostMergeSkip | null => {
  if (isHumanCategory(glob.category)) return 'human glob';
  if (isAgentSetGlob(glob)) return 'agent set';
  if (files.length === 0) return 'no files';
  if (isDocsOnly(files)) return 'docs only';
  return null;
};

/** The spec and guide files among the merge's files (by the board's `specPaths`). */
export const specFilesChanged = (
  files: readonly string[],
  specPaths: readonly string[],
): string[] => files.filter((f) => specPaths.some((p) => matchesGlob(f, p)));

/** A fact the model proposed, checked. */
export interface PostMergeFact {
  readonly statement: string;
  readonly evidence: string;
  readonly target: FactTarget;
}

/** A spec or guide section the merge left out of date. */
export interface DriftSection {
  readonly path: string;
  readonly section: string;
}

export interface PostMergeDrift {
  readonly sections: readonly DriftSection[];
  /** The behaviour change, quoted from the diff or the plan. */
  readonly change: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/** The creation key of the one drift sub a glob gets: a retry (or a second pass) creates nothing twice. */
export const driftKey = (globId: string): string => `post-merge-drift:${globId}`;

/** The drift sub's title: "Update spec/guide for s15t275: <sections>". */
export const driftTitle = (globId: string, sections: readonly DriftSection[]): string => {
  const names = [
    ...new Set(sections.map((s) => (s.section.trim() === '' ? s.path : s.section.trim()))),
  ];
  return clip(`Update spec/guide for ${globId}: ${names.join(', ')}`, 200);
};

/** The drift sub's plan: the sections, the behaviour change quoted, and the merged PR. */
export const driftPlan = (
  glob: Pick<Glob, 'id' | 'title' | 'pr'>,
  drift: PostMergeDrift,
  repo: string | null,
): string => {
  const pr =
    glob.pr === null
      ? ''
      : repo === null
        ? `PR #${String(glob.pr.number)}`
        : `[PR #${String(glob.pr.number)}](https://github.com/${repo}/pull/${String(glob.pr.number)})`;
  const lines = [
    '## Why',
    `${glob.id} (${glob.title}) merged${pr === '' ? '' : ` in ${pr}`} and changed behaviour that the spec or guide describes, without updating them. Found by slop's post-merge pass.`,
    '',
    '## Behaviour change',
    ...drift.change.split('\n').map((l) => `> ${l}`),
    '',
    '## Tasks',
    ...drift.sections.map(
      (s) =>
        `- [ ] Update \`${s.path}\`${s.section.trim() === '' ? '' : `, section "${s.section.trim()}"`} to match.`,
    ),
    '',
    '## Done when',
    '- Each section above describes the merged behaviour, and nothing else in the spec or guide contradicts it.',
  ];
  return lines.join('\n');
};

/** The line the glob shows: "post-merge: 2 facts submitted, spec drift: s15t290" (or "none"). */
export const postMergeSummary = (done: {
  readonly facts: number;
  readonly drift: string | null;
  readonly skipped?: PostMergeSkip | null;
  readonly specConfigured?: boolean;
}): string => {
  if (done.skipped != null) return `post-merge: skipped (${done.skipped})`;
  const facts = `${String(done.facts)} fact${done.facts === 1 ? '' : 's'} submitted`;
  const drift =
    done.drift ?? (done.specConfigured === false ? 'not checked (no spec paths)' : 'none');
  return `post-merge: ${facts}, spec drift: ${drift}`;
};

/**
 * Reads the model's answer: at most `MAX_POST_MERGE_FACTS` facts with a statement and evidence, and a drift only with at least one
 * section whose path is one of the board's spec files and a quoted change. Anything else is dropped.
 */
export const checkPostMergeAnswer = (
  answer: unknown,
  specFiles: readonly string[],
): { readonly facts: PostMergeFact[]; readonly drift: PostMergeDrift | null } | null => {
  if (typeof answer !== 'object' || answer === null) return null;
  const a = answer as { facts?: unknown; drift?: unknown };
  if (!Array.isArray(a.facts)) return null;
  const facts: PostMergeFact[] = [];
  for (const raw of a.facts as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as { statement?: unknown; evidence?: unknown; target?: unknown };
    const statement = typeof f.statement === 'string' ? oneLine(f.statement) : '';
    const evidence = typeof f.evidence === 'string' ? oneLine(f.evidence) : '';
    const target = FACT_TARGETS.find((t) => t === f.target);
    if (statement === '' || evidence === '' || target === undefined) continue;
    if (facts.some((x) => x.statement === statement)) continue;
    facts.push({
      statement: clip(statement, MAX_POST_MERGE_TEXT),
      evidence: clip(evidence, MAX_POST_MERGE_TEXT),
      target,
    });
    if (facts.length === MAX_POST_MERGE_FACTS) break;
  }
  let drift: PostMergeDrift | null = null;
  if (typeof a.drift === 'object' && a.drift !== null) {
    const d = a.drift as { sections?: unknown; change?: unknown };
    const change = typeof d.change === 'string' ? d.change.trim() : '';
    const sections: DriftSection[] = [];
    if (Array.isArray(d.sections)) {
      for (const raw of d.sections as unknown[]) {
        if (typeof raw !== 'object' || raw === null) continue;
        const s = raw as { path?: unknown; section?: unknown };
        const path = typeof s.path === 'string' ? s.path.trim() : '';
        const section = typeof s.section === 'string' ? oneLine(s.section) : '';
        if (
          !specFiles.includes(path) ||
          sections.some((x) => x.path === path && x.section === section)
        )
          continue;
        sections.push({ path, section: clip(section, 120) });
        if (sections.length === MAX_DRIFT_SECTIONS) break;
      }
    }
    if (change !== '' && sections.length > 0)
      drift = { sections, change: clip(change, MAX_POST_MERGE_TEXT) };
  }
  return { facts, drift };
};
