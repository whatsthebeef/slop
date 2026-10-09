import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import {
  INBOX_TEXT_LIMIT,
  MAX_ATTACH_GLOBS,
  inboxChunks,
  inboxContentHash,
  inboxItemOf,
  inboxLabel,
  inboxLink,
  inboxRef,
  inboxTitle,
  inboxView,
} from '../domain/inbox.js';
import { IMPORT_SOURCES } from '../domain/inbox.js';
import type {
  ImportSource,
  InboxDetail,
  InboxItem,
  InboxSourceType,
  InboxStatus,
  InboxView,
} from '../domain/inbox.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import { addAttachment } from './artifact-service.js';

/** A source label is a short note ("Tuesday standup"). */
const SOURCE_LABEL_LIMIT = 100;
const TITLE_LIMIT = 200;
const DEFAULT_LIST: readonly InboxStatus[] = ['new', 'attached', 'kept'];

export interface NewPaste {
  readonly text: string;
  readonly title?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly sourceLabel?: string | undefined;
}

/** One legacy item an import delivers (a Jira issue, a Google Doc), already turned into text by the importer. */
export interface ImportedItem {
  readonly source: ImportSource;
  /** Its id in the source (the issue key, the doc id): re-delivering it updates the same item. */
  readonly sourceKey: string;
  readonly title: string;
  readonly text: string;
  readonly sourceType: InboxSourceType;
  readonly sourceLabel?: string | undefined;
  readonly occurredAt?: string | undefined;
}

export type ImportOutcome =
  | { readonly sourceKey: string; readonly result: 'added' | 'updated' | 'skipped' }
  | { readonly sourceKey: string; readonly result: 'failed'; readonly reason: string };

/** The most items one import call takes. */
export const MAX_IMPORT_ITEMS = 50;

/** The item changed (or was linked) under an attach: thrown to roll the transaction back. */
class AttachConflict extends Error {
  constructor() {
    super('The inbox item changed during attach');
  }
}

/**
 * The board inbox (spec, Inbox and ingest): the one write path for pasted items. `add` stores the row and its search
 * item (so it is searchable at once, even with the model down); the InboxPipeline writes its summary and suggestions.
 * A person then attaches an item to globs, keeps it, or discards it.
 */
export class InboxService {
  constructor(private readonly deps: { store: Store; clock: Clock; notifier: Notifier }) {}

  /** Stores pasted text; pasting the same text again returns the existing item (`created: false`). */
  async add(
    email: string,
    boardId: number,
    input: NewPaste,
  ): Promise<Result<{ id: number; created: boolean }>> {
    const text = input.text.trim();
    if (text === '') return invalidInput('Paste some text');
    if (text.length > INBOX_TEXT_LIMIT)
      return invalidInput(`The text is over ${String(INBOX_TEXT_LIMIT)} characters`);
    const title = (input.title ?? '').trim();
    if (title.length > TITLE_LIMIT)
      return invalidInput(`The title is over ${String(TITLE_LIMIT)} characters`);
    const sourceLabel = (input.sourceLabel ?? '').trim();
    if (sourceLabel.length > SOURCE_LABEL_LIMIT)
      return invalidInput(`The source label is over ${String(SOURCE_LABEL_LIMIT)} characters`);
    if (input.occurredAt !== undefined && Number.isNaN(Date.parse(input.occurredAt)))
      return invalidInput('The date is not a date');
    const now = this.deps.clock.now();
    const occurredAt =
      input.occurredAt === undefined ? now : new Date(input.occurredAt).toISOString();
    const result = await this.deps.store.transaction(
      async (tx): Promise<Result<{ id: number; created: boolean }>> => {
        const actor = await memberOf(tx, email, boardId);
        if (!actor.ok) return actor;
        const stored = await tx.insertInboxItem({
          boardId,
          title,
          text,
          source: 'paste',
          sourceLabel,
          sourceType: 'meeting',
          occurredAt,
          createdAt: now,
          createdBy: email,
          contentHash: inboxContentHash(text),
        });
        // A repeat of text that is in the inbox changes nothing; one that was discarded comes back as new.
        if (!stored.created && stored.item.status !== 'discarded')
          return ok({ id: stored.item.id, created: false });
        const fresh: InboxItem = stored.created
          ? stored.item
          : {
              ...stored.item,
              status: 'new',
              state: 'pending',
              attempts: 0,
              processAfter: null,
              lastError: null,
              summary: null,
              suggestions: [],
            };
        // Indexed in the same transaction: keyword search finds it before any embedding or summary exists.
        await tx.replaceItem(inboxItemOf(fresh, [], null), inboxChunks(fresh));
        const indexed = await tx.getItemByRef(boardId, inboxRef(fresh.id));
        if (indexed === null) throw new Error('Inbox item write returned nothing');
        if (
          !(await tx.updateInboxItem(
            { ...fresh, itemId: indexed.id, updatedAt: now },
            stored.item.version,
          ))
        ) {
          throw new Error('Inbox item changed while it was added');
        }
        return ok({ id: fresh.id, created: true });
      },
    );
    if (result.ok) this.deps.notifier.publish({ kind: 'board.inbox', boardId });
    return result;
  }

