import { isHumanCategory } from '@slop/core';
import type { ExternalGlob, Holding, RelationGate, RelationSource, RelationSuggestion, RelationUntil, Supersession } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { AddRelationInput, GlobView } from '@/lib/api';
import { globsKey } from '@/lib/live';
import { lacksReason, OTHER_BOARD_GLOB } from '@/lib/status-line';
import { HumanIcon, MachineIcon } from '../actor-icons';
import { SectionToggle } from '../section-toggle';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
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
  auto: 'added automatically',
};

/** Accepts (writes the relation; a failed step's `glob` is the fix to link) or dismisses a card suggestion; resolves false when it failed. */
export type SuggestionHandler = (suggestionId: string, action: 'accept' | 'dismiss', glob?: string) => Promise<boolean>;

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
  /** Set when the other glob is on another board (its name, and whether the viewer may not see it). */
  readonly external?: ExternalGlob;
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
  /** The glob that supersedes this one (a muted line, not a status). */
  readonly supersededBy: Supersession | null;
  /** The globs this one supersedes. */
  readonly supersedes: readonly Supersession[];
  /** How many globs on boards the viewer is not on wait for this one. */
  readonly otherBoards: number;
  /** Card suggestions from the automatic pass: possible prerequisites, supersessions and a failed step's fix. */
  readonly suggestions: readonly RelationSuggestion[];
}

