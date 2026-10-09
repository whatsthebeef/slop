import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHAT_DONT_KNOW, MAX_QUERY_LENGTH } from '@slop/core';
import { History, Maximize2, Minimize2, Pin, PinOff, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, useNavigate } from 'react-router';
import { api, RequestError } from '@/lib/api';
import type { ChatCitation, ChatMessage, ChatQuestion, GlobView } from '@/lib/api';
import { actionsFor, citedGlobs, globScope, mentionedGlobs, saveLabel, scopeLabel, scopeOf, sourceTone, stateLabel, suggestionsFor, unavailableNotice, withCiteLinks } from '@/lib/chat';
import { globsKey } from '@/lib/live';
import { useCurrentPage } from '@/lib/page-context';
import type { PageContext } from '@/lib/page-context';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';
import { Button } from './ui/button';
import { Textarea } from './ui/input';

const day = (iso: string) => iso.slice(0, 10);

const inAppLink = (link: string | null): link is string => link !== null && link.startsWith('/') && !link.startsWith('//');
const hostLink = (link: string | null): link is string => link !== null && link.startsWith('https:');

/** A citation chip: coloured by the kind of source, struck through when superseded. It opens the source in the main area (a code host's page in a new tab). */
const Chip = ({ citation, onNavigate }: { citation: ChatCitation; onNavigate: () => void }) => {
  const state = stateLabel(citation);
  const label = `${citation.sourceLabel}: ${citation.title} · ${day(citation.date)}${state === null ? '' : ` (${state})`}`;
  const className = cn(
    'mx-0.5 inline-flex min-w-5 items-center justify-center rounded border px-1 align-baseline text-xs font-medium no-underline',
    sourceTone(citation.source),
    (citation.status === 'superseded' || citation.status === 'legacy') && 'line-through opacity-70',
  );
  if (inAppLink(citation.link)) {
    return (
      <Link className={className} to={citation.link} title={label} aria-label={label} data-testid='chat-chip' onClick={onNavigate}>
        {citation.n}
      </Link>
    );
  }
  if (hostLink(citation.link)) {
    return (
      <a className={className} href={citation.link} target='_blank' rel='noreferrer' title={label} aria-label={label} data-testid='chat-chip'>
        {citation.n}
      </a>
    );
  }
  return (
    <span className={className} title={label} data-testid='chat-chip'>
      {citation.n}
    </span>
  );
};

/** The answer as Markdown. `[n]` becomes a chip for its source; the model's own links are shown as plain text, since nothing it writes is trusted to point anywhere. */
const Answer = ({ text, citations, onNavigate }: { text: string; citations: readonly ChatCitation[]; onNavigate: () => void }) => (
  <div className='text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:text-xs [&_td]:border [&_td]:px-1 [&_th]:border [&_th]:px-1 [&_ul]:list-disc'>
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => (url.startsWith('cite:') ? url : defaultUrlTransform(url))}
      components={{
        a: ({ href, children }): ReactNode => {
          const n = href?.startsWith('cite:') === true ? Number(href.slice(5)) : null;
          const citation = n === null ? undefined : citations.find((c) => c.n === n);
          return citation === undefined ? <span>{children}</span> : <Chip citation={citation} onNavigate={onNavigate} />;
        },
      }}
    >
      {withCiteLinks(text, citations)}
    </Markdown>
  </div>
);

/** A compact card for each glob the answer mentions that is on the board. */
const GlobCards = ({ boardId, ids, onNavigate }: { boardId: number; ids: readonly string[]; onNavigate: () => void }) => {
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId), enabled: ids.length > 0 });
  const found = ids.flatMap((id) => globs.data?.find((g) => g.id === id) ?? []);
  if (found.length === 0) return null;
  return (
    <div className='mt-1 flex flex-wrap gap-1' data-testid='chat-glob-cards'>
      {found.map((g: GlobView) => (
        <Link key={g.id} to={`/boards/${String(boardId)}/globs/${g.id}`} onClick={onNavigate} className='max-w-full rounded border bg-background px-2 py-1 text-xs hover:bg-muted'>
          <span className='font-medium'>{g.id}</span> <span className='text-muted-foreground'>{g.status.replace('_', ' ')}</span>
          <span className='block truncate'>{g.title}</span>
        </Link>
      ))}
    </div>
  );
};

