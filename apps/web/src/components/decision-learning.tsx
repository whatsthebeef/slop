import { basisText, llmWaitingReason, MAX_PROCESSING_ATTEMPTS, STALE_AFTER_DAYS, STALE_BELOW_THRESHOLD_RUNS, STALE_KEEP_DAYS } from '@slop/core';
import type { DecisionAttributes, DecisionDocument, DecisionLearning, EffectCheck, EffectFigures, KbSignal, KbStaleReason } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { MarkdownView } from '@/components/markdown-view';
import { Button } from '@/components/ui/button';
import { Label, Select, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { GlobView } from '@/lib/api';
import { nextTry } from '@/lib/kb-processing';
import { globDiffKey, globKey, globsKey } from '@/lib/live';
import { useToast } from '@/toast';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

const message = (error: unknown) => (error instanceof RequestError ? error.body.message : 'Something went wrong');

/** How often the learning's state is read again while the pipeline works on it (hints normally refresh it). */
export const PIPELINE_POLL_MS = 15_000;

/** Whether the pipeline still has work on a learning (routing, or its draft). */
export const inPipeline = (learning: DecisionLearning): boolean =>
  learning.status === 'open' && (learning.processing === 'pending' || learning.processing === 'routed');

/** The learning's glob and everything that shows its state, read again after a write. */
const refreshGlob = (client: QueryClient, glob: GlobView) => {
  void client.invalidateQueries({ queryKey: globKey(glob.id) });
  void client.invalidateQueries({ queryKey: globsKey(glob.boardId) });
  void client.invalidateQueries({ queryKey: globDiffKey(glob.id) });
};

/** After a refused write: a version conflict means the glob changed meanwhile, so its view is read again. */
const reportError = (client: QueryClient, glob: GlobView, toast: (text: string) => void, error: unknown) => {
  if (error instanceof RequestError && error.body.code === 'version_conflict') {
    toast(`${error.body.message}. The view now shows it as it is.`);
    refreshGlob(client, glob);
    return;
  }
  toast(message(error));
};

/** A link to a glob on the board. */
const GlobLinks = ({ boardId, ids }: { boardId: number; ids: readonly string[] }) =>
  ids.map((id, index) => (
    <span key={id}>
      {index > 0 && ', '}
      <Link className='font-mono underline decoration-dotted hover:decoration-solid' to={`/boards/${String(boardId)}?glob=${encodeURIComponent(id)}`}>
        {id}
      </Link>
    </span>
  ));

/**
 * Where the background pipeline is with an open learning: routing or drafting (with the last error and the next try while
 * retrying), waiting for the AI to be usable again (no Retry: it resumes by itself once the sign-in or access is fixed), or
 * given up on, with Retry for admins.
 */
export const ProcessingState = ({ glob, learning, routed, admin }: { glob: GlobView; learning: DecisionLearning; routed: boolean; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () => api.retryProposal(glob.id, glob.version),
    onSuccess: () => {
      toast(`${glob.id} is being tried again now`);
      refreshGlob(client, glob);
    },
    onError: (e) => reportError(client, glob, toast, e),
  });
  if (learning.status !== 'open') return null;
  const stage = routed ? 'Drafting' : 'Routing';
  if (learning.processing === 'failed') {
    return (
      <div className='flex flex-wrap items-center gap-2 rounded-md border border-required-border bg-red-soft/15 p-2 text-xs' data-testid='processing-failed'>
        <span>
          {stage} failed: {learning.processingError ?? 'unknown error'}
        </span>
        {admin && (
          <Button size='sm' variant='outline' className='ml-auto' disabled={retry.isPending} data-testid='retry' onClick={() => retry.mutate()}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (!inPipeline(learning)) return null;
  const waiting = llmWaitingReason(learning);
  if (waiting !== null) {
    return (
      <p className='text-xs text-muted-foreground' data-testid='processing-waiting'>
        Waiting: AI unavailable — {waiting}. {stage} resumes once it works again.
      </p>
    );
  }
  // After a failed attempt, `processAfter` is the backoff's end; while the job runs again it is the claim's 5-minute lease,
  // which says nothing about when the step finishes, so the view says it is trying again now.
  const next = nextTry(learning, Date.now());
  const at = next === 'running' ? 'now' : next === 'shortly' ? 'shortly' : `by ${next.toLocaleTimeString()}`;
  return (
    <p className='text-xs text-muted-foreground' data-testid='processing'>
      {learning.processing === 'pending' ? 'Routing…' : 'Drafting…'}
      {learning.processingError !== null &&
        ` Attempt ${String(learning.processingAttempts)} of ${String(MAX_PROCESSING_ATTEMPTS)} failed: ${learning.processingError}. ${next === 'running' ? 'Trying again now' : `Trying again ${at}`}.`}
    </p>
  );
};

/** A mined learning's signal: the figures behind it, as last measured (refreshed weekly while open). */
export const SignalFigures = ({ signal }: { signal: KbSignal }) => {
  const occurrences = signal.figures.count !== signal.figures.affected;
  return (
    <table className='w-fit text-xs' data-testid='signal'>
      <thead className='text-muted-foreground'>
        <tr>
          <th className='pr-4 text-left font-normal'>Signal</th>
          <th className='pr-4 text-right font-normal'>Affected</th>
          <th className='pr-4 text-right font-normal'>Of</th>
          <th className='pr-4 text-right font-normal'>Rate</th>
          {occurrences && <th className='pr-4 text-right font-normal'>Occurrences</th>}
          <th className='text-left font-normal'>Window</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className='pr-4'>
            {signal.label}
            {signal.agent !== null && <span className='text-muted-foreground'> ({signal.agent})</span>}
          </td>
          <td className='pr-4 text-right tabular-nums'>{signal.figures.affected}</td>
          <td className='pr-4 text-right tabular-nums'>{signal.figures.eligible}</td>
          <td className='pr-4 text-right tabular-nums'>{percent(signal.figures.rate)}</td>
          {occurrences && <td className='pr-4 text-right tabular-nums'>{signal.figures.count}</td>}
          <td className='text-muted-foreground'>
            {signal.window.from.slice(0, 10)} – {signal.window.to.slice(0, 10)}
          </td>
        </tr>
      </tbody>
    </table>
  );
};

export const EFFECT_VERDICTS: Record<Exclude<EffectCheck['state'], 'watching'>, string> = {
  improved: 'improved',
  not_improved: 'not improved',
  worse_elsewhere: 'improved, but another signal got markedly worse',
  unmeasurable: 'unmeasurable (no eligible glob merged before the approval)',
};

/** What a check's basis counts from, in a few words: "since v12", or "since 2026-10-07". */
export const sinceText = (check: EffectCheck): string =>
  check.basis.kind === 'agent_set' ? `since v${String(check.basis.fromVersion)}` : `since ${check.basis.since.slice(0, 10)}`;

/** One side's row of the before/after table. */
const EffectRow = ({ boardId, name, figures }: { boardId: number; name: string; figures: EffectFigures }) => (
  <tr>
    <td className='pr-4'>{name}</td>
    <td className='pr-4 text-right tabular-nums'>{figures.affected}</td>
    <td className='pr-4 text-right tabular-nums'>{figures.eligible}</td>
    <td className='pr-4 text-right tabular-nums'>{percent(figures.rate)}</td>
    <td className='text-muted-foreground'>{figures.affectedGlobIds.length === 0 ? '—' : <GlobLinks boardId={boardId} ids={figures.affectedGlobIds} />}</td>
  </tr>
);

/**
 * An approved change's effect check: watching with the after side's progress, or the verdict; the before and after
 * figures (and any signal that got markedly worse), with the affected globs, and the revise-or-revert learning it raised.
 */
export const EffectCheckView = ({ boardId, check }: { boardId: number; check: EffectCheck }) => {
  const { before, after } = check;
  const status = check.state === 'watching' ? `watching (${String(after?.eligible ?? 0)}/${String(check.n)} globs ${sinceText(check)})` : EFFECT_VERDICTS[check.state];
  return (
    <div className='grid gap-1 rounded-md border border-border bg-muted/40 p-2 text-xs' data-testid='effect-check'>
      <p>
        <span className='font-medium'>Effect check: </span>
        {status}
        <span className='text-muted-foreground'>
          {' '}
          · {check.label}, {check.n} globs a side with {basisText(check.basis)}
          {check.checkedAt !== null && ` · checked ${when(check.checkedAt)}`}
        </span>
      </p>
      {before === null || after === null ? (
        <p className='text-muted-foreground'>The figures come with the next check.</p>
      ) : (
        <table className='w-fit' data-testid='effect-figures'>
          <thead className='text-muted-foreground'>
            <tr>
              <th className='pr-4 text-left font-normal'></th>
              <th className='pr-4 text-right font-normal'>Affected</th>
              <th className='pr-4 text-right font-normal'>Of</th>
              <th className='pr-4 text-right font-normal'>Rate</th>
              <th className='text-left font-normal'>Affected globs</th>
            </tr>
          </thead>
          <tbody>
            <EffectRow boardId={boardId} name='Before' figures={before} />
            <EffectRow boardId={boardId} name={check.state === 'watching' ? 'After so far' : 'After'} figures={after} />
            {check.worse.flatMap((w) => [
              <EffectRow key={`${w.key}-before`} boardId={boardId} name={`${w.label}, before`} figures={w.before} />,
              <EffectRow key={`${w.key}-after`} boardId={boardId} name={`${w.label}, after`} figures={w.after} />,
            ])}
          </tbody>
        </table>
      )}
      {check.raisedItemId !== null && (
        <p data-testid='effect-raised'>
          Raised <GlobLinks boardId={boardId} ids={[check.raisedItemId]} /> to revise or revert the change.
        </p>
      )}
    </div>
  );
};

/** Why a learning was flagged stale, in words. */
const staleText = (reason: KbStaleReason | null): string =>
  reason === 'signal_below_threshold'
    ? `its signal has been below its threshold for ${String(STALE_BELOW_THRESHOLD_RUNS)} weekly runs or more`
    : `no new evidence for ${String(STALE_AFTER_DAYS)} days`;

/** A learning weekly consolidation flagged stale: an admin marks it not stale (it isn't flagged again for a while), or rejects it. */
export const StaleNote = ({ glob, attributes, admin }: { glob: GlobView; attributes: DecisionAttributes; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const keep = useMutation({
    mutationFn: () => api.keepProposal(glob.id, glob.version),
    onSuccess: () => {
      toast(`${glob.id} is marked not stale: it won't be flagged again for ${String(STALE_KEEP_DAYS)} days`);
      refreshGlob(client, glob);
    },
    onError: (e) => reportError(client, glob, toast, e),
  });
  const since = attributes.stale?.since ?? null;
  if (since === null) return null;
  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs' data-testid='stale'>
      <span>
        <span className='font-medium'>Stale since {when(since)}: </span>
        <span className='text-muted-foreground'>{staleText(attributes.stale?.reason ?? null)}. Weekly consolidation only flags it: mark it not stale, or reject it.</span>
      </span>
      {admin && (
        <Button size='sm' variant='outline' className='ml-auto' disabled={keep.isPending} data-testid='not-stale' onClick={() => keep.mutate()}>
          Not stale
        </Button>
      )}
    </div>
  );
};

/** For a learning an admin approves that has no signal of its own: one of the board's signals as measured now, for the effect check to watch. */
export const WatchSignal = ({ boardId, value, onChange }: { boardId: number; value: string; onChange: (key: string) => void }) => {
  const signals = useQuery({ queryKey: ['kb-signals', boardId], queryFn: () => api.boardSignals(boardId) });
  return (
    <Label className='text-xs'>
      Watch signal (effect check)
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={signals.data === undefined} data-testid='watch-signal'>
        <option value=''>None</option>
        {(signals.data ?? []).map((s) => (
          <option key={s.key} value={s.key}>
            {s.label} ({s.figures.affected}/{s.figures.eligible}, {percent(s.figures.rate)})
          </option>
        ))}
      </Select>
    </Label>
  );
};

/** The approval's Watch signal field: only when one was chosen. */
export const watching = (key: string): { watchSignal?: string } => (key === '' ? {} : { watchSignal: key });

/** Whether an open learning can be given a signal to watch on approval: statements without one (mined ones watch their own). */
export const canWatch = (learning: DecisionLearning | null, attributes: DecisionAttributes): boolean =>
  learning?.status === 'open' && attributes.document === undefined && attributes.signal === undefined;

/** Keeps an open learning's statement as an approved learning, without changing any document (admins). */
export const KeepAsLearning = ({
  glob,
  attributes,
  learning,
  busy,
}: {
  glob: GlobView;
  attributes: DecisionAttributes;
  learning: DecisionLearning | null;
  busy: boolean;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState(glob.title);
  const [watch, setWatch] = useState('');
  const keep = useMutation({
    mutationFn: () => api.keepAsLearning(glob.id, glob.version, statement, watch === '' ? undefined : watch),
    onSuccess: () => {
      toast(`${glob.id} kept as a learning`);
      setOpen(false);
      refreshGlob(client, glob);
    },
    onError: (e) => reportError(client, glob, toast, e),
  });
  return (
    <div className='grid gap-2'>
      <Button size='sm' variant={open ? 'default' : 'outline'} aria-pressed={open} disabled={busy} data-testid='keep-as-learning' onClick={() => setOpen(!open)}>
        Keep as a learning
      </Button>
      {open && (
        <form
          className='grid gap-2 rounded border p-3'
          data-testid='keep-form'
          onSubmit={(e) => {
            e.preventDefault();
            if (statement.trim() !== '') keep.mutate();
          }}
        >
          <p className='text-xs text-muted-foreground'>Kept as an approved learning, served to agents with the board's conventions, without changing any document.</p>
          <Label>
            Statement
            <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
          </Label>
          {canWatch(learning, attributes) && <WatchSignal boardId={glob.boardId} value={watch} onChange={setWatch} />}
          <div className='flex justify-end gap-2'>
            <Button type='button' size='sm' variant='ghost' onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={busy || keep.isPending || statement.trim() === ''}>
              Keep as a learning
            </Button>
          </div>
        </form>
      )}
    </div>
  );
};

const sameAudience = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

const audienceText = (audience: readonly string[]) => (audience.length === 0 ? 'no agents' : audience.join(', '));

/** A document the board already has, as the Knowledge page's index lists it. */
interface ExistingDocument {
  readonly name: string;
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
  readonly version: number;
}

const Side = ({ title, area, audience, description, changed, children }: { title: string; area: string | null; audience: readonly string[]; description: string; changed: { area: boolean; description: boolean }; children: ReactNode }) => (
  <div className='grid content-start gap-1'>
    <span className='font-semibold'>{title}</span>
    <span className={changed.area ? 'font-medium' : 'text-muted-foreground'}>area {area ?? '—'}</span>
    <span className='text-muted-foreground'>always for: {audienceText(audience)}</span>
    <span className={changed.description ? 'font-medium' : 'text-muted-foreground'}>{description || '—'}</span>
    {children}
  </div>
);

/**
 * A proposed whole document: new, or replacing one the board has, in which case the current version is shown beside the
 * proposed one and changed metadata is called out (an audience change decides which agents are always given the document).
 * Approving a whole document is for people only: agents are never allowed to.
 */
export const DocumentProposal = ({ boardId, document, content }: { boardId: number; document: DecisionDocument; content: string }) => {
  const [shown, setShown] = useState(false);
  const kb = useQuery({ queryKey: ['kb', boardId], queryFn: () => api.knowledge(boardId) });
  const existing: ExistingDocument | null = kb.data?.documents.find((d) => d.name === document.name) ?? null;
  const current = useQuery({
    queryKey: ['kb-doc', boardId, existing?.name ?? null],
    queryFn: () => api.knowledgeDoc(boardId, existing?.name ?? ''),
    enabled: shown && existing !== null,
  });
  const currentContent = current.data?.find((d) => d.name === existing?.name)?.content;
  return (
    <div className='grid gap-1 text-xs' data-testid='document-proposal'>
      <span>
        <span className='font-medium'>{document.name}</span> · {existing === null ? 'new document' : `replaces v${String(existing.version)}`} · area {document.area} · always for:{' '}
        {audienceText(document.audience)}
      </span>
      <span className='text-muted-foreground'>{document.description}</span>
      <span className='text-muted-foreground'>A whole document always needs a person to approve it; agents can't.</span>
      {existing !== null && !sameAudience(existing.audience, document.audience) && (
        <p className='rounded-md border border-required-border bg-red-soft/15 p-2' data-testid='audience-change'>
          Audience changes from <span className='font-medium'>{audienceText(existing.audience)}</span> to <span className='font-medium'>{audienceText(document.audience)}</span>: this
          changes which agents are always given the document.
        </p>
      )}
      <button type='button' className='w-fit text-left hover:underline' data-testid='show-document' onClick={() => setShown(!shown)}>
        {shown ? 'Hide document' : existing === null ? 'Show document' : 'Compare with the current document'}
      </button>
      {shown &&
        (existing === null ? (
          <MarkdownView content={content} />
        ) : (
          <div className='grid gap-3 md:grid-cols-2'>
            <Side
              title={`Current (v${String(existing.version)})`}
              area={existing.area}
              audience={existing.audience}
              description={existing.description}
              changed={{ area: existing.area !== document.area, description: existing.description !== document.description }}
            >
              <MarkdownView content={currentContent ?? 'Loading…'} />
            </Side>
            <Side
              title='Proposed'
              area={document.area}
              audience={document.audience}
              description={document.description}
              changed={{ area: existing.area !== document.area, description: existing.description !== document.description }}
            >
              <MarkdownView content={content} />
            </Side>
          </div>
        ))}
    </div>
  );
};
