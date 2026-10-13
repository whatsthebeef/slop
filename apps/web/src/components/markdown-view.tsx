import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { barClass, barLabel, boxClass, COLLAPSED_REM, FADE_STYLE, needsCollapse } from '@/lib/collapsible';

/**
 * Renders an artifact's markdown. GitHub-flavoured, because local reviews and plans lean on
 * tables. react-markdown doesn't render raw HTML, so artifact content can't inject markup.
 */
export const MarkdownView = ({ content, bare = false }: { content: string; bare?: boolean }) => (
  <div
    className={`${bare ? '' : 'rounded bg-muted p-3 '}text-sm leading-relaxed [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:text-xs [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-xs [&_td]:border [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_ul]:list-disc`}
    data-testid="markdown-view"
  >
    <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
  </div>
);

/**
 * MarkdownView for long documents: clipped to about 24rem with a light fade on the last line, and a full-width "Show more ▾" bar joined to the
 * bottom of the box ("Show less ▴" once expanded). Short documents show no bar. `startExpanded` opens it expanded
 * (a deep link); the state is per view.
 */
export const CollapsibleMarkdown = ({ content, startExpanded = false }: { content: string; startExpanded?: boolean }) => {
  const [expanded, setExpanded] = useState(startExpanded);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const natural = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = natural.current;
    if (el === null) return undefined;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setLong(needsCollapse(el.offsetHeight, rem));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);
  const clipped = long && !expanded;
  return (
    <div ref={box} data-testid="collapsible-markdown">
      <div className={boxClass(long)}>
        <div style={clipped ? { maxHeight: `${String(COLLAPSED_REM)}rem`, overflow: 'hidden', ...FADE_STYLE } : undefined} data-testid="markdown-fade">
          <div ref={natural}>
            <MarkdownView content={content} bare />
          </div>
        </div>
      </div>
      {long && (
        <button
          type="button"
          className={barClass(clipped)}
          aria-expanded={expanded}
          data-testid={expanded ? 'show-less' : 'show-more'}
          onClick={() => {
            if (expanded) box.current?.scrollIntoView({ block: 'nearest' });
            setExpanded(!expanded);
          }}
        >
          {barLabel(expanded)}
          {expanded ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
};
