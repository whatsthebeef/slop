import { SOURCE_LABELS } from '@slop/core';
import type { AuthorityTier, ContextSettingChange, DecisionSourceKind, SourceType } from '@slop/core';

/** A share (0 to 1) as a whole percent; a share under one percent says so rather than showing 0%. */
export const percentText = (share: number): string => {
  if (!(share > 0)) return '0%';
  const percent = share * 100;
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`;
};

/** A source type as people read it (the citation label). */
export const sourceTypeText = (source: SourceType): string => SOURCE_LABELS[source];

export const TIER_TEXT: Readonly<Record<AuthorityTier, string>> = {
  merged_code: 'Merged code and implementation records',
  decision: 'Current choices',
  approved_plan: 'Plans and approved knowledge',
  discussion: 'Pasted discussion',
  legacy: 'Legacy',
};

export const CHOICE_SOURCE_TEXT: Readonly<Record<DecisionSourceKind, string>> = {
  implementation_plan: 'Implementation record',
  plan: 'Plan',
  attachment: 'Attachment',
  kb_item: 'Knowledge item',
  inbox: 'Pasted discussion',
};

/** A setting's number with its unit (`90 days`, `0.6`, `6,000 characters`). */
export const settingValueText = (value: number, unit: string): string => {
  const shown = Number.isInteger(value) ? value.toLocaleString('en') : String(Math.round(value * 1000) / 1000);
  return unit === 'days' || unit === 'characters' ? `${shown} ${unit}` : shown;
};

/** One history row's move: `0.6 → 0.55`, a reset says so. */
export const changeText = (change: Pick<ContextSettingChange, 'before' | 'after' | 'outcome'>, unit: string): string =>
  `${settingValueText(change.before, unit)} → ${settingValueText(change.after, unit)}${change.outcome === 'reset' ? ' (reset)' : ''}`;
