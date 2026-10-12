import { parseInvestigation } from '@slop/core';
import type { ArtifactKind, Investigation } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, FileCheck, FileText, Microscope, Paperclip, SearchCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, RequestError } from '@/lib/api';
import type { ArtifactSummaryView } from '@/lib/api';
import { inboxLinkTarget, isInboxLink } from '@/lib/inbox';
import { artifactKey, globsKey, inboxKey } from '@/lib/live';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';
import { Button } from './ui/button';
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
  independent_review: { title: 'Independent review', icon: SearchCheck },
  investigation: { title: 'Investigation', icon: Microscope },
  assessment: { title: 'Assessment', icon: ClipboardCheck },
  // A KB learning's pipeline output (JSON), shown by the decision section rather than as files.
  draft: { title: 'Draft', icon: FileText },
  outcome: { title: 'Outcome', icon: FileCheck },
  effect_check: { title: 'Effect check', icon: SearchCheck },
  attachment: { title: 'Attachment', icon: Paperclip },
};

/** The kinds shown as icons on a card, in this order. */
export const CARD_ARTIFACT_KINDS = [
  'plan',
  'implementation_plan',
  'local_review',
  'assessment',
  'independent_review',
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

/** Detach for the "From the inbox" attachment: confirms, then removes the item from this glob. */
const DetachInboxItem = ({ globId, link, label }: { globId: string; link: string; label: string }) => {
  const client = useQueryClient();
  const toast = useToast();
  const target = inboxLinkTarget(link);
  const detach = useMutation({
    mutationFn: () => {
      if (target === null) throw new Error('Not an inbox link');
      return api.detachInbox(target.boardId, target.itemId, [globId]);
    },
    onSuccess: () => {
      if (target !== null) void client.invalidateQueries({ queryKey: inboxKey(target.boardId) });
      void client.invalidateQueries({ queryKey: globsKey(target?.boardId ?? 0) });
      toast('Detached');
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Something went wrong'),
  });
  if (target === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="w-fit"
      disabled={detach.isPending}
      onClick={() => {
        if (window.confirm(`Detach "${label.replace(/^From the inbox: /, '')}" from ${globId}? It leaves this glob's context and choices.`))
          detach.mutate();
      }}
    >
      Detach
    </Button>
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
              <div className="flex flex-wrap items-center gap-3">
                <Link className="text-sm underline" to={shown.link}>
                  Open in the inbox
                </Link>
                <DetachInboxItem globId={globId} link={shown.link} label={shown.label} />
              </div>
            ) : (
              <a className="text-sm underline" href={shown.link} target="_blank" rel="noreferrer">
                {shown.link}
              </a>
            ))}
          {shown.kind === 'investigation' && (
            <InvestigationFields content={shown.content} validation={shown.provenance.validation} />
          )}
          <MarkdownView content={shown.content} />
        </>
      )}
    </div>
  );
};

/** The investigation's parsed block as a summary, or the validation note when it could not be read. */
const InvestigationFields = ({ content, validation }: { content: string; validation: string | undefined }) => {
  const parsed = parseInvestigation(content);
  if (!parsed.ok) {
    return (
      <p className="text-sm text-red" data-testid="investigation-invalid">
        {validation ?? parsed.errors.join('; ')}
      </p>
    );
  }
  const i: Investigation = parsed.investigation;
  const rows: [string, string][] = [
    ['Risk', `${i.riskTier}${i.riskAreas.length > 0 ? ` (${i.riskAreas.join(', ')})` : ''}`],
    ['Needs a human', i.needsHuman.needed ? `yes: ${i.needsHuman.reason ?? ''}` : 'no'],
    ['Confidence', i.confidence],
    ['Expected lines', `${String(i.expectedLines.min)}–${String(i.expectedLines.max)}`],
    ['Modules', i.modules.join(', ') || 'none'],
    ['Files', i.files.map((f) => `${f.change} ${f.path}`).join('\n') || 'none'],
    [
      'Parts',
      i.parts.map((p) => `${p.name} (${String(p.files.length)} files${p.needs.length > 0 ? `, needs ${p.needs.join(', ')}` : ''})`).join('\n') ||
        'one',
    ],
    ['Made against', `plan ${i.planHash.slice(0, 8)} · base ${i.baseCommit.slice(0, 7)}`],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="investigation-fields">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
};
