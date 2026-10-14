/**
 * The test plan artifact (kind `test_plan`): a Markdown matrix for people (which specs prove the change) and one fenced
 * ```` ```atf-specs ```` block for the board's pipeline (the specs to run after the merge is deployed). Saving never
 * rejects: the text is stored and every problem found is reported in a note beside it, as for the investigation. The parsed
 * list is kept on the artifact's provenance so readers don't parse again. Pure; no YAML library in core, so the small
 * block grammar (`specs:` list of `- path`, `grep:` scalar or null, `#` comments) is read by hand.
 */

export const TEST_PLAN_STATUSES = ['new', 'existing', 'adjusted'] as const;
export type TestPlanStatus = (typeof TEST_PLAN_STATUSES)[number];

/** What the pipeline runs: the spec paths (relative to the board's repo) and an optional Playwright `--grep`. */
export interface AtfSpecList {
  readonly specs: readonly string[];
  readonly grep: string | null;
}

export interface TestPlanRow {
  readonly name: string;
  /** Null when the cell is not one of the known statuses (a validation note says so). */
  readonly status: TestPlanStatus | null;
  /** The first backticked path of the Location cell, without a trailing "(to add)"; empty when there is none. */
  readonly location: string;
  readonly description: string;
}

export interface TestPlanParse {
  readonly matrix: readonly TestPlanRow[];
  /** The last `atf-specs` block; null when there is none. */
  readonly atf: AtfSpecList | null;
  /** Everything wrong with the document; empty when it is valid. */
  readonly notes: readonly string[];
}

export const MAX_ATF_SPECS = 200;
export const MAX_SPEC_PATH_LENGTH = 300;
export const MAX_ATF_GREP_LENGTH = 200;
/** An `adjusted` row must say what changes; shorter than this is "nothing". */
export const MIN_ADJUSTED_DESCRIPTION = 10;

const FENCE = /^```atf-specs[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** A value cut at an unquoted ` #` comment, with matching outer quotes removed. */
const scalar = (raw: string): string => {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end > 0) return text.slice(1, end);
  }
  const hash = text.search(/(^|\s)#/);
  return (hash < 0 ? text : text.slice(0, hash)).trim();
};

interface Block {
  readonly list: AtfSpecList;
  readonly errors: readonly string[];
}

const readBlock = (block: string): Block => {
  const specs: string[] = [];
  const errors: string[] = [];
  let grep: string | null = null;
  let inSpecs = false;
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item !== null && inSpecs) {
      const path = scalar(item[1] ?? '');
      if (path !== '') specs.push(path);
      continue;
    }
    const key = /^(specs|grep)\s*:(.*)$/.exec(line);
    if (key === null) {
      errors.push(`Unrecognised line in the atf-specs block: "${line.trim().slice(0, 60)}"`);
      continue;
    }
    if (key[1] === 'specs') {
      inSpecs = true;
      const rest = scalar(key[2] ?? '');
      if (rest !== '' && rest !== '[]') errors.push('specs must be a list of "- path" lines');
    } else {
      inSpecs = false;
      const value = scalar(key[2] ?? '');
      grep = value === '' || value === 'null' || value === '~' ? null : value;
    }
  }
  return { list: { specs, grep }, errors };
};

/** The cells of one table row, `\|` kept as a pipe inside a cell. */
const cells = (line: string): string[] => {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};

const HEADER = ['name', 'status', 'location', 'description'];

