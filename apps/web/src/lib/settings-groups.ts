import { readSectionOpen, writeSectionOpen } from './section-open';

export const SETTINGS_GROUP_IDS = ['board', 'members', 'environments', 'automation', 'reports', 'system'] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

/** The six groups of the settings page: what a person chooses, then what the server can do. */
export const SETTINGS_GROUPS: Record<SettingsGroupId, { readonly title: string; readonly blurb: string }> = {
  board: { title: 'Board and repository', blurb: 'What this board is called, which repository it works in, and when its working hours count.' },
  members: { title: 'Members and access', blurb: 'Who can use this board, what they may do, and the token an outside script uses.' },
  environments: { title: 'Environments and deploys', blurb: 'Where globs are deployed, how, and how acceptance tests learn what to run.' },
  automation: { title: 'Automation', blurb: 'What slop does on its own: investigating big globs, reviewing changes and approving knowledge.' },
  reports: { title: 'Reports', blurb: 'The time report: how much of each developer\'s time went to R&D.' },
  system: { title: 'System', blurb: 'What the server can do right now. Read-only.' },
};

/** Every group starts open except System, which is read-only status and sits collapsed at the bottom. */
export const defaultGroupOpen = (id: SettingsGroupId): boolean => id !== 'system';

const storageKey = (id: SettingsGroupId): string => `slop.settings-group.${id}`;

/** The viewer's remembered open state of a group (this browser's storage), else the default. */
export const readGroupOpen = (id: SettingsGroupId): boolean => readSectionOpen(storageKey(id)) ?? defaultGroupOpen(id);

export const writeGroupOpen = (id: SettingsGroupId, open: boolean): void => writeSectionOpen(storageKey(id), open);
