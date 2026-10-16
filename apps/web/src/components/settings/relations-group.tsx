import type { PinInput, RelationLearningView, RelationSourceView } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { api, relationLearningKey } from '@/lib/api';
import { useToast } from '@/toast';
import { message } from './form';
import { Field, SettingBlock, SettingsGroup } from './group';

const SOURCE_NAME: Record<string, string> = {
  mention: 'Mentions',
  inferred: 'Inference',
  agent: 'Agents',
  person: 'People',
  learned: 'Failed runs',
  split: 'Splits',
};

const percent = (n: number | null): string => (n === null ? 'not measured' : `${String(Math.round(n * 100))}%`);

/** What the counts mean, in words: how many relations were needed, not needed, and how many dependencies had none. */
export const countsLine = (s: Pick<RelationSourceView, 'tp' | 'fp' | 'fn'>): string => `${String(s.tp)} needed · ${String(s.fp)} not needed · ${String(s.fn)} missed`;

/** The posture in a word: "gates", "weak links only", "gates, bolder" (inference also proposes by module). */
export const postureLine = (s: RelationSourceView): string => {
  const base = s.posture.posture === 'weak' ? 'weak links only' : s.posture.measured || s.posture.pinned ? 'gates' : 'gates (not enough data)';
  return s.posture.bold ? `${base}, bolder` : base;
};

/** Sources whose posture an admin can pin (the others always gate). */
const PINNABLE = ['mention', 'inferred'];

const SourceRow = ({ source, window, admin, onPosture }: { source: RelationSourceView; window: number; admin: boolean; onPosture: (value: string) => void }) => {
  const { posture } = source;
  const pinnable = admin && PINNABLE.includes(source.source);
  return (
    <li className='grid gap-1 rounded-md border p-2 text-xs' data-testid={`relation-source-${source.source}`}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-sm font-medium'>{SOURCE_NAME[source.source] ?? source.source}</span>
        <span className='rounded bg-muted px-1.5 py-0.5' data-testid={`relation-posture-${source.source}`}>
          {postureLine(source)}
        </span>
        {posture.pinned && (
          <span className='rounded bg-muted px-1.5 py-0.5' data-testid={`relation-pinned-${source.source}`}>
            pinned
          </span>
        )}
        {pinnable && (
          <Select
            className='ml-auto w-40'
            aria-label={`Posture of ${SOURCE_NAME[source.source] ?? source.source}`}
            value={posture.pinned ? posture.posture : 'learned'}
            onChange={(e) => onPosture(e.target.value)}
          >
            <option value='learned'>Learned</option>
            <option value='gate'>Always gate</option>
            <option value='weak'>Always weak</option>
          </Select>
        )}
      </div>
      <p className='text-muted-foreground'>
        Precision {percent(source.precision)} ({String(source.precisionSamples)} samples) · recall {percent(source.recall)}
        {source.recall !== null && ` (${String(source.recallSamples)} samples)`} · {countsLine(source)} · last {String(window)} days
      </p>
      <p className='text-muted-foreground' data-testid={`relation-why-${source.source}`}>
        {posture.why}
      </p>
    </li>
  );
};

/** One threshold or window the admin can pin: shown in its own unit, sent as the API takes it. */
interface Pin {
  readonly key: 'precisionThreshold' | 'recallThreshold' | 'windowDays' | 'minSamples';
  readonly label: string;
  readonly hint: string;
  readonly unit: number;
  readonly now: (v: RelationLearningView) => number;
}

const PINS: readonly Pin[] = [
  { key: 'precisionThreshold', label: 'Precision threshold (%)', hint: 'Below this share of relations that were needed, a source only makes weak links.', unit: 100, now: (v) => v.thresholds.precision },
  { key: 'recallThreshold', label: 'Recall threshold (%)', hint: 'Below this share of dependencies that had a relation, inference gets bolder.', unit: 100, now: (v) => v.thresholds.recall },
  { key: 'windowDays', label: 'Window (days)', hint: 'Only the last days of signals count.', unit: 1, now: (v) => v.thresholds.windowDays },
  { key: 'minSamples', label: 'Minimum samples', hint: 'Fewer samples than this and slop keeps gating.', unit: 1, now: (v) => v.thresholds.minSamples },
];

