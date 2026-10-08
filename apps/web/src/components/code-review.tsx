import type { CodeReviewComment } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { globCodeReviewKey } from '@/lib/live';

const when = (iso: string) => new Date(iso).toLocaleString();

const where = (c: CodeReviewComment) => (c.path === null ? null : c.line === null ? c.path : `${c.path}:${c.line}`);

/** One stored item, collapsed to its first line: CodeRabbit's text is shown as plain text, never as markdown or HTML. */
const Item = ({ item, title }: { item: CodeReviewComment; title: string }) => (
  <li className='grid gap-1' data-testid={`code-review-${item.kind}`}>
    <details>
      <summary className='flex cursor-pointer flex-wrap gap-x-2 font-mono text-[11px]'>
        <span>{title}</span>
        <span className='text-muted-foreground'>{when(item.updatedAt)}</span>
        {item.url !== null && (
          <a className='underline' href={item.url} target='_blank' rel='noreferrer' onClick={(e) => e.stopPropagation()}>
            open
          </a>
        )}
      </summary>
      <pre className='mt-1 max-h-72 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap'>{item.body === '' ? '(no text)' : item.body}</pre>
    </details>
  </li>
);

/**
 * The glob view's CodeRabbit section: its summary, reviews and inline comments on the PR, as CodeRabbit wrote them. They
 * live beside the glob: `glob.reviews` hints and reconnects refresh them. Hidden until CodeRabbit has posted something.
 */
export const CodeReviewSection = ({ globId }: { globId: string }) => {
  const query = useQuery({ queryKey: globCodeReviewKey(globId), queryFn: () => api.globCodeReview(globId) });
  const review = query.data;
  if (review?.badge == null) return null;
  return (
    <section className='grid gap-2' aria-label='CodeRabbit' data-testid='code-review'>
      <h3 className='flex flex-wrap gap-x-2 text-xs font-semibold text-muted-foreground'>
        <span>CodeRabbit</span>
        <span className='font-normal'>
          {review.badge.count} inline comment{review.badge.count === 1 ? '' : 's'}
        </span>
        {review.badge.url !== null && (
          <a className='font-normal underline' href={review.badge.url} target='_blank' rel='noreferrer'>
            open the review on GitHub
          </a>
        )}
      </h3>
      <ul className='grid gap-1'>
        {review.summary !== null && <Item item={review.summary} title='Summary' />}
        {review.reviews.map((r) => (
          <Item key={r.externalId} item={r} title={`Review${r.commitSha === null ? '' : ` at ${r.commitSha.slice(0, 7)}`}`} />
        ))}
        {review.inline.map((c) => (
          <Item key={c.externalId} item={c} title={where(c) ?? 'Inline comment'} />
        ))}
        {review.comments.map((c) => (
          <Item key={c.externalId} item={c} title='Comment' />
        ))}
      </ul>
    </section>
  );
};
