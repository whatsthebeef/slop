import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { explodeCommands } from '@/lib/command-text';
import { copyOrSelect } from '@/lib/plan-text';
import { Button } from './ui/button';
import { barClass, barLabel, boxClass, COLLAPSED_REM, FADE_STYLE, needsCollapse } from '@/lib/collapsible';

/** The text of a code block's children: react-markdown hands `pre` a `code` element with the block as its string. */
const textOf = (node: ReactNode): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
};

/** A fenced code block with a Copy button (the code only, without the trailing newline). */
export const CodeBlock = ({ children }: { children?: ReactNode }) => {
  const [copied, setCopied] = useState(false);
  const code = textOf(children).replace(/\n$/, '');
  return (
    <div className="relative" data-testid="step-code">
      <pre>{children}</pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute right-1 top-1"
        data-testid="step-code-copy"
        onClick={() => void copyOrSelect(code, typeof navigator === 'undefined' ? undefined : navigator.clipboard, () => undefined).then(setCopied)}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
};

/** Every markdown view's default: code blocks get a copy button. */
const COPY_COMPONENTS: Components = { pre: ({ children }) => <CodeBlock>{children}</CodeBlock> };

/** What may appear inside a sentence: phrasing elements only, so a block (a fence, a list, a heading) can't nest in a `<p>` or `<span>`; its text stays. */
const INLINE_ELEMENTS = ['p', 'strong', 'em', 'del', 'code', 'a', 'br'];

/**
 * Markdown inside a sentence or a one-line slot (a dismissal reason, a note): paragraphs become spans so they
 * sit inline, and blocks (fences, lists, headings) are flattened to their text.
 */
export const InlineMarkdown = ({ text, className }: { text: string; className?: string }) => (
  <span className={className} data-testid="inline-markdown">
    <Markdown
      remarkPlugins={[remarkGfm]}
      allowedElements={INLINE_ELEMENTS}
      unwrapDisallowed
      components={{ p: ({ children }) => <span>{children}</span> }}
    >
      {text}
    </Markdown>
  </span>
);

/**
 * Renders an artifact's markdown. GitHub-flavoured, because local reviews and plans lean on
 * tables. react-markdown doesn't render raw HTML, so artifact content can't inject markup.
 */
/** `components` swaps how chosen elements render (the test plan draws its `atf-specs` block as a list). */
export const MarkdownView = ({
  content,
  bare = false,
  components,
  commands = false,
}: {
  content: string;
  bare?: boolean;
  components?: Components;
  /** Human-step text: each inline shell command (`bash …`, `git …`) is lifted out of its sentence into its own copyable box. */
  commands?: boolean;
}) => (
  <div
    className={`${bare ? '' : 'rounded bg-muted p-3 '}text-sm leading-relaxed [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:text-xs [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-xs [&_td]:border [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_ul]:list-disc`}
    data-testid="markdown-view"
  >
    <Markdown remarkPlugins={[remarkGfm]} components={{ ...COPY_COMPONENTS, ...components }}>
      {commands ? explodeCommands(content) : content}
    </Markdown>
  </div>
);

/**
 * MarkdownView for long documents: clipped to about 24rem with a light fade on the last line, and a full-width "Show more ▾" bar joined to the
 * bottom of the box ("Show less ▴" once expanded). Short documents show no bar. `startExpanded` opens it expanded
 * (a deep link); the state is per view.
 */
export const CollapsibleMarkdown = ({
  content,
  startExpanded = false,
  components,
  commands = false,
}: {
  content: string;
  startExpanded?: boolean;
  components?: Components;
  commands?: boolean;
}) => {
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
      <div className={boxClass(long, clipped)}>
        <div style={clipped ? { maxHeight: `${String(COLLAPSED_REM)}rem`, overflow: 'hidden', ...FADE_STYLE } : undefined} data-testid="markdown-fade">
          <div ref={natural}>
            <MarkdownView content={content} bare components={components} commands={commands} />
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
