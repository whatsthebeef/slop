export function merge3(base: unknown, main: unknown, branch: unknown): unknown;
export function renumber(options: {
  drizzleDir: string;
  testDir: string;
  mainJournal: string;
  readMain: (rel: string) => string | null;
  readOurs: (rel: string) => string | null;
  mv: (from: string, to: string) => void;
  log?: (line: string) => void;
}): { renames: { from: string; to: string }[]; testRefs: string[]; changed: boolean };
export function driftCheck(serverDir: string): { clean: boolean; output: string };
