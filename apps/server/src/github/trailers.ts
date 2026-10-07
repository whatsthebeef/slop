/** `Slop-Agent-Set: <v>` (or `v<v>`): the board's agent-set version the commit was made with (catalog orchestrator and finalise). */
const SLOP_AGENT_SET = /^Slop-Agent-Set:\s*v?(\d{1,9})\s*$/m;

/** The agent-set version a commit message's trailer names, or null when it has none. */
export const agentSetTrailer = (message: string | null | undefined): number | null => {
  const version = SLOP_AGENT_SET.exec(message ?? '')?.[1];
  return version === undefined ? null : Number(version);
};
