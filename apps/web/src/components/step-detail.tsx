import type { Components } from 'react-markdown';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { copyOrSelect } from '@/lib/plan-text';
import { Button } from './ui/button';
import { MarkdownView } from './markdown-view';

/** The text of a code block's children: react-markdown hands `pre` a `code` element with the block as its string. */
const textOf = (node: ReactNode): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'props' in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return '';
};

const CodeBlock = ({ children }: { children?: ReactNode }) => {
  const [copied, setCopied] = useState(false);
  const code = textOf(children).replace(/\n$/, '');
  return (
    <div className='relative' data-testid='step-code'>
      <pre>{children}</pre>
      <Button
        size="sm"
        variant="outline"
        className='absolute right-1 top-1'
        data-testid='step-code-copy'
        onClick={() =>
          void copyOrSelect(
            code,
            typeof navigator === 'undefined' ? undefined : navigator.clipboard,
            () => undefined,
          ).then(setCopied)
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
};

const components: Components = { pre: ({ children }) => <CodeBlock>{children}</CodeBlock> };

/** A human step's detail (Markdown: Why / Do this / Check it worked), shown expanded under the step's title; code blocks have a copy button. */
export const StepDetail = ({ detail }: { detail: string }) => (
  <div className='min-w-0 break-words [overflow-wrap:anywhere]' data-testid='step-detail'>
    <MarkdownView content={detail} bare components={components} />
  </div>
);