const Sources = ({ citations }: { citations: readonly ChatCitation[] }) => (
  <details className='mt-1 text-xs text-muted-foreground'>
    <summary className='cursor-pointer'>Sources ({citations.length})</summary>
    <ol className='mt-1 grid gap-0.5' aria-label='Sources'>
      {citations.map((c) => {
        const state = stateLabel(c);
        return (
          <li key={`${c.n}:${c.source}:${c.title}:${c.date}`}>
            [{c.n}] {c.sourceLabel}: {c.title} · {day(c.date)}
            {state !== null && <span className={c.status === 'superseded' ? 'ml-1 italic' : 'ml-1'}>({state})</span>}
          </li>
        );
      })}
    </ol>
  </details>
);

const Tools = ({ tools }: { tools: readonly string[] }) => (
  <details className='mt-1 text-xs text-muted-foreground' data-testid='chat-tools'>
    <summary className='cursor-pointer'>
      Used {tools.length} {tools.length === 1 ? 'step' : 'steps'}
    </summary>
    <ul className='mt-1 list-disc pl-4'>
      {tools.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  </details>
);

/** The buttons under an answer (`actionsFor` decides which). */
const Actions = ({
  boardId,
  chatId,
  message,
  page,
  answered,
  onNavigate,
}: {
  boardId: number;
  chatId: number;
  message: ChatMessage;
  page: PageContext;
  answered: boolean;
  onNavigate: () => void;
}) => {
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const globs = citedGlobs(message, page);
  const [saved, setSaved] = useState<string | null>(null);
  const actions = actionsFor(message, page, answered);
  const save = useMutation({
    mutationFn: () => api.saveChatAnswer(boardId, chatId, message.id, page.type === 'glob' ? page.id : undefined),
    onSuccess: (r) => {
      setSaved(r.id);
      void client.invalidateQueries({ queryKey: ['kb', boardId] });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not save the answer'),
  });
  const attach = useMutation({
    mutationFn: () => api.attachInbox(boardId, Number(page.id), (message.citations ?? []).flatMap((c) => (c.globId === null ? [] : [c.globId]))),
    onSuccess: () => {
      toast('Attached to the globs this answer cites');
      void client.invalidateQueries({ queryKey: ['inbox', boardId] });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not attach'),
  });
  if (actions.length === 0) return null;
  const firstGlob = globs[0];
  return (
    <div className='mt-1 flex flex-wrap gap-1 border-t pt-1' data-testid='chat-actions'>
      {actions.includes('create_glob') && (
        <Button
          size='sm'
          variant='outline'
          onClick={() => {
            onNavigate();
            void navigate(`/boards/${String(boardId)}`, { state: { createFrom: message.content.slice(0, 1500) } });
          }}
        >
          Create glob
        </Button>
      )}
      {actions.includes('attach') && (
        <Button size='sm' variant='outline' disabled={attach.isPending} onClick={() => attach.mutate()}>
          Attach to cited globs
        </Button>
      )}
      {actions.includes('save') &&
        (saved === null ? (
          <Button size='sm' variant='outline' disabled={save.isPending} onClick={() => save.mutate()}>
            {saveLabel(page)}
          </Button>
        ) : (
          <span className='self-center text-xs text-muted-foreground' role='status'>
            Sent to the proposal queue as {saved}
          </span>
        ))}
      {actions.includes('open_glob') && firstGlob !== undefined && (
        <Button size='sm' variant='outline' onClick={() => { onNavigate(); void navigate(`/boards/${String(boardId)}/globs/${firstGlob}`); }}>
          Open in glob view
        </Button>
      )}
    </div>
  );
};

const Message = ({
  boardId,
  chatId,
  message,
  answered,
  page,
  onNavigate,
}: {
  boardId: number;
  chatId: number;
  message: ChatMessage;
  answered: boolean;
  page: PageContext;
  onNavigate: () => void;
}) => {
  const citations = message.citations ?? [];
  const user = message.role === 'user';
  return (
    <article className={user ? 'ml-8 rounded-md bg-muted p-2' : 'mr-4 rounded-md border p-2'} data-testid={`chat-${message.role}`}>
      {user ? (
        <p className='whitespace-pre-wrap text-sm'>{message.content}</p>
      ) : (
        <>
          <Answer text={message.content} citations={citations} onNavigate={onNavigate} />
          <GlobCards boardId={boardId} ids={mentionedGlobs(message.content)} onNavigate={onNavigate} />
          {citations.length > 0 && <Sources citations={citations} />}
          {message.tools != null && message.tools.length > 0 && <Tools tools={message.tools} />}
          <Actions boardId={boardId} chatId={chatId} message={message} page={page} answered={answered} onNavigate={onNavigate} />
        </>
      )}
    </article>
  );
};

/**
 * The board chat, docked on the right of the app's layout beside the routed page (never a modal, nothing dimmed). Each
 * person has their own conversations with the board's records, listed under History; a scope chip says what the
 * question is about and follows the page (pin it to keep it, or widen it to the whole board). Answers stream in as
 * Markdown with a Stop button, cite their sources as chips and offer actions. Full screen centres the conversation at a
 * reading width; the same button or Esc returns it to the side with the conversation intact.
 */
export const ChatPanel = ({
  boardId,
  fullScreen,
  focusToken,
  chatId,
  onChatChange,
  onClose,
  onFullScreenChange,
}: {
  boardId: number;
  fullScreen: boolean;
  /** Changes each time an opener (icon, `/`, ⌘K) asks for the cursor in the input. */
  focusToken: number;
  /** The open conversation (null: a new one starts with the next question); kept by the shell so closing the panel doesn't lose it. */
  chatId: number | null;
  onChatChange: (chatId: number | null) => void;
  onClose: () => void;
  onFullScreenChange: (fullScreen: boolean) => void;
}) => {
  const client = useQueryClient();
  const page = useCurrentPage();
  const [pinned, setPinned] = useState<PageContext | null>(null);
  const [widened, setWidened] = useState(false);
  const scope = scopeOf(page, pinned, widened);
  const messagesKey = ['chat', boardId, chatId] as const;
  const chats = ['chats', boardId] as const;
  const messages = useQuery({ queryKey: messagesKey, queryFn: () => (chatId === null ? Promise.resolve([]) : api.chatMessages(boardId, chatId)), enabled: chatId !== null });
  const past = useQuery({ queryKey: chats, queryFn: () => api.chats(boardId) });
  const [showPast, setShowPast] = useState(false);
  const [question, setQuestion] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [thinkHarder, setThinkHarder] = useState(false);
  // The question being answered and what has streamed so far; the stored messages replace it once the answer is done.
  const [pending, setPending] = useState<{ question: string; text: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const stop = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, [focusToken]);
  // Closing the panel ends an answer in progress; nothing is stored for it.
  useEffect(() => () => stop.current?.abort(), []);

  const ask = async (text: string) => {
    const q = text.trim();
    if (q === '' || pending !== null) return;
    const controller = new AbortController();
    stop.current = controller;
    setPending({ question: q, text: '' });
    setError(null);
    const body: ChatQuestion = {
      question: q,
      ...(chatId === null ? {} : { chat: chatId }),
      ...(includeHistory ? { history: true } : {}),
      ...(globScope(scope) === undefined ? {} : { glob: globScope(scope) }),
      page: { type: scope.type, ...(scope.id === undefined ? {} : { id: scope.id }) },
      ...(thinkHarder ? { think: true } : {}),
    };
    setQuestion((current) => (current.trim() === q ? '' : current));
    try {
      const reply = await api.askChat(boardId, body, { onText: (piece) => setPending((p) => (p === null ? p : { ...p, text: p.text + piece })), signal: controller.signal });
      client.setQueryData<ChatMessage[]>(['chat', boardId, reply.chat.id], (old) => [...(old ?? []), reply.question, reply.reply]);
      onChatChange(reply.chat.id);
      void client.invalidateQueries({ queryKey: chats });
    } catch (e) {
      // Stopping is the person's choice, not a failure: the question goes back in the box.
      if (controller.signal.aborted) setQuestion((current) => (current.trim() === '' ? q : current));
      else setError(e);
    } finally {
      setPending(null);
      setThinkHarder(false);
      stop.current = null;
    }
  };
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteChat(boardId, id),
    onSuccess: (_r, id) => {
      if (id === chatId) onChatChange(null);
      void client.invalidateQueries({ queryKey: chats });
    },
  });

  const shown = messages.data ?? [];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, pending?.text]);

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    void ask(question);
  };
  const notice = error === null ? null : unavailableNotice(error);
  // Following a citation shows its source in the main area; in full screen that also brings the chat back to the side.
  const followed = () => onFullScreenChange(false);
  const newChat = () => {
    stop.current?.abort();
    onChatChange(null);
    setShowPast(false);
    setError(null);
  };

  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col border-l-2 border-foreground/80 bg-card p-3 text-sm',
        fullScreen ? 'flex-1' : 'w-[30rem] max-w-[85vw] shrink-0',
      )}
      aria-label='Board chat'
      data-testid='chat-panel'
      data-fullscreen={fullScreen}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        if (fullScreen) onFullScreenChange(false);
        else onClose();
      }}
    >
      <div className={cn('mx-auto flex min-h-0 w-full flex-1 flex-col gap-2', fullScreen && 'max-w-3xl')}>
        <div className='flex items-center justify-between gap-2'>
          <h2 className='font-semibold'>Ask this board</h2>
          <div className='flex items-center gap-1'>
            <Button variant='ghost' size='sm' disabled={chatId === null && pending === null} onClick={newChat}>
              <Plus className='h-4 w-4' aria-hidden />
              New chat
            </Button>
            <button className='rounded p-1 hover:bg-muted' aria-label='Past conversations' aria-pressed={showPast} title='Past conversations' onClick={() => setShowPast((v) => !v)}>
              <History className='h-4 w-4' />
            </button>
            <button
              className='rounded p-1 hover:bg-muted'
              aria-label={fullScreen ? 'Back to the side panel' : 'Full screen'}
              aria-pressed={fullScreen}
              data-testid='chat-fullscreen'
              onClick={() => onFullScreenChange(!fullScreen)}
            >
              {fullScreen ? <Minimize2 className='h-4 w-4' /> : <Maximize2 className='h-4 w-4' />}
            </button>
            <button className='rounded p-1 hover:bg-muted' aria-label='Close chat' onClick={onClose}>
              <X className='h-4 w-4' />
            </button>
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-1 text-xs' data-testid='chat-scope'>
          <span className='rounded-full border px-2 py-0.5' data-testid='chat-scope-chip'>
            {scopeLabel(scope)}
          </span>
          {scope.type !== 'board' && (
            <button
              className='rounded p-1 hover:bg-muted'
              aria-label={pinned === null ? 'Pin the scope' : 'Unpin the scope'}
              aria-pressed={pinned !== null}
              title={pinned === null ? 'Keep this scope when you move to another page' : 'Follow the page again'}
              onClick={() => setPinned(pinned === null ? scope : null)}
            >
              {pinned === null ? <Pin className='h-3.5 w-3.5' /> : <PinOff className='h-3.5 w-3.5' />}
            </button>
          )}
          {(scope.type !== 'board' || widened) && (
            <button className='rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted' aria-pressed={widened} onClick={() => setWidened((v) => !v)}>
              {widened ? `Back to ${scopeLabel(pinned ?? page)}` : 'Whole board'}
            </button>
          )}
        </div>
        {showPast && (
          <ul className='max-h-40 overflow-auto rounded border p-1 text-xs' aria-label='Past conversations'>
            {past.data?.length === 0 && <li className='p-1 text-muted-foreground'>No earlier conversations.</li>}
            {past.data?.map((c) => (
              <li key={c.id} className='flex items-center gap-1'>
                <button
                  className={cn('min-w-0 flex-1 truncate rounded p-1 text-left hover:bg-muted', c.id === chatId && 'font-medium')}
                  onClick={() => {
                    onChatChange(c.id);
                    setShowPast(false);
                  }}
                >
                  {c.title} <span className='text-muted-foreground'>· {day(c.updatedAt)}</span>
                </button>
                <button className='rounded p-1 hover:bg-muted' aria-label={`Delete ${c.title}`} onClick={() => remove.mutate(c.id)}>
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className='grid min-h-0 flex-1 content-start gap-2 overflow-auto' aria-live='polite'>
          {messages.isPending && chatId !== null && <p className='text-muted-foreground'>Loading…</p>}
          {messages.error !== null && <p className='text-destructive'>{messages.error.message}</p>}
          {(chatId === null || shown.length === 0) && pending === null && (
            <div className='grid gap-2'>
              <p className='text-muted-foreground'>Ask why something was decided or built. Answers come only from the board's records, with their sources.</p>
              <div className='flex flex-wrap gap-1' data-testid='chat-suggestions'>
                {suggestionsFor(scope).map((s) => (
                  <button key={s} className='rounded-full border px-2 py-1 text-xs hover:bg-muted' onClick={() => void ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chatId !== null &&
            shown.map((m) => <Message key={m.id} boardId={boardId} chatId={chatId} message={m} answered={m.content !== CHAT_DONT_KNOW} page={scope} onNavigate={followed} />)}
          {pending !== null && (
            <>
              <article className='ml-8 rounded-md bg-muted p-2' data-testid='chat-user'>
                <p className='whitespace-pre-wrap text-sm'>{pending.question}</p>
              </article>
              <article className='mr-4 rounded-md border p-2' data-testid='chat-streaming'>
                {pending.text === '' ? <p className='text-muted-foreground'>Reading the board's records…</p> : <Answer text={pending.text} citations={[]} onNavigate={followed} />}
              </article>
            </>
          )}
          {notice !== null && <p className='text-destructive' role='alert'>{notice}</p>}
          {error !== null && notice === null && <p className='text-destructive' role='alert'>{error instanceof Error ? error.message : 'Something went wrong'}</p>}
          <div ref={end} />
        </div>
        <form className='grid gap-2 border-t pt-2' onSubmit={submit}>
          <Textarea
            ref={input}
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
            <label className='flex items-center gap-1' title='Also searches older and superseded material. It is on by itself when a question is about the past.'>
              <input type='checkbox' checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
              Include history
            </label>
            <label className='flex items-center gap-1' title='Answer the next question with the stronger model (slower)'>
              <input type='checkbox' checked={thinkHarder} onChange={(e) => setThinkHarder(e.target.checked)} />
              Think harder
            </label>
            {pending === null ? (
              <Button type='submit' size='sm' className='ml-auto' disabled={question.trim() === ''}>
                Ask
              </Button>
            ) : (
              <Button type='button' size='sm' variant='outline' className='ml-auto' onClick={() => stop.current?.abort()}>
                <Square className='h-3 w-3' aria-hidden />
                Stop
              </Button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
};