const rowOf = (h: Holding): RelatedRow => ({
  relationId: h.relationId,
  id: h.to,
  title: h.toTitle,
  words: gateWords(h.gate, h.until),
  reason: h.reason,
  source: h.source,
  dismissible: h.source !== 'split',
  ...(h.external === undefined ? {} : { external: h.external }),
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
      ...(h.external === undefined ? {} : { external: h.external }),
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
    supersededBy: view.supersededBy ?? null,
    supersedes: view.supersedes ?? [],
    otherBoards: view.waitedOnByOtherBoards ?? 0,
    suggestions: glob.suggestions ?? [],
  };
  const empty =
    groups.holding.length + groups.decisions.length + groups.holdsBack.length + groups.done.length + groups.supersedes.length + groups.suggestions.length === 0 &&
    groups.supersededBy === null &&
    groups.otherBoards === 0;
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
}: {
  boardId: number;
  row: RelatedRow;
  how?: string;
  /** The row is a glob that waits for this one (its hidden text reads from that side). */
  holdsBack?: boolean;
  onDismiss: ((relationId: string) => Promise<boolean>) | null;
}) => {
  const hidden = row.external?.hidden === true;
  const reason = (row.reason ?? '').trim();
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
      <span className="text-muted-foreground"> · {row.words}</span>
      {how !== undefined && <span className="text-muted-foreground"> ({how})</span>}
      {reason !== '' && <span className="text-muted-foreground">: {row.source === 'auto' ? `“${reason}”` : reason}</span>}
      {lacksReason(row) && (
        <span className="ml-2 rounded bg-muted px-1.5 text-xs text-muted-foreground" data-testid={`no-reason-${row.id}`}>
          no reason given
        </span>
      )}
      <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid={row.source === 'auto' ? `auto-badge-${row.id}` : undefined}>
        {row.source === 'person' ? <HumanIcon decorative /> : <MachineIcon decorative />}
        {SOURCE_WORDS[row.source]}
      </span>
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

const SUGGESTION_WORDS: Record<RelationSuggestion['kind'], { readonly yes: string; readonly no: string }> = {
  prerequisite: { yes: 'Add relation', no: 'Not a prerequisite' },
  reverse: { yes: 'Add relation', no: 'Not related' },
  supersedes: { yes: 'Mark superseded', no: 'Not superseded' },
  step_failed: { yes: 'Link a glob', no: 'No fix needed' },
};

/** One card suggestion: its text with the two answers; a failed step also takes the ID of the glob that fixes it. */
const SuggestionItem = ({ suggestion, onSuggestion }: { suggestion: RelationSuggestion; onSuggestion: SuggestionHandler | undefined }) => {
  const [fix, setFix] = useState('');
  const [working, setWorking] = useState(false);
  const sending = useRef(false);
  const words = SUGGESTION_WORDS[suggestion.kind];
  const failed = suggestion.kind === 'step_failed';
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
          {failed && (
            <Input
              className="h-7 w-32 text-xs"
              aria-label="Glob that fixes it"
              placeholder="s15b6"
              value={fix}
              onChange={(e) => setFix(e.target.value)}
              data-testid="suggestion-fix-glob"
            />
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={working || (failed && fixId === '')}
            data-testid="suggestion-accept"
            onClick={() => answer('accept', failed ? fixId : undefined)}
          >
            {words.yes}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={working} data-testid="suggestion-dismiss" onClick={() => answer('dismiss')}>
            {words.no}
          </Button>
        </span>
      )}
    </li>
  );
};

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
  const [gate, setGate] = useState<RelationGate | 'supersedes'>('start');
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
    const why = text === '' ? {} : { reason: text };
    const ok = await onAdd(
      gate === 'supersedes' ? { ...why, supersedes: id } : decision ? { ...why, gate, holdsBack: id } : { ...why, gate, to: id, version: glob.version },
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
      <Input aria-label={decision ? 'Glob it holds back' : 'Glob or decision'} placeholder="s15t7" list={listId} value={other} onChange={(e) => setOther(e.target.value)} />
      <datalist id={listId}>
        {candidates.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </datalist>
      <Select aria-label="Gate" value={gate} onChange={(e) => setGate(e.target.value === 'supersedes' && !decision ? 'supersedes' : (gates.find((g) => g === e.target.value) ?? 'start'))}>
        {gates.map((g) => (
          <option key={g} value={g}>
            {decision ? { start: 'can’t start until decided', merge: 'can’t merge until decided', sign_off: 'can’t sign off until decided' }[g] : gateWords(g, 'merged')}
          </option>
        ))}
        {!decision && <option value="supersedes">supersedes it (replaces its work)</option>}
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
  onSuggestion,
}: {
  ctx: GlobViewContext;
  /** The ✕ on a row: the relation is not a dependency; resolves false when it failed. */
  onDismissEdge: (relationId: string) => Promise<boolean>;
  onAddRelation: (input: AddRelationInput) => Promise<boolean>;
  /** The answers on a suggestion; without it the suggestions show without buttons. */
  onSuggestion?: SuggestionHandler;
}) => {
  const { glob } = ctx;
  const groups = relatedGroups(glob);
  const boardId = glob.boardId;
  const splitFrom = glob.split !== undefined && glob.split.part > 0 ? glob.split.source : null;
  const holding = groups === null ? 0 : groups.holding.length + groups.decisions.length;
  const decision = isHumanCategory(glob.category);
  const count = groups === null ? 0 : holding + groups.holdsBack.length + groups.done.length + groups.supersedes.length + groups.suggestions.length + (groups.supersededBy === null ? 0 : 1);
  // Starts open while something holds the glob back, until the viewer toggles it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const open = toggled ?? (holding > 0 || (groups?.suggestions.length ?? 0) > 0 || (decision && groups !== null && groups.holdsBack.length > 0));
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm" aria-label="Related" data-testid="related">
      <RelationsHeader
        open={open}
        onToggle={() => setToggled(!open)}
        title="Related"
        count={count}
        holding={holding}
        addLabel={decision ? 'Holds back' : 'Add relation'}
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
            <Row key={r.relationId} boardId={boardId} row={r} holdsBack onDismiss={null} />
          ))}
        </Group>
      )}
      {groups !== null && groups.otherBoards > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="related-other-boards">
          {String(groups.otherBoards)} {groups.otherBoards === 1 ? 'glob' : 'globs'} on other boards {groups.otherBoards === 1 ? 'waits' : 'wait'} for this
        </p>
      )}
      {groups !== null && groups.supersededBy !== null && (
        <SupersessionLine boardId={boardId} other={groups.supersededBy} lead="Superseded by" testId="related-superseded-by" onDismiss={onDismissEdge} />
      )}
      {groups !== null &&
        groups.supersedes.map((o) => <SupersessionLine key={o.id} boardId={boardId} other={o} lead="Supersedes" testId={`related-supersedes-${o.id}`} onDismiss={null} />)}
      {groups !== null && groups.suggestions.length > 0 && (
        <Group name="Suggestions" testId="related-suggestions">
          {groups.suggestions.map((sg) => (
            <SuggestionItem key={sg.id} suggestion={sg} onSuggestion={onSuggestion} />
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
          {adding && <AddRelationForm ctx={ctx} gates={decision ? ['start', 'merge'] : ['start', 'merge', 'sign_off']} onAdd={onAddRelation} onClose={() => setAdding(false)} />}
        </>
      )}
    </section>
  );
};
