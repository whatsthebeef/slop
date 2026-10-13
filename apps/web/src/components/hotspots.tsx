import type { Hotspot } from '@slop/core';
import { useQuery } from '@tanstack/react-query';
import { JobStatus } from '@/components/job-status';
import { api } from '@/lib/api';
import { useLiveKnowledge } from '@/lib/live';

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** One hotspot's numbers in a line: conflicts, globs, merges and size (a number the code host couldn't give is left out). */
export const hotspotLine = (h: Hotspot): string =>
  [
    plural(h.conflicts, 'conflict', 'conflicts'),
    plural(h.globs.length, 'glob', 'globs'),
    ...(h.real > 0 ? [`${h.real} real`] : []),
    ...(h.merges === null ? [] : [plural(h.merges, 'merge', 'merges')]),
    ...(h.lines === null ? [] : [plural(h.lines, 'line', 'lines')]),
  ].join(' · ');

/** The files that keep conflicting on the board inside the window, hottest first, and the hourly job that finds them. */
export const Hotspots = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  useLiveKnowledge(boardId);
  const view = useQuery({ queryKey: ['hotspots', boardId], queryFn: () => api.hotspots(boardId) });
  return (
    <section className="grid gap-2" data-testid="hotspots">
      <h2 className="text-sm font-semibold">Conflict hotspots</h2>
      <p className="text-xs text-muted-foreground">
        Files that keep conflicting: at least 3 different globs, or 2 real (not purely additive)
        conflicts, in the last {view.data?.windowDays ?? 7} days. A file stops being listed when its
        window is quiet.
      </p>
      <JobStatus boardId={boardId} admin={admin} job="hotspots" />
      {view.data === undefined ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : view.data.hotspots.length === 0 ? (
        <p className="text-xs text-muted-foreground">No file is a hotspot.</p>
      ) : (
        <ul className="grid gap-1 text-xs">
          {view.data.hotspots.map((h) => (
            <li key={h.path} className="flex flex-wrap gap-x-2">
              <code>{h.path}</code>
              <span className="text-muted-foreground">{hotspotLine(h)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
