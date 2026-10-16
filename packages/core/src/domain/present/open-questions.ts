import { questionsOf } from '../questions.js';
import type { OpenQuestion } from '../questions.js';
import type { PresentableGlob } from './facts.js';

/** No answer and not dismissed. */
export const isOpen = (q: OpenQuestion): boolean =>
  q.answer === undefined && q.dismissed === undefined;

export const openQuestionsOf = (glob: Pick<PresentableGlob, 'questions'>): OpenQuestion[] =>
  questionsOf(glob).filter(isOpen);

/** Answered or dismissed ones, newest first. */
export const closedQuestionsOf = (glob: Pick<PresentableGlob, 'questions'>): OpenQuestion[] =>
  questionsOf(glob)
    .filter((q) => !isOpen(q))
    .sort((a, b) =>
      (b.answer?.at ?? b.dismissed?.at ?? '').localeCompare(a.answer?.at ?? a.dismissed?.at ?? ''),
    );

/**
 * The open questions that hold the glob right now: a start question holds a glob in Planning (Start now clears it), a merge question
 * holds any glob that is not merged yet. A notice (`none`) holds nothing.
 */
export const holdingQuestionsOf = (
  glob: Pick<PresentableGlob, 'questions' | 'status'>,
): OpenQuestion[] =>
  openQuestionsOf(glob).filter((q) =>
    q.blocking === 'start'
      ? glob.status === 'planning' && q.startOverridden === undefined
      : q.blocking === 'merge' && glob.status !== 'signed_off',
  );

/** True while a start question holds the glob in Planning. */
export const heldByQuestion = (glob: Pick<PresentableGlob, 'questions' | 'status'>): boolean =>
  holdingQuestionsOf(glob).some((q) => q.blocking === 'start');

const clip = (text: string, max = 140): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
};

/** The chip's tooltip: the first open question's text (more are in the glob view). Null with none open. */
export const questionChipTip = (glob: Pick<PresentableGlob, 'questions'>): string | null => {
  const open = openQuestionsOf(glob);
  const [first] = open;
  if (first === undefined) return null;
  return `${clip(first.text)}${open.length > 1 ? ` (+${String(open.length - 1)} more)` : ''}. Opens the questions`;
};

/** What the card's corner says for open questions. */
export const questionText = (count: number): string => (count > 1 ? 'questions' : 'question');
