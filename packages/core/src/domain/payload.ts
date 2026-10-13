import type { Artifact } from './knowledge.js';

/** A glob's payload: what it is about, as one versioned text. */
export interface Payload {
  readonly version: number;
  readonly content: string;
}

/**
 * The payload is the glob's plan.md (the latest version of the `plan` artifact): the plan for work, the proposal text for
 * a decision. Before any is saved there is none. `artifacts` are the
 * latest version of each artifact, as `listArtifacts` returns them.
 */
export const payloadOf = (artifacts: readonly Pick<Artifact, 'kind' | 'version' | 'content'>[]): Payload | null => {
  const plan = artifacts.find((a) => a.kind === 'plan');
  return plan === undefined ? null : { version: plan.version, content: plan.content };
};
