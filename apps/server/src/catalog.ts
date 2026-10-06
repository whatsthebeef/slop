import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Catalog, CatalogAgentSet } from '@slop/core';
import { agentSetKind, parseFrontmatter } from '@slop/core';

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))),
  );
  return files.flat();
};

/**
 * A stable hash of an agent set: the delivered files' paths and contents, sorted by path (files
 * that aren't delivered, like the README, don't count).
 */
export const hashAgentSet = (files: readonly { path: string; content: string }[]): string => {
  const hash = createHash('sha256');
  const delivered = files.filter((f) => agentSetKind(f.path) !== null);
  for (const file of delivered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // Lengths frame each field, so no path or content can run into the next.
    hash.update(`${String(file.path.length)}:${file.path}\n${String(Buffer.byteLength(file.content))}:`);
    hash.update(file.content);
  }
  return hash.digest('hex');
};

/** The generic catalog shipped in slop's repo (`catalog/kb`, `catalog/agents`), read from disk. */
export class FsCatalog implements Catalog {
  private agents: Promise<CatalogAgentSet> | null = null;

  constructor(private readonly root: string) {}

  async kbEntries(): Promise<{ id: string; version: number; fileName: string; content: string }[]> {
    const dir = join(this.root, 'kb');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    return Promise.all(
      files.map(async (fileName) => {
        const content = await readFile(join(dir, fileName), 'utf8');
        const meta = parseFrontmatter(content);
        return { id: meta.catalog ?? fileName.replace(/\.md$/, ''), version: meta.catalogVersion ?? 1, fileName, content };
      }),
    );
  }

  /**
   * Read once per process: the agent-set version a board serves follows the catalog hash recorded
   * at start (`KnowledgeService.syncCatalogAgentSet`), so served files must not drift from it.
   */
  agentSet(): Promise<CatalogAgentSet> {
    this.agents ??= this.readAgentSet().catch((error: unknown) => {
      this.agents = null;
      throw error;
    });
    return this.agents;
  }

  private async readAgentSet(): Promise<CatalogAgentSet> {
    const dir = join(this.root, 'agents');
    const paths = await walk(dir);
    const files = await Promise.all(
      paths.sort().map(async (file) => ({ path: relative(dir, file).split(sep).join('/'), content: await readFile(file, 'utf8') })),
    );
    return { hash: hashAgentSet(files), files };
  }
}

/**
 * Fills the agent set's deployment placeholders when it is served (e.g. `.mcp.json` needs
 * slop's URL and the Claude Code client ID). Both are public values, not secrets.
 */
export const renderAgentSetFile = (content: string, values: Record<string, string>): string =>
  content.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
