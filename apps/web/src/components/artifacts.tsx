import type { ArtifactKind } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, FileCheck, FileText, Paperclip } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { ArtifactSummaryView } from '@/lib/api';
import { isInboxLink } from '@/lib/inbox';
import { artifactKey } from '@/lib/live';
import { cn } from '@/lib/utils';
import { MarkdownView } from './markdown-view';

export const ARTIFACT_META: Record<
  ArtifactKind,
  { readonly title: string; readonly icon: LucideIcon }
> = {
  plan: { title: 'plan.md', icon: FileText },
  implementation_plan: { title: 'Implementation record', icon: FileCheck },
  // Legacy rows only: postplans were migrated into the record and writes to the kind land there.
  postplan: { title: 'Postplan (old)', icon: FileCheck },
  local_review: { title: 'Local review', icon: ClipboardCheck },
  attachment: { title: 'Attachment', icon: Paperclip },
};

/** The kinds shown as icons on a card, in this order. */
export const CARD_ARTIFACT_KINDS = [
  'plan',
  'implementation_plan',
  'local_review',
] as const;

export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly label: string;
}

const titleOf = (a: ArtifactRef) =>
  a.kind === 'attachment' ? a.label : ARTIFACT_META[a.kind].title;
const when = (iso: string) => new Date(iso).toLocaleString();
const shortSha = (sha: string) => sha.slice(0, 7);

/** The glob view's artifact list; selecting one shows its content with its version history. */
export const ArtifactsSection = ({
  globId,
  artifacts,
  selected,
  onSelect,
}: {
  globId: string;
  artifacts: readonly ArtifactSummaryView[];
  selected: ArtifactRef | null;
  onSelect: (artifact: ArtifactRef | null) => void;
}) => {
  if (artifacts.length === 0) return null;
  const current =
    selected === null
      ? undefined
      : artifacts.find((a) => a.kind === selected.kind && a.label === selected.label);
  return (
    <div className="grid gap-2" data-testid="artifacts">
      <h3 className="text-xs font-semibold text-muted-foreground">Artifacts</h3>
      <div className="flex flex-wrap gap-1.5">
        {artifacts.map((a) => {
          const Icon = ARTIFACT_META[a.kind].icon;
          const active = current === a;
          return (
            <button
              key={`${a.kind}:${a.label}`}
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-muted',
                active && 'border-foreground bg-muted',
              )}
              aria-pressed={active}
              onClick={() => onSelect(active ? null : { kind: a.kind, label: a.label })}
              data-testid={`artifact-${a.kind}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {titleOf(a)}
              <span className="text-muted-foreground">v{a.version}</span>
            </button>
          );
        })}
      </div>
      {current !== undefined && <ArtifactViewer globId={globId} summary={current} />}
    </div>
  );
};

const ArtifactViewer = ({ globId, summary }: { globId: string; summary: ArtifactSummaryView }) => {
  const versions = useQuery({
    queryKey: artifactKey(globId, summary.kind, summary.label),
    queryFn: () => api.artifactVersions(globId, summary.kind, summary.label),
  });
  // null follows the latest version as new ones arrive.
  const [pinned, setPinned] = useState<number | null>(null);
  useEffect(() => setPinned(null), [globId, summary.kind, summary.label]);

  const list = versions.data ?? [];
  const shown = (pinned === null ? list.at(-1) : list.find((v) => v.version === pinned)) ?? null;
  return (
    <div className="grid gap-2 rounded border p-3" data-testid="artifact-viewer">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{titleOf(summary)}</span>
        {list.length > 1 && (
          <select
            className="rounded border bg-background px-1 py-0.5"
            aria-label="Version"
            value={shown?.version ?? ''}
            onChange={(e) => {
              const version = Number(e.target.value);
              setPinned(version === list.at(-1)?.version ? null : version);
            }}
          >
            {[...list].reverse().map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {when(v.createdAt)}
              </option>
            ))}
          </select>
        )}
        {shown !== null && (
          <span>
            {list.length <= 1 && `v${shown.version} · `}
            {shown.commitSha !== null && (
              <>
                commit <span className="font-mono">{shortSha(shown.commitSha)}</span> ·{' '}
              </>
            )}
            {shown.provenance.by} · {shown.provenance.actor}
            {list.length <= 1 && ` · ${when(shown.createdAt)}`}
          </span>
        )}
      </div>
      {versions.isError ? (
        <p className="text-sm text-red">Could not load this artifact.</p>
      ) : shown === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {shown.link !== null &&
            // A link into slop (an inbox item) opens in place; anything else in a new tab.
            (isInboxLink(shown.link) ? (
              <Link className="text-sm underline" to={shown.link}>
                Open in the inbox
              </Link>
            ) : (
              <a className="text-sm underline" href={shown.link} target="_blank" rel="noreferrer">
                {shown.link}
              </a>
            ))}
          <MarkdownView content={shown.content} />
        </>
      )}
    </div>
  );
};
