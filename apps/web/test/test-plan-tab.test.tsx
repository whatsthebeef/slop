// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanSection } from '../src/components/glob-view/plan';
import type { GlobViewContext } from '../src/components/glob-view/context';
import type { ArtifactView, BoardView, GlobSpecResult, GlobView } from '../src/lib/api';
import { ToastProvider } from '../src/toast';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };

const view = (patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  id: 's1t1',
  list: 'planning',
  branch: 's1t1',
  currentRun: null,
  ...patch,
});

const PLAN_TEXT = `| Name | Status | Location | Description |
| --- | --- | --- | --- |
| Login works | new | \`tests/features/login.feature\` (to add) | Signs in |

\`\`\`atf-specs
specs:
  - tests/features/login.feature
  - tests/features/logout.feature
grep: "@smoke"
\`\`\`
`;

const artifact = (
  kind: 'plan' | 'test_plan',
  version: number,
  content: string,
  validation?: string,
): ArtifactView => ({
  id: version,
  kind,
  label: '',
  version,
  content,
  link: null,
  commitSha: null,
  createdAt: '2026-10-14T10:00:00Z',
  provenance: { by: 'a@b.c', actor: 'a@b.c', ...(validation === undefined ? {} : { validation }) },
});

/** A fake server for the routes the tab reads and writes; `puts` records the test plan saves. */
interface Server {
  testPlan: ArtifactView[];
  specs: GlobSpecResult[];
  puts: { content: string; version?: number }[];
  /** The next test plan save answers with this error. */
  conflict: boolean;
}

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

const install = (server: Server) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: { method?: string; body?: string | null }) => {
      const method = init?.method ?? 'GET';
      if (path.endsWith('/test-plan') && method === 'GET') {
        const current = server.testPlan.at(-1) ?? null;
        return json(200, {
          current,
          versions: server.testPlan.map((a) => ({
            version: a.version,
            createdAt: a.createdAt,
            by: a.provenance.by,
          })),
        });
      }
      if (path.endsWith('/test-plan') && method === 'PUT') {
        const body = JSON.parse(init?.body ?? '{}') as { content: string; version?: number };
        server.puts.push(body);
        if (server.conflict)
          return json(409, {
            code: 'version_conflict',
            message: 'The test plan is at version 2, not 1: read it again and retry',
          });
        const saved = artifact('test_plan', server.testPlan.length + 1, body.content);
        server.testPlan.push(saved);
        return json(200, saved);
      }
      if (path.includes('/artifacts/test_plan')) return json(200, server.testPlan);
      if (path.endsWith('/plan'))
        return json(200, {
          current: artifact('plan', 1, 'Build the thing.'),
          versions: [{ version: 1, createdAt: '2026-10-14T10:00:00Z', by: 'a@b.c' }],
        });
      if (path.endsWith('/tests')) return json(200, { value: [], specs: server.specs });
      return json(404, { code: 'not_found', message: 'no such route' });
    }),
  );
};

const newServer = (patch: Partial<Server> = {}): Server => ({
  testPlan: [],
  specs: [],
  puts: [],
  conflict: false,
  ...patch,
});

const renderPlan = (glob: GlobView = view({ allowedActions: ['investigate'] })) => {
  const onAction = vi.fn<GlobViewContext['onAction']>(() => Promise.resolve(true));
  const ctx: GlobViewContext = {
    board,
    glob,
    groups: [],
    busy: false,
    onAction,
    onUpdate: () => Promise.resolve(null),
    onOpenSection: () => undefined,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PlanSection ctx={ctx} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onAction, client };
};

const openTestPlan = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: /Test plan/ }));
};

beforeAll(() => {
  for (const [name, value] of [
    ['scrollIntoView', () => undefined],
    ['hasPointerCapture', () => false],
    ['setPointerCapture', () => undefined],
    ['releasePointerCapture', () => undefined],
  ] as const) {
    if (!(name in Element.prototype))
      Object.defineProperty(Element.prototype, name, { value, configurable: true, writable: true });
  }
});

