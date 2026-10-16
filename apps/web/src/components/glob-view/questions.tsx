import type { OpenQuestion } from '@slop/core';
import { useState } from 'react';
import type { AnswerQuestionInput } from '@/lib/api';
import { blocksReadOnly } from '@/lib/blocking-item';
import { closedQuestionsOf, openQuestionsOf } from '@/lib/questions';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Block } from './block';
import type { GlobViewContext } from './context';

const raisedLine = (q: OpenQuestion): string => `Raised by ${q.raisedBy.kind}${q.raisedBy.actor === null ? '' : ` (${q.raisedBy.actor})`}, ${q.raisedAt.slice(0, 10)}`;

const HOLDS: Readonly<Record<OpenQuestion['blocking'], string>> = {
  start: 'Holds the start',
  merge: 'Holds the merge',
  none: 'Notice only',
};

/** One open question: its options as buttons, a free-text answer, and Dismiss (go ahead as is, with an optional note). One request per click. */
const OpenQuestionRow = ({
  question,
  disabled,
  readOnly,
  onAnswer,
  onDismiss,
}: {
  question: OpenQuestion;
  disabled: boolean;
  /** Planning: the question shows its text with no buttons; the glob's Pick up / Start is the one action. */
  readOnly: boolean;
  onAnswer: (questionId: string, input: AnswerQuestionInput) => Promise<boolean>;
  onDismiss: (questionId: string, note?: string) => Promise<boolean>;
}) => {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [dismissing, setDismissing] = useState(false);
  const [working, setWorking] = useState(false);
  const off = disabled || working;
  const run = async (send: () => Promise<boolean>) => {
    if (working) return;
    setWorking(true);
    const ok = await send();
    setWorking(false);
    if (ok) {
      setText('');
      setNote('');
      setDismissing(false);
    }
  };
  const answer = text.trim();
  return (
    <li className="grid gap-2 rounded border border-edge p-2" data-testid={`question-${question.id}`}>
      <div className="grid gap-0.5">
        <span className="whitespace-pre-wrap break-words font-medium" data-testid="question-text">
          {question.text}
        </span>
        <span className="text-xs text-muted-foreground">
          {raisedLine(question)}. {HOLDS[question.blocking]}.
        </span>
      </div>
      {!readOnly && (question.options ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="question-options">
          {(question.options ?? []).map((option) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              disabled={off}
              onClick={() => void run(() => onAnswer(question.id, { answer: option, option }))}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {!readOnly && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer !== '') void run(() => onAnswer(question.id, { answer }));
          }}
        >
          <Input
            aria-label={`Answer ${question.id}`}
            placeholder="Your answer"
            className="min-w-0 flex-1"
            value={text}
            disabled={off}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" disabled={off || answer === ''}>
            Answer
          </Button>
          <Button type="button" variant="outline" disabled={off} onClick={() => setDismissing((d) => !d)}>
            Dismiss
          </Button>
        </form>
      )}
      {!readOnly && dismissing && (
        <form
          className="flex flex-wrap items-center gap-2"
          data-testid="question-dismiss-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => onDismiss(question.id, note.trim() === '' ? undefined : note.trim()));
          }}
        >
          <Input
            aria-label={`Dismiss note ${question.id}`}
            placeholder="Note (optional)"
            className="min-w-0 flex-1"
            value={note}
            disabled={off}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button type="submit" disabled={off}>
            Go ahead as is
          </Button>
        </form>
      )}
    </li>
  );
};

const closedLine = (q: OpenQuestion): string =>
  q.answer !== undefined
    ? `Answered by ${q.answer.by}, ${q.answer.at.slice(0, 10)}: ${q.answer.text}`
    : `Dismissed by ${q.dismissed?.by ?? 'someone'}, ${(q.dismissed?.at ?? '').slice(0, 10)}: go ahead as is${q.dismissed?.note == null ? '' : `. ${q.dismissed.note}`}`;

/**
 * The Questions section at the top of the glob view: every open question with what a person can do about it, and the answered or
 * dismissed ones folded underneath. Nothing when the glob has none.
 */
export const QuestionsSection = ({
  ctx: { glob, busy },
  onAnswer,
  onDismiss,
}: {
  ctx: GlobViewContext;
  onAnswer: (questionId: string, input: AnswerQuestionInput) => Promise<boolean>;
  onDismiss: (questionId: string, note?: string) => Promise<boolean>;
}) => {
  const open = openQuestionsOf(glob);
  const closed = closedQuestionsOf(glob);
  if (open.length === 0 && closed.length === 0) return null;
  return (
    <div className="grid gap-2" data-testid="questions-section">
      {open.length > 0 && (
        <Block
          tone="person"
          actor="human"
          testId="questions-open"
          title={open.length === 1 ? 'A question needs an answer' : `${String(open.length)} questions need an answer`}
          why={<span className="text-xs text-muted-foreground">Answering saves it in the glob&apos;s Clarifications, so the agents read it.</span>}
        >
          <ul className="grid gap-2">
            {open.map((q) => (
              <OpenQuestionRow key={q.id} question={q} disabled={busy} readOnly={blocksReadOnly(glob)} onAnswer={onAnswer} onDismiss={onDismiss} />
            ))}
          </ul>
        </Block>
      )}
      {closed.length > 0 && (
        <Block tone="info" actor="human" testId="questions-closed" title={`${String(closed.length)} answered`} fold={{ label: 'Show answered questions' }}>
          <ul className="grid gap-2">
            {closed.map((q) => (
              <li key={q.id} className="grid gap-0.5" data-testid={`answered-${q.id}`}>
                <span className="whitespace-pre-wrap break-words font-medium">{q.text}</span>
                <span className="text-xs text-muted-foreground">{closedLine(q)}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
};
