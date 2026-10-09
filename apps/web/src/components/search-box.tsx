import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { SearchHit } from '@slop/core';

const DEBOUNCE_MS = 300;
const MIN_LENGTH = 2;

const day = (iso: string) => iso.slice(0, 10);

/** A citation's link: slop's own paths stay in the app, a code host's https URL opens in a new tab, anything else is plain text. */
const Cite = ({ hit, onNavigate }: { hit: SearchHit; onNavigate: () => void }) => {
  const { link, title } = hit.citation;
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

/**
 * The board's search box: keyword and semantic matches over the board's plans, reviews, knowledge and changes. By
 * default it favours current material; "Include history" ranks everything the board has ever recorded.
 */
export const SearchBox = ({ boardId }: { boardId: number }) => {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const enabled = term.length >= MIN_LENGTH;
  const results = useQuery({
    queryKey: ['search', boardId, term, history],
    queryFn: () => api.searchBoard(boardId, term, history),
    enabled,
  });

  return (
    <div
      className='relative'
      data-testid='search-box'
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <div className='relative'>
        <Search className='pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground' aria-hidden />
        <Input
          type='search'
          className='w-80 max-w-full pl-8'
          placeholder='Search this board'
          aria-label='Search this board'
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && enabled && (
        <div
          className='absolute right-0 z-40 mt-1 grid max-h-[70vh] w-[28rem] max-w-[90vw] gap-2 overflow-auto rounded-md border bg-card p-3 text-sm shadow-lg'
          data-testid='search-results'
        >
          <label className='flex items-center gap-2 text-xs text-muted-foreground'>
            <input type='checkbox' checked={history} onChange={(e) => setHistory(e.target.checked)} />
            Include history
          </label>
          {results.isPending && <p className='text-muted-foreground'>Searching…</p>}
          {results.error !== null && <p className='text-destructive'>{results.error.message}</p>}
          {results.data?.semantic === 'unavailable' && (
            <p className='text-xs text-muted-foreground'>Search by meaning is unavailable right now; showing keyword matches only.</p>
          )}
          {results.data?.hits.length === 0 && <p className='text-muted-foreground'>No matches.</p>}
          {results.data?.hits.map((hit) => (
            <article key={`${hit.itemId}:${hit.header}:${hit.text.length}`} className='grid gap-0.5 border-t pt-2 first:border-t-0 first:pt-0'>
              <p className='flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground'>
                <Cite hit={hit} onNavigate={() => setOpen(false)} />
                <span>{hit.header.replace(/^\[|\]$/g, '')}</span>
                <span>{day(hit.citation.date)}</span>
                {hit.label !== null && <span className='italic'>{hit.label}</span>}
              </p>
              <p className='line-clamp-3 whitespace-pre-wrap'>{hit.text}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
