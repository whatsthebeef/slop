/**
 * The investigation artifact (kind `investigation`): the investigator's output as data. Its text ends with one fenced
 * block, ```` ```investigation ````, holding a JSON object that slop validates. A malformed block is kept as text and
 * reported with a note, never rejected: the investigation is still useful to read. Pure.
 */
import { RISK_TIERS } from './knowledge.js';
import type { RiskTier } from './knowledge.js';
import { contextSectionList } from './intake-learning.js';
import { RELATION_GATES, RELATION_UNTILS } from './types.js';
import type { RelationGate, RelationUntil } from './types.js';
import { MAX_PROPOSED_PARTS, goalOf, splitShape } from './size-check.js';
import type { SizeProposal, SizeThreshold, Workstream } from './size-check.js';

export const CHANGE_KINDS = ['create', 'modify', 'delete'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const INVESTIGATION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type InvestigationConfidence = (typeof INVESTIGATION_CONFIDENCES)[number];

export interface InvestigationFile {
  readonly path: string;
  readonly change: ChangeKind;
}

/**
 * A part that could ship on its own; `needs` names the other parts (by `name`) it builds on. `title` and `plan`
 * (the part's own share of the original plan) are optional: older investigations lack them and fall back to the name.
 */
export interface InvestigationPart {
  readonly name: string;
  readonly title?: string;
  readonly plan?: string;
  readonly files: readonly string[];
  readonly needs: readonly string[];
}

/**
 * A relation to another open glob or a decision glob that the investigator found in the code or the plan, with the evidence it
 * read: this glob can't pass `gate` (default `start`) until `to` reaches `until` (default `merged`; `decided` for a decision).
 */
export interface InvestigationRelation {
  readonly to: string;
  readonly gate: RelationGate;
  readonly until: RelationUntil;
  /** One line naming the file or symbol that shows it, e.g. "uses humanSteps() from s15f100". */
  readonly reason: string;
  readonly files: readonly string[];
}

export interface Investigation {
  readonly files: readonly InvestigationFile[];
  readonly modules: readonly string[];
  readonly expectedLines: { readonly min: number; readonly max: number };
  /** The parallelisable parts; one entry (or none) means the work is not meant to be cut. */
  readonly parts: readonly InvestigationPart[];
  readonly riskTier: RiskTier;
  /** The board's risk areas the change touches. */
  readonly riskAreas: readonly string[];
  readonly needsHuman: { readonly needed: boolean; readonly reason: string | null };
  readonly confidence: InvestigationConfidence;
  /**
   * The other open globs (and open decisions) this one is held back by, from the code the investigator read. Absent when it did
   * not say; an empty list says it looked and found none, which drops the needs slop had guessed from the plan. An investigation
   * stored with the old `dependencies` list reads the same: its needs are start relations, its overlaps are dropped.
   */
  readonly relations?: readonly InvestigationRelation[];
  /** The investigator predicts the change needs a rollout (a person's steps after the merge); absent when not said. */
  readonly needsRollout?: boolean;
  /** sha256 (hex) of plan.md as it was when the investigation was made. */
  readonly planHash: string;
  /** The base branch commit the code was read at. */
  readonly baseCommit: string;
}

export type InvestigationParse =
  | { readonly ok: true; readonly investigation: Investigation }
  | { readonly ok: false; readonly errors: readonly string[] };

const FENCE = /^```investigation[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The text of the last `investigation` fence in the content, or null when there is none. */
export const investigationBlock = (content: string): string | null => {
  const blocks = [...content.matchAll(FENCE)];
  return blocks.at(-1)?.[1] ?? null;
};

/** Reads and validates the investigation's block; every problem found is listed. */
export const parseInvestigation = (content: string): InvestigationParse => {
  const block = investigationBlock(content);
  if (block === null) return { ok: false, errors: ['No ```investigation fenced block found'] };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (e) {
    return {
      ok: false,
      errors: [`The block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (!isRecord(raw)) return { ok: false, errors: ['The block must be a JSON object'] };
  const errors: string[] = [];

  const files: InvestigationFile[] = [];
  if (!Array.isArray(raw.files)) errors.push('files must be a list of {path, change}');
  else
    raw.files.forEach((f: unknown, i) => {
      if (
        !isRecord(f) ||
        typeof f.path !== 'string' ||
        f.path.trim() === '' ||
        !CHANGE_KINDS.includes(f.change as ChangeKind)
      ) {
        errors.push(`files[${String(i)}] needs a path and a change of ${CHANGE_KINDS.join(', ')}`);
      } else files.push({ path: f.path, change: f.change as ChangeKind });
    });

  if (!isStringList(raw.modules)) errors.push('modules must be a list of names');

  const lines = raw.expectedLines;
  if (!isRecord(lines) || !isCount(lines.min) || !isCount(lines.max) || lines.min > lines.max) {
    errors.push('expectedLines must be {min, max} with 0 <= min <= max');
  }

  const parts: InvestigationPart[] = [];
  if (!Array.isArray(raw.parts))
    errors.push('parts must be a list (empty when the work is one part)');
  else {
    const names = new Set<string>();
    raw.parts.forEach((p: unknown, i) => {
      if (
        !isRecord(p) ||
        typeof p.name !== 'string' ||
        p.name.trim() === '' ||
        !isStringList(p.files) ||
        !isStringList(p.needs)
      ) {
        errors.push(`parts[${String(i)}] needs a name, files and needs (lists of strings)`);
      } else {
        names.add(p.name);
        const text = (key: 'title' | 'plan'): string | undefined => {
          const v = p[key];
          if (v === undefined || v === null) return undefined;
          if (typeof v !== 'string') {
            errors.push(`parts[${String(i)}].${key} must be a string`);
            return undefined;
          }
          return v.trim() === '' ? undefined : v.trim();
        };
        const title = text('title');
        const partPlan = text('plan');
        parts.push({
          name: p.name,
          files: p.files,
          needs: p.needs,
          ...(title !== undefined ? { title } : {}),
          ...(partPlan !== undefined ? { plan: partPlan } : {}),
        });
      }
    });
    for (const p of parts) {
      for (const n of p.needs)
        if (!names.has(n)) errors.push(`part "${p.name}" needs "${n}", which is not a part`);
    }
  }

  if (!RISK_TIERS.includes(raw.riskTier as RiskTier))
    errors.push(`riskTier must be one of ${RISK_TIERS.join(', ')}`);
  if (!isStringList(raw.riskAreas))
    errors.push('riskAreas must be a list of names (empty when none)');

  const human = raw.needsHuman;
  if (
    !isRecord(human) ||
    typeof human.needed !== 'boolean' ||
    !(human.reason === null || typeof human.reason === 'string')
  ) {
    errors.push('needsHuman must be {needed: boolean, reason: string | null}');
  } else if (human.needed && (human.reason === null || human.reason.trim() === '')) {
    errors.push('needsHuman.reason is required when needed is true');
  }

  if (!INVESTIGATION_CONFIDENCES.includes(raw.confidence as InvestigationConfidence))
    errors.push(`confidence must be one of ${INVESTIGATION_CONFIDENCES.join(', ')}`);
  const relations: InvestigationRelation[] = [];
  if (raw.relations !== undefined) {
    if (!Array.isArray(raw.relations)) errors.push('relations must be a list of {to, gate?, until?, reason, files?} when given');
    else
      raw.relations.forEach((d: unknown, i) => {
        const gate = isRecord(d) ? (d.gate === undefined ? 'start' : RELATION_GATES.find((g) => g === d.gate)) : undefined;
        const until = isRecord(d) ? (d.until === undefined ? 'merged' : RELATION_UNTILS.find((u) => u === d.until)) : undefined;
        if (
          !isRecord(d) ||
          typeof d.to !== 'string' ||
          d.to.trim() === '' ||
          gate === undefined ||
          until === undefined ||
          typeof d.reason !== 'string' ||
          d.reason.trim() === '' ||
          (d.files !== undefined && !isStringList(d.files))
        ) {
          errors.push(`relations[${String(i)}] needs a to, an optional gate (${RELATION_GATES.join(', ')}) and until (${RELATION_UNTILS.join(', ')}), a reason and optional files (a list of paths)`);
        } else relations.push({ to: d.to.trim(), gate, until, reason: d.reason.trim(), files: d.files ?? [] });
      });
  } else if (raw.dependencies !== undefined) {
    // The older shape: {id, kind needs|overlaps, reason, files}. A need is a start relation; an overlap is no relation.
    if (!Array.isArray(raw.dependencies)) errors.push('dependencies must be a list of {id, kind, reason, files} when given');
    else
      raw.dependencies.forEach((d: unknown, i) => {
        if (
          !isRecord(d) ||
          typeof d.id !== 'string' ||
          d.id.trim() === '' ||
          (d.kind !== 'needs' && d.kind !== 'overlaps') ||
          typeof d.reason !== 'string' ||
          d.reason.trim() === '' ||
          (d.files !== undefined && !isStringList(d.files))
        ) {
          errors.push(`dependencies[${String(i)}] needs an id, a kind of needs or overlaps, a reason and files (a list of paths)`);
        } else if (d.kind === 'needs') relations.push({ to: d.id.trim(), gate: 'start', until: 'merged', reason: d.reason.trim(), files: d.files ?? [] });
      });
  }
  if (raw.needsRollout !== undefined && typeof raw.needsRollout !== 'boolean') errors.push('needsRollout must be a boolean when given');
  if (typeof raw.planHash !== 'string' || raw.planHash.trim() === '')
    errors.push('planHash is required');
  if (typeof raw.baseCommit !== 'string' || raw.baseCommit.trim() === '')
    errors.push('baseCommit is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    investigation: {
      files,
      modules: raw.modules as string[],
      expectedLines: { min: (lines as { min: number }).min, max: (lines as { max: number }).max },
      parts,
      riskTier: raw.riskTier as RiskTier,
      riskAreas: raw.riskAreas as string[],
      needsHuman: {
        needed: (human as { needed: boolean }).needed,
        reason: (human as { reason: string | null }).reason,
      },
      confidence: raw.confidence as InvestigationConfidence,
      ...(raw.relations !== undefined || raw.dependencies !== undefined ? { relations } : {}),
      ...(raw.needsRollout === true ? { needsRollout: true } : {}),
      planHash: raw.planHash as string,
      baseCommit: raw.baseCommit as string,
    },
  };
};

/** The note stored and shown with a malformed investigation. */
export const validationNote = (errors: readonly string[]): string =>
  `Investigation block not parsed: ${errors.join('; ')}`;

// ---------------------------------------------------------------------------
// What slop does on receipt (spec, Investigation as data)

/** Why a human should check the glob, from the investigation; null when nothing in it asks for one. */
export const escalationOf = (
  investigation: Investigation,
): { reason: string; evidence: string } | null => {
  const reasons = [
    ...(investigation.needsHuman.needed ? [investigation.needsHuman.reason?.trim() ?? ''] : []),
    ...(investigation.riskAreas.length > 0
      ? [`Touches the board's risk areas: ${investigation.riskAreas.join(', ')}`]
      : []),
  ].filter((r) => r !== '');
  if (reasons.length === 0) return null;
  return {
    reason: reasons.join('. '),
    evidence: `Investigation: risk tier ${investigation.riskTier}, ${String(investigation.files.length)} files, confidence ${investigation.confidence}`,
  };
};

