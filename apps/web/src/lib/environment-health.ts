import type { BoardEnvironment } from '@slop/core';

/** The command line a pipeline adds to report its deploys to slop. */
export const reportDeployLine = (environment: string): string => `.sstor/report-deploy.sh ${environment}`;

/**
 * One line on an observed environment's health: what was last seen and who told slop. A pipeline environment that has
 * never reported says so, with the line to add; a manual one says it waits for someone to record a release.
 */
export const environmentHealth = (env: BoardEnvironment): string => {
  const latest = env.latest;
  if (latest === null) {
    return env.deployKnown === 'manual'
      ? 'No deploy recorded yet. Record each release here.'
      : `No deploy reported yet. Add ${reportDeployLine(env.environment)} to its pipeline.`;
  }
  const what = `${latest.sha.slice(0, 7)}${latest.ref === null ? '' : ` (${latest.ref})`}`;
  const who = env.recordedBy === null ? '' : ` recorded by ${env.recordedBy}`;
  return `Last deploy ${what}${who} at ${new Date(latest.at).toLocaleString()}`;
};
