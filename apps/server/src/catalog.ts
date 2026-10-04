import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Catalog } from '@slop/core';
import { parseFrontmatter } from '@slop/core';

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))),
  );
  return files.flat();
};

/** The generic catalog shipped in slop's repo (`catalog/kb`, `catalog/agents`), read from disk. */
export class FsCatalog implements Catalog {
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

  async agentSet(): Promise<{ path: string; content: string }[]> {
    const dir = join(this.root, 'agents');
    const files = await walk(dir);
    return Promise.all(
      files.sort().map(async (file) => ({ path: relative(dir, file), content: await readFile(file, 'utf8') })),
    );
  }
}

/**
 * Fills the agent set's deployment placeholders when it is served (e.g. `.mcp.json` needs
 * slop's URL and the Claude Code client ID). Both are public values, not secrets.
 */
export const renderAgentSetFile = (content: string, values: Record<string, string>): string =>
  content.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
