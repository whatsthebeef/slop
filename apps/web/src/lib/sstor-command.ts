import type { Action } from '@slop/core';
import { copyOrSelect } from '@/lib/plan-text';

/** The sstor command that starts the person's own session after Pick up (plain: the click already picked the glob up); null for any other action. */
export const sstorCommand = (action: Action, globId: string): string | null => {
  if (action === 'pick_up' || action === 'take_over') return `sstor --glob ${globId}`;
  return null;
};

/**
 * Starts copying the action's sstor command. Call it synchronously in the click handler, before awaiting the request:
 * browsers refuse clipboard writes once the user gesture has passed. Resolves to the command and whether it was copied,
 * or null when the action has no command.
 */
export const copySstorCommand = (
  action: Action,
  globId: string,
  clipboard: { writeText: (text: string) => Promise<void> } | undefined,
): Promise<{ command: string; copied: boolean }> | null => {
  const command = sstorCommand(action, globId);
  if (command === null) return null;
  return copyOrSelect(command, clipboard, () => undefined).then((copied) => ({ command, copied }));
};

/**
 * The command the conflict box shows: Pick up (take_over) for a viewer who can take the glob over, the plain session command for
 * the implementer (who has no take_over). The by-hand `--resolve` helper is only ever offered under "by hand (advanced)".
 */
export const conflictCommand = (globId: string, canTakeOver: boolean): string =>
  sstorCommand(canTakeOver ? 'take_over' : 'pick_up', globId) ?? `sstor --glob ${globId}`;

/** The by-hand section of the conflict box: the git commands, and `--resolve` marked as the mergetool-only helper. */
export const conflictByHand = (globId: string, branch: string, base: string): string =>
  `git fetch origin ${base} && git checkout ${branch} && git merge origin/${base}\n# resolve the conflicts, commit\ngit push origin ${branch}\n\n# mergetool only, no Claude:\nsstor --glob ${globId} --resolve`;

/** What happens to the run: stopped when active, cancelled when queued, nothing to say otherwise. */
const runClause = (state: string | undefined): string =>
  state === 'queued'
    ? 'The queued run is cancelled; '
    : state === 'active'
      ? "The machine's run is stopped; "
      : '';

/** What the Pick up confirmation says: the title, what happens to the run and the branch, and the command that carries on. */
export const takeOverConfirmation = (glob: {
  id: string;
  branch: string;
  currentRun?: { state: string } | null;
}): { title: string; happens: string; command: string; how: string } => ({
  title: `Pick up ${glob.id} from the machine?`,
  happens: `${runClause(glob.currentRun?.state)}its commits so far stay on the branch ${glob.branch}; the glob becomes yours (you are the implementer).`,
  command: `sstor --glob ${glob.id}`,
  how: "This opens the glob's Claude session on your machine, on the branch, with the plan and the machine's notes.",
});
