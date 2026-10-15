import { fixOf, isValidCombination, WORK_KINDS } from '@slop/core';
import type { EditFailure, WorkKind } from '@slop/core';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GroupInput } from '@/components/group-input';
import { Label, Select } from '@/components/ui/input';
import type { GlobChanges } from '@/lib/api';
import { canBeFix, currentWorkKind, saveFix, saveWorkKind } from '@/lib/type-change';
import type { GlobViewContext } from './context';

/** The edits being typed into the view (group, environment, waits-for) and the server's refusal of the last save. */
export const useGlobEdits = (globId: string) => {
  const [draft, setDraft] = useState<GlobChanges>({});
  const [failure, setFailure] = useState<EditFailure | null>(null);
  useEffect(() => {
    setDraft({});
    setFailure(null);
  }, [globId]);
  return {
    draft,
    failure,
    setFailure,
    /** Edits the draft; a refusal shown earlier no longer applies to what the person is typing. */
    edit: (changes: GlobChanges) => {
      setDraft((d) => ({ ...d, ...changes }));
      setFailure(null);
    },
    discard: () => {
      setDraft({});
      setFailure(null);
    },
    clear: () => setDraft({}),
  };
};

export type GlobEdits = ReturnType<typeof useGlobEdits>;

/** The fix flag and work kind (saved when they change, with an Undo), group and environment (saved together with Save). */
export const EditFieldsSection = ({
  ctx: { board, glob, groups, busy, onUpdate },
  decision,
  edits,
  run,
  onReload,
}: {
  ctx: GlobViewContext;
  decision: boolean;
  edits: GlobEdits;
  /** Runs work with the page marked busy. */
  run: (work: () => Promise<void>) => Promise<void>;
  /** Loads the glob's latest values into the view (after a version conflict). */
  onReload: () => Promise<void>;
}) => {
  const { draft, failure, setFailure, edit } = edits;
  const merged = { ...glob, ...draft };
  const dirty = Object.keys(draft).length > 0;
  const deployable = board.environments.filter((e) => e.allowBranchDeploy);
  // The fix flag and work kind save when they change, and say so with an Undo.
  const [kindNote, setKindNote] = useState<{ undo: { fix: boolean } | { workKind: WorkKind } } | null>(null);
  useEffect(() => setKindNote(null), [glob.id]);
  const fix = fixOf(glob);
  const workKind = currentWorkKind(glob);
  const changeFix = async (to: boolean, from: boolean) => {
    const result = await saveFix(onUpdate, from, to);
    if (result.saved) {
      setFailure(null);
      setKindNote({ undo: { fix: result.undo } });
    } else {
      setFailure(result.failure);
      setKindNote(null);
    }
  };
  const changeWorkKind = async (to: WorkKind, from: WorkKind) => {
    const result = await saveWorkKind(onUpdate, from, to);
    if (result.saved) {
      setFailure(null);
      setKindNote({ undo: { workKind: result.undo } });
    } else {
      setFailure(result.failure);
      setKindNote(null);
    }
  };
  // The work kind feeds the time report: only board admins correct it.
  const canEditWorkKind = board.role === 'admin';
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
        {!decision && (
          <Label>
            Fix
            <Select
              value={fix ? 'yes' : 'no'}
              disabled={busy}
              title={glob.fixSource === 'person' ? 'Set by a person' : 'Inferred from the plan: choose to correct it'}
              data-testid="fix"
              onChange={(e) => void run(() => changeFix(e.target.value === 'yes', fix))}
            >
              <option value="no">Not a fix</option>
              <option value="yes" disabled={!canBeFix(glob)}>
                Fix
              </option>
            </Select>
          </Label>
        )}
        {!decision && canEditWorkKind && (
          <Label>
            Work kind
            <Select
              value={workKind}
              disabled={busy}
              title={glob.workKindSource === 'person' ? 'Set by a person' : 'Inferred from the plan'}
              data-testid="work-kind"
              onChange={(e) => void run(() => changeWorkKind(e.target.value as WorkKind, workKind))}
            >
              {WORK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === 'rnd' ? 'R&D' : 'Maintenance'}
                </option>
              ))}
            </Select>
          </Label>
        )}
        <Label>
          Group
          <GroupInput
            groups={groups}
            value={merged.group ?? ''}
            onChange={(e) => edit({ group: e.target.value === '' ? null : e.target.value })}
          />
        </Label>
        {!decision && (
          <Label>
            Environment
            <Select
              value={merged.environment ?? ''}
              onChange={(e) => edit({ environment: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">None</option>
              {deployable.map((env) => (
                <option key={env.name}>{env.name}</option>
              ))}
            </Select>
          </Label>
        )}
      </div>
      {kindNote !== null && failure === null && (
        <div
          role="status"
          className="flex items-center justify-end gap-2 text-xs text-muted-foreground"
          data-testid="kind-saved"
        >
          <span>Saved</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                ('fix' in kindNote.undo ? changeFix(kindNote.undo.fix, fix) : changeWorkKind(kindNote.undo.workKind, workKind)).then(() => setKindNote(null)),
              )
            }
          >
            Undo
          </Button>
        </div>
      )}
      {failure !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-end gap-2 text-sm text-red"
        >
          <span>{failure.message}</span>
          {failure.conflict && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await onReload();
                  setFailure(null);
                })
              }
            >
              Reload latest
            </Button>
          )}
        </div>
      )}
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={edits.discard}>
            Discard
          </Button>
          <Button
            size="sm"
            disabled={busy || !isValidCombination(merged.type, merged.category, fixOf(merged))}
            onClick={() =>
              void run(async () => {
                const refused = await onUpdate(draft);
                setFailure(refused);
                if (refused === null) edits.clear();
              })
            }
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
};
