import type { DecisionView } from '@slop/core';
import { readSectionOpen, writeSectionOpen } from './section-open';

/** One key for every glob: the viewer's last toggle of the Choices section. */
const STORAGE_KEY = 'slop.choices-open';
/** At most this many choices start expanded. */
export const MAX_OPEN_CHOICES = 3;

/** Choices with a replacement the model proposed but could not verify: this one's, or one it would replace. */
export const hintCount = (decisions: DecisionView[]): number =>
  decisions.filter((d) => d.replacedBy?.state === 'hint' || d.replaces.some((r) => r.state === 'hint')).length;

/** Starts expanded for a few choices; collapsed for more, or when any replacement is waiting on review. */
export const defaultOpen = (decisions: DecisionView[]): boolean => decisions.length <= MAX_OPEN_CHOICES && hintCount(decisions) === 0;

/** The viewer's remembered choice, or null when nothing usable is stored (or storage is unavailable). */
export const readChoicesOpen = (): boolean | null => readSectionOpen(STORAGE_KEY);

export const writeChoicesOpen = (open: boolean): void => writeSectionOpen(STORAGE_KEY, open);
