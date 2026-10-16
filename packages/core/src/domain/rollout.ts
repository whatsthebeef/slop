import { isCapabilityName } from './capabilities.js';
import { HUMAN_STEP_BLOCKS } from './human-steps.js';
import type { HumanStepBlock } from './human-steps.js';
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
  /** A script in the repo the step points at (`script: scripts/rollout/<glob>-<slug>.sh` under the title); null when none. It wins over a fenced body. */
  readonly scriptPath: string | null;
  /** Labelled lines under the step, read into fields (`Why:`, `Permissions:`, `Run:` once per command, `Check:` or `Check it worked:`); they are not part of the detail. */
  readonly why: string | null;
  readonly permissions: string | null;
  readonly commands: readonly string[];
  readonly verify: string | null;
  /** Commands named in the `Check:` text (inline code spans that start with a known command), in order, one per line for the UI. */
  readonly checkCommands: readonly string[];
  /** The environment the step waits for a deploy to (`(env: production)`); null: it is due after the merge. */
  readonly env: string | null;
  /** `(once)`: a one-shot command inside the change. It has no environment (an `env` beside it is dropped and said so), falls due as soon as its script is on the branch and is never reopened. */
  readonly once: boolean;
  /** What the step says it holds back (`(blocks: sign_off, dependants)`); null when it doesn't say, so the default for its due applies. */
  readonly blocks: readonly HumanStepBlock[] | null;
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
 * - A parenthesised suffix can carry more, as comma-separated `key: value` pairs in any order:
 *   `(env: production, blocks: sign_off, dependants, check: fileAttachments)`. `env` names the environment the step waits for
 *   a deploy to (none: it is due after the merge; the board's environments are checked when the record is read, see `reconcileRollout`).
 *   `once` (or `once: true`) marks a one-shot command inside the change: no environment (an `env` beside it is dropped), due as soon as its
 *   script is on the glob's branch, done once and never reopened. Use it for work that takes effect by being run (an IAM grant, a setting),
 *   not by deploying. `blocks` lists what an open step holds
 *   back (`sign_off`, `reviewing`, `dependants`, or `none`); without it a step after the merge holds back sign-off and
 *   dependants, and a step after a deploy holds back nothing. A key slop doesn't know is dropped and said so in the detail.
 * - A script's body is its first fenced code block; any other fenced block stays in the detail.
 * - A line `script: <repo path>` under a step (a bullet, bold and backticks are fine) points the step at a script committed
 *   in the repo (`scripts/rollout/<glob>-<slug>.sh`). The line is not shown as detail, and the path wins over a fenced body.
 *   `script: <repo path>` inside a longer detail line counts too when the path has a `/` or a script's extension (it ends
 *   at a space, or at `.`, `,`, `;`, `:`, `!` or `)` before one or the line's end); that line stays in the detail, since
 *   it says more. The first path found wins.
 * - Titles are plain text: a bold kind (`**manual:** Do x`, `**manual**: Do x`) reads as the kind, emphasis or a code
 *   span around the whole title is dropped (`**Do x**` is `Do x`), and inline code inside it loses its backticks.
 * - Labelled lines under a step fill its fields: `Why:`, `Permissions:`, `Run:` (one command per line, several allowed, backticks
 *   stripped) and `Check:` or `Check it worked:` (a bullet, bold label and backticks are fine). The first of each single-valued
 *   label wins. Lines outside code fences that carry no label (and `Do this:` lines with nothing after them) stay as detail.
 * - The section runs to the next heading of the same or a higher level (headings inside code fences don't count).
 *   "None", "n/a", "nothing" or an empty section, or one with no list items, has no steps.
 * - Titles are made unique (`Title (2)`), because a re-read of the record matches steps by title.
 */
export const parseRollout = (record: string): RolloutStep[] => {
  const lines = sectionOf(record);
  const steps: RolloutStep[] = [];
  let topIndent: number | null = null;
  let current: {
    kind: RolloutStepKind;
    title: string;
    check: string | null;
    detail: string[];
    script: string[] | null;
    scriptPath: string | null;
    fence: Fence | null;
    why: string | null;
    permissions: string | null;
    commands: string[];
    verify: string | null;
    checkCommands: string[];
    /** The labelled field wrapped lines continue until a blank line, a bullet, a label or a fence. */
    open: 'why' | 'permissions' | 'verify' | 'run' | null;
    env: string | null;
    once: boolean;
    blocks: readonly HumanStepBlock[] | null;
  } | null = null;
  const finish = () => {
    if (current === null) return;
    const detail = trimBlank(current.detail).join('\n');
    steps.push({
      kind: current.kind,
      title: current.title,
      detail: detail === '' ? null : detail,
      check: current.check,
      script: current.scriptPath === null && current.kind === 'script' && current.script !== null ? current.script.join('\n') : null,
      scriptPath: current.scriptPath,
      why: current.why,
      permissions: current.permissions,
      // The script's own run command is shown from `script`, so a Run line that repeats it is dropped.
      commands: withExports(current.commands).filter(
        (c) => current?.scriptPath == null || !isScriptRun(c, current.scriptPath),
      ),
      verify: current.verify,
      checkCommands: current.checkCommands,
      env: current.env,
      once: current.once,
      blocks: current.blocks,
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
      current = {
        kind: parsed.kind,
        title: parsed.title,
        check: parsed.check,
        detail: [],
        script: null,
        scriptPath: null,
        fence: null,
        why: null,
        permissions: null,
        commands: [],
        verify: null,
        checkCommands: [],
        open: null,
        env: parsed.env,
        once: parsed.once,
        blocks: parsed.blocks,
      };
      if (parsed.overflow !== null) current.detail.push(parsed.overflow);
      for (const note of parsed.notes) current.detail.push(note);
      continue;
    }
    if (current === null) continue;
    const path = SCRIPT_LINE.exec(line);
    if (path?.[1] !== undefined && current.scriptPath === null && isRepoPath(path[1])) {
      current.scriptPath = path[1];
      continue;
    }
    // A path named inside a longer line points the step at it too, but the line stays: it carries other text.
    if (current.scriptPath === null && path === null) current.scriptPath = inlineScript(line);
    const labelled = FIELD_LINE.exec(line);
    if (labelled?.[1] !== undefined && labelled[2] !== undefined) {
      const label = labelled[1].toLowerCase();
      const raw = labelled[2];
      if (stripTicks(raw) !== '') {
        if (label === 'do this' && commandsOf(raw.includes('`') ? raw : '').commands.length === 0) {
          // Prose after `Do this:` stays detail; only one that names commands is split into them.
          current.open = null;
          current.detail.push(line.trim());
          continue;
        }
        if (label === 'run' || label === 'do this') {
          const found = commandsOf(raw);
          current.commands.push(...found.commands);
          if (found.rest !== '') current.detail.push(found.rest);
          current.open = found.commands.length > 0 ? null : 'run';
        } else if (label === 'why') {
          current.why ??= stripTicks(raw);
          current.open = current.why === stripTicks(raw) ? 'why' : null;
        } else if (label === 'permissions') {
          current.permissions ??= stripTicks(raw);
          current.open = current.permissions === stripTicks(raw) ? 'permissions' : null;
        } else {
          if (current.verify === null) {
            current.verify = stripTicks(raw);
            current.open = 'verify';
          } else current.open = null;
          current.checkCommands.push(...checkSpans(raw));
        }
        continue;
      }
    }
    // A wrapped line continues the field above it: its value runs to the next label, bullet, fence or blank line.
    if (current.open !== null && line.trim() !== '' && ITEM.exec(line) === null && FENCE_OPEN.exec(line) === null) {
      const text = stripTicks(line);
      if (current.open === 'run') {
        const found = commandsOf(line);
        current.commands.push(...found.commands);
        if (found.rest !== '') current.detail.push(found.rest);
      } else {
        const joined = `${current[current.open] ?? ''} ${text}`.trim();
        if (current.open === 'why') current.why = joined;
        else if (current.open === 'permissions') current.permissions = joined;
        else {
          current.verify = joined;
          current.checkCommands.push(...checkSpans(line));
        }
      }
      continue;
    }
    current.open = null;
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
/** `script: path`, as a bullet or not, with the label bold and the path in backticks or not. */
export const SCRIPT_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?script\s*:(?:\*\*)?\s*`?([^\s`]+)`?\s*$/i;
/** `script: path` inside a line: the path ends at a space, or at `.`, `,`, `;`, `:`, `!` or `)` before a space or the line's end. */
const SCRIPT_INLINE = /(?:^|[\s(])(?:\*\*)?script\s*:(?:\*\*)?\s*`?([^\s`]+?)`?(?=[.,;:!)]?(?:\s|$))/gi;
/** In prose a dotted word isn't a script (`script: e.g.`, `script: README.md`): an inline path needs a `/` or a script's extension. */
const SCRIPT_LIKE = /\/|\.(?:sh|bash|mjs|js|ts|py)$/;
/** `Why: …`, `Permissions: …`, `Run: …`, `Check: …` or `Check it worked: …`, as a bullet or not, with the label bold or not. */
const FIELD_LINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(why|permissions|run|do this|check(?: it worked)?)\s*:(?:\*\*)?\s*(.*)$/i;
const isScriptRun = (command: string, path: string): boolean =>
  command === `bash ${path}` || command === `sh ${path}` || command === `./${path}`;
const stripTicks = (value: string): string => value.replace(/`/g, '').trim();

/** `VAR=value cmd`: an environment prefix typed in front of a command. */
const ENV_PREFIX = /^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+)(\S.*)$/;
/** An inline span that is a shell command: it starts with a command a person types. */
const COMMAND_START = /^(?:aws|gh|git|bash|sh|\.\/|curl|psql|pnpm|npm|npx|node|slop|sstor|docker|export|unset|cd|claude-aws-session|[A-Za-z_][A-Za-z0-9_]*=)/;
const CONNECTORS = /^[\s,;.:()]*(?:(?:then|and|or|first|next|after that)[\s,;.:()]*)*$/i;

/** One command typed by a person; an `AWS_PROFILE=x cmd` prefix is kept here and split by `withExports`. */
const commandLines = (value: string): string[] => [value.trim()].filter((c) => c !== '');

/**
 * The commands in a `Run:` / `Do this:` value, in order, and the words around them. With inline code spans, each
 * span is a command (a `--dry-run` span after a command is that command's preview: it goes before it) and the rest
 * is prose; without spans the whole value is one command.
 */
const commandsOf = (value: string): { commands: string[]; rest: string } => {
  if (!value.includes('`')) return { commands: commandLines(value), rest: '' };
  const commands: string[] = [];
  const rest = value.replace(/`([^`]+)`/g, (_m, span: string) => {
    const text = span.trim();
    const prev = commands[commands.length - 1];
    if (/^--dry-run$/i.test(text) && prev !== undefined) commands.splice(commands.length - 1, 0, `${prev} ${text}`);
    else if (COMMAND_START.test(text) || ENV_PREFIX.test(text)) commands.push(text);
    else return span;
    return '';
  });
  return { commands, rest: CONNECTORS.test(rest.replace(/\b(?:preview with|first)\b/gi, '')) ? '' : rest.replace(/\s+/g, ' ').trim() };
};

/** The command spans named in a `Check:` text. */
const checkSpans = (value: string): string[] =>
  [...value.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').trim()).filter((c) => COMMAND_START.test(c));

/**
 * Splits `VAR=value cmd` into `export VAR=value` then `cmd`, once per variable, and ends with an `unset VAR` for each
 * variable the step exported, so a person's shell is left as it was.
 */
const withExports = (commands: readonly string[]): string[] => {
  const out: string[] = [];
  const exported: string[] = [];
  for (const command of commands) {
    const m = ENV_PREFIX.exec(command);
    if (m?.[1] === undefined || m[2] === undefined) {
      out.push(command);
      continue;
    }
    for (const pair of m[1].trim().split(/\s+/)) {
      const name = pair.slice(0, pair.indexOf('='));
      if (!exported.includes(name)) {
        out.push(`export ${pair}`);
        exported.push(name);
      }
    }
    out.push(m[2]);
  }
  return [...out, ...exported.map((n) => `unset ${n}`)];
};
const KIND_PREFIX = /^(script|setting|manual)\s*:\s*(.*)$/i;
const OPTIONS_SUFFIX = /\s*\(([^()]*)\)\s*$/;
const KNOWN_OPTIONS: readonly string[] = ['env', 'blocks', 'check', 'once'];
const ENV_NAME = /^[\w.-]+$/;
/** A bold kind: `**manual:** x`, `**manual**: x` (or with `__`). */
const BOLD_KIND = /^(\*\*|__)(script|setting|manual)(?:\s*:\s*\1|\1\s*:)\s*/i;
/** Marks that can wrap a whole title, longest first so `**x**` isn't read as `*` around `*x*`. */
const WRAPPERS = ['**', '__', '*', '_', '`'] as const;
const CHECK_SUFFIX = /\s*\(?\bcheck\s*:\s*([A-Za-z][\w-]*)\)?\s*$/i;

/** A relative path inside the repo: a `/` or an extension (not a bare word), no leading slash, no `..`, no spaces. */
export const isRepoPath = (path: string): boolean => (path.includes('/') || path.includes('.')) && !path.startsWith('/') && !path.split('/').includes('..') && /^[\w.@+-]+(?:\/[\w.@+-]+)*$/.test(path);

const inlineScript = (line: string): string | null => {
  for (const m of line.matchAll(SCRIPT_INLINE)) if (m[1] !== undefined && isRepoPath(m[1]) && SCRIPT_LIKE.test(m[1])) return m[1];
  return null;
};

/** Drops emphasis or a code span around the whole text (repeatedly, for `***x***`), then inline code's backticks. A mark that also appears inside (`**a** and **b**`) isn't a wrapper. */
const unwrap = (text: string): string => {
  let t = text.trim();
  for (let mark = WRAPPERS.find((w) => isWrapped(t, w)); mark !== undefined; mark = WRAPPERS.find((w) => isWrapped(t, w))) t = t.slice(mark.length, -mark.length);
  return t.replace(/`([^`]+)`/g, '$1');
};
const isWrapped = (text: string, mark: string): boolean => {
  const inner = text.slice(mark.length, -mark.length);
  return text.length > mark.length * 2 && text.startsWith(mark) && text.endsWith(mark) && !inner.includes(mark) && inner.trim() === inner;
};

/**
 * A stored step title as `parseRollout` would write it now (kind, check suffix and emphasis read off, as `titleOf`
 * does). A re-read matches steps stored before titles were plain (`**Check the backfill ran**`) with it.
 */
export const plainTitle = (text: string): string => titleOf(text)?.title ?? text.trim();

/**
 * Which stored step each parsed title is (an index into `stored`, or -1), each stored step used once: an exact title
 * first, then the stored title made plain and numbered as `parseRollout` numbers repeats, so a stored `**Do x**` beside
 * a stored `Do x` is `Do x (2)`.
 */
export const matchStoredTitles = (titles: readonly string[], stored: readonly string[]): number[] => {
  const taken = new Set<number>();
  const exact = titles.map((title) => {
    const i = stored.findIndex((s, j) => !taken.has(j) && s === title);
    if (i >= 0) taken.add(i);
    return i;
  });
  const seen = new Map<string, number>();
  for (const i of taken) {
    const plain = plainTitle(stored[i] ?? '');
    seen.set(plain, (seen.get(plain) ?? 0) + 1);
  }
  const byPlain = new Map<string, number>();
  stored.forEach((s, j) => {
    if (taken.has(j)) return;
    const plain = plainTitle(s);
    const n = (seen.get(plain) ?? 0) + 1;
    seen.set(plain, n);
    const key = n === 1 ? plain : `${plain} (${String(n)})`;
    if (!byPlain.has(key)) byPlain.set(key, j);
  });
  return exact.map((i, k) => {
    if (i >= 0) return i;
    const j = byPlain.get(titles[k] ?? '');
    if (j === undefined || taken.has(j)) return -1;
    taken.add(j);
    return j;
  });
};

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
  // `**manual:** x` reads as `manual: x`, and `**manual: x**` as well.
  const whole = unwrap(text);
  const bold = BOLD_KIND.exec(whole);
  const prefix = KIND_PREFIX.exec(bold === null ? whole : `${bold[2] ?? ''}: ${whole.slice(bold[0].length)}`);
  const word = prefix?.[1]?.toLowerCase();
  const kind: RolloutStepKind = word === 'script' || word === 'setting' ? word : 'manual';
  let title = unwrap(prefix === null ? whole : (prefix[2] ?? ''));
  if (NOTHING.test(title) && prefix === null) return null;
  let check: string | null = null;
  let env: string | null = null;
  let blocks: HumanStepBlock[] | null = null;
  let once = false;
  const notes: string[] = [];
  const capability = (name: string): string | null => {
    if (isCapabilityName(name)) return name;
    notes.push(`check: ${name} is not a capability slop knows`);
    return null;
  };
  const options = OPTIONS_SUFFIX.exec(title);
  const pairs = options?.[1] === undefined ? null : optionPairs(options[1]);
  if (options !== null && pairs !== null) {
    title = unwrap(title.slice(0, options.index));
    for (const [key, value] of pairs) {
      if (key === 'check') check = capability(value);
      else if (key === 'env') {
        if (ENV_NAME.test(value)) env = value;
        else notes.push(`env: ${value} is not an environment name`);
      } else if (key === 'once') {
        once = !/^(false|no|0)$/i.test(value);
      } else if (key === 'blocks') {
        blocks = [];
        for (const word of value.split(/[\s,+]+/).filter((w) => w !== '' && w !== 'none')) {
          if (isBlock(word)) blocks.push(word);
          else notes.push(`blocks: ${word} is not something a step can hold back`);
        }
      } else notes.push(`${key} is not a rollout option slop knows`);
    }
    blocks = blocks === null ? null : [...new Set(blocks)];
  } else {
    const suffix = CHECK_SUFFIX.exec(title);
    if (suffix?.[1] !== undefined) {
      title = unwrap(title.slice(0, suffix.index));
      check = capability(suffix[1]);
    }
  }
  if (title === '') title = kind === 'script' ? 'Run the script' : 'Do this by hand';
  // A once step is environment-independent: it is never filed under an environment.
  if (once && env !== null) {
    notes.push(`env: ${env} is ignored: a once step has no environment`);
    env = null;
  }
  const cut = shortTitle(title);
  return { kind, title: cut.title, check, notes, overflow: cut.overflow, env, once, blocks };
};

const isBlock = (word: string): word is HumanStepBlock => HUMAN_STEP_BLOCKS.some((b) => b === word);

/**
 * The `key: value` pairs of a parenthesised suffix, or null when it is not one (no pair uses a key slop knows, so
 * "(staging: needs approval)" stays part of the title). A segment after a comma with no key continues the previous value
 * (`blocks: sign_off, dependants`). Keys are lower-cased.
 */
const optionPairs = (text: string): [string, string][] | null => {
  const pairs: [string, string][] = [];
  for (const segment of text.split(',')) {
    // A bare `once` is the flag with no value.
    if (/^\s*once\s*$/i.test(segment)) {
      pairs.push(['once', 'true']);
      continue;
    }
    const keyed = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(segment);
    const last = pairs[pairs.length - 1];
    if (keyed?.[1] !== undefined) pairs.push([keyed[1].toLowerCase(), (keyed[2] ?? '').trim()]);
    else if (last !== undefined) last[1] = `${last[1]}, ${segment.trim()}`;
    else return null;
  }
  return pairs.some(([key]) => KNOWN_OPTIONS.includes(key)) ? pairs : null;
};

/** Longest step title kept as written, in characters; a longer one is cut and its rest moves into the detail. */
export const ROLLOUT_TITLE_MAX = 120;

/** A title over the limit is cut at its first sentence (or, with none that short, at a word) and the rest becomes detail. */
const shortTitle = (title: string): { title: string; overflow: string | null } => {
  if (title.length <= ROLLOUT_TITLE_MAX) return { title, overflow: null };
  const sentence = /^(.+?)[.!?]\s+(?=\S)/.exec(title);
  if (sentence?.[1] !== undefined && sentence[1].length <= ROLLOUT_TITLE_MAX) {
    return { title: sentence[1], overflow: title.slice(sentence[0].length).trim() };
  }
  const space = title.lastIndexOf(' ', ROLLOUT_TITLE_MAX - 1);
  const end = space > 0 ? space : ROLLOUT_TITLE_MAX - 1;
  return { title: `${title.slice(0, end).trimEnd()}…`, overflow: title };
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

/** The label of the attachment that records why a merged glob needs no rollout ("No rollout needed: <reason>"). */
export const ROLLOUT_NONE_LABEL = 'Rollout check';

/** The line the attachment starts with, then the one-line reason. */
export const ROLLOUT_NONE_PREFIX = 'No rollout needed: ';

/** What the rollout job concluded about a merged change. */
export type RolloutAnswer =
  | { readonly decision: 'steps'; readonly steps: readonly RolloutStep[] }
  | { readonly decision: 'none'; readonly reason: string }
  | { readonly decision: 'ask'; readonly question: string };

/** Longest reason or question kept, in characters. */
export const ROLLOUT_TEXT_MAX = 300;

export const ROLLOUT_SYSTEM = `You decide what a person must do after a change is merged and deployed, beyond the deploy itself.
The server image deploys on merge; drizzle migrations run when the server starts; GitHub workflows take effect with the merge.
A person is needed only for: a script to run (stack deploys, one-off data updates), a setting or secret to put in production (a new setting without a default, or one that only matters in production), or something to do by hand.
A step is an action after the merge that this change requires. It is not a note (information with no action), not a review or approval due before the merge, and not optional or per-board setup. Only state commands, settings and numbers the diff or record show.
Write each step as a short imperative title (under 120 characters, no conditions or commands in it), then indented bullets: 'Why: <one sentence>', 'Permissions: <the exact login and rights, for a step run in a terminal>', one 'Run: <command>' line per command (no backticks, no Markdown), 'Check: <what you should see>'. Anything else a person needs goes in plain lines under the title.
A step that can only be done after a deploy to another environment (for example production) ends its title with '(env: <environment name>)', using a name the record or diff shows; a step with no env is for right after the merge. A one-shot command that does not depend on an environment (an IAM grant, an account setting) ends its title with '(once)' and has no env. Add 'blocks: sign_off' there only when the glob must not be signed off before that step is done; steps after a deploy hold nothing back by default. Add 'check: <capability>' only when told that capability exists. Name a script that exists in the diff or the tree on a line 'script: <repo path>' under the title and never repeat its path in another line (slop shows its run command itself); never invent one.
Answer with one JSON object and nothing else, in one of three shapes:
{"decision":"none","reason":"<one line: why nothing is needed, e.g. migration 0071 runs on start; no new settings>"}
{"decision":"steps","rollout":"<a ## Rollout section's list: one '- script|setting|manual: <short imperative title>' item per step, its Why / Permissions / Run / Check lines indented under it, '(env: <environment>, blocks: sign_off, check: <capability>)' at the end of a title, each part only when it applies>"}
{"decision":"ask","question":"<one specific question a person can answer, e.g. Does SLOP_X need setting in prod? It has no default>"}
Prefer "none" when the diff only adds settings with defaults, or only changes code the deploy ships. Use "ask" only when the diff doesn't let you tell. Never invent steps.`;

export interface RolloutInputs {
  readonly glob: { readonly id: string; readonly title: string };
  readonly files: readonly string[];
  /** Diffs of the files under the rollout paths (cut), keyed by path. */
  readonly patches: Readonly<Record<string, string>>;
  readonly record: string;
  readonly capabilities: readonly string[];
}

/** Longest implementation record and per-file diff the prompt carries, in characters. */
export const ROLLOUT_RECORD_MAX = 6_000;
export const ROLLOUT_PATCH_MAX = 6_000;

const cutText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n… (cut)` : text);

export const rolloutPrompt = (inputs: RolloutInputs): string =>
  [
    `Glob ${inputs.glob.id}: ${inputs.glob.title}`,
    `Files in the merge (${String(inputs.files.length)}):`,
    ...inputs.files.slice(0, 80).map((f) => `- ${f}`),
    '',
    'Diffs of the files that triggered this check:',
    ...Object.entries(inputs.patches).flatMap(([file, patch]) => [`### ${file}`, '```diff', cutText(patch, ROLLOUT_PATCH_MAX), '```']),
    Object.keys(inputs.patches).length === 0 ? '(the code host gave no diff; judge from the file names and the record)' : '',
    '',
    'Implementation record:',
    cutText(inputs.record, ROLLOUT_RECORD_MAX),
    '',
    `Capabilities slop can verify for a step's check: ${inputs.capabilities.length === 0 ? 'none' : inputs.capabilities.join(', ')}`,
  ].join('\n');

const oneLine = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  return line === '' ? null : line.slice(0, ROLLOUT_TEXT_MAX);
};

/** The model's answer, checked: an object with a known decision and its text; `steps` needs at least one parsed step. */
export const checkRolloutAnswer = (answer: unknown): { readonly ok: true; readonly value: RolloutAnswer } | { readonly ok: false; readonly error: string } => {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return { ok: false, error: 'not an object' };
  const record = answer as Record<string, unknown>;
  if (record.decision === 'none') {
    const reason = oneLine(record.reason);
    return reason === null ? { ok: false, error: 'none without a reason' } : { ok: true, value: { decision: 'none', reason: reason.replace(/^no rollout needed:?\s*/i, '') } };
  }
  if (record.decision === 'ask') {
    const question = oneLine(record.question);
    return question === null ? { ok: false, error: 'ask without a question' } : { ok: true, value: { decision: 'ask', question } };
  }
  if (record.decision === 'steps') {
    const rollout = typeof record.rollout === 'string' ? record.rollout : '';
    const steps = parseRollout(`## Rollout\n${rollout}`);
    return steps.length === 0 ? { ok: false, error: 'steps without a step' } : { ok: true, value: { decision: 'steps', steps } };
  }
  return { ok: false, error: 'unknown decision' };
};
