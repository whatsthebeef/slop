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
