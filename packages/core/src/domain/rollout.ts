import { isCapabilityName } from './capabilities.js';
import { matchesGlob } from './sub-gate.js';

/** The artifact kind a script step's body is stored as, one per step label. */
export const ROLLOUT_SCRIPT_KIND = 'rollout_script';

/** Title of the step slop adds when a merge touches rollout paths and the record has no Rollout section. */
export const ROLLOUT_NOT_WRITTEN_TITLE = 'Rollout steps not written: check what this change needs';

/** Where a step came from (`StoredHumanStep.origin`): the record's `## Rollout` section, or the rollout-paths check. */
export const ROLLOUT_SECTION_ORIGIN = 'rollout-section';
export const ROLLOUT_PATHS_ORIGIN = 'rollout-paths';

export type RolloutStepKind = 'script' | 'setting' | 'manual';

/** One step written in the record's `## Rollout` section. */
export interface RolloutStep {
  readonly kind: RolloutStepKind;
  readonly title: string;
  /** Markdown under the title (everything but the script's own code block); null when there is none. */
  readonly detail: string | null;
  /** A capability slop can verify (see `CAPABILITY_NAMES`); null when none was named or the name isn't one. */
  readonly check: string | null;
  /** A `script` step's body: its first fenced code block, without the fences; null for other steps or when absent. */
  readonly script: string | null;
}

/**
 * The `## Rollout` section of an implementation record, as steps. The format is forgiving, one step per list item:
 *
 *     ## Rollout
 *     - script: Deploy the host stack (check: fileAttachments)
 *       Detail lines, indented under the item.
 *       ```bash
 *       infra/deploy/host-deploy.sh
 *       ```
 *     - setting: Add ATTACHMENTS_BUCKET to /slop/prod/server-env
 *     - manual: Turn on the network setting in the Claude app
 *
 * - Items are `-`, `*`, `+` or numbered (`1.`, `1)`). Only items at the section's top list indent are steps; bullets
 *   nested deeper are detail of the step above.
 * - The kind is `script`, `setting` or `manual` (any case); an item without one counts as `manual`.
 * - `(check: name)` or `check: name` at the end of the title names a capability slop can verify and tick the step by
 *   itself once it is on. A name slop doesn't know is dropped and said so in the detail, so the step still shows.
 * - A script's body is its first fenced code block; any other fenced block stays in the detail.
 * - The section runs to the next heading of the same or a higher level (headings inside code fences don't count).
 *   "None", "n/a", "nothing" or an empty section, or one with no list items, has no steps.
 * - Titles are made unique (`Title (2)`), because a re-read of the record matches steps by title.
 */
export const parseRollout = (record: string): RolloutStep[] => {
  const lines = sectionOf(record);
  const steps: RolloutStep[] = [];
  let topIndent: number | null = null;
  let current: { kind: RolloutStepKind; title: string; check: string | null; detail: string[]; script: string[] | null; fence: Fence | null } | null = null;
  const finish = () => {
    if (current === null) return;
    const detail = trimBlank(current.detail).join('\n');
    steps.push({
      kind: current.kind,
      title: current.title,
      detail: detail === '' ? null : detail,
      check: current.check,
      script: current.kind === 'script' && current.script !== null ? current.script.join('\n') : null,
    });
    current = null;
  };
  for (const line of lines) {
    if (current?.fence != null) {
      const { fence } = current;
      if (isFenceClose(line, fence)) {
        current.fence = null;
        if (fence.target === 'detail') current.detail.push(line.trim() === '' ? '' : dedent(line, fence.indent));
        continue;
      }
      const text = dedent(line, fence.indent);
      if (fence.target === 'script') current.script?.push(text);
      else current.detail.push(text);
      continue;
    }
    const item = ITEM.exec(line);
    const indent = item?.[1]?.length ?? 0;
    // Only a marker at the section's top list indent starts a step; a deeper one is detail of the step above it.
    if (item !== null && (topIndent === null || indent <= topIndent)) {
      topIndent ??= indent;
      finish();
      const parsed = titleOf(item[2] ?? '');
      if (parsed === null) continue;
      current = { kind: parsed.kind, title: parsed.title, check: parsed.check, detail: [], script: null, fence: null };
      if (parsed.unknownCheck !== null) current.detail.push(`check: ${parsed.unknownCheck} is not a capability slop knows`);
      continue;
    }
    if (current === null) continue;
    const open = FENCE_OPEN.exec(line);
    if (open !== null && open[2] !== undefined) {
      const marker = open[2];
      const first = current.kind === 'script' && current.script === null;
      current.fence = { char: marker.charAt(0), length: marker.length, indent: (open[1] ?? '').length, target: first ? 'script' : 'detail' };
      if (first) current.script = [];
      else current.detail.push(line.trim());
      continue;
    }
    current.detail.push(line.trim());
  }
  finish();
  return uniqueTitles(steps);
};

