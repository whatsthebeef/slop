const KEY = 'slop-recent-boards';
/** When each board was last opened, for the all-boards page's order. */
const VISITS_KEY = 'slop-board-visits';
export const RECENT_SLOTS = 3;

interface Slot {
  readonly id: number;
  readonly at: number;
}

const read = (): Slot[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((s: unknown) =>
      typeof s === 'object' &&
      s !== null &&
      'id' in s &&
      'at' in s &&
      typeof s.id === 'number' &&
      typeof s.at === 'number'
        ? [{ id: s.id, at: s.at }]
        : [],
    );
  } catch {
    return [];
  }
};

/**
 * Records a visit and returns the recent boards in slot order. Like tmux windows, a board keeps
 * its slot once it has one; a new board takes the least recently used slot, so tabs don't shuffle.
 */
export const visitBoard = (id: number, now = Date.now()): number[] => {
  const slots = read().slice(0, RECENT_SLOTS);
  const index = slots.findIndex((s) => s.id === id);
  if (index >= 0) slots[index] = { id, at: now };
  else if (slots.length < RECENT_SLOTS) slots.push({ id, at: now });
  else {
    const oldest = slots.reduce(
      (min, s, i, all) => (s.at < (all[min]?.at ?? Infinity) ? i : min),
      0,
    );
    slots[oldest] = { id, at: now };
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(slots));
    localStorage.setItem(VISITS_KEY, JSON.stringify({ ...boardVisits(), [id]: now }));
  } catch {
    // Private windows can refuse storage; the switcher still works for this visit.
  }
  return slots.map((s) => s.id);
};

/** The recent boards in slot order, without recording a visit. */
export const recentBoards = (): number[] =>
  read()
    .slice(0, RECENT_SLOTS)
    .map((s) => s.id);

/** The board opened most recently, if any. */
export const lastBoard = (): number | undefined =>
  read().reduce<Slot | undefined>(
    (last, s) => (last === undefined || s.at > last.at ? s : last),
    undefined,
  )?.id;

/** When each board was last opened in this browser (epoch ms by board id). */
export const boardVisits = (): Record<number, number> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VISITS_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === 'number'),
    );
  } catch {
    return {};
  }
};
