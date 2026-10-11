import { GREP_LINE_LIMIT, GREP_MATCH_LIMIT, LIST_DIR_LIMIT, READ_FILE_LIMIT, toolCap } from '../domain/review-tools.js';
import type { ReviewToolCall } from '../domain/review-tools.js';

export interface DirEntry {
  readonly name: string;
  readonly type: 'file' | 'dir';
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Read-only access to the code being reviewed (the PR's test-merge ref before merge, the current base branch after).
 * Reads go through the code host's API; `grep` searches a temporary shallow clone. There is nothing here that runs code.
 */
export interface CodeAccess {
  /** The file's text, or null when there is no such file. */
  readFile(path: string, signal?: AbortSignal): Promise<string | null>;
  /** The entries directly in a directory ('' is the root); null when there is no such directory. */
  listDir(path: string, signal?: AbortSignal): Promise<readonly DirEntry[] | null>;
  /** Lines matching the regular expression, at most `limit`; the adapter makes the clone on the first search. */
  grep(pattern: string, limit: number, signal?: AbortSignal): Promise<readonly GrepMatch[]>;
  /** Deletes the temporary clone. Safe to call more than once and when no clone was made. */
  dispose(): Promise<void>;
}

const cut = (value: string, limit: number): string => (value.length > limit ? `${value.slice(0, limit)}\n[cut: ${value.length - limit} more characters]` : value);

/**
 * One review's tool use: runs the model's calls against `CodeAccess`, enforces the call cap and renders each result as
 * text for the model. A failing tool (a missing file, an invalid regular expression) is an answer the model sees, never
 * an error that fails the review, but it still counts against the cap.
 */
export class ReviewToolSession {
  private used = 0;
  private readonly cap: number;

  constructor(
    private readonly access: CodeAccess,
    cap?: number | null,
    private readonly signal?: AbortSignal,
  ) {
    this.cap = toolCap(cap);
  }

  get callsUsed(): number {
    return this.used;
  }

  get callsLeft(): number {
    return this.cap - this.used;
  }

  async run(call: ReviewToolCall): Promise<string> {
    if (this.used >= this.cap) return `Tool limit reached (${this.cap} calls). Give your review now, from what you have.`;
    this.used += 1;
    try {
      if (call.tool === 'read_file') {
        const content = await this.access.readFile(call.path, this.signal);
        return content === null ? `No such file: ${call.path}` : cut(content, READ_FILE_LIMIT);
      }
      if (call.tool === 'list_dir') {
        const entries = await this.access.listDir(call.path, this.signal);
        if (entries === null) return `No such directory: ${call.path === '' ? '.' : call.path}`;
        const shown = entries.slice(0, LIST_DIR_LIMIT).map((entry) => (entry.type === 'dir' ? `${entry.name}/` : entry.name));
        return shown.join('\n') + (entries.length > shown.length ? `\n[${entries.length - shown.length} more entries]` : '');
      }
      const matches = await this.access.grep(call.pattern, GREP_MATCH_LIMIT + 1, this.signal);
      if (matches.length === 0) return 'No matches.';
      const lines = matches.slice(0, GREP_MATCH_LIMIT).map((m) => `${m.path}:${m.line}:${m.text.slice(0, GREP_LINE_LIMIT)}`);
      return lines.join('\n') + (matches.length > GREP_MATCH_LIMIT ? `\n[more than ${GREP_MATCH_LIMIT} matches; narrow the pattern]` : '');
    } catch (error) {
      if (this.signal?.aborted === true) throw error;
      return `The tool failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }
}
