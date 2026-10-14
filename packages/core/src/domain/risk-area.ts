import { extractPlanFeatures } from './intake-learning.js';
import { matchesGlob } from './sub-gate.js';

/**
 * A board's risk areas: kinds of work that need a human review, so intake chooses `same` for a request that touches one
 * and `sub` otherwise. They start as the defaults, and slop learns the rest from outcomes: a reverted sub, a bug that
 * blamed one, a failed deploy or a small sub that needed fixes adds or strengthens an area for its paths; clean subs
 * wear a learned area away; a person changing intake's type counts three times. Pure: the store and the events are
 * in `RiskAreaService`.
 */

export const RISK_AREA_SOURCES = ['default', 'learned'] as const;
export type RiskAreaSource = (typeof RISK_AREA_SOURCES)[number];

/** What happened to a sub (or intake's choice for it), as far as risk areas are concerned. */
export const RISK_OUTCOMES = [
  'reverted',
  'bug',
  'deploy_failed',
  'blocked',
  'small_fix',
  'clean',
  'type_to_same',
  'type_to_sub',
] as const;
export type RiskOutcomeKind = (typeof RISK_OUTCOMES)[number];

/** A change's cause: the outcome, or a person's reset. */
export const RISK_AREA_CAUSES = [...RISK_OUTCOMES, 'reset', 'cleanup'] as const;
export type RiskAreaCause = (typeof RISK_AREA_CAUSES)[number];

export const RISK_AREA_CHANGE_KINDS = ['added', 'strengthened', 'clean', 'removed', 'reset', 'correction', 'candidate'] as const;
export type RiskAreaChangeKind = (typeof RISK_AREA_CHANGE_KINDS)[number];

/** Clean outcomes (a correction to `sub` counts as `CORRECTION_WEIGHT`) after which a learned area is removed. */
export const CLEAN_TO_REMOVE = 3;
/** A person's change of intake's type counts this many times. */
export const CORRECTION_WEIGHT = 3;
/** How long after a merge a sub is clean when nothing went wrong. */
export const CLEAN_WINDOW_DAYS = 14;
/** The most learned areas one outcome adds. */
const MAX_NEW_AREAS = 3;
/** The fewest path segments a learned directory area has (`apps/server/src/db`): a package or app root (`apps/web/src`) is too wide. */
export const MIN_AREA_DEPTH = 4;
/** The fewest separate globs a learned area needs as evidence before it is added. */
export const MIN_EVIDENCE_GLOBS = 2;

export interface RiskArea {
  readonly boardId: number;
  readonly name: string;
  /** Path globs (`**` spans directories); a request whose files match one is in the area. */
  readonly pathPatterns: readonly string[];
  readonly why: string;
  readonly source: RiskAreaSource;
  /** How many bad outcomes (a correction counts 3) put the area here or kept it. 0 for an untouched default. */
  readonly strength: number;
  /** Clean outcomes since the last bad one. */
  readonly cleanCount: number;
  readonly updatedAt: string;
}

export interface RiskAreaChange {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  /** Null for a correction or outcome whose paths no area covers and none could be added for (no paths known). */
  readonly areaName: string | null;
  readonly kind: RiskAreaChangeKind;
  /** The glob whose outcome it was; null for a reset. */
  readonly globId: string | null;
  readonly cause: RiskAreaCause;
}

export type NewRiskAreaChange = Omit<RiskAreaChange, 'id'>;

/** An outcome to apply: what happened, to which glob, over which paths. */
export interface RiskOutcome {
  readonly kind: RiskOutcomeKind;
  readonly globId: string;
  readonly paths: readonly string[];
  readonly at: string;
}

/** The board's risk areas and history, for board settings. */
export interface RiskAreaView {
  readonly areas: readonly (RiskArea & {
    readonly subSafe: boolean;
    /** The globs whose bad outcomes put a learned area here (empty for a default). */
    readonly evidence: readonly string[];
  })[];
  readonly history: readonly RiskAreaChange[];
}

/** The areas a board starts with: generic path patterns, no repo-specific names. */
export const DEFAULT_RISK_AREAS: readonly Pick<RiskArea, 'name' | 'pathPatterns' | 'why'>[] = [
  {
    name: 'Auth and security',
    pathPatterns: ['**/auth/**', '**/oauth/**', '**/security/**', '**/secrets/**'],
    why: 'A mistake here exposes accounts or data, so a person reads it first.',
  },
  {
    name: 'Migrations that rewrite existing data',
    pathPatterns: ['**/drizzle/**/*rewrite*', '**/migrations/**/*rewrite*', '**/drizzle/**/*backfill*'],
    why: 'A migration that rewrites existing rows cannot be undone by reverting the code. Additive migrations (new tables or columns) are not in this area.',
  },
  {
    name: 'Agent instructions',
    pathPatterns: ['.claude/**', '**/CLAUDE.md', '**/AGENTS.md'],
    why: 'Instructions steer every later run, so a change needs a person to read it.',
  },
  {
    name: 'Infrastructure and production',
    pathPatterns: ['infra/**', '**/terraform/**', '**/Dockerfile', 'compose*.yaml', '.github/workflows/**'],
    why: 'It changes what runs in production, and a bad change shows only after a deploy.',
  },
  {
    name: 'Public API or cross-board contracts',
    pathPatterns: ['**/openapi*', '**/contracts/**', '**/public-api/**'],
    why: 'Others depend on the contract, so changing it needs a person to weigh who breaks.',
  },
];

