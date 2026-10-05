import type { Action, ArtifactSummary, DomainError, Glob, Role } from '@slop/core';
import { listOf, machine } from '@slop/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The glob as clients see it: the stored document plus derived fields, and its artifact
 * summaries where the caller read them (they live in the artifacts table, not on the glob).
 */
export const globView = (
  glob: Glob,
  allowedActions: readonly Action[] | null = null,
  artifacts: readonly ArtifactSummary[] | null = null,
) => ({
  ...glob,
  list: listOf(glob.status),
  branch: glob.id,
  currentRun: machine.currentRun(glob),
  ...(allowedActions === null ? {} : { allowedActions }),
  ...(artifacts === null ? {} : { artifacts: artifacts.map(artifactView) }),
});

/** An artifact summary on a glob view (the glob ID is implied). */
const artifactView = ({ kind, label, version, versions, commitSha, createdAt, by, actor }: ArtifactSummary) => ({
  kind,
  label,
  version,
  versions,
  commitSha,
  createdAt,
  by,
  actor,
});

export const globViewFor = (glob: Glob, email: string, role: Role, artifacts: readonly ArtifactSummary[] | null = null) =>
  globView(
    glob,
    machine.allowedActions(glob, { email, role }, { postplanSha: machine.postplanShaOf(artifacts ?? []) }),
    artifacts,
  );

export const statusOf = (error: DomainError): ContentfulStatusCode => {
  switch (error.code) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'version_conflict':
    case 'invalid_transition':
    case 'run_active':
      return 409;
    case 'invalid_combination':
    case 'invalid_input':
      return 422;
  }
};

export const errorBody = (error: DomainError) =>
  error.code === 'version_conflict' && 'current' in error ? { ...error, current: globView(error.current) } : error;

const SIGNED_OFF_VISIBLE_MS = 14 * 86_400_000;

/** Signed-off globs drop off the board after two weeks (computed on display). */
export const onBoard = (glob: Glob, now: number): boolean =>
  glob.status !== 'signed_off' ||
  glob.signedOffAt === null ||
  now - Date.parse(glob.signedOffAt) < SIGNED_OFF_VISIBLE_MS;
