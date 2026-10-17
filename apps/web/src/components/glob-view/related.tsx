import { isFromMention, isHumanCategory, lacksReason, OTHER_BOARD_GLOB } from '@slop/core';
import type { ExternalGlob, Holding, RelationGate, RelationSource, RelationSuggestion, RelationUntil, Supersession, VerdictFields } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { AddRelationInput, GlobView } from '@/lib/api';
import { globsKey } from '@/lib/live';
import { HumanIcon, MachineIcon } from '../actor-icons';
import { SectionToggle } from '../section-toggle';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import { Tip } from '../ui/tip';
import type { GlobViewContext } from './context';

/** What a gate refuses until its target gets there, in words: "can't start until merged". */
export const gateWords = (gate: RelationGate, until: RelationUntil, subject?: 'this'): string => {
  const what = gate === 'start' ? 'start' : gate === 'merge' ? 'merge' : 'sign off';
  const when = until === 'merged' ? 'merged and rolled out' : until === 'decided' ? 'decided' : 'signed off';
  return `can't ${what} until ${subject === undefined ? '' : 'this is '}${when}`;
};

const SOURCE_WORDS: Record<RelationSource, string> = {
  person: 'added by a person',
  agent: 'added by an agent',
  inferred: 'inferred by slop',
  learned: 'learned from a failed run',
  split: 'from the split',
  mention: 'from a mention',
  // The old name of `mention`, on rows written before it.
  auto: 'from a mention',
};

/** Accepts (writes the relation; a failed step's `glob` is the fix to link) or dismisses a card suggestion; resolves false when it failed. */
export type SuggestionHandler = (suggestionId: string, action: 'accept' | 'dismiss', glob?: string) => Promise<boolean>;

/** What the post-merge check found, in words: "needed: uses `X` from s15t246", "not needed: no shared files", or "unsure"; null before it ran. */
export const verdictText = (v: VerdictFields): string | null => {
  if (v.verdict === undefined) return null;
  const reason = (v.verdictReason ?? '').trim();
  const lead = v.verdict === 'needed' ? 'needed' : v.verdict === 'not_needed' ? 'not needed' : 'unsure';
  return reason === '' ? lead : `${lead}: ${reason}`;
};

/** One row of the Holding this back, Holds back and No longer holding sections. */
export interface RelatedRow extends VerdictFields {
  readonly relationId: string;
  /** The other glob. */
  readonly id: string;
  readonly title: string | null;
  readonly words: string;
  readonly reason: string | null;
  readonly source: RelationSource;
  /** A relation of this glob a person may dismiss (not one that no longer holds). */
  readonly dismissible: boolean;
  /** Set when the other glob is on another board (its name, and whether the viewer may not see it). */
  readonly external?: ExternalGlob;
  /** The other glob is a decision (or an action) this one waits for: the row says so. */
  readonly decision?: boolean;
}

/** What the relation sections list. */
export interface RelatedGroups {
  /** Unmet relations a person or slop made (start gates first): what keeps the glob back right now. */
  readonly holding: readonly RelatedRow[];
  /** Unmet relations that wait for a decision. */
  readonly decisions: readonly RelatedRow[];
  /** Other globs this one holds back. */
  readonly holdsBack: readonly RelatedRow[];
  /** Relations that stopped holding (met, deleted, dismissed, overridden). */
  readonly done: readonly (RelatedRow & { readonly how: string })[];
  /** Weak links ("may relate"): they hold nothing back; a person can make one a gate. */
  readonly weak: readonly RelatedRow[];
  /** The glob that supersedes this one (a muted line, not a status). */
  readonly supersededBy: Supersession | null;
  /** The globs this one supersedes. */
  readonly supersedes: readonly Supersession[];
  /** How many globs on boards the viewer is not on wait for this one. */
  readonly otherBoards: number;
  /** A failed step's open question, "is there a fix glob?" (a mentioned glob is never asked about: it becomes a relation). */
  readonly suggestions: readonly RelationSuggestion[];
}

