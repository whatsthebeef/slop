import { isValidCombination } from '@slop/core';
import type { Category, EditFailure } from '@slop/core';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import type { GlobChanges } from '@/lib/api';
import { categoryOptions, saveCategory } from '@/lib/type-change';
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

/** Category (saved when it changes, with an Undo), group and environment (saved together with Save). */
export const EditFieldsSection = ({
  ctx: { board, glob, busy, onUpdate },
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
  // Category saves when it changes, and says so with an Undo.
  const [categoryNote, setCategoryNote] = useState<{ undo: Category } | null>(null);
  useEffect(() => setCategoryNote(null), [glob.id]);
  const changeCategory = async (to: Category, from: Category) => {
    const result = await saveCategory(onUpdate, from, to);
    if (result.saved) {
      setFailure(null);
      setCategoryNote({ undo: result.undo });
    } else {
      setFailure(result.failure);
      setCategoryNote(null);
    }
  };
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
        {!decision && (
          <Label>
            Category
            <Select
              value={glob.category}
              disabled={busy}
              data-testid="category"
              onChange={(e) =>
                void run(() => changeCategory(e.target.value as Category, glob.category))
              }
            >
              {categoryOptions(glob.type).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Label>
        )}
        <Label>
          Group
          <Input
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
      {categoryNote !== null && failure === null && (
        <div
          role="status"
          className="flex items-center justify-end gap-2 text-xs text-muted-foreground"
          data-testid="category-saved"
        >
          <span>Saved</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                changeCategory(categoryNote.undo, glob.category).then(() => setCategoryNote(null)),
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
            disabled={busy || !isValidCombination(merged.type, merged.category)}
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
