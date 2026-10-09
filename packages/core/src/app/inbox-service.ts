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
  isIntegrationSource,
  SOURCE_REF_LIMIT,
} from '../domain/inbox.js';
import type {
  InboxDetail,
  InboxItem,
  InboxSourceType,
  InboxStatus,
  InboxView,
  IntegrationSource,
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

/** Text an integration delivers: see `InboxService.addFromSource`. */
export interface NewSourceItem {
  readonly source: string;
  readonly sourceRef: string;
  readonly text: string;
  readonly title?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly sourceType: InboxSourceType;
  readonly occurredAt: string;
  /** Who it came from, for the record (`slack:U123`). */
  readonly createdBy: string;
}

/** An item an integration delivers: `sourceRef` (the source's own ID for it) makes delivery idempotent. */
export interface NewDelivery extends NewPaste {
  readonly source: IntegrationSource;
  readonly sourceRef: string;
}

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
    return this.put(boardId, input, 'paste', '', email, (tx) => memberOf(tx, email, boardId));
  }

  /**
   * Stores an item an integration delivers for `boardId` (the caller has checked its token for that board). One item
   * per board, source and `sourceRef`: delivering it again returns the existing item, even one that was discarded.
   */
  async deliver(boardId: number, input: NewDelivery): Promise<Result<{ id: number; created: boolean }>> {
    if (!isIntegrationSource(input.source)) return invalidInput('Unknown source');
    const sourceRef = input.sourceRef.trim();
    if (sourceRef === '') return invalidInput('Give the source reference');
    if (sourceRef.length > SOURCE_REF_LIMIT)
      return invalidInput(`The source reference is over ${String(SOURCE_REF_LIMIT)} characters`);
    return this.put(boardId, input, input.source, sourceRef, null, async (tx) =>
      (await tx.getBoard(boardId)) === null ? notFound(`No board ${String(boardId)}`) : ok(null),
    );
  }

  private async put(
    boardId: number,
    input: NewPaste,
    source: string,
    sourceRef: string,
    createdBy: string | null,
    allowed: (tx: Tx) => Promise<Result<unknown>>,
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
        const permitted = await allowed(tx);
        if (!permitted.ok) return permitted;
        const stored = await tx.insertInboxItem({
          boardId,
          title,
          text,
          source,
          sourceRef,
          sourceLabel,
          sourceType: 'meeting',
          occurredAt,
          createdAt: now,
          createdBy,
          contentHash: inboxContentHash(text),
        });
        // A repeat of text that is in the inbox changes nothing; pasted text that was discarded comes back as new,
        // but an integration's item stays discarded (its source ref is what makes delivery idempotent).
        if (!stored.created && (stored.item.status !== 'discarded' || sourceRef !== ''))
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
   * Files text an integration delivered (a Slack thread), on behalf of a source the server has already authenticated, so
   * there is no member check: the caller maps the source to its board. `sourceRef` is the dedupe key: sending the same
   * thread again updates the item (new text, summary and suggestions again) instead of adding a second one.
   */
  async addFromSource(
    boardId: number,
    input: NewSourceItem,
  ): Promise<Result<{ id: number; created: boolean }>> {
    const text = input.text.trim();
    if (text === '') return invalidInput('There is no text to file');
    if (text.length > INBOX_TEXT_LIMIT)
      return invalidInput(`The text is over ${String(INBOX_TEXT_LIMIT)} characters`);
    if (input.sourceRef === '') return invalidInput('A source needs a reference');
    const title = (input.title ?? '').trim().slice(0, TITLE_LIMIT);
    const sourceLabel = (input.sourceLabel ?? '').trim().slice(0, SOURCE_LABEL_LIMIT);
    const now = this.deps.clock.now();
    const hash = inboxContentHash(text);
    const result = await this.deps.store.transaction(
      async (tx): Promise<Result<{ id: number; created: boolean }>> => {
        if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${String(boardId)}`);
        const stored = await tx.insertInboxItem({
          boardId,
          title,
          text,
          source: input.source,
          sourceRef: input.sourceRef,
          sourceLabel,
          sourceType: input.sourceType,
          occurredAt: input.occurredAt,
          createdAt: now,
          createdBy: input.createdBy,
          contentHash: hash,
        });
        const current = stored.item;
        // The same thread, unchanged: nothing to do (a discarded one comes back as new, as a repeat paste does).
        if (!stored.created && current.status !== 'discarded' && current.contentHash === hash && current.sourceRef === input.sourceRef)
          return ok({ id: current.id, created: false });
        // The text matched another item's (a paste of it): that item stays as it is.
        if (!stored.created && current.sourceRef !== input.sourceRef)
          return ok({ id: current.id, created: false });
        const fresh: InboxItem = stored.created
          ? current
          : {
              ...current,
              title: title === '' ? current.title : title,
              text,
              contentHash: hash,
              sourceLabel,
              occurredAt: input.occurredAt,
              status: current.status === 'discarded' ? 'new' : current.status,
              state: 'pending',
              attempts: 0,
              processAfter: null,
              lastError: null,
              summary: null,
              suggestions: [],
            };
        const links = stored.created
          ? []
          : (await tx.listInboxLinks(boardId)).filter((l) => l.inboxId === fresh.id).map((l) => l.globId);
        await tx.replaceItem(inboxItemOf(fresh, links, await groupOf(tx, links)), inboxChunks(fresh));
        const indexed = await tx.getItemByRef(boardId, inboxRef(fresh.id));
        if (indexed === null) throw new Error('Inbox item write returned nothing');
        if (!(await tx.updateInboxItem({ ...fresh, itemId: indexed.id, updatedAt: now }, current.version)))
          throw new Error('Inbox item changed while it was added');
        return ok({ id: fresh.id, created: stored.created });
      },
    );
    if (result.ok) this.deps.notifier.publish({ kind: 'board.inbox', boardId });
    return result;
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