/** The verdict fields of a relation view row, only those it has. */
const verdictFields = (r: VerdictFields): VerdictFields => ({
  ...(r.verdict === undefined ? {} : { verdict: r.verdict }),
  ...(r.verdictReason === undefined ? {} : { verdictReason: r.verdictReason }),
  ...(r.verdictBy === undefined ? {} : { verdictBy: r.verdictBy }),
});

const rowOf = (h: Holding): RelatedRow => ({
  relationId: h.relationId,
  id: h.to,
  title: h.toTitle,
  words: gateWords(h.gate, h.until),
  reason: h.reason,
  source: h.source,
  dismissible: h.source !== 'split',
  ...verdictFields(h),
  ...(h.external === undefined ? {} : { external: h.external }),
});

const HOW_WORDS = { met: 'done', deleted: 'deleted', dismissed: 'dismissed', overridden: 'forced through' } as const;

/** The relation sections' content: the glob's relations in groups; null when the API is older and sends none. */
export const relatedGroups = (glob: GlobView): RelatedGroups | null => {
  const view = glob.relations;
  if (view === undefined) return null;
  const holding = view.holding;
  const groups: RelatedGroups = {
    holding: holding.filter((h) => !h.toIsDecision && h.toIsAction !== true).map(rowOf),
    decisions: holding.filter((h) => h.toIsDecision || h.toIsAction === true).map((h) => ({ ...rowOf(h), decision: true })),
    holdsBack: view.holdsBack.map((h) => ({
      relationId: h.relationId,
      id: h.from,
      title: h.fromTitle,
      words: gateWords(h.gate, h.until, 'this'),
      reason: h.reason,
      source: h.source,
      dismissible: false,
      ...verdictFields(h),
      ...(h.external === undefined ? {} : { external: h.external }),
    })),
    weak: (view.weak ?? []).map((w) => ({
      relationId: w.relationId,
      id: w.to,
      title: w.toTitle,
      words: 'may relate',
      reason: w.reason,
      source: w.source,
      dismissible: true,
      ...(w.external === undefined ? {} : { external: w.external }),
    })),
    done: view.done.map((d) => ({
      relationId: d.relationId,
      id: d.to,
      title: d.toTitle,
      words: gateWords(d.gate, d.until),
      reason: d.reason,
      source: d.source,
      dismissible: false,
      ...verdictFields(d),
      how: HOW_WORDS[d.how],
    })),
    supersededBy: view.supersededBy ?? null,
    supersedes: view.supersedes ?? [],
    otherBoards: view.waitedOnByOtherBoards ?? 0,
    suggestions: glob.suggestions ?? [],
  };
  return groups;
};

const GlobLink = ({ boardId, id }: { boardId: number; id: string }) => (
  <Link to={`/boards/${String(boardId)}?glob=${encodeURIComponent(id)}`} className="font-mono underline">
    {id}
  </Link>
);

/** The small ✕ on a relation row: slop got it wrong, it is not a dependency. */
const DismissRelation = ({ id, relationId, onDismiss }: { id: string; relationId: string; onDismiss: (relationId: string) => Promise<boolean> }) => (
  <button
    type="button"
    className="ml-2 text-xs text-muted-foreground hover:text-foreground"
    title="Not a dependency"
    aria-label={`Not a dependency: ${id}`}
    data-testid={`dismiss-edge-${id}`}
    onClick={() => void onDismiss(relationId)}
  >
    ✕
  </button>
);

/** The other board's name after a glob that lives there: "board Ops", or "another board" when slop sends no name. */
const BoardNote = ({ external }: { external: ExternalGlob }) => (
  <span className="text-muted-foreground" data-testid="related-board">
    {' '}
    · {external.boardName === null ? 'another board' : `board ${external.boardName}`}
  </span>
);

