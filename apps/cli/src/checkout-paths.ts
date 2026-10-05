import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { SlopError } from './errors.js';

/** What removing a path would do: remove `path`, or nothing because it is missing or outside. */
export type Removal =
  | { readonly kind: 'remove'; readonly path: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'outside' };

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Paths inside a git checkout, resolved through symlinks so init never writes or deletes
 * outside it. Symlinks that stay inside the checkout (CLAUDE.md -> AGENTS.md) keep working:
 * writes go to the link's target.
 */
export class CheckoutPaths {
  private constructor(
    readonly root: string,
    private readonly realRoot: string,
  ) {}

  static async open(root: string): Promise<CheckoutPaths> {
    return new CheckoutPaths(root, await realpath(root));
  }

  private isInside(realPath: string): boolean {
    return realPath === this.realRoot || realPath.startsWith(this.realRoot + sep);
  }

  private refuse(relative: string, realPath: string): SlopError {
    return new SlopError(
      `refusing to write ${relative}: it resolves to ${realPath}, outside the git checkout`,
    );
  }

  /** Creates the folder if needed and returns its real path; refuses one outside the checkout. */
  async folder(relative: string): Promise<string> {
    const lexical = join(this.root, relative);
    // Check the deepest folder that exists before mkdir creates anything beneath it.
    let existing = lexical;
    let realExisting = await realpathOrUndefined(existing);
    while (realExisting === undefined) {
      if ((await lstatOrUndefined(existing)) !== undefined) {
        throw new SlopError(`refusing to write ${relative}: ${existing} is a broken symlink`);
      }
      existing = dirname(existing);
      realExisting = await realpathOrUndefined(existing);
    }
    if (!this.isInside(realExisting)) throw this.refuse(relative, realExisting);
    await mkdir(lexical, { recursive: true });
    const realFolder = await realpath(lexical);
    if (!this.isInside(realFolder)) throw this.refuse(relative, realFolder);
    return realFolder;
  }

  /** The real path to write `relative` to; refuses one that resolves outside the checkout. */
  async writable(relative: string): Promise<string> {
    const target = join(await this.folder(dirname(relative)), basename(relative));
    const stats = await lstatOrUndefined(target);
    if (stats?.isSymbolicLink() !== true) return target;
    const linked = await realpathOrUndefined(target);
    if (linked === undefined) {
      throw new SlopError(`refusing to write ${relative}: it is a broken symlink`);
    }
    if (!this.isInside(linked)) throw this.refuse(relative, linked);
    return linked;
  }

  /**
   * How to remove `relative`: the entry itself (a symlink is unlinked, not followed), unless its
   * folder or its link target lies outside the checkout.
   */
  async removal(relative: string): Promise<Removal> {
    const parent = await realpathOrUndefined(join(this.root, dirname(relative)));
    if (parent === undefined) return { kind: 'missing' };
    if (!this.isInside(parent)) return { kind: 'outside' };
    const target = join(parent, basename(relative));
    const stats = await lstatOrUndefined(target);
    if (stats === undefined) return { kind: 'missing' };
    if (stats.isSymbolicLink()) {
      const linked = await realpathOrUndefined(target);
      if (linked !== undefined && !this.isInside(linked)) return { kind: 'outside' };
    }
    return { kind: 'remove', path: target };
  }
}

/** Writes through a temp file in the same folder, so an interrupted run never truncates `path`. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