  /**
   * Delivers imported history (spec, Inbox and ingest): each item is stored `archived` (indexed and attachable, out of
   * the live inbox) and already summarised, so a backfill neither floods the inbox nor spends the model. The source and
   * key identify the item: an unchanged one is `skipped`, a changed one is `updated` and re-indexed. An item a person
   * discarded stays discarded. One item failing does not stop the others.
   */
  async importItems(
    email: string,
    boardId: number,
    items: readonly ImportedItem[],
  ): Promise<Result<ImportOutcome[]>> {
    if (items.length === 0) return invalidInput('Nothing to import');
    if (items.length > MAX_IMPORT_ITEMS)
      return invalidInput(`Import at most ${String(MAX_IMPORT_ITEMS)} items at a time`);
    const member = await this.deps.store.transaction((tx) => memberOf(tx, email, boardId));
    if (!member.ok) return member;
    const outcomes: ImportOutcome[] = [];
    for (const item of items) {
      try {
        outcomes.push(await this.importOne(email, boardId, item));
      } catch (error) {
        // The item's transaction rolled back (e.g. its text is the same as another item's): report it, carry on.
        outcomes.push({
          sourceKey: item.sourceKey,
          result: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (outcomes.some((o) => o.result === 'added' || o.result === 'updated'))
      this.deps.notifier.publish({ kind: 'board.inbox', boardId });
    return ok(outcomes);
  }

  private async importOne(
    email: string,
    boardId: number,
    input: ImportedItem,
  ): Promise<ImportOutcome> {
    const sourceKey = input.sourceKey.trim();
    const failed = (reason: string): ImportOutcome => ({ sourceKey, result: 'failed', reason });
    if (!IMPORT_SOURCES.some((s) => s === input.source)) return failed('Unknown import source');
    if (sourceKey === '') return failed('The item has no key');
    const text = input.text.trim();
    if (text === '') return failed('The item has no text');
    const title = input.title.trim().slice(0, TITLE_LIMIT);
    const sourceLabel = (input.sourceLabel ?? '').trim().slice(0, SOURCE_LABEL_LIMIT);
    if (input.occurredAt !== undefined && Number.isNaN(Date.parse(input.occurredAt)))
      return failed('The date is not a date');
    // Over the limit is cut (a long Doc stays findable by its start) rather than refused.
    const body = text.length > INBOX_TEXT_LIMIT ? text.slice(0, INBOX_TEXT_LIMIT) : text;
    const now = this.deps.clock.now();
    const occurredAt = input.occurredAt === undefined ? now : new Date(input.occurredAt).toISOString();
    return this.deps.store.transaction(async (tx): Promise<ImportOutcome> => {
      const existing = await tx.findInboxItemBySource(boardId, input.source, sourceKey);
      const contentHash = inboxContentHash(body);
      if (existing === null) {
        const stored = await tx.insertInboxItem({
          boardId,
          title,
          text: body,
          source: input.source,
          sourceKey,
          sourceLabel,
          sourceType: input.sourceType,
          occurredAt,
          createdAt: now,
          createdBy: email,
          contentHash,
          status: 'archived',
          state: 'done',
        });
        // The same text is in the inbox already (pasted, or another source's): nothing to add.
        if (!stored.created) return { sourceKey, result: 'skipped' };
        await this.index(tx, stored.item, now);
        return { sourceKey, result: 'added' };
      }
      if (existing.status === 'discarded') return { sourceKey, result: 'skipped' };
      const unchanged =
        existing.contentHash === contentHash &&
        existing.title === title &&
        existing.occurredAt === occurredAt;
      if (unchanged) return { sourceKey, result: 'skipped' };
      const changed: InboxItem = {
        ...existing,
        title,
        text: body,
        sourceLabel,
        sourceType: input.sourceType,
        occurredAt,
        contentHash,
        updatedAt: now,
      };
      await this.index(tx, changed, now);
      return { sourceKey, result: 'updated' };
    });
  }

  /** Writes the search item for a row (its links kept) and points the row at it. */
  private async index(tx: Tx, row: InboxItem, now: string): Promise<void> {
    const links = (await tx.listInboxLinks(row.boardId))
      .filter((l) => l.inboxId === row.id)
      .map((l) => l.globId);
    await tx.replaceItem(inboxItemOf(row, links, links.length > 0 ? await groupOf(tx, links) : null), inboxChunks(row));
    const indexed = await tx.getItemByRef(row.boardId, inboxRef(row.id));
    if (indexed === null) throw new Error('Inbox item write returned nothing');
    if (!(await tx.updateInboxItem({ ...row, itemId: indexed.id, updatedAt: now }, row.version)))
      throw new Error('Inbox item changed while it was imported');
  }

  /** The board's items (default: new, attached and kept), newest first; `discarded` only when asked for. */
  async list(
    email: string,
    boardId: number,
    statuses?: readonly InboxStatus[],
  ): Promise<Result<InboxView[]>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const items = await tx.listInboxItems(boardId, statuses ?? DEFAULT_LIST);
      const links = await tx.listInboxLinks(boardId);
      const globs = new Map((await tx.listGlobs(boardId, {})).map((g) => [g.id, g]));
      return ok(items.map((i) => inboxView(i, links, globs)));
    });
  }

  async get(email: string, boardId: number, id: number): Promise<Result<InboxDetail>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const item = await tx.getInboxItem(boardId, id);
      if (item === null) return notFound(`No inbox item ${String(id)}`);
      const links = await tx.listInboxLinks(boardId);
      const globs = new Map((await tx.listGlobs(boardId, {})).map((g) => [g.id, g]));
      return ok({ ...inboxView(item, links, globs), text: item.text });
    });
  }

  /**
   * Attaches an item to globs of its board: each gets a link attachment ("From the inbox: <title>"), the item goes into
   * the glob's context and becomes a source for its decisions. Attaching again to a glob already linked changes nothing.
   */
  async attach(
    email: string,
    boardId: number,
    id: number,
    globIds: readonly string[],
  ): Promise<Result<InboxView>> {
    const wanted = [...new Set(globIds)];
    if (wanted.length === 0) return invalidInput('Choose at least one glob');
    if (wanted.length > MAX_ATTACH_GLOBS)
      return invalidInput(`Attach to at most ${String(MAX_ATTACH_GLOBS)} globs at a time`);
    let result: Result<{ view: InboxView; linked: string[] }>;
    try {
      result = await this.deps.store.transaction(
        async (tx): Promise<Result<{ view: InboxView; linked: string[] }>> => {
          const actor = await memberOf(tx, email, boardId);
          if (!actor.ok) return actor;
          const item = await tx.getInboxItem(boardId, id);
          if (item === null) return notFound(`No inbox item ${String(id)}`);
          if (item.status === 'discarded')
            return invalidInput('A discarded item cannot be attached');
          const globs: Glob[] = [];
          for (const globId of wanted) {
            const glob = await tx.getGlob(globId);
            if (glob?.boardId !== boardId)
              return notFound(`No glob ${globId} on board ${String(boardId)}`);
            globs.push(glob);
          }
          const existing = await tx.listInboxLinks(boardId);
          const linkedBefore = new Set(
            existing.filter((l) => l.inboxId === id).map((l) => l.globId),
          );
          const now = this.deps.clock.now();
          const linked: string[] = [];
          for (const glob of globs) {
            if (linkedBefore.has(glob.id)) continue;
            const artifact = await addAttachment(tx, this.deps.clock, glob, email, {
              label: await labelFor(tx, glob.id, item),
              content: '',
              link: inboxLink(boardId, id),
            });
            // A racing attach got there first: roll everything back rather than leave a second attachment.
            if (
              !(await tx.insertInboxLink({
                inboxId: id,
                globId: glob.id,
                artifactId: artifact.id,
                linkedBy: email,
                linkedAt: now,
              }))
            )
              throw new AttachConflict();
            linked.push(glob.id);
          }
          let current = item;
          if (linked.length > 0) {
            const all = [...linkedBefore, ...linked];
            // Metadata only: the item's content hash doesn't cover its links, so nothing is chunked again.
            if (item.itemId !== null)
              await tx.setItemLinks(item.itemId, all, await groupOf(tx, all));
            current = { ...item, status: 'attached', updatedAt: now };
            // Throws so the attachments and links written above roll back with it.
            if (!(await tx.updateInboxItem(current, item.version))) throw new AttachConflict();
          }
          const links = await tx.listInboxLinks(boardId);
          const known = new Map((await tx.listGlobs(boardId, {})).map((g) => [g.id, g]));
          return ok({ view: inboxView(current, links, known), linked });
        },
      );
    } catch (error) {
      if (error instanceof AttachConflict) return invalidInput('The item changed: try again');
      throw error;
    }
    if (!result.ok) return result;
    for (const globId of result.value.linked)
      this.deps.notifier.publish({ kind: 'glob.artifacts', boardId, globId });
    if (result.value.linked.length > 0)
      this.deps.notifier.publish({ kind: 'board.inbox', boardId });
    return ok(result.value.view);
  }

  /** Keeps a new item: it stays indexed and findable, on no glob. */
  async keep(email: string, boardId: number, id: number): Promise<Result<InboxView>> {
    return this.settle(email, boardId, id, (item) => {
      if (item.status === 'attached') return invalidInput('An attached item is kept already');
      if (item.status === 'discarded') return invalidInput('A discarded item cannot be kept');
      return ok({ ...item, status: 'kept' });
    });
  }

  /** Discards an item that isn't attached: it leaves search (its row stays; pasting the same text again brings it back as new). */
  async discard(email: string, boardId: number, id: number): Promise<Result<InboxView>> {
    return this.settle(
      email,
      boardId,
      id,
      (item) => {
        if (item.status === 'attached')
          return invalidInput('An attached item cannot be discarded: it is on a glob');
        return ok({ ...item, status: 'discarded', itemId: null });
      },
      true,
    );
  }

  private async settle(
    email: string,
    boardId: number,
    id: number,
    change: (item: InboxItem) => Result<InboxItem>,
    removeFromSearch = false,
  ): Promise<Result<InboxView>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<InboxView>> => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const item = await tx.getInboxItem(boardId, id);
      if (item === null) return notFound(`No inbox item ${String(id)}`);
      // Settling twice is not an error: the item is already where the person wanted it.
      if (item.status === 'discarded' && removeFromSearch) return ok(await this.viewOf(tx, item));
      const next = change(item);
      if (!next.ok) return next;
      const changed = { ...next.value, updatedAt: this.deps.clock.now() };
      if (!(await tx.updateInboxItem(changed, item.version)))
        return invalidInput('The item changed: try again');
      if (removeFromSearch) await tx.deleteItemByRef(boardId, inboxRef(id));
      return ok(await this.viewOf(tx, changed));
    });
    if (result.ok) this.deps.notifier.publish({ kind: 'board.inbox', boardId });
    return result;
  }

  private async viewOf(tx: Tx, item: InboxItem): Promise<InboxView> {
    const links = await tx.listInboxLinks(item.boardId);
    const globs = new Map((await tx.listGlobs(item.boardId, {})).map((g) => [g.id, g]));
    return inboxView(item, links, globs);
  }
}

/** The attachment's label on a glob: a different item with the same title on it gets the item's number, so versions of one label never mix two items. */
const labelFor = async (tx: Tx, globId: string, item: InboxItem): Promise<string> => {
  const label = inboxLabel(inboxTitle(item));
  const taken = (await tx.listArtifacts(globId, 'attachment')).some(
    (a) => a.label === label && a.link !== inboxLink(item.boardId, item.id),
  );
  return taken ? `${label} (#${String(item.id)})` : label;
};

/** The group the item's globs share, else null (a search filter, so only an unambiguous group is set). */
const groupOf = async (tx: Tx, globIds: readonly string[]): Promise<string | null> => {
  const groups = new Set((await tx.getGlobs(globIds)).map((g) => g.group));
  const [only] = [...groups];
  return groups.size === 1 && only !== undefined ? only : null;
};