export const Row = ({
  boardId,
  row,
  how,
  holdsBack = false,
  onDismiss,
  onPromote,
}: {
  boardId: number;
  row: RelatedRow;
  how?: string;
  /** The row is a glob that waits for this one (its hidden text reads from that side). */
  holdsBack?: boolean;
  onDismiss: ((relationId: string) => Promise<boolean>) | null;
  /** "Make it a gate" on a weak link; absent for any other row. */
  onPromote?: ((relationId: string) => Promise<boolean>) | null;
}) => {
  const hidden = row.external?.hidden === true;
  const verdict = verdictText(row);
  const reason = (row.reason ?? '').trim();
  const fromMention = isFromMention(row.source);
  return (
    <li data-testid={`related-row-${row.id}`}>
      {hidden ? (
        <span data-testid="related-hidden">{holdsBack ? 'A glob on another board waits for this' : 'Waits for a glob on another board'}</span>
      ) : (
        <>
          <GlobLink boardId={row.external?.boardId ?? boardId} id={row.id} />
          {row.title !== null && <span> {row.title}</span>}
          {row.external !== undefined && <BoardNote external={row.external} />}
        </>
      )}
      {row.decision === true && <span className="text-muted-foreground"> · decision</span>}
      <span className="text-muted-foreground"> · {row.words}</span>
      {how !== undefined && <span className="text-muted-foreground"> ({how})</span>}
      {reason !== '' && !fromMention && <span className="text-muted-foreground">: {reason}</span>}
      {lacksReason(row) && (
        <span className="ml-2 rounded bg-muted px-1.5 text-xs text-muted-foreground" data-testid={`no-reason-${row.id}`}>
          no reason given
        </span>
      )}
      {fromMention ? (
        // The sentence that made slop add the relation is the chip's hover, so people can see why it is there.
        <Tip text={reason === '' ? 'Slop added this from a glob ID in the text' : reason} className="ml-2">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid={`mention-badge-${row.id}`}>
            <MachineIcon decorative />
            {SOURCE_WORDS[row.source]}
          </span>
        </Tip>
      ) : (
        <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
          {row.source === 'person' ? <HumanIcon decorative /> : <MachineIcon decorative />}
          {SOURCE_WORDS[row.source]}
        </span>
      )}
      {verdict !== null && (
        <span className="ml-2 text-xs text-muted-foreground" data-testid={`verdict-${row.id}`} title={row.verdictBy === 'model' ? 'Judged by a model' : 'Checked against the code'}>
          · {verdict}
        </span>
      )}
      {onPromote != null && (
        <Button size="sm" variant="outline" className="ml-2 h-6 px-2 text-xs" data-testid={`promote-${row.id}`} onClick={() => void onPromote(row.relationId)}>
          Make it a gate
        </Button>
      )}
      {row.dismissible && onDismiss !== null && <DismissRelation id={row.id} relationId={row.relationId} onDismiss={onDismiss} />}
    </li>
  );
};

/** One side of a supersession as a muted line: "Superseded by s1t2: reason" with the ✕ that removes the label, or "Supersedes s1t3". */
const SupersessionLine = ({
  boardId,
  other,
  lead,
  testId,
  onDismiss,
}: {
  boardId: number;
  other: Supersession;
  lead: string;
  testId: string;
  onDismiss: ((relationId: string) => Promise<boolean>) | null;
}) => {
  const reason = (other.reason ?? '').trim();
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      {lead}{' '}
      {other.hidden === true ? OTHER_BOARD_GLOB : <GlobLink boardId={other.external?.boardId ?? boardId} id={other.id} />}
      {other.title !== null && other.hidden !== true && <span> {other.title}</span>}
      {other.external !== undefined && other.hidden !== true && <BoardNote external={other.external} />}
      {reason !== '' && <span>: {reason}</span>}
      {lacksReason(other) && (
        <span className="ml-2 rounded bg-muted px-1.5" data-testid={`no-reason-${other.id}`}>
          no reason given
        </span>
      )}
      {onDismiss !== null && other.relationId !== undefined && (
        <DismissRelation id={other.id} relationId={other.relationId} onDismiss={onDismiss} />
      )}
    </p>
  );
};

