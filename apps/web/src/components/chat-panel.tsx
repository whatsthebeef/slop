import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_QUERY_LENGTH } from '@slop/core';
import { MessageCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { ChatCitation, ChatMessage } from '@/lib/api';
import { stateLabel, unavailableNotice } from '@/lib/chat';
import type { ChatRequest } from '@/lib/chat';
import { Button } from './ui/button';
import { Input, Textarea } from './ui/input';

const day = (iso: string) => iso.slice(0, 10);

/** A citation's link: slop's own paths stay in the app, a code host's https URL opens in a new tab, anything else is plain text. */
const Cite = ({ citation, onNavigate }: { citation: ChatCitation; onNavigate: () => void }) => {
  const { link, title } = citation;
  if (link === null) return <span className='font-medium'>{title}</span>;
  const inApp = link.startsWith('/') && !link.startsWith('//');
  if (!inApp && !link.startsWith('https:')) return <span className='font-medium'>{title}</span>;
  return inApp ? (
    <Link className='font-medium underline' to={link} onClick={onNavigate}>
      {title}
    </Link>
  ) : (
    <a className='font-medium underline' href={link} target='_blank' rel='noreferrer'>
      {title}
    </a>
  );
};

const Citations = ({ citations, onNavigate }: { citations: readonly ChatCitation[]; onNavigate: () => void }) => (
  <ol className='mt-1 grid gap-0.5 border-t pt-1 text-xs text-muted-foreground' aria-label='Sources'>
    {citations.map((c) => {
      const state = stateLabel(c);
      return (
        <li key={`${c.n}:${c.source}:${c.title}:${c.date}`}>
          [{c.n}] {c.sourceLabel}: <Cite citation={c} onNavigate={onNavigate} /> · {day(c.date)}
          {state !== null && <span className={c.status === 'superseded' ? 'ml-1 italic' : 'ml-1'}>({state})</span>}
        </li>
      );
    })}
  </ol>
);

const Message = ({ message, onNavigate }: { message: ChatMessage; onNavigate: () => void }) => (
  <article className={message.role === 'user' ? 'ml-8 rounded-md bg-muted p-2' : 'mr-4 rounded-md border p-2'} data-testid={`chat-${message.role}`}>
    <p className='whitespace-pre-wrap text-sm'>{message.content}</p>
    {message.citations !== null && message.citations.length > 0 && <Citations citations={message.citations} onNavigate={onNavigate} />}
  </article>
);

/**
 * The board chat: a side panel opened from the board header. Each person has their own conversation with the board's
 * records; answers cite their sources, and a decision is marked current or superseded by a newer one. Answer text
 * comes from a model, so it is plain text.
 */
export const ChatPanel = ({
  boardId,
  open,
  onOpenChange,
  request,
}: {
  boardId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question sent from elsewhere (the search box's Ask); the panel asks it once per request. */
  request: ChatRequest | null;
}) => (
  <>
    <Button variant='outline' onClick={() => onOpenChange(!open)} aria-expanded={open} data-testid='chat-toggle'>
      <MessageCircle className='h-4 w-4' aria-hidden />
      Ask
    </Button>
    {open && <ChatSide boardId={boardId} request={request} onClose={() => onOpenChange(false)} />}
  </>
);

const ChatSide = ({ boardId, request, onClose }: { boardId: number; request: ChatRequest | null; onClose: () => void }) => {
  const client = useQueryClient();
  const key = ['chat', boardId];
  const history = useQuery({ queryKey: key, queryFn: () => api.chatHistory(boardId) });
  const [question, setQuestion] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [glob, setGlob] = useState('');
  const [group, setGroup] = useState('');
  const end = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: ({ question: q, history: withHistory }: { question: string; history: boolean }) =>
      api.askChat(boardId, {
        question: q,
        ...(withHistory ? { history: true } : {}),
        ...(glob.trim() === '' ? {} : { glob: glob.trim() }),
        ...(group.trim() === '' ? {} : { group: group.trim() }),
      }),
    onSuccess: (_reply, { question: asked }) => {
      // Clear the box only if it still holds what was asked, so a question typed meanwhile survives.
      setQuestion((current) => (current.trim() === asked ? '' : current));
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearChat(boardId),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
  });

  const messages = history.data ?? [];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, ask.isPending]);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q !== '' && !ask.isPending) ask.mutate({ question: q, history: includeHistory });
  };

  // A question from the search box is asked once, when its request arrives (also on opening the panel).
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (request === null || handled.current === request.id) return;
    handled.current = request.id;
    setIncludeHistory(request.history);
    ask.mutate({ question: request.question, history: request.history });
  }, [request, ask]);
  const notice = ask.error === null ? null : unavailableNotice(ask.error);

  return (
    <aside
      className='fixed top-0 right-0 z-40 flex h-dvh w-[26rem] max-w-full flex-col gap-2 border-l-2 border-foreground/80 bg-card p-3 text-sm shadow-lg'
      aria-label='Board chat'
      data-testid='chat-panel'
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className='flex items-center justify-between gap-2'>
        <h2 className='font-semibold'>Ask this board</h2>
        <div className='flex items-center gap-1'>
          <Button variant='ghost' size='sm' disabled={messages.length === 0 || clear.isPending} onClick={() => clear.mutate()}>
            Clear conversation
          </Button>
          <button className='rounded p-1 hover:bg-muted' aria-label='Close chat' onClick={onClose}>
            <X className='h-4 w-4' />
          </button>
        </div>
      </div>
      <div className='grid min-h-0 flex-1 content-start gap-2 overflow-auto' aria-live='polite'>
        {history.isPending && <p className='text-muted-foreground'>Loading…</p>}
        {history.error !== null && <p className='text-destructive'>{history.error.message}</p>}
        {history.data?.length === 0 && (
          <p className='text-muted-foreground'>Ask why something was decided or built. Answers come only from the board's records, with their sources.</p>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} onNavigate={onClose} />
        ))}
        {ask.isPending && <p className='text-muted-foreground'>Reading the board's records…</p>}
        {notice !== null && <p className='text-destructive' role='alert'>{notice}</p>}
        {ask.error !== null && notice === null && <p className='text-destructive' role='alert'>{ask.error.message}</p>}
        <div ref={end} />
      </div>
      <form className='grid gap-2 border-t pt-2' onSubmit={submit}>
        <Textarea
          aria-label='Your question'
          placeholder='Why did we decide…?'
          value={question}
          maxLength={MAX_QUERY_LENGTH}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
        />
        <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <label className='flex items-center gap-1'>
            <input type='checkbox' checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
            Include history
          </label>
          <Input className='h-7 w-24 text-xs' aria-label='Limit to glob' placeholder='glob id' value={glob} onChange={(e) => setGlob(e.target.value)} />
          <Input className='h-7 w-24 text-xs' aria-label='Limit to group' placeholder='group' value={group} onChange={(e) => setGroup(e.target.value)} />
          <Button type='submit' size='sm' className='ml-auto' disabled={ask.isPending || question.trim() === ''}>
            {ask.isPending ? 'Asking…' : 'Ask'}
          </Button>
        </div>
      </form>
    </aside>
  );
};
