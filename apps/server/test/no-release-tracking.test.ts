import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * slop no longer records what release or integration environments run (environment deploys, containment, presence,
 * roles, production, "deploys known by", the sub default). A static scan keeps that model from creeping back: it reads
 * the source, not behaviour, so it also catches a leftover nobody calls.
 */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SOURCE_DIRS = [join(root, 'packages', 'core', 'src'), join(root, 'apps', 'server', 'src')];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

const REMOVED = [
  'EnvironmentService',
  'environment-service',
  'environment-executors',
  'recordDeploy',
  'recordManualDeploy',
  'recordContainment',
  'EnvironmentDeploy',
  'GlobPresence',
  'environment_deploys',
  'glob_environments',
  'atf_batches',
  'check_environment',
  'EnvironmentRole',
  'ENVIRONMENT_ROLES',
  'ENVIRONMENT_DEPLOY_KNOWN',
  'deployKnown',
  'subDefault',
  'SLOP_FOLLOW_ENVIRONMENT',
  'report-deploy',
];

// `.role`, `.production` and friends read off something named like an environment (a member's `.role` is fine).
const ENVIRONMENT_FIELD = /\b(?:env\w*|e)\??\.(?:role|production|deployKnown|subDefault)\b/i;

describe('release tracking is gone', () => {
  const files = SOURCE_DIRS.flatMap(sourceFiles).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('scans the source trees', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('mentions none of the removed identifiers', () => {
    const found = files.flatMap(({ path, text }) => REMOVED.filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)).map((name) => `${path.slice(root.length + 1)}: ${name}`));
    expect(found).toEqual([]);
  });

  it("reads no environment's role, production flag, deploy source or sub default", () => {
    const found = files.flatMap(({ path, text }) =>
      text
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => ENVIRONMENT_FIELD.test(line))
        .map(({ line, n }) => `${path.slice(root.length + 1)}:${String(n)}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });
});
