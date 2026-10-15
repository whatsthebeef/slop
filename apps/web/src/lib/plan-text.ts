/** The text plan.md shows: the draft, else the saved plan. */
export const planText = (draft: string | null, saved: string | null): string => draft ?? saved ?? '';

/** What a draft is compared against: Save is offered only once the text differs from it. */
export const planBaseline = (saved: string | null): string => saved ?? '';

/** Copy text to the clipboard; if it is refused or missing, select the text so the user can copy it by hand. */
export const copyOrSelect = async (
  text: string,
  clipboard: { writeText: (text: string) => Promise<void> } | undefined,
  select: () => void,
): Promise<boolean> => {
  try {
    if (!clipboard) throw new Error('no clipboard');
    await clipboard.writeText(text);
    return true;
  } catch {
    select();
    return false;
  }
};

/** A saved plan.md version, as the header's version label describes it. */
export interface PlanSaved {
  readonly version: number;
  readonly createdAt: string;
  readonly provenance: { readonly by: string; readonly actor: string };
}

/** The author without the domain: everything before the "@" ("slop" and other machine authors stay as they are). */
const planAuthor = (actor: string): string => {
  const at = actor.indexOf('@');
  return at > 0 ? actor.slice(0, at) : actor;
};

/** A version as the header and its dropdown name it: `v3 · john · 2026-10-14` (the date is local, yyyy-mm-dd). */
export const planVersionLabel = (saved: PlanSaved): string => {
  const d = new Date(saved.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `v${String(saved.version)} · ${planAuthor(saved.provenance.actor)} · ${date}`;
};

/** The header's version label; while a draft differs from the saved text it is marked unsaved. */
export const planVersionLine = (saved: PlanSaved | null, editing = false): string => {
  const line = saved === null ? 'not written yet' : planVersionLabel(saved);
  return editing ? `${line} · unsaved` : line;
};

/** Until a glob is signed off the plan field already shows plan.md, so the Artifacts list leaves it out. The test plan has its own tab, so it is always left out. */
export const listedArtifacts = <T extends { readonly kind: string }>(artifacts: readonly T[], signedOff: boolean): readonly T[] =>
  artifacts.filter((a) => a.kind !== 'test_plan' && (signedOff || a.kind !== 'plan'));
