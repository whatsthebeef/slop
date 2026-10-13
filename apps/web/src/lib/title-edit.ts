import type { EditFailure } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { GlobChanges } from './api';

export type TitleDecision = { kind: 'empty' } | { kind: 'unchanged' } | { kind: 'save'; title: string };

/** What to do with the typed title: refuse an empty one, send nothing when it is unchanged, else save it trimmed. */
export const decideTitle = (current: string, typed: string): TitleDecision => {
  const title = typed.trim();
  if (title === '') return { kind: 'empty' };
  if (title === current) return { kind: 'unchanged' };
  return { kind: 'save', title };
};

/**
 * The title's edit state, used by the glob view's sticky header (a wrapping textarea): begin and cancel,
 * Enter or blur saves, Esc cancels, an empty title is refused, and a refused save keeps the draft and says why.
 * `resetKey` (the glob's ID) ends an edit when the view moves to another glob.
 */
export const useTitleEdit = ({
  title,
  resetKey,
  onUpdate,
  onReload,
}: {
  title: string;
  resetKey: string;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  onReload: () => Promise<void>;
}) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<EditFailure | null>(null);
  const [emptyRefused, setEmptyRefused] = useState(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Set when Esc cancels, so the blur that follows the field unmounting doesn't save.
  const cancelled = useRef(false);

  useEffect(() => {
    setEditing(false);
    setError(null);
    setEmptyRefused(false);
  }, [resetKey]);
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  const begin = () => {
    cancelled.current = false;
    setText(title);
    setError(null);
    setEmptyRefused(false);
    setEditing(true);
  };
  const cancel = () => {
    cancelled.current = true;
    setEditing(false);
    setError(null);
    setEmptyRefused(false);
  };
  const commit = async () => {
    if (saving || cancelled.current) return;
    const decision = decideTitle(title, text);
    if (decision.kind === 'empty') {
      setEmptyRefused(true);
      field.current?.focus();
      return;
    }
    if (decision.kind === 'unchanged') {
      setEditing(false);
      return;
    }
    setSaving(true);
    const refused = await onUpdate({ title: decision.title });
    setSaving(false);
    if (refused === null) {
      setEditing(false);
      setError(null);
    } else {
      setError(refused);
    }
  };
  const change = (value: string) => {
    // Titles are one line: a pasted line break becomes a space.
    setText(value.replace(/\s*\n\s*/g, ' '));
    setEmptyRefused(false);
    setError(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.shiftKey) void commit();
    } else if (e.key === 'Escape') {
      // Esc ends the edit and nothing more (the page's own Esc handling must not also run).
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      cancel();
    }
  };
  const reload = async () => {
    await onReload();
    cancel();
  };

  return { editing, text, saving, error, emptyRefused, field, begin, cancel, commit: () => void commit(), change, onKeyDown, reload };
};
