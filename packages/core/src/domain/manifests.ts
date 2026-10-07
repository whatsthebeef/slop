/**
 * Dependency manifests (mined signals: a new library with no conventions yet). Pure parsing of a manifest's
 * text before and after a commit into the dependency names it added; the server fetches the texts.
 */

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|requirements[^/]*\.txt)$/;

export const isManifestPath = (path: string): boolean => MANIFEST.test(path);

const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** package.json: names in the dependency sections, leaving out the workspace's own packages and local paths. */
const packageJson = (content: string): Set<string> => {
  const names = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A manifest that doesn't parse names nothing (the commit may have broken it; CI says so).
    return names;
  }
  if (parsed === null || typeof parsed !== 'object') return names;
  const sections: [string, unknown][] = Object.entries(parsed);
  for (const [section, deps] of sections) {
    if (!PACKAGE_SECTIONS.includes(section) || deps === null || typeof deps !== 'object') continue;
    const entries: [string, unknown][] = Object.entries(deps);
    for (const [name, spec] of entries) {
      if (typeof spec === 'string' && /^(workspace|link|file):/.test(spec)) continue;
      names.add(name);
    }
  }
  return names;
};

/** A requirement's name: up to the first version, extra, marker or URL character, lower case. */
const requirementName = (line: string): string | null => {
  const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1];
  return name === undefined ? null : name.toLowerCase().replace(/_/g, '-');
};

const requirementsTxt = (content: string): Set<string> => {
  const names = new Set<string>();
  for (const raw of content.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (line === '' || line.startsWith('-')) continue;
    const name = requirementName(line);
    if (name !== null) names.add(name);
  }
  return names;
};

/** TOML tables whose keys are dependencies (Cargo, Poetry). */
const DEPENDENCY_TABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies$|^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/;
/** `[dependencies.serde]`-style tables name one dependency each. */
const DEPENDENCY_SUBTABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/;

/** pyproject.toml and Cargo.toml: `[project] dependencies = [...]` (and optional ones), and dependency tables. */
const toml = (content: string): Set<string> => {
  const names = new Set<string>();
  let table = '';
  let inArray = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header?.[1] !== undefined) {
      table = header[1].trim().replace(/"/g, '');
      inArray = false;
      const sub = DEPENDENCY_SUBTABLE.exec(table)?.[1];
      if (sub !== undefined) names.add(sub.toLowerCase());
      continue;
    }
    const inProjectList = table === 'project' || table === 'project.optional-dependencies';
    if (inProjectList && /^[A-Za-z0-9_-]*dependencies\s*=\s*\[/.test(line)) inArray = true;
    if (inArray || (table === 'project.optional-dependencies' && line.includes('['))) {
      for (const match of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        const name = requirementName(match[1] ?? match[2] ?? '');
        if (name !== null) names.add(name);
      }
      if (line.includes(']')) inArray = false;
      continue;
    }
    if (DEPENDENCY_TABLE.test(table)) {
      const key = /^([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
      if (key !== undefined && key !== 'python') names.add(key.toLowerCase());
    }
  }
  return names;
};

/** go.mod: required modules, leaving out indirect ones. */
const goMod = (content: string): Set<string> => {
  const names = new Set<string>();
  let inBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const spec = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
    if (spec === undefined || spec.includes('// indirect')) continue;
    const module = /^(\S+)\s+v\S+/.exec(spec.trim())?.[1];
    if (module !== undefined) names.add(module);
  }
  return names;
};

const dependenciesOf = (path: string, content: string): Set<string> => {
  const file = path.split('/').at(-1) ?? path;
  if (file === 'package.json') return packageJson(content);
  if (file === 'go.mod') return goMod(content);
  if (file === 'pyproject.toml' || file === 'Cargo.toml') return toml(content);
  return requirementsTxt(content);
};

/** The dependency names a commit added to a manifest (`before` is null for a new file), sorted. */
export const addedDependencies = (path: string, before: string | null, after: string | null): string[] => {
  if (!isManifestPath(path) || after === null) return [];
  const had = before === null ? new Set<string>() : dependenciesOf(path, before);
  return [...dependenciesOf(path, after)].filter((name) => !had.has(name)).sort();
};