/** A fresh default area (never touched). */
export const defaultAreas = (boardId: number, now: string): RiskArea[] =>
  DEFAULT_RISK_AREAS.map((a) => ({
    boardId,
    name: a.name,
    pathPatterns: [...a.pathPatterns],
    why: a.why,
    source: 'default',
    strength: 0,
    cleanCount: 0,
    updatedAt: now,
  }));

/** Whether any of `paths` falls under one of the area's patterns. */
export const pathsMatchArea = (area: Pick<RiskArea, 'pathPatterns'>, paths: readonly string[]): boolean =>
  paths.some((p) => area.pathPatterns.some((g) => matchesGlob(p, g)));

/** The areas any of `paths` falls under. */
export const areasMatching = <A extends Pick<RiskArea, 'pathPatterns'>>(areas: readonly A[], paths: readonly string[]): A[] =>
  areas.filter((a) => pathsMatchArea(a, paths));

/** The most paths and area names the evidence line lists. */
const EVIDENCE_PATHS = 5;

/** What a piece of work (a part's plan) touches in the board's risk areas. */
export interface RiskMatch<A extends Pick<RiskArea, 'name' | 'pathPatterns'> = RiskArea> {
  /** The areas the plan's files fall under; empty when none. */
  readonly areas: readonly A[];
  /** The plan's files that fall under any matched area, in plan order (the evidence). */
  readonly paths: readonly string[];
}

/**
 * Matches one part's plan text against the board's risk areas: the files the plan names (as intake reads them) that
 * fall under each area. The same matcher intake and the outcome learning use, for a part rather than a whole request.
 */
export const matchRiskAreas = <A extends Pick<RiskArea, 'name' | 'pathPatterns'>>(areas: readonly A[], plan: string): RiskMatch<A> => {
  const files = extractPlanFeatures(plan).filePaths;
  const matched = areasMatching(areas, files);
  const paths = files.filter((p) => matched.some((a) => pathsMatchArea(a, [p])));
  return { areas: matched, paths };
};

/** The evidence line for a part's escalation: "From the split of s1t1: files a.ts, b.ts, areas Auth and security". */
export const splitEvidence = (sourceId: string, match: { readonly areas: readonly Pick<RiskArea, 'name'>[]; readonly paths: readonly string[] }): string => {
  const shown = match.paths.slice(0, EVIDENCE_PATHS).join(', ');
  const more = match.paths.length > EVIDENCE_PATHS ? ` (+${match.paths.length - EVIDENCE_PATHS} more)` : '';
  return `From the split of ${sourceId}: files ${shown}${more}, areas ${match.areas.map((a) => a.name).join(', ')}`;
};

/** A default area clean subs have shown safe: kept (it is a default), but intake leans `sub` there. */
export const subSafe = (area: RiskArea): boolean => area.source === 'default' && area.strength === 0 && area.cleanCount >= CLEAN_TO_REMOVE;

/**
 * The narrow scope a learned area covers for `path`: its module directory (at most `MIN_AREA_DEPTH` levels) when that is deep
 * enough, else the file itself. Never a package or app root.
 */
const scopeOf = (path: string): string => {
  const parts = path.split('/');
  const dir = parts.slice(0, -1);
  return dir.length >= MIN_AREA_DEPTH ? dir.slice(0, MIN_AREA_DEPTH).join('/') : path;
};

/** Whether a learned area's path pattern is narrow: a module directory deep enough (`dir/**`) or one exact file. */
export const isNarrowPattern = (pattern: string): boolean => {
  if (pattern.includes('*') && !pattern.endsWith('/**')) return false;
  if (!pattern.endsWith('/**')) return !pattern.includes('*') && pattern !== '';
  const base = pattern.slice(0, -3);
  return !base.includes('*') && base.split('/').length >= MIN_AREA_DEPTH;
};

/** Whether a learned area breaks the rule for learned areas: every one of its patterns must be narrow. */
export const isWideArea = (area: Pick<RiskArea, 'pathPatterns'>): boolean => !area.pathPatterns.every(isNarrowPattern);

const BAD_CHANGE_KINDS: readonly RiskAreaChangeKind[] = ['added', 'strengthened', 'candidate', 'correction'];

/**
 * The separate globs whose bad outcomes are evidence for a learned area: those the history names it for with a change that
 * adds or strengthens it (or notes it as a candidate), not the clean ones.
 */
export const evidenceGlobs = (history: readonly Pick<RiskAreaChange, 'areaName' | 'kind' | 'globId' | 'cause'>[], areaName: string): string[] => [
  ...new Set(
    history
      .filter((c) => c.areaName === areaName && c.globId !== null && BAD_CHANGE_KINDS.includes(c.kind) && !isClean(c.cause))
      .map((c) => c.globId as string),
  ),
];

