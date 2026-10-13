import type { FindingView } from '@slop/core';
import { readSectionOpen, writeSectionOpen } from './section-open';

/** One key for every glob: the viewer's last toggle of the Review findings section. */
const STORAGE_KEY = 'slop.findings-open';

/** Starts expanded only while an in-scope finding is open; collapsed for none, or only suggestions and unrated ones. */
export const defaultFindingsOpen = (findings: readonly Pick<FindingView, 'severity'>[]): boolean => findings.some((f) => f.severity === 'in_scope');

/** The heading's summary, e.g. "2 in scope · 3 suggestions"; empty when nothing is rated yet. */
export const findingsSummary = (findings: readonly Pick<FindingView, 'severity'>[]): string => {
  const inScope = findings.filter((f) => f.severity === 'in_scope').length;
  const suggestions = findings.filter((f) => f.severity === 'suggestion').length;
  return [inScope > 0 ? `${String(inScope)} in scope` : null, suggestions > 0 ? `${String(suggestions)} ${suggestions === 1 ? 'suggestion' : 'suggestions'}` : null]
    .filter((part) => part !== null)
    .join(' · ');
};

export const readFindingsOpen = (): boolean | null => readSectionOpen(STORAGE_KEY);

export const writeFindingsOpen = (open: boolean): void => writeSectionOpen(STORAGE_KEY, open);
