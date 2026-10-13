/**
 * The investigation artifact (kind `investigation`): the investigator's output as data. Its text ends with one fenced
 * block, ```` ```investigation ````, holding a JSON object that slop validates. A malformed block is kept as text and
 * reported with a note, never rejected: the investigation is still useful to read. Pure.
 */
import { RISK_TIERS } from './knowledge.js';
import type { RiskTier } from './knowledge.js';
import { contextSectionList } from './intake-learning.js';
import { MAX_PROPOSED_PARTS } from './size-check.js';
import type { ProposedPart, SizeProposal, SizeThreshold } from './size-check.js';

export const CHANGE_KINDS = ['create', 'modify', 'delete'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const INVESTIGATION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type InvestigationConfidence = (typeof INVESTIGATION_CONFIDENCES)[number];

export interface InvestigationFile {
  readonly path: string;
  readonly change: ChangeKind;
}

/**
 * A part that could ship on its own; `needs` names the other parts (by `name`) it builds on. `title`, `summary` and `plan`
 * (the part's own share of the original plan) are optional: older investigations lack them and fall back to the name.
 */
export interface InvestigationPart {
  readonly name: string;
  readonly title?: string;
  readonly summary?: string;
  readonly plan?: string;
  readonly files: readonly string[];
  readonly needs: readonly string[];
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
        const text = (key: 'title' | 'summary' | 'plan'): string | undefined => {
          const v = p[key];
          if (v === undefined || v === null) return undefined;
          if (typeof v !== 'string') {
            errors.push(`parts[${String(i)}].${key} must be a string`);
            return undefined;
          }
          return v.trim() === '' ? undefined : v.trim();
        };
        const title = text('title');
        const summary = text('summary');
        const partPlan = text('plan');
        parts.push({
          name: p.name,
          files: p.files,
          needs: p.needs,
          ...(title !== undefined ? { title } : {}),
          ...(summary !== undefined ? { summary } : {}),
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

/** The card title: `<original title> <i>/<n>: <part title>`, the original cut so the whole stays within 120 characters. */
const partTitle = (
  original: string,
  index: number,
  count: number,
  part: InvestigationPart,
): string => {
  const label = (part.title ?? part.name).trim();
  const position = ` ${String(index + 1)}/${String(count)}: `;
  const room = 120 - position.length - Math.min(label.length, 60);
  const head = original.trim();
  const prefix = head.length > room ? `${head.slice(0, Math.max(room - 1, 1)).trimEnd()}…` : head;
  return `${prefix}${position}${label}`.slice(0, 120);
};

/**
 * A split proposal from the investigation's parts, in split_glob's shape; null when they can't be cut into 2 to 10 parts.
 * Each part's title is the original glob's title with its position and the part's own title; its summary and plan are its
 * own, with the plan's context sections it lacks carried in (as `buildProposal` does). A part without them (an older
 * investigation) gets the name-based title and summary and the whole original plan.
 */
export const proposalFromParts = (
  parts: readonly InvestigationPart[],
  plan: string,
  title = '',
): SizeProposal | null => {
  const sorted = ordered(parts);
  if (sorted === null || sorted.length < 2 || sorted.length > MAX_PROPOSED_PARTS) return null;
  const context = contextSectionList(plan);
  const original = title.trim() === '' ? 'Part' : title;
  const built: ProposedPart[] = sorted.map((part, index) => {
    const own = part.plan?.trim() ?? '';
    const missing = context.filter((section) => !lowered(own).includes(lowered(section.heading)));
    const carried = [
      own,
      ...missing.map((section) => `## ${section.heading}\n\n${section.body}`),
    ].join('\n\n');
    return {
      title: partTitle(original, index, sorted.length, part),
      summary:
        part.summary?.trim() ??
        `${part.name.trim()} part of ${title.trim() === '' ? 'the original glob' : title.trim()}. Files: ${part.files.join(', ')}`,
      plan:
        own === ''
          ? `${index === 0 ? 'This part stays the original glob.' : 'A part split out of the original glob.'} Scope: ${part.name}\n\nFiles:\n${bullets(part.files)}\n\nOriginal plan (keep only this part's share of its tasks and "Done when" lines):\n\n${plan.trim()}`
          : `${index === 0 ? 'This part stays the original glob.' : 'A part split out of the original glob.'}\n\n${carried}\n\nFiles:\n${bullets(part.files)}`,
      after: part.needs.map((n) => sorted.findIndex((p) => p.name === n)).sort((a, b) => a - b),
    };
  });
  return { parts: built };
};

/**
 * The oversize flag an investigation raises: its parts name the cut, so it counts against the board's parts limit at the
 * limit itself (the plan's own estimate is a guess, this is the investigator's reading of the code). Null below it.
 */
export const oversizeOf = (
  investigation: Investigation,
  threshold: SizeThreshold,
  plan: string,
  title = '',
): { reasons: string[]; proposal: SizeProposal | null } | null => {
  const count = investigation.parts.length;
  if (count < 2 || count < threshold.maxParts) return null;
  return {
    reasons: [
      `${String(count)} independent parts in the investigation (the board's limit is ${String(threshold.maxParts)})`,
    ],
    proposal: proposalFromParts(investigation.parts, plan, title),
  };
};
