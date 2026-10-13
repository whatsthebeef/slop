import type { Action, EditFailure } from '@slop/core';
import type { BoardView, GlobChanges, GlobView } from '@/lib/api';
import type { GlobTarget } from '@/lib/glob-section';

/** What every section of the glob view gets, instead of a dozen separate props. */
export interface GlobViewContext {
  board: BoardView;
  glob: GlobView;
  /** An action or save is running, or the glob has not moved since one was sent. */
  busy: boolean;
  /** Resolves false when the action failed. `anyway` goes ahead of unmerged prerequisites (Retry). */
  onAction: (action: Action, anyway?: boolean) => Promise<boolean>;
  /** Saves the edits; resolves null when saved, or why the server refused them. */
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  /** Scrolls to a section (or opens an artifact in it). */
  onOpenSection: (target: GlobTarget) => void;
}
