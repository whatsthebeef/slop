import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HelpDoc } from '@slop/core';

/** Where a citation to a help section points: the file on the code host. */
const HELP_URL_BASE = 'https://github.com/whatsthebeef/slop/blob/main';
/** One help item must stay under the indexer's own text cap (100,000 characters); sections are cut well before it. */
export const HELP_DOC_MAX_CHARS = 60_000;

/** The spec and the feature guide: each file is split into one item per `##` section. */
const DOCS_FILES = ['slop_behaviour_architecture_spec.md', 'guide.md'] as const;
/** The agent catalog's user-facing parts: whole files, then every command. Nothing else in the repository is help. */
const CATALOG_FILES = ['agents/README.md', 'agents/claude_md.md'] as const;
const CATALOG_COMMANDS_DIR = 'agents/commands';

const slugOf = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A section's pieces when it is over the cap: paragraphs packed up to `max` characters. */
const packParagraphs = (text: string, max: number): string[] => {
  const out: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    for (let i = 0; i < paragraph.length || i === 0; i += max) {
      const piece = paragraph.slice(i, i + max);
      if (current !== '' && current.length + piece.length + 2 > max) {
        out.push(current);
        current = '';
      }
      current += (current === '' ? '' : '\n\n') + piece;
    }
  }
  if (current.trim() !== '') out.push(current);
  return out;
};

/**
 * One file as help items: one per `##` section (the text before the first `##` is the first item, named for the file's
 * `#` title), a section over the cap split into several. Refs are `<path>#<slug>`, unique within the file.
 */
export const splitHelpFile = (path: string, markdown: string, bySection: boolean): HelpDoc[] => {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? path;
  const sections = bySection ? markdown.split(/^(?=## )/m) : [markdown];
  const docs: HelpDoc[] = [];
  const used = new Map<string, number>();
  for (const section of sections) {
    if (section.trim() === '') continue;
    const heading = /^##\s+(.+)$/m.exec(section)?.[1]?.trim();
    const name = heading === undefined ? title : `${title}: ${heading}`;
    const base = slugOf(heading ?? 'top') || 'section';
    const pieces = section.length > HELP_DOC_MAX_CHARS ? packParagraphs(section, HELP_DOC_MAX_CHARS) : [section];
    pieces.forEach((text, i) => {
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      docs.push({
        ref: `${path}#${n === 1 ? base : `${base}-${String(n)}`}`,
        title: i === 0 ? name : `${name} (part ${String(i + 1)})`,
        text: text.trim(),
        url: `${HELP_URL_BASE}/${path}`,
      });
    });
  }
  return docs;
};

/**
 * Slop's help, read from the repository's own files: the behaviour spec, the feature guide and the agent catalog's
 * README, CLAUDE.md template and commands. Read once at startup; a missing folder or file logs a warning and
 * contributes nothing, so a deploy without the docs still starts.
 */
export const loadHelpCorpus = async (dirs: { docsDir: string; catalogDir: string }, warn: (message: string) => void): Promise<HelpDoc[]> => {
  const out: HelpDoc[] = [];
  const add = async (dir: string, relative: string, repoPath: string, bySection: boolean) => {
    try {
      out.push(...splitHelpFile(repoPath, await readFile(join(dir, relative), 'utf8'), bySection));
    } catch (error) {
      warn(`help corpus: ${repoPath} not read (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  for (const file of DOCS_FILES) await add(dirs.docsDir, file, `docs/${file}`, true);
  for (const file of CATALOG_FILES) await add(dirs.catalogDir, file, `catalog/${file}`, true);
  let commands: string[] = [];
  try {
    commands = (await readdir(join(dirs.catalogDir, CATALOG_COMMANDS_DIR))).filter((f) => f.endsWith('.md')).sort();
  } catch (error) {
    warn(`help corpus: ${CATALOG_COMMANDS_DIR} not read (${error instanceof Error ? error.message : String(error)})`);
  }
  for (const file of commands) await add(dirs.catalogDir, `${CATALOG_COMMANDS_DIR}/${file}`, `catalog/${CATALOG_COMMANDS_DIR}/${file}`, false);
  return out;
};
