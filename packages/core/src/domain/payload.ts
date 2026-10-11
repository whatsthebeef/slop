import type { Artifact } from './knowledge.js';
import type { Glob } from './types.js';

/** A glob's payload: what it is about, as one versioned text. */
export interface Payload {
  readonly version: number;
  readonly content: string;
}

/**
 * The payload is the glob's plan.md (the latest version of the `plan` artifact): the plan for work, the proposal text for
 * a decision. Before any is saved it is the summary (version 0), or nothing when that is empty too. `artifacts` are the
 * latest version of each artifact, as `listArtifacts` returns them.
 */
export const payloadOf = (artifacts: readonly Pick<Artifact, 'kind' | 'version' | 'content'>[], glob: Pick<Glob, 'summary'>): Payload | null => {
  const plan = artifacts.find((a) => a.kind === 'plan');
  if (plan !== undefined) return { version: plan.version, content: plan.content };
  return glob.summary.trim() === '' ? null : { version: 0, content: glob.summary };
};
