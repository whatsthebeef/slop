import { FINDING_CLASSES } from '@slop/core';
import type { FindingClass, FindingView } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { defaultFindingsOpen, findingsSummary, readFindingsOpen, writeFindingsOpen } from '@/lib/findings-collapse';
import { findingsKey } from '@/lib/live';
import { cn } from '@/lib/utils';
import { SectionToggle } from './section-toggle';

const SEVERITY_TEXT: Record<FindingView['severity'], string> = {
  in_scope: 'in scope',
  suggestion: 'suggestion',
  unknown: 'unrated',
};

const SOURCE_TEXT: Record<FindingView['source'], string> = {
  local_review: 'local review',
};

const where = (f: FindingView) => (f.path === null ? null : f.line === null ? f.path : `${f.path}:${f.line}`);

/** Findings grouped by class in the class list's order; unclassified ones last. */
const grouped = (findings: readonly FindingView[]) => {
  const groups = new Map<FindingClass | null, FindingView[]>();
  for (const f of findings) groups.set(f.class, [...(groups.get(f.class) ?? []), f]);
  return [...groups.entries()].sort(
    ([a], [b]) => (a === null ? FINDING_CLASSES.length : FINDING_CLASSES.indexOf(a)) - (b === null ? FINDING_CLASSES.length : FINDING_CLASSES.indexOf(b)),
  );
};

/**
 * The glob view's review findings: each finding with its severity,
 * location, round, source and commit. Finding text comes from reviews, so it is
 * shown as plain text, never as markdown. Findings live beside the glob: `glob.findings` hints and
 * reconnects refresh them, and a slow poll while any review or finding is still being processed
 * catches up on hints a hidden tab missed. The section collapses to its heading and counts of severity; the viewer's toggle is
 * remembered, until then it starts expanded while an in-scope finding is open, and a `section=findings` link opens it.
 */
export const ReviewFindings = ({ globId, startOpen = false }: { globId: string; startOpen?: boolean }) => {
  const [toggled, setToggled] = useState<boolean | null>(() => (startOpen ? true : readFindingsOpen()));
  const query = useQuery({
    queryKey: findingsKey(globId),
    queryFn: () => api.findings(globId),
    refetchInterval: (q) => {
      const data = q.state.data;
      return data !== undefined && (data.pending > 0 || data.sources.pending > 0) ? 10_000 : false;
    },
  });
  const data = query.data;
  if (data === undefined || (data.findings.length === 0 && data.sources.pending === 0 && data.sources.failed === 0)) return null;
  const busy = data.pending + data.sources.pending;
  const open = toggled ?? defaultFindingsOpen(data.findings);
  const summary = findingsSummary(data.findings);
  const toggle = () => {
    setToggled(!open);
    writeFindingsOpen(!open);
  };

  return (
    <section className='grid gap-2' aria-label='Review findings' data-testid='review-findings'>
      <div className='flex items-center gap-2'>
        <SectionToggle open={open} onToggle={toggle} testId='findings-toggle'>
          Review findings ({data.findings.length})
          {summary !== '' && <span className='font-normal'>{summary}</span>}
        </SectionToggle>
        {busy > 0 && data.waiting === null && (
          <span className='text-xs text-muted-foreground'>
            {data.sources.pending > 0 ? 'Reading reviews…' : `Classifying ${String(data.pending)}…`}
          </span>
        )}
      </div>
      {open && (
        <>
        {data.waiting !== null && (
          <p className='text-xs text-muted-foreground' data-testid='findings-waiting'>
            Waiting: AI unavailable — {data.waiting}. {data.sources.pending > 0 ? 'Reading reviews' : 'Classifying'} resumes once it works again.
          </p>
        )}
        {data.sources.failed > 0 && (
          <p className='text-xs text-red'>
            {data.sources.failed === 1 ? "One review couldn't be split into findings." : `${String(data.sources.failed)} reviews couldn't be split into findings.`}
          </p>
        )}
        <div className='grid gap-2'>
          {grouped(data.findings).map(([cls, items]) => (
            <div key={cls ?? 'unclassified'} className='grid gap-1'>
              <h4 className='text-[11px] font-semibold text-muted-foreground'>{cls ?? 'Not classified yet'}</h4>
              <ul className='grid gap-1'>
                {items.map((f) => (
                  <li key={f.id} className='grid gap-0.5 text-xs' data-testid='finding'>
                    <div className='flex flex-wrap gap-x-2 font-mono text-[11px] text-muted-foreground'>
                      <span className={cn(f.severity === 'in_scope' && 'font-semibold text-foreground')}>{SEVERITY_TEXT[f.severity]}</span>
                      {where(f) !== null && <span>{where(f)}</span>}
                      {f.round !== null && <span>round {f.round}</span>}
                      <span>{SOURCE_TEXT[f.source]}</span>
                      {f.commitSha !== null && <span>{f.commitSha.slice(0, 7)}</span>}
                      {f.state === 'failed' && (
                        <span className='text-red' title={f.error ?? undefined}>
                          couldn't classify
                        </span>
                      )}
                    </div>
                    {/* Third-party text: plain, whitespace kept, never rendered as markdown. */}
                    <p className='whitespace-pre-wrap break-words'>{f.text}</p>
                    {f.classNote !== null && <p className='text-[11px] text-muted-foreground'>{f.classNote}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        </>
      )}
    </section>
  );
};
