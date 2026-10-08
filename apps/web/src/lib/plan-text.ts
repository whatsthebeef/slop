/** The text plan.md shows: the draft, else the saved plan, else the glob's summary (its starting text). */
export const planText = (draft: string | null, saved: string | null, summary: string): string =>
  draft ?? saved ?? summary;

/** What a draft is compared against: Save is offered only once the text differs from it. */
export const planBaseline = (saved: string | null, summary: string): string => saved ?? summary;

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

/** The saved version the header describes: its number and who saved it. */
export interface PlanSaved {
  readonly version: number;
  readonly createdAt: string;
  readonly provenance: { readonly by: string; readonly actor: string };
}

/**
 * The header's version line: which plan.md version the editor shows and who saved it. While a draft differs from the
 * saved text it also says which version Save will make.
 */
export const planVersionLine = (saved: PlanSaved | null, editing = false): string => {
  if (saved === null) return editing ? 'not written yet · Save makes version 1' : 'not written yet';
  const who = saved.provenance.by === 'human' ? saved.provenance.actor : `${saved.provenance.actor} (${saved.provenance.by})`;
  const when = `${saved.createdAt.slice(0, 16).replace('T', ' ')} UTC`;
  const line = `version ${saved.version} · saved by ${who} · ${when}`;
  return editing ? `${line} · Save makes version ${saved.version + 1}` : line;
};
