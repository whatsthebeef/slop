import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { WRAP_LONG } from '@/lib/chat';
import { cn } from '@/lib/utils';

/** The board's 👎 answers, newest first: each is a test case for the chat (admins only). */
export const ChatTestCases = ({ boardId }: { boardId: number }) => {
  const cases = useQuery({ queryKey: ['chat-test-cases', boardId], queryFn: () => api.chatTestCases(boardId) });
  return (
    <section className='grid gap-2' data-testid='chat-test-cases'>
      <h2 className='text-sm font-semibold'>Chat answers rated 👎</h2>
      <p className='text-xs text-muted-foreground'>Each one is kept with its question, so later changes to the chat can be checked against it.</p>
      {cases.isPending && <p className='text-sm text-muted-foreground'>Loading…</p>}
      {cases.error !== null && <p className='text-sm text-destructive'>{cases.error.message}</p>}
      {cases.data?.length === 0 && <p className='text-sm text-muted-foreground'>None yet.</p>}
      <ul className='grid gap-2'>
        {cases.data?.map((c) => (
          <li key={c.id} className={cn(WRAP_LONG, 'rounded border p-2 text-sm')}>
            <p className='font-medium'>{c.question}</p>
            {c.note !== null && <p className='text-xs'>Wrong: {c.note}</p>}
            <details className='text-xs text-muted-foreground'>
              <summary className='cursor-pointer'>
                {c.email} · {c.createdAt.slice(0, 10)}
                {c.tools.length > 0 ? ` · ${String(c.tools.length)} ${c.tools.length === 1 ? 'step' : 'steps'}` : ''}
              </summary>
              <p className='mt-1 whitespace-pre-wrap'>{c.answer}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
};
