import type { Notice as PresentedNotice } from '@slop/core';
import { stripMarkdown } from '@slop/core';
import { conflictByHand } from '@/lib/sstor-command';
import type { GlobViewContext } from './context';
import { Link } from './status';

/** Every file behind a conflict or a clash; opened up to ten, then collapsed under its count. */
const Files = ({ files, clash }: { files: readonly string[]; clash: boolean }) => (
  <details data-testid="notice-files" open={files.length <= 10}>
    <summary className="cursor-pointer text-xs text-muted-foreground">
      {clash ? 'Files both globs change' : 'Files changed on both sides'} ({files.length})
    </summary>
    <ul className="font-mono text-xs break-all">
      {files.map((f) => (
        <li key={f}>{f}</li>
      ))}
    </ul>
  </details>
);

/** The by-hand route to resolve a conflict, collapsed. */
const ByHand = ({ globId, branch, base }: { globId: string; branch: string; base: string }) => (
  <details data-testid="conflict-by-hand">
    <summary className="cursor-pointer text-xs text-muted-foreground">
      Resolve by hand instead (advanced)
    </summary>
    <code className="block whitespace-pre-wrap font-mono text-xs">
      {conflictByHand(globId, branch, base)}
    </code>
  </details>
);

/**
 * The one notice beside the primary action: why the last click did not work, or the most important thing wrong with the glob, each
 * said once (a conflict says its files, and the failed checks it explains are not repeated). It has no dismiss: it goes when the
 * next click is sent, or when what it says is fixed, and a new failure replaces it. The words come from `presentGlob`.
 */
export const Notice = ({
  ctx: { glob },
  notice,
}: {
  ctx: GlobViewContext;
  notice: PresentedNotice | null;
}) => {
  if (notice === null) return null;
  const base = glob.conflict?.base ?? glob.failure?.conflict?.base ?? null;
  const byHand = notice.kind === 'conflict' && glob.implementer !== null ? base : null;
  return (
    <div
      role="status"
      className="grid gap-1 rounded border border-destructive/60 bg-destructive/5 p-2 text-sm"
      data-testid="notice"
      data-kind={notice.kind}
      title={notice.detail === null ? undefined : stripMarkdown(notice.detail)}
    >
      <p data-testid="notice-text">
        {stripMarkdown(notice.text)}
        {notice.url !== null && (
          <>
            {' ('}
            <Link href={notice.url}>check run</Link>
            {')'}
          </>
        )}
      </p>
      {notice.files.length > 0 && <Files files={notice.files} clash={notice.kind === 'clash'} />}
      {byHand !== null && <ByHand globId={glob.id} branch={glob.branch} base={byHand} />}
    </div>
  );
};