const outcomeWeight = (kind: RiskOutcomeKind): number => (kind === 'type_to_same' || kind === 'type_to_sub' ? CORRECTION_WEIGHT : 1);
const isClean = (kind: RiskAreaCause): boolean => kind === 'clean' || kind === 'type_to_sub';

const WHY: Record<RiskOutcomeKind, string> = {
  reverted: 'A sub that changed it was reverted',
  bug: 'A bug blamed a sub that changed it',
  deploy_failed: 'A deploy failed after a sub changed it',
  blocked: 'A person blocked a sub that changed it at auto-merge',
  small_fix: 'A small sub that changed it needed fixes after merging',
  clean: 'Clean subs',
  type_to_same: 'A person changed intake\'s sub to same for work in it',
  type_to_sub: 'A person changed intake\'s same to sub for work in it',
};

export interface AppliedOutcome {
  /** The areas to write (changed or new ones only). */
  readonly put: readonly RiskArea[];
  /** The learned areas that wore away. */
  readonly removed: readonly string[];
  readonly changes: readonly NewRiskAreaChange[];
}

/**
 * Applies one outcome to a board's areas (pure). Bad outcomes (reverted, blamed by a bug, failed deploy, blocked, a small
 * sub that needed fixes, a person changing sub to same) strengthen every area the paths fall under and add a learned
 * area for the paths no area covers. Clean outcomes (a quiet sub, a person changing same to sub, which counts 3) count
 * clean for the areas the paths fall under; a learned area with `CLEAN_TO_REMOVE` clean outcomes is removed, a default
 * one only turns sub-safe. A person's change of type is recorded as a `correction`.
 */
export const applyOutcome = (
  boardId: number,
  areas: readonly RiskArea[],
  outcome: RiskOutcome,
  /** The board's history so far: a new learned area needs `MIN_EVIDENCE_GLOBS` separate globs in it (this outcome's included). */
  history: readonly Pick<RiskAreaChange, 'areaName' | 'kind' | 'globId' | 'cause'>[] = [],
): AppliedOutcome => {
  const weight = outcomeWeight(outcome.kind);
  const correction = outcome.kind === 'type_to_same' || outcome.kind === 'type_to_sub';
  const record = (areaName: string | null, kind: RiskAreaChangeKind): NewRiskAreaChange => ({
    boardId,
    at: outcome.at,
    areaName,
    kind: correction && kind !== 'removed' ? 'correction' : kind,
    globId: outcome.globId,
    cause: outcome.kind,
  });
  const put: RiskArea[] = [];
  const removed: string[] = [];
  const changes: NewRiskAreaChange[] = [];
  const matching = areasMatching(areas, outcome.paths);
  if (isClean(outcome.kind)) {
    for (const area of matching) {
      const cleanCount = area.cleanCount + weight;
      if (area.source === 'learned' && cleanCount >= CLEAN_TO_REMOVE) {
        removed.push(area.name);
        changes.push(record(area.name, 'removed'));
      } else {
        put.push({ ...area, cleanCount, updatedAt: outcome.at });
        changes.push(record(area.name, 'clean'));
      }
    }
    if (matching.length === 0 && correction) changes.push(record(null, 'clean'));
    return { put, removed, changes };
  }
  for (const area of matching) {
    put.push({ ...area, strength: area.strength + weight, cleanCount: 0, updatedAt: outcome.at });
    changes.push(record(area.name, 'strengthened'));
  }
  const uncovered = outcome.paths.filter((p) => !areas.some((a) => pathsMatchArea(a, [p])));
  const scopes = [...new Set(uncovered.map(scopeOf))].slice(0, MAX_NEW_AREAS);
  for (const scope of scopes) {
    const name = `Learned: ${scope}`;
    const pattern = uncovered.includes(scope) ? scope : `${scope}/**`;
    // One glob is not a pattern: the area waits as a candidate until a second, separate glob has the same bad outcome.
    const globs = new Set([...evidenceGlobs(history, name), outcome.globId]);
    if (globs.size < MIN_EVIDENCE_GLOBS) {
      changes.push(record(name, 'candidate'));
      continue;
    }
    put.push({
      boardId,
      name,
      pathPatterns: [pattern],
      why: WHY[outcome.kind],
      source: 'learned',
      strength: weight + (globs.size - 1),
      cleanCount: 0,
      updatedAt: outcome.at,
    });
    changes.push(record(name, 'added'));
  }
  if (matching.length === 0 && scopes.length === 0 && correction) changes.push(record(null, 'strengthened'));
  return { put, removed, changes };
};

/** The history key that makes a learned outcome idempotent. */
export const riskChangeKey = (globId: string | null, cause: RiskAreaCause, areaName: string | null): string =>
  `${globId ?? ''}:${cause}:${areaName ?? ''}`;

/** The one-line text of an area for the intake prompt. */
export const riskAreaLine = (area: RiskArea): string =>
  `- ${area.name} (paths: ${area.pathPatterns.join(', ')}): ${area.why}${subSafe(area) ? ' Recent subs here were clean: lean sub.' : ''}`;
