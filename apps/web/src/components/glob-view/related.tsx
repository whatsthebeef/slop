import { isHumanCategory } from '@slop/core';
import type { Holding, RelationGate, RelationSource, RelationUntil } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { AddRelationInput, GlobView } from '@/lib/api';
import { globsKey } from '@/lib/live';
import { HumanIcon, MachineIcon } from '../actor-icons';
import { SectionToggle } from '../section-toggle';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import type { GlobViewContext } from './context';

/** What a gate refuses until its target gets there, in words: "can't start until merged". */
export const gateWords = (gate: RelationGate, until: RelationUntil, subject?: 'this'): string => {
  const what = gate === 'start' ? 'start' : gate === 'merge' ? 'merge' : 'sign off';
  const when = until === 'merged' ? 'merged' : until === 'decided' ? 'decided' : 'signed off';
  return `can't ${what} until ${subject === undefined ? '' : 'this is '}${when}`;
};

const SOURCE_WORDS: Record<RelationSource, string> = {
  person: 'added by a person',
  agent: 'added by an agent',
  inferred: 'inferred by slop',
  learned: 'learned from a failed run',
  split: 'from the split',
};

/** One row of the Related section, whichever group it is in. */
export interface RelatedRow {
  readonly relationId: string;
  /** The other glob. */
  readonly id: string;
  readonly title: string | null;
  readonly words: string;
  readonly reason: string | null;
  readonly source: RelationSource;
  /** A relation of this glob a person may dismiss (not one that no longer holds). */
  readonly dismissible: boolean;
}

/** What the Related section lists, in its groups. */
export interface RelatedGroups {
  /** Unmet relations a person or slop made (start gates first): what keeps the glob back right now. */
  readonly holding: readonly RelatedRow[];
  /** Unmet relations that wait for a decision. */
  readonly decisions: readonly RelatedRow[];
  /** Other globs this one holds back. */
  readonly holdsBack: readonly RelatedRow[];
  /** Relations that stopped holding (met, deleted, dismissed, overridden). */
  readonly done: readonly (RelatedRow & { readonly how: string })[];
}

const rowOf = (h: Holding): RelatedRow => ({
  relationId: h.relationId,
  id: h.to,
  title: h.toTitle,
  words: gateWords(h.gate, h.until),
  reason: h.reason,
  source: h.source,
  dismissible: h.source !== 'split',
});

const HOW_WORDS = { met: 'done', deleted: 'deleted', dismissed: 'dismissed', overridden: 'started anyway' } as const;