/**
 * The parts, each after the ones it needs (stable otherwise); null when they need each other in a circle. The first is
 * the one that stays the original glob.
 */
const ordered = (parts: readonly InvestigationPart[]): InvestigationPart[] | null => {
  const done: InvestigationPart[] = [];
  const left = [...parts];
  while (left.length > 0) {
    const next = left.findIndex((p) => p.needs.every((n) => done.some((d) => d.name === n)));
    if (next < 0) return null;
    done.push(...left.splice(next, 1));
  }
  return done;
};

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join('\n');

const lowered = (text: string): string => text.toLowerCase();

/**
 * The workstreams of the investigation's parts; null when they can't be cut into 2 to 10. Each workstream's plan is its own,
 * with the plan's context sections it lacks carried in (as `buildProposal` does). A part without one (an older investigation)
 * gets the name-based goal and the whole original plan. `title` is unused now that a workstream is not a glob of its own.
 */
export const proposalFromParts = (
  parts: readonly InvestigationPart[],
  plan: string,
): SizeProposal | null => {
  const sorted = ordered(parts);
  if (sorted === null || sorted.length < 2 || sorted.length > MAX_PROPOSED_PARTS) return null;
  const context = contextSectionList(plan);
  const built: Workstream[] = sorted.map((part) => {
    const own = part.plan?.trim() ?? '';
    const missing = context.filter((section) => !lowered(own).includes(lowered(section.heading)));
    const carried = [
      own,
      ...missing.map((section) => `## ${section.heading}\n\n${section.body}`),
    ].join('\n\n');
    return {
      name: (part.title ?? part.name).trim().slice(0, 120),
      goal: own === '' ? `Scope: ${part.name}` : goalOf(own),
      files: part.files,
      plan:
        own === ''
          ? `Scope: ${part.name}\n\nFiles:\n${bullets(part.files)}\n\nOriginal plan (keep only this workstream's share of its tasks and "Done when" lines):\n\n${plan.trim()}`
          : `${carried}\n\nFiles:\n${bullets(part.files)}`,
      needs: part.needs.map((n) => sorted.findIndex((p) => p.name === n)).filter((n) => n >= 0).sort((a, b) => a - b),
    };
  });
  return { workstreams: built, ...splitShape(built) };
};

/**
 * The oversize flag an investigation raises: its parts name the cut, so it counts against the board's parts limit at the
 * limit itself (the plan's own estimate is a guess, this is the investigator's reading of the code). Null below it.
 */
export const oversizeOf = (
  investigation: Investigation,
  threshold: SizeThreshold,
  plan: string,
): { reasons: string[]; proposal: SizeProposal | null } | null => {
  const count = investigation.parts.length;
  if (count < 2 || count < threshold.maxParts) return null;
  return {
    reasons: [
      `${String(count)} independent parts in the investigation (the board's limit is ${String(threshold.maxParts)})`,
    ],
    proposal: proposalFromParts(investigation.parts, plan),
  };
};