/** A failed step's question: its text with the two answers ("Link a glob" takes the ID of the glob that fixes it). */
const FailedStepItem = ({ suggestion, onSuggestion }: { suggestion: RelationSuggestion; onSuggestion: SuggestionHandler | undefined }) => {
  const [fix, setFix] = useState('');
  const [working, setWorking] = useState(false);
  const sending = useRef(false);
  const answer = (action: 'accept' | 'dismiss', glob?: string) => {
    if (onSuggestion === undefined || sending.current) return;
    sending.current = true;
    setWorking(true);
    void (glob === undefined ? onSuggestion(suggestion.id, action) : onSuggestion(suggestion.id, action, glob)).finally(() => {
      sending.current = false;
      setWorking(false);
    });
  };
  const fixId = fix.trim();
  return (
    <li className="grid gap-1" data-testid={`suggestion-${suggestion.id}`}>
      <span>{suggestion.text}</span>
      {onSuggestion !== undefined && (
        <span className="flex flex-wrap items-center gap-2">
          <Input
            className="h-7 w-32 text-xs"
            aria-label="Glob that fixes it"
            placeholder="s15b6"
            value={fix}
            onChange={(e) => setFix(e.target.value)}
            data-testid="suggestion-fix-glob"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={working || fixId === ''}
            data-testid="suggestion-accept"
            onClick={() => answer('accept', fixId)}
          >
            Link a glob
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={working} data-testid="suggestion-dismiss" onClick={() => answer('dismiss')}>
            No fix needed
          </Button>
        </span>
      )}
    </li>
  );
};

/**
 * The form behind "+ Add holding" and "+ Add holds back": pick a glob (or type its ID), a gate, and Add. `holding` adds a
 * relation this glob is held back by (`to`); `holdsBack` adds one for another glob that this one holds back. The section's header
 * button opens and closes it.
 */
export const AddRelationForm = ({
  ctx: { glob, busy },
  mode,
  gates,
  onAdd,
  onClose,
}: {
  ctx: GlobViewContext;
  /** `holding`: a glob or decision that holds this one back; `holdsBack`: a glob this one holds back. */
  mode: 'holding' | 'holdsBack';
  gates: readonly RelationGate[];
  onAdd: (input: AddRelationInput) => Promise<boolean>;
  onClose: () => void;
}) => {
  const decision = isHumanCategory(glob.category);
  const holdsBack = mode === 'holdsBack';
  const [other, setOther] = useState('');
  const [gate, setGate] = useState<RelationGate | 'supersedes'>('start');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const globs = useQuery({ queryKey: globsKey(glob.boardId), queryFn: () => api.globs(glob.boardId) });
  // A decision holds work globs back; a glob is held back by other work globs and by decisions.
  const candidates = (globs.data ?? []).filter((g) => g.id !== glob.id && (!decision || !isHumanCategory(g.category)) && (!holdsBack || !isHumanCategory(g.category)));
  const id = other.trim();
  const submit = async () => {
    if (id === '') return;
    setWorking(true);
    const text = reason.trim();
    const why = text === '' ? {} : { reason: text };
    const ok = await onAdd(
      gate === 'supersedes' ? { ...why, supersedes: id } : holdsBack ? { ...why, gate, holdsBack: id } : { ...why, gate, to: id, version: glob.version },
    );
    setWorking(false);
    if (ok) {
      setOther('');
      setReason('');
      onClose();
    }
  };
  const listId = `relation-candidates-${glob.id}`;
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_auto_2fr_auto_auto] sm:items-center"
      data-testid="add-relation-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input aria-label={holdsBack ? 'Glob it holds back' : 'Glob or decision'} placeholder="s15t7" list={listId} value={other} onChange={(e) => setOther(e.target.value)} />
      <datalist id={listId}>
        {candidates.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </datalist>
      <Select aria-label="Gate" value={gate} onChange={(e) => setGate(e.target.value === 'supersedes' && !holdsBack ? 'supersedes' : (gates.find((g) => g === e.target.value) ?? 'start'))}>
        {gates.map((g) => (
          <option key={g} value={g}>
            {holdsBack ? (decision ? { start: 'can’t start until decided', merge: 'can’t merge until decided', sign_off: 'can’t sign off until decided' }[g] : gateWords(g, 'merged', 'this')) : gateWords(g, 'merged')}
          </option>
        ))}
        {!holdsBack && <option value="supersedes">supersedes it (replaces its work)</option>}
      </Select>
      <Input
        aria-label="Reason (optional)"
        placeholder={gate === 'supersedes' ? 'Why is it replaced? (one line)' : 'Why does it wait? (one line)'}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={busy || working || id === ''} data-testid="add-relation-submit">
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
};