const Thresholds = ({ view, admin, onSave }: { view: RelationLearningView; admin: boolean; onSave: (pins: PinInput) => void }) => {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const shown = (p: Pin): string => draft[p.key] ?? String(Math.round(p.now(view) * p.unit));
  const changed = PINS.filter((p) => draft[p.key] !== undefined && Number(draft[p.key]) / p.unit !== p.now(view));
  const pinned = (p: Pin): boolean => view.pins[p.key] !== undefined;
  const save = () => {
    const pins: { -readonly [K in keyof PinInput]: PinInput[K] } = {};
    for (const p of changed) pins[p.key] = Number(draft[p.key]) / p.unit;
    onSave(pins);
    setDraft({});
  };
  return (
    <div className='grid gap-3 sm:grid-cols-2' data-testid='relation-thresholds'>
      {PINS.map((p) => (
        <Field key={p.key} label={`${p.label}${pinned(p) ? ' · pinned' : ''}`} hint={p.hint}>
          {(props) => (
            <Input {...props} type='number' disabled={!admin} value={shown(p)} onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })} data-testid={`relation-pin-${p.key}`} />
          )}
        </Field>
      ))}
      {admin && (
        <div className='sm:col-span-2'>
          <Button size='sm' disabled={changed.length === 0} onClick={save} data-testid='relation-pin-save'>
            Pin
          </Button>
        </div>
      )}
    </div>
  );
};

/**
 * Settings, Relations: how often each source's relations turned out right on this board over the window, and so how readily slop
 * makes them hold a glob back. Everyone sees the numbers; only an admin can pin a posture or a threshold, or reset the pins.
 */
export const RelationsGroup = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const key = relationLearningKey(boardId);
  const query = useQuery({ queryKey: key, queryFn: () => api.relationLearning(boardId) });
  const apply = useMutation({
    mutationFn: (run: () => Promise<RelationLearningView>) => run(),
    onSuccess: (view) => client.setQueryData(key, view),
    onError: (error) => toast(message(error)),
  });
  const view = query.data;
  const pinned = view !== undefined && (view.pins.precisionThreshold !== undefined || view.pins.recallThreshold !== undefined || view.pins.windowDays !== undefined || view.pins.minSamples !== undefined || Object.keys(view.pins.postures ?? {}).length > 0);
  return (
    <SettingsGroup id='relations'>
      {view === undefined ? (
        <p className='text-xs text-muted-foreground'>{query.isError ? 'Could not load the relation numbers.' : 'Loading…'}</p>
      ) : (
        <>
          <SettingBlock
            title='What slop has learned'
            hint='A relation counts as needed when the post-merge check, a failed run or a promoted weak link says so, and as not needed when it was forced through, dismissed or judged unnecessary. A dependency counts as missed when a person added it later or two globs collided.'
            testId='relation-sources'
          >
            <ul className='grid gap-2'>
              {view.sources.map((s) => (
                <SourceRow
                  key={s.source}
                  source={s}
                  window={view.thresholds.windowDays}
                  admin={admin}
                  onPosture={(value) =>
                    apply.mutate(() =>
                      value === 'learned' ? api.resetRelationLearning(boardId, s.source) : api.pinRelationLearning(boardId, { postures: { [s.source]: value === 'weak' ? 'weak' : 'gate' } }),
                    )
                  }
                />
              ))}
            </ul>
          </SettingBlock>
          <SettingBlock
            title='Thresholds'
            hint={`Slop starts from ${String(Math.round(view.defaults.precision * 100))}% precision, ${String(Math.round(view.defaults.recall * 100))}% recall, ${String(view.defaults.windowDays)} days and ${String(view.defaults.minSamples)} samples. ${admin ? 'Pin a value to keep it.' : 'An admin can pin them.'}`}
          >
            <Thresholds key={JSON.stringify(view.thresholds)} view={view} admin={admin} onSave={(pins) => apply.mutate(() => api.pinRelationLearning(boardId, pins))} />
            {admin && (
              <div>
                <Button size='sm' variant='outline' disabled={!pinned || apply.isPending} onClick={() => apply.mutate(() => api.resetRelationLearning(boardId))} data-testid='relation-reset'>
                  Reset all pins
                </Button>
              </div>
            )}
          </SettingBlock>
        </>
      )}
    </SettingsGroup>
  );
};