const locationOf = (cell: string): string => {
  const ticked = /`([^`]+)`/.exec(cell)?.[1] ?? cell;
  return ticked.replace(/\s*\(to add\)\s*$/i, '').trim();
};

/** The rows of the first table headed `Name | Status | Location | Description`, outside code fences. */
const readMatrix = (content: string, notes: string[]): TestPlanRow[] => {
  const lines = content.split(/\r?\n/);
  const rows: TestPlanRow[] = [];
  let fenced = false;
  let started = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (started) break;
      continue;
    }
    if (fenced) continue;
    if (!started) {
      if (
        line.trim().startsWith('|') &&
        cells(line)
          .map((c) => c.toLowerCase())
          .join('|') === HEADER.join('|')
      )
        started = true;
      continue;
    }
    if (!line.trim().startsWith('|')) break;
    const parts = cells(line);
    // The |---|---| separator row.
    if (parts.every((p) => /^:?-{2,}:?$/.test(p))) continue;
    const [name = '', rawStatus = '', location = '', ...rest] = parts;
    const status = TEST_PLAN_STATUSES.find((s) => s === rawStatus.toLowerCase()) ?? null;
    if (status === null)
      notes.push(
        `Row "${name}" has status "${rawStatus}", not one of ${TEST_PLAN_STATUSES.join(', ')}`,
      );
    rows.push({
      name,
      status,
      location: locationOf(location),
      description: rest.join(' | ').trim(),
    });
  }
  return rows;
};

/** Why a spec path is not usable, or null: relative to the repo, no `..`, no backslash, bounded. */
const pathProblem = (path: string): string | null => {
  if (path.length > MAX_SPEC_PATH_LENGTH)
    return `"${path.slice(0, 40)}..." is longer than ${String(MAX_SPEC_PATH_LENGTH)} characters`;
  if (path.startsWith('/')) return `"${path}" is absolute: use a path relative to the repo`;
  if (path.includes('\\')) return `"${path}" has a backslash: use forward slashes`;
  if (path.split('/').includes('..'))
    return `"${path}" goes up with "..": use a path inside the repo`;
  return null;
};

/** Reads the matrix and the `atf-specs` block of a test plan and checks them; never throws. */
export const parseTestPlan = (content: string): TestPlanParse => {
  const notes: string[] = [];
  const matrix = readMatrix(content, notes);
  const found = [...content.matchAll(FENCE)].at(-1)?.[1];
  const block = found === undefined ? null : readBlock(found);
  if (block === null) {
    if (matrix.length > 0) notes.push('No ```atf-specs block: the pipeline has nothing to run');
  } else {
    notes.push(...block.errors);
    const { specs, grep } = block.list;
    if (specs.length > MAX_ATF_SPECS)
      notes.push(`At most ${String(MAX_ATF_SPECS)} specs, found ${String(specs.length)}`);
    for (const path of specs) {
      const problem = pathProblem(path);
      if (problem !== null) notes.push(problem);
    }
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const path of specs) {
      if (seen.has(path)) twice.add(path);
      seen.add(path);
    }
    for (const path of twice) notes.push(`"${path}" is listed twice`);
    if (grep !== null && grep.length > MAX_ATF_GREP_LENGTH)
      notes.push(`grep is longer than ${String(MAX_ATF_GREP_LENGTH)} characters`);
    for (const row of matrix) {
      if (row.location !== '' && !seen.has(row.location))
        notes.push(
          `"${row.location}" (${row.name}) is in the matrix but not in the atf-specs block`,
        );
    }
  }
  for (const row of matrix) {
    if (row.status === 'adjusted' && row.description.length < MIN_ADJUSTED_DESCRIPTION) {
      notes.push(`Row "${row.name}" is adjusted: its description must say what changes`);
    }
  }
  return { matrix, atf: block?.list ?? null, notes };
};

/** The note stored and shown with a test plan that has problems; null when it is valid. */
export const testPlanNote = (notes: readonly string[]): string | null =>
  notes.length === 0 ? null : `Test plan not fully valid: ${notes.join('; ')}`;

/**
 * The spec list of a stored test plan: the one saved on its provenance, else read from the text (a version saved before the
 * list was kept). Null when the plan has no block.
 */
export const testPlanSpecs = (artifact: {
  readonly content: string;
  readonly provenance: { readonly atfSpecs?: AtfSpecList };
}): AtfSpecList | null => artifact.provenance.atfSpecs ?? parseTestPlan(artifact.content).atf;

/** A spec or grep with the globs that asked for it. */
export interface RequestedSpec {
  readonly spec: string;
  readonly globIds: readonly string[];
}
export interface RequestedGrep {
  readonly grep: string;
  readonly globIds: readonly string[];
}

/**
 * The union of several globs' lists (a deploy burst runs it once): each spec once and each grep once, with the globs that
 * listed it. Sorted, so the same input always gives the same batch.
 */
export const unionSpecs = (
  plans: readonly { readonly globId: string; readonly atf: AtfSpecList | null }[],
): { readonly specs: readonly RequestedSpec[]; readonly greps: readonly RequestedGrep[] } => {
  const specs = new Map<string, Set<string>>();
  const greps = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, key: string, globId: string) => {
    into.set(key, (into.get(key) ?? new Set<string>()).add(globId));
  };
  for (const { globId, atf } of plans) {
    if (atf === null) continue;
    for (const spec of atf.specs) add(specs, spec, globId);
    if (atf.grep !== null) add(greps, atf.grep, globId);
  }
  const sorted = <T>(
    m: Map<string, Set<string>>,
    make: (key: string, globIds: string[]) => T,
  ): T[] =>
    [...m].sort(([a], [b]) => a.localeCompare(b)).map(([key, ids]) => make(key, [...ids].sort()));
  return {
    specs: sorted(specs, (spec, globIds) => ({ spec, globIds })),
    greps: sorted(greps, (grep, globIds) => ({ grep, globIds })),
  };
};