beforeEach(() => {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('plan section tabs', () => {
  it('opens on plan.md and switches to the test plan', async () => {
    install(newServer());
    const user = userEvent.setup();
    renderPlan();
    expect(await screen.findByText('plan.md', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /plan\.md/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await openTestPlan(user);
    expect(await screen.findByText('No test plan yet')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Test plan/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('opens the test plan from the deep link', async () => {
    install(newServer());
    window.history.replaceState(null, '', '/?section=plan&tab=test-plan');
    renderPlan();
    expect(await screen.findByText('No test plan yet')).toBeTruthy();
  });

  it('keeps a decision glob to plan.md only', async () => {
    install(newServer());
    renderPlan(view({ category: 'decision' }));
    expect(await screen.findByText('plan.md', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('test plan: empty state', () => {
  it('offers the investigator when the glob allows investigating, and runs it', async () => {
    install(newServer());
    const user = userEvent.setup();
    const { onAction } = renderPlan();
    await openTestPlan(user);
    await user.click(await screen.findByRole('button', { name: /Let the investigator draft it/ }));
    expect(onAction).toHaveBeenCalledWith('investigate');
  });

  it('shows instruction text instead when investigating is not allowed', async () => {
    install(newServer());
    const user = userEvent.setup();
    renderPlan(view({ allowedActions: ['start'] }));
    await openTestPlan(user);
    expect(await screen.findByTestId('test-plan-investigate-hint')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Let the investigator draft it/ })).toBeNull();
  });

  it('writes one from the template and saves it as the first version', async () => {
    const server = newServer();
    install(server);
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    await user.click(await screen.findByRole('button', { name: 'Write one' }));
    const area = await screen.findByRole<HTMLTextAreaElement>('textbox');
    expect(area.value).toContain('| Name | Status | Location | Description |');
    expect(area.value).toContain('```atf-specs');
    await user.click(screen.getByRole('button', { name: 'Save test plan' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.version).toBe(0);
    expect(server.puts[0]?.content).toContain('atf-specs');
  });
});

describe('test plan: saved', () => {
  it('renders the matrix as a table and the block as a spec list with results', async () => {
    install(
      newServer({
        testPlan: [artifact('test_plan', 1, PLAN_TEXT)],
        specs: [{ spec: 'tests/features/login.feature', status: 'passed' }],
      }),
    );
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    expect(await screen.findByRole('table')).toBeTruthy();
    const items = await screen.findAllByTestId('atf-spec');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('tests/features/login.feature');
    await waitFor(() =>
      expect(within(items[0] as HTMLElement).getByTestId('spec-result').textContent).toBe('passed'),
    );
    expect(within(items[1] as HTMLElement).getByTestId('spec-result').textContent).toBe(
      'no result yet',
    );
    expect(screen.getByTestId('atf-specs-list').textContent).toContain('@smoke');
    // The list brings its own box: it must not sit inside the code block's <pre>.
    expect(screen.getByTestId('atf-specs-list').closest('pre')).toBeNull();
  });

  it('shows the validation badge from the artifact provenance', async () => {
    install(
      newServer({
        testPlan: [
          artifact('test_plan', 1, PLAN_TEXT, 'Test plan not fully valid: duplicate spec'),
        ],
      }),
    );
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    const badge = await screen.findByTestId('test-plan-badge');
    expect(badge.textContent).toBe('not fully valid');
    expect(
      screen.getByText('Test plan not fully valid: duplicate spec', { selector: 'p' }),
    ).toBeTruthy();
  });

  it('shows a valid badge when the note is absent', async () => {
    install(newServer({ testPlan: [artifact('test_plan', 1, PLAN_TEXT)] }));
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    expect((await screen.findByTestId('test-plan-badge')).textContent).toBe('valid');
  });

  it('edits and saves against the version it read', async () => {
    const server = newServer({ testPlan: [artifact('test_plan', 1, PLAN_TEXT)] });
    install(server);
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const area = await screen.findByRole<HTMLTextAreaElement>('textbox');
    await user.type(area, ' more');
    await user.click(screen.getByRole('button', { name: 'Save test plan' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.version).toBe(1);
    expect(server.puts[0]?.content.endsWith(' more')).toBe(true);
    // Back to the preview, now at version 2.
    await waitFor(() => expect(within(screen.getByRole('tabpanel')).getByTestId('plan-version').textContent).toContain('v2'));
  });

  it('keeps an unsaved draft when switching tabs and back', async () => {
    install(newServer({ testPlan: [artifact('test_plan', 1, PLAN_TEXT)] }));
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(await screen.findByRole<HTMLTextAreaElement>('textbox'), ' kept');
    await user.click(screen.getByRole('tab', { name: /plan\.md/ }));
    await openTestPlan(user);
    expect((await screen.findByRole<HTMLTextAreaElement>('textbox')).value.endsWith(' kept')).toBe(true);
  });

  it('switches the preview between versions from the dropdown', async () => {
    install(
      newServer({
        testPlan: [artifact('test_plan', 1, 'old text'), artifact('test_plan', 2, 'new text')],
      }),
    );
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    expect(await screen.findByText('new text')).toBeTruthy();
    await user.click(within(screen.getByRole('tabpanel')).getByTestId('plan-version'));
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('(latest)');
    await user.click(items[1] as HTMLElement);
    expect(await screen.findByText('old text')).toBeTruthy();
    expect(screen.queryByText('new text')).toBeNull();
  });

  it('copies the test plan text', async () => {
    install(newServer({ testPlan: [artifact('test_plan', 1, PLAN_TEXT)] }));
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    renderPlan();
    // After setup(): user-event installs its own clipboard stub on navigator.
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    await openTestPlan(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PLAN_TEXT));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('flags a version conflict, keeps the draft and offers a reload', async () => {
    const server = newServer({ testPlan: [artifact('test_plan', 1, PLAN_TEXT)], conflict: true });
    install(server);
    const user = userEvent.setup();
    renderPlan();
    await openTestPlan(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const area = await screen.findByRole<HTMLTextAreaElement>('textbox');
    await user.type(area, ' mine');
    // Someone else saves version 2 meanwhile; our save is refused.
    server.testPlan.push(artifact('test_plan', 2, 'theirs'));
    await user.click(screen.getByRole('button', { name: 'Save test plan' }));
    expect(await screen.findByText(/The test plan is at version 2, not 1/)).toBeTruthy();
    expect(await screen.findByText('test-plan.md changed since you started editing.')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value.endsWith(' mine')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('theirs')).toBeTruthy();
  });
});
