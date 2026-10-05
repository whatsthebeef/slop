import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders an artifact's markdown. GitHub-flavoured, because local reviews and plans lean on
 * tables. react-markdown doesn't render raw HTML, so artifact content can't inject markup.
 */
export const MarkdownView = ({ content }: { content: string }) => (
  <div
    className="max-h-96 overflow-auto rounded bg-muted p-3 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:text-xs [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_table]:my-2 [&_table]:text-xs [&_td]:border [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_ul]:list-disc"
    data-testid="markdown-view"
  >
    <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
  </div>
);