/**
 * The header of a relation section, as Human steps has it: a collapsible subheading with a count and an optional ghost "+ Add …"
 * button that opens the add form below.
 */
export const RelationsHeader = ({
  open,
  onToggle,
  title,
  count,
  addLabel,
  onAdd,
  toggleTestId,
  addTestId,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  count: number;
  addLabel?: string;
  onAdd?: () => void;
  toggleTestId: string;
  addTestId?: string;
}) => (
  <div className="flex items-center gap-2">
    <SectionToggle open={open} onToggle={onToggle} testId={toggleTestId}>
      {title} ({count})
    </SectionToggle>
    {addLabel !== undefined && onAdd !== undefined && (
      <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs" data-testid={addTestId ?? 'add-relation'} onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    )}
  </div>
);

const sectionClass = 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-xs';

const List = ({ children }: { children: React.ReactNode }) => <ul className="ml-4 grid list-disc gap-0.5">{children}</ul>;

/** The Add button's state: the form is open or closed, and clicking it opens the section. */
const useAddForm = (open: boolean, setToggled: (open: boolean) => void) => {
  const [adding, setAdding] = useState(false);
  return {
    adding,
    toggle: () => {
      setAdding(!(adding && open));
      setToggled(true);
    },
    close: () => setAdding(false),
  };
};

interface RelationSectionProps {
  ctx: GlobViewContext;
}

/**
 * Holding this back: what keeps the glob back (with the gate in words, why and who said so), the decisions it waits for, the
 * "may relate" links, the glob it was split from, what it supersedes and a failed step's question. Slop infers relations; a person
 * can dismiss one that isn't, or add one.
 */
export const HoldingSection = ({
  ctx,
  onDismissEdge,
  onAddRelation,
  onSuggestion,
  onPromote,
}: RelationSectionProps & {
  /** The ✕ on a row: the relation is not a dependency; resolves false when it failed. */
  onDismissEdge: (relationId: string) => Promise<boolean>;
  onAddRelation: (input: AddRelationInput) => Promise<boolean>;
  /** The answers on a failed step's question; without it the question shows without buttons. */
  onSuggestion?: SuggestionHandler;
  /** "Make it a gate" on a "may relate" row; resolves false when it failed. Without it the rows show without the button. */
  onPromote?: (relationId: string) => Promise<boolean>;
}) => {
  const { glob } = ctx;
  const groups = relatedGroups(glob);
  const boardId = glob.boardId;
  const splitFrom = glob.split !== undefined && glob.split.part > 0 ? glob.split.source : null;
  const decision = isHumanCategory(glob.category);
  const holding = groups === null ? 0 : groups.holding.length + groups.decisions.length;
  const count = groups === null ? 0 : holding + groups.weak.length + groups.supersedes.length + groups.suggestions.length + (groups.supersededBy === null ? 0 : 1);
  // Starts open while something holds the glob back, until the viewer toggles it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (holding > 0 || (groups?.suggestions.length ?? 0) > 0);
  const form = useAddForm(open, setToggled);
  return (
    <section className={sectionClass} aria-label="Holding this back" data-testid="holding">
      <RelationsHeader
        open={open}
        onToggle={() => setToggled(!open)}
        title="Holding this back"
        count={count}
        addLabel="Add holding"
        onAdd={form.toggle}
        toggleTestId="holding-toggle"
        addTestId="add-holding"
      />
      {open && (
        <>
          {groups !== null && holding + groups.weak.length > 0 && (
            <List>
              {[...groups.holding, ...groups.decisions].map((r) => (
                <Row key={r.relationId} boardId={boardId} row={r} onDismiss={onDismissEdge} />
              ))}
              {groups.weak.map((r) => (
                <Row key={r.relationId} boardId={boardId} row={r} onDismiss={onDismissEdge} onPromote={onPromote ?? null} />
              ))}
            </List>
          )}
          {splitFrom !== null && (
            <p className="text-muted-foreground" data-testid="related-split-from">
              Split from <GlobLink boardId={boardId} id={splitFrom} />
            </p>
          )}
          {groups !== null && groups.supersededBy !== null && (
            <SupersessionLine boardId={boardId} other={groups.supersededBy} lead="Superseded by" testId="related-superseded-by" onDismiss={onDismissEdge} />
          )}
          {groups !== null &&
            groups.supersedes.map((o) => <SupersessionLine key={o.id} boardId={boardId} other={o} lead="Supersedes" testId={`related-supersedes-${o.id}`} onDismiss={null} />)}
          {groups !== null && groups.suggestions.length > 0 && (
            <div data-testid="related-failed-step">
              <span className="font-medium">Failed step</span>
              <ul className="ml-4 list-disc">
                {groups.suggestions.map((sg) => (
                  <FailedStepItem key={sg.id} suggestion={sg} onSuggestion={onSuggestion} />
                ))}
              </ul>
            </div>
          )}
          {form.adding && (
            <AddRelationForm ctx={ctx} mode="holding" gates={decision ? ['start', 'merge'] : ['start', 'merge', 'sign_off']} onAdd={onAddRelation} onClose={form.close} />
          )}
        </>
      )}
    </section>
  );
};

/** Holds back: the globs waiting for this one, and how many on other boards do. A decision with rows starts open. */
export const HoldsBackSection = ({ ctx, onAddRelation }: RelationSectionProps & { onAddRelation: (input: AddRelationInput) => Promise<boolean> }) => {
  const { glob } = ctx;
  const groups = relatedGroups(glob);
  const decision = isHumanCategory(glob.category);
  const rows = groups?.holdsBack ?? [];
  const otherBoards = groups?.otherBoards ?? 0;
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (decision && rows.length > 0);
  const form = useAddForm(open, setToggled);
  return (
    <section className={sectionClass} aria-label="Holds back" data-testid="holds-back">
      <RelationsHeader
        open={open}
        onToggle={() => setToggled(!open)}
        title="Holds back"
        count={rows.length}
        addLabel="Add holds back"
        onAdd={form.toggle}
        toggleTestId="holds-back-toggle"
        addTestId="add-holds-back"
      />
      {open && (
        <>
          {rows.length > 0 && (
            <List>
              {rows.map((r) => (
                <Row key={r.relationId} boardId={glob.boardId} row={r} holdsBack onDismiss={null} />
              ))}
            </List>
          )}
          {otherBoards > 0 && (
            <p className="text-muted-foreground" data-testid="related-other-boards">
              {String(otherBoards)} {otherBoards === 1 ? 'glob' : 'globs'} on other boards {otherBoards === 1 ? 'waits' : 'wait'} for this
            </p>
          )}
          {form.adding && <AddRelationForm ctx={ctx} mode="holdsBack" gates={decision ? ['start', 'merge'] : ['start', 'merge', 'sign_off']} onAdd={onAddRelation} onClose={form.close} />}
        </>
      )}
    </section>
  );
};

/** No longer holding: the relations that ended (muted, with how). Only shown when there are rows; starts collapsed. */
export const NoLongerHoldingSection = ({ ctx }: RelationSectionProps) => {
  const done = relatedGroups(ctx.glob)?.done ?? [];
  const [open, setOpen] = useState(false);
  if (done.length === 0) return null;
  return (
    <section className={`${sectionClass} text-muted-foreground`} aria-label="No longer holding" data-testid="no-longer-holding">
      <RelationsHeader open={open} onToggle={() => setOpen(!open)} title="No longer holding" count={done.length} toggleTestId="no-longer-holding-toggle" />
      {open && (
        <List>
          {done.map((r) => (
            <Row key={r.relationId} boardId={ctx.glob.boardId} row={r} how={r.how} onDismiss={null} />
          ))}
        </List>
      )}
    </section>
  );
};