/** The Related section's content: the glob's relations in groups; null when it has none (or the API is older and sends none). */
export const relatedGroups = (glob: GlobView): RelatedGroups | null => {
  const view = glob.relations;
  if (view === undefined) return null;
  const holding = view.holding;
  const groups: RelatedGroups = {
    holding: holding.filter((h) => !h.toIsDecision && h.toIsAction !== true).map(rowOf),
    decisions: holding.filter((h) => h.toIsDecision || h.toIsAction === true).map(rowOf),
    holdsBack: view.holdsBack.map((h) => ({
      relationId: h.relationId,
      id: h.from,
      title: h.fromTitle,
      words: gateWords(h.gate, h.until, 'this'),
      reason: h.reason,
      source: h.source,
      dismissible: false,
    })),
    done: view.done.map((d) => ({
      relationId: d.relationId,
      id: d.to,
      title: d.toTitle,
      words: gateWords(d.gate, d.until),
      reason: d.reason,
      source: d.source,
      dismissible: false,
      how: HOW_WORDS[d.how],
    })),
  };
  const empty = groups.holding.length + groups.decisions.length + groups.holdsBack.length + groups.done.length === 0;
  return empty ? null : groups;
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

export const Row = ({
  boardId,
  row,
  how,
  onDismiss,
}: {
  boardId: number;
  row: RelatedRow;
  how?: string;
  onDismiss: ((relationId: string) => Promise<boolean>) | null;
}) => (
  <li data-testid={`related-row-${row.id}`}>
    <GlobLink boardId={boardId} id={row.id} />
    {row.title !== null && <span> {row.title}</span>}
    <span className="text-muted-foreground"> · {row.words}</span>
    {how !== undefined && <span className="text-muted-foreground"> ({how})</span>}
    {row.reason !== null && <span className="text-muted-foreground">: {row.reason}</span>}
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
      {row.source === 'person' ? <HumanIcon decorative /> : <MachineIcon decorative />}
      {SOURCE_WORDS[row.source]}
    </span>
    {row.dismissible && onDismiss !== null && <DismissRelation id={row.id} relationId={row.relationId} onDismiss={onDismiss} />}
  </li>
);

const Group = ({ name, testId, children }: { name: string; testId: string; children: React.ReactNode }) => (
  <div data-testid={testId}>
    <span className="font-medium">{name}</span>
    <ul className="ml-4 list-disc">{children}</ul>
  </div>
);

/**
 * The form behind "+ Add relation" and a decision's "+ Holds back": pick a glob (or type its ID), a gate, and Add. A glob adds a
 * relation it is held back by (`to`); a decision adds one for another glob that it holds back (`holdsBack`). The section's header
 * button opens and closes it.
 */
export const AddRelationForm = ({
  ctx: { glob, busy },
  gates,
  onAdd,
  onClose,
}: {
  ctx: GlobViewContext;
  gates: readonly RelationGate[];
  onAdd: (input: AddRelationInput) => Promise<boolean>;
  onClose: () => void;
}) => {
  const decision = isHumanCategory(glob.category);
  const [other, setOther] = useState('');
  const [gate, setGate] = useState<RelationGate>('start');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const globs = useQuery({ queryKey: globsKey(glob.boardId), queryFn: () => api.globs(glob.boardId) });
  // A decision holds work globs back; a glob is held back by other work globs and by decisions.
  const candidates = (globs.data ?? []).filter((g) => g.id !== glob.id && (!decision || !isHumanCategory(g.category)));
  const id = other.trim();
  const submit = async () => {
    if (id === '') return;
    setWorking(true);
    const text = reason.trim();
    const base = { gate, ...(text === '' ? {} : { reason: text }) };
    const ok = await onAdd(decision ? { ...base, holdsBack: id } : { ...base, to: id, version: glob.version });
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
      <Input aria-label={decision ? 'Glob it holds back' : 'Glob or decision'} placeholder="s15t7" list={listId} value={other} onChange={(e) => setOther(e.target.value)} />
      <datalist id={listId}>
        {candidates.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </datalist>
      <Select aria-label="Gate" value={gate} onChange={(e) => setGate(gates.find((g) => g === e.target.value) ?? 'start')}>
        {gates.map((g) => (
          <option key={g} value={g}>
            {decision ? { start: 'can’t start until decided', merge: 'can’t merge until decided', sign_off: 'can’t sign off until decided' }[g] : gateWords(g, 'merged')}
          </option>
        ))}
      </Select>
      <Input aria-label="Reason (optional)" placeholder="Why (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
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
 * The header of Related and of a decision's Holds back, as Human steps has it: a collapsible subheading with a count (and, while
 * collapsed, how many hold the glob back) and a ghost "+ Add …" button that opens the add form below.
 */
export const RelationsHeader = ({
  open,
  onToggle,
  title,
  count,
  holding,
  addLabel,
  onAdd,
  toggleTestId,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  count: number;
  holding: number;
  addLabel: string;
  onAdd: () => void;
  toggleTestId: string;
}) => (
  <div className="flex items-center gap-2">
    <SectionToggle open={open} onToggle={onToggle} testId={toggleTestId}>
      {title} ({count})
      {!open && holding > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground" data-testid="related-holding-count">
          {holding} holding
        </span>
      )}
    </SectionToggle>
    <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs" data-testid="add-relation" onClick={onAdd}>
      <Plus className="h-3.5 w-3.5" />
      {addLabel}
    </Button>
  </div>
);

/**
 * The Related section of a work glob: what holds it back (with the gate in words, why and who said so), the decisions it waits
 * for, the glob it was split from, what it holds back, and what no longer holds (collapsed). Slop infers relations; a person can dismiss one
 * that isn't, or add one.
 */
export const RelatedSection = ({
  ctx,
  onDismissEdge,
  onAddRelation,
}: {
  ctx: GlobViewContext;
  /** The ✕ on a row: the relation is not a dependency; resolves false when it failed. */
  onDismissEdge: (relationId: string) => Promise<boolean>;
  onAddRelation: (input: AddRelationInput) => Promise<boolean>;
}) => {
  const { glob } = ctx;
  const groups = relatedGroups(glob);
  const boardId = glob.boardId;
  const splitFrom = glob.split !== undefined && glob.split.part > 0 ? glob.split.source : null;
  const holding = groups === null ? 0 : groups.holding.length + groups.decisions.length;
  const count = groups === null ? 0 : holding + groups.holdsBack.length + groups.done.length;
  // Starts open while something holds the glob back, until the viewer toggles it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const open = toggled ?? holding > 0;
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm" aria-label="Related" data-testid="related">
      <RelationsHeader
        open={open}
        onToggle={() => setToggled(!open)}
        title="Related"
        count={count}
        holding={holding}
        addLabel="Add relation"
        onAdd={() => {
          setAdding(!(adding && open));
          setToggled(true);
        }}
        toggleTestId="related-toggle"
      />
      {open && (
        <>
      {groups !== null && groups.holding.length > 0 && (
        <Group name="Holding this back" testId="related-holding">
          {groups.holding.map((r) => (
            <Row key={r.relationId} boardId={boardId} row={r} onDismiss={onDismissEdge} />
          ))}
        </Group>
      )}
      {groups !== null && groups.decisions.length > 0 && (
        <Group name="Decisions" testId="related-decisions">
          {groups.decisions.map((r) => (
            <Row key={r.relationId} boardId={boardId} row={r} onDismiss={onDismissEdge} />
          ))}
        </Group>
      )}
      {splitFrom !== null && (
        <p className="text-xs text-muted-foreground" data-testid="related-split-from">
          Split from <GlobLink boardId={boardId} id={splitFrom} />
        </p>
      )}
      {groups !== null && groups.holdsBack.length > 0 && (
        <Group name="Holds back" testId="related-holds-back">
          {groups.holdsBack.map((r) => (
            <Row key={r.relationId} boardId={boardId} row={r} onDismiss={null} />
          ))}
        </Group>
      )}
      {groups !== null && groups.done.length > 0 && (
        <details data-testid="related-done">
          <summary className="cursor-pointer font-medium">Done ({groups.done.length})</summary>
          <ul className="ml-4 list-disc">
            {groups.done.map((r) => (
              <Row key={r.relationId} boardId={boardId} row={r} how={r.how} onDismiss={null} />
            ))}
          </ul>
        </details>
      )}
          {adding && <AddRelationForm ctx={ctx} gates={['start', 'merge', 'sign_off']} onAdd={onAddRelation} onClose={() => setAdding(false)} />}
        </>
      )}
    </section>
  );
};
