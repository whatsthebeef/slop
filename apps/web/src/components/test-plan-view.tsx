import { useQuery } from '@tanstack/react-query';
import { parseTestPlan } from '@slop/core';
import type { ReactNode } from 'react';
import { isValidElement, useMemo } from 'react';
import type { Components } from 'react-markdown';
import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CollapsibleMarkdown } from '@/components/markdown-view';
import { MachineIcon } from '@/components/actor-icons';
import { api } from '@/lib/api';
import type { ArtifactView, GlobSpecResult } from '@/lib/api';
import { globTestsKey } from '@/lib/live';

/** The skeleton "Write one" starts from: the matrix the investigator and reviewers read, and the block the runner reads. */
export const TEST_PLAN_TEMPLATE = `| Name | Status | Location | Description |
| --- | --- | --- | --- |

\`\`\`atf-specs
specs: []
grep: null
\`\`\`
`;

const STATUS_CLASS: Record<string, string> = {
  passed: 'text-green-700 dark:text-green-300',
  failed: 'text-red',
  skipped: 'text-muted-foreground',
  missing: 'text-amber-800 dark:text-amber-200',
};

/** One planned spec's latest result, or "no result yet" until something reports it. */
export const ResultPill = ({ result }: { result: GlobSpecResult | undefined }) => {
  const status = result?.status ?? null;
  const url = result?.url ?? null;
  const pill = (
    <span
      className={`shrink-0 rounded border px-1.5 text-[0.7rem] ${status === null ? 'text-muted-foreground' : (STATUS_CLASS[status] ?? '')}`}
      data-testid="spec-result"
    >
      {status ?? 'no result yet'}
    </span>
  );
  return url === null ? (
    pill
  ) : (
    <a href={url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
      {pill}
    </a>
  );
};

/** A code block's text: react-markdown hands it over as a string or a list of strings. */
const textOf = (node: ReactNode): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.filter((n): n is string => typeof n === 'string').join('')
      : '';

/** The `atf-specs` block as a list of specs (and the grep), with the validation badge and each spec's result. */
const SpecBlock = ({
  text,
  validation,
  checked,
  results,
}: {
  text: string;
  validation: string | null;
  /** True for a saved version, whose validation note was computed on save (a draft has none to show). */
  checked: boolean;
  results: ReadonlyMap<string, GlobSpecResult>;
}) => {
  const list = parseTestPlan(`\`\`\`atf-specs\n${text}\n\`\`\``).atf;
  return (
    <div
      className="my-2 grid gap-1 rounded border bg-background p-2 text-xs"
      data-testid="atf-specs-list"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">ATF specs</span>
        {checked && (
          <span
            className={`rounded border px-1.5 ${validation === null ? 'text-green-700 dark:text-green-300' : 'border-amber/50 bg-amber/10 text-amber-800 dark:text-amber-200'}`}
            title={validation ?? undefined}
            data-testid="test-plan-badge"
          >
            {validation === null ? 'valid' : 'not fully valid'}
          </span>
        )}
      </div>
      {validation !== null && <p className="text-amber-800 dark:text-amber-200">{validation}</p>}
      {list === null || list.specs.length === 0 ? (
        <p className="text-muted-foreground">No specs listed.</p>
      ) : (
        <ul className="grid gap-0.5">
          {list.specs.map((spec) => (
            <li
              key={spec}
              className="!ml-0 flex items-center justify-between gap-2"
              data-testid="atf-spec"
            >
              <code className="break-all">{spec}</code>
              <ResultPill result={results.get(spec)} />
            </li>
          ))}
        </ul>
      )}
      {list !== null && list.grep !== null && (
        <p>
          grep: <code>{list.grep}</code>
        </p>
      )}
    </div>
  );
};

/** The test plan preview: its matrix as a table and the atf-specs block as a list with results. */
export const TestPlanPreview = ({
  globId,
  content,
  artifact,
  startExpanded,
}: {
  globId: string;
  content: string;
  /** The saved version on screen; null for a draft. */
  artifact: ArtifactView | null;
  startExpanded: boolean;
}) => {
  // Same key family as the tests section, so the live hints refresh it too. A failure is fine: pills say "no result yet".
  const tests = useQuery({
    queryKey: [...globTestsKey(globId), 'view'],
    queryFn: () => api.globTestsView(globId),
  });
  const results = useMemo(
    () => new Map((tests.data?.specs ?? []).map((s) => [s.spec, s])),
    [tests.data],
  );
  const validation = artifact?.provenance.validation ?? null;
  const checked = artifact !== null;
  const components = useMemo<Components>(
    () => ({
      code: ({ className, children, ...rest }) =>
        className?.includes('language-atf-specs') === true ? (
          <SpecBlock
            text={textOf(children).replace(/\n$/, '')}
            validation={validation}
            checked={checked}
            results={results}
          />
        ) : (
          <code className={className} {...rest}>
            {children}
          </code>
        ),
      // The list brings its own box, so the block is not wrapped in the code box.
      pre: ({ children }) =>
        isValidElement(children) && children.type === SpecBlock ? children : <pre>{children}</pre>,
    }),
    [validation, checked, results],
  );
  return (
    <CollapsibleMarkdown content={content} startExpanded={startExpanded} components={components} />
  );
};

/** Before the first test plan: write it, or have the investigator draft it where the glob allows. */
export const TestPlanEmpty = ({
  onWrite,
  canInvestigate,
  busy,
  onInvestigate,
}: {
  onWrite: () => void;
  canInvestigate: boolean;
  busy: boolean;
  onInvestigate: () => void;
}): ReactNode => (
  <div
    className="grid justify-items-start gap-2 rounded bg-muted p-3 text-sm"
    data-testid="test-plan-empty"
  >
    <p className="flex items-center gap-1.5 font-semibold">
      <ClipboardCheck aria-hidden className="h-4 w-4" />
      No test plan yet
    </p>
    <p className="text-xs text-muted-foreground">
      The test plan lists the end-to-end specs this glob adds, adjusts or relies on, so they run
      once it is deployed.
    </p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onWrite}>
        Write one
      </Button>
      {canInvestigate ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={onInvestigate}>
          <MachineIcon decorative />
          Let the investigator draft it
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground" data-testid="test-plan-investigate-hint">
          The investigator drafts it when it investigates the glob (Planning, before it starts), or
          ask your agent to save one with save_test_plan.
        </span>
      )}
    </div>
  </div>
);
