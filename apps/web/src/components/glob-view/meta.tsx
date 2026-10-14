import { HumanIcon, MachineIcon } from '@/components/actor-icons';
import type { GlobViewContext } from './context';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

/** A person's email with the human icon, or "Machine" with the robot head; "—" when nobody. */
const Actor = ({ who, title }: { who: string | null; title?: string }) =>
  who === null ? (
    <>—</>
  ) : who === 'slop' ? (
    <span className="inline-flex items-center gap-1" title={title}>
      <MachineIcon decorative />
      Machine
    </span>
  ) : (
    <span className="inline-flex items-center gap-1">
      <HumanIcon decorative />
      {who}
    </span>
  );

/** Planner, implementer, creation date and merged pull requests (the activity log carries the PR and the runs). */
export const GlobMeta = ({ ctx: { board, glob } }: { ctx: GlobViewContext }) => {
  const machineRun = glob.runs.find(
    (r) => r.generation === glob.generation && r.purpose !== 'investigate',
  );
  const implementer = glob.implementer ?? (machineRun === undefined ? null : 'slop');
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <dt>Planner</dt>
      <dd>
        <Actor who={glob.planner} />
      </dd>
      <dt>Implementer</dt>
      <dd>
        <Actor
          who={implementer}
          title={machineRun === undefined ? undefined : `Routine run by ${machineRun.routineOwner}`}
        />
      </dd>
      <dt>Created</dt>
      <dd>{when(glob.createdAt)}</dd>
      {glob.prs.length > 0 && (
        <>
          <dt>Merged and continued</dt>
          <dd className="flex flex-wrap gap-x-2">
            {glob.prs.map((p) => (
              <span key={p.number} title={`${p.mergeSha.slice(0, 7)} · ${when(p.mergedAt)}`}>
                {board.repo === null ? (
                  `#${p.number}`
                ) : (
                  <a
                    className="underline"
                    href={`https://github.com/${board.repo}/pull/${p.number}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{p.number}
                  </a>
                )}{' '}
                <span className="font-mono">{p.mergeSha.slice(0, 7)}</span>
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
};