interface Fence {
  readonly char: string;
  readonly length: number;
  readonly indent: number;
  readonly target: 'script' | 'detail';
}

/** A list item: indent, a bullet or number marker, then the text. */
const ITEM = /^( *)(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE_OPEN = /^( *)(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const NOTHING = /^(none|n\/a|na|nothing|no rollout|not needed|no)[.!]?$/i;
const KIND_PREFIX = /^(script|setting|manual)\s*:\s*(.*)$/i;
const CHECK_SUFFIX = /\s*\(?\bcheck\s*:\s*([A-Za-z][\w-]*)\)?\s*$/i;

const isFenceClose = (line: string, fence: Fence): boolean => {
  const m = FENCE_OPEN.exec(line);
  const marker = m?.[2];
  return marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length && line.trim() === marker;
};

const dedent = (line: string, indent: number): string => {
  let cut = 0;
  while (cut < indent && line.charAt(cut) === ' ') cut++;
  return line.slice(cut);
};

const trimBlank = (lines: readonly string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end);
};

const titleOf = (text: string) => {
  const prefix = KIND_PREFIX.exec(text.trim());
  const word = prefix?.[1]?.toLowerCase();
  const kind: RolloutStepKind = word === 'script' || word === 'setting' ? word : 'manual';
  let title = (prefix === null ? text : (prefix[2] ?? '')).trim();
  if (NOTHING.test(title) && prefix === null) return null;
  let check: string | null = null;
  let unknownCheck: string | null = null;
  const suffix = CHECK_SUFFIX.exec(title);
  if (suffix?.[1] !== undefined) {
    title = title.slice(0, suffix.index).trim();
    if (isCapabilityName(suffix[1])) check = suffix[1];
    else unknownCheck = suffix[1];
  }
  if (title === '') title = kind === 'script' ? 'Run the script' : 'Do this by hand';
  return { kind, title, check, unknownCheck };
};

/** The lines of the Rollout section: after its heading, up to the next heading of the same or a higher level. */
const sectionOf = (record: string): string[] => {
  const lines = record.split(/\r?\n/);
  let fence: { char: string; length: number } | null = null;
  let level = 0;
  const found: string[] = [];
  for (const line of lines) {
    const open = FENCE_OPEN.exec(line);
    if (fence !== null) {
      if (open?.[2] !== undefined && open[2].charAt(0) === fence.char && open[2].length >= fence.length && line.trim() === open[2]) fence = null;
    } else if (open?.[2] !== undefined) {
      fence = { char: open[2].charAt(0), length: open[2].length };
    } else {
      const heading = HEADING.exec(line);
      if (heading?.[1] !== undefined) {
        if (level > 0 && heading[1].length <= level) break;
        if (level === 0 && /^rollout\s*:?$/i.test(heading[2] ?? '')) {
          level = heading[1].length;
          continue;
        }
      }
    }
    if (level > 0) found.push(line);
  }
  return found;
};

const uniqueTitles = (steps: RolloutStep[]): RolloutStep[] => {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const n = (seen.get(step.title) ?? 0) + 1;
    seen.set(step.title, n);
    return n === 1 ? step : { ...step, title: `${step.title} (${String(n)})` };
  });
};

/** The artifact label a script step's body is stored under: stable for a title, so a re-read adds versions, not artifacts. */
export const rolloutScriptLabel = (title: string): string =>
  `rollout: ${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)}`;

/** Whether any of a merge's files is under one of the rollout paths. */
export const touchesRolloutPaths = (files: readonly string[], paths: readonly string[]): boolean =>
  files.some((file) => paths.some((glob) => glob.trim() !== '' && matchesGlob(file, glob)));
