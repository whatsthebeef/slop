import { MarkdownView } from './markdown-view';

/** A human step's detail (Markdown: Why / Do this / Check it worked), shown expanded under the step's title; code blocks have a copy button. */
export const StepDetail = ({ detail }: { detail: string }) => (
  <div className='min-w-0 break-words [overflow-wrap:anywhere]' data-testid='step-detail'>
    <MarkdownView content={detail} bare commands />
  </div>
);
