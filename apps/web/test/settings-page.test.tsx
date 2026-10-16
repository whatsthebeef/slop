// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_GROUP_IDS, SETTINGS_GROUPS } from '../src/lib/settings-groups';
import { SettingsPage } from '../src/pages/settings';

const api = vi.hoisted(() => ({
  board: vi.fn(),
  repoConnection: vi.fn(),
  readiness: vi.fn(),
  members: vi.fn(),
  integrationToken: vi.fn(),
  reports: vi.fn(),
  health: vi.fn(),
  chatTestCases: vi.fn(),
  atfRunners: vi.fn(),
  relationLearning: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { ...api } }));

const board = (role: string) => ({
  id: 1,
  name: 'Pocket board',
  role,
  version: 3,
  repo: 'acme/pocket',
  baseBranch: 'main',
  timeZone: 'UTC',
  environments: [{ name: 'dev', allowBranchDeploy: true }],
  deploy: null,
  atf: null,
  effectCheckGlobs: 10,
  agentKbApproval: 'docs',
  autoInvestigate: true,
  review: { enabled: true, model: null, minSeverity: 'medium', ignoredPaths: [], toolCap: null },
  readinessTicks: {},
});

beforeEach(() => {
  localStorage.clear();
  // jsdom has no scrollIntoView (the readiness link calls it).
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  api.board.mockResolvedValue(board('admin'));
  api.repoConnection.mockResolvedValue({ repo: 'acme/pocket', configured: true, connected: true, installUrl: null, appName: 'slop' });
  api.readiness.mockResolvedValue([]);
  api.members.mockResolvedValue([{ email: 'a@b.c', role: 'admin' }]);
  api.integrationToken.mockResolvedValue({ active: false, createdAt: null });
  api.reports.mockResolvedValue({ timeZone: 'UTC', canDownload: true });
  api.health.mockResolvedValue({ capabilities: {} });
  api.chatTestCases.mockResolvedValue([]);
  api.atfRunners.mockResolvedValue([]);
  api.relationLearning.mockResolvedValue({
    thresholds: { windowDays: 90, precision: 0.5, recall: 0.5, minSamples: 5 },
    defaults: { windowDays: 90, precision: 0.5, recall: 0.5, minSamples: 5 },
    sources: [],
    pins: {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Where = () => {
  const { pathname, search } = useLocation();
  return <p data-testid='where'>{`${pathname}${search}`}</p>;
};

const renderPage = (url = '/boards/1/settings') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path='/boards/:boardId/settings' element={<SettingsPage />} />
          <Route path='/boards/:boardId/knowledge' element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const groups = () => screen.getAllByTestId(/^settings-group-[a-z]+$/).map((el) => el.dataset['testid']);
const toggle = (id: string) => screen.getByTestId(`settings-group-${id}-toggle`);

describe('Settings page', () => {
  it('holds only the eight groups a person chooses from, with System collapsed at the bottom', async () => {
    renderPage();
    await screen.findByTestId('settings-group-board');
    expect(groups()).toEqual(SETTINGS_GROUP_IDS.map((id) => `settings-group-${id}`));
    expect(SETTINGS_GROUP_IDS.map((id) => toggle(id).textContent)).toEqual([
      'Board and repository',
      'Members and access',
      'Environments and deploys',
      'ATF runners',
      'Automation',
      'Relations',
      'Reports',
      'System',
    ]);
    expect(SETTINGS_GROUP_IDS.map((id) => toggle(id).getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true', 'true', 'true', 'true', 'true', 'false']);
    for (const id of SETTINGS_GROUP_IDS) expect(screen.getByTestId(`settings-group-${id}`).textContent).toContain(SETTINGS_GROUPS[id].blurb);
  });

  it('no longer shows anything slop has learned', async () => {
    renderPage();
    await screen.findByTestId('settings-group-board');
    await userEvent.setup().click(toggle('system'));
    for (const id of ['size-threshold', 'size-calibration', 'sub-limit', 'risk-areas', 'escalations', 'dependency-rules', 'type-learning', 'intake-accuracy', 'context-report', 'kb-jobs'])
      expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByText('Learning jobs')).toBeNull();
    expect(screen.queryByText('Escalation criteria')).toBeNull();
    // The parts that stay are all here.
    expect(await screen.findByTestId('system-capabilities')).toBeTruthy();
    expect(screen.getByTestId('time-reports')).toBeTruthy();
    expect(screen.getByTestId('integration-token')).toBeTruthy();
    expect(screen.getByTestId('deploy-settings')).toBeTruthy();
    expect(screen.getByTestId('atf-settings')).toBeTruthy();
    expect(screen.getByTestId('effect-check-globs')).toBeTruthy();
  });

  it('explains every setting in visible text under its label, never in a tooltip', async () => {
    renderPage();
    await screen.findByTestId('settings-group-board');
    await userEvent.setup().click(toggle('system'));
    await screen.findByTestId('system-capabilities');
    const page = document.body;
    expect(page.querySelectorAll('[title]')).toHaveLength(0);
    const described = ['Repository (owner/name)', 'Base branch', 'Working-hours time zone', 'Reviewer model', 'Comment on GitHub from this severity up', 'Paths the reviewer skips', 'Reviewer tool calls per review'];
    for (const label of described) {
      const control = screen.getByLabelText(label);
      const hint = document.getElementById(control.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent ?? '', label).not.toBe('');
    }
    for (const testId of ['auto-investigate', 'review-enabled', 'agent-kb-approval']) {
      const hint = document.getElementById(screen.getByTestId(testId).getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent ?? '', testId).not.toBe('');
    }
    expect(screen.getByTestId('environment-hints').textContent).toContain('subs created without an environment get this one');
  });

  it("shows how each observed environment's deploys are known, and Record a deploy for a manual one (s15t239)", async () => {
    api.board.mockResolvedValue({
      ...board('admin'),
      environments: [
        { name: 'dev', allowBranchDeploy: true },
        { name: 'staging', allowBranchDeploy: false, role: 'integration' },
        { name: 'prod', allowBranchDeploy: false, role: 'release', production: true, deployKnown: 'manual' },
      ],
    });
    renderPage();
    await screen.findByTestId('environments');
    const known = (name: string) => screen.getByLabelText<HTMLSelectElement>(`How ${name}'s deploys are known`);
    // No role, nothing to report or record.
    expect(known('dev').disabled).toBe(true);
    expect(known('staging').value).toBe('pipeline');
    expect(known('prod').value).toBe('manual');
    const hints = screen.getAllByTestId('deploy-known-hint').map((h) => h.textContent);
    expect(hints[0]).toContain('report-deploy.sh');
    expect(hints[1]).toContain("You record each release in slop; its globs' after-deploy steps fall due");
    expect(screen.getAllByRole('button', { name: 'Record a deploy' })).toHaveLength(1);
    expect(screen.getByTestId('record-deploy-prod')).toBeTruthy();
  });

  it('remembers which groups are open, for this viewer', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findByTestId('settings-group-board');
    await user.click(toggle('board'));
    await user.click(toggle('system'));
    expect(toggle('board').getAttribute('aria-expanded')).toBe('false');
    expect(within(screen.getByTestId('settings-group-board')).queryByTestId('board-name')).toBeNull();
    expect(localStorage.getItem('slop.settings-group.board')).toBe('closed');
    expect(localStorage.getItem('slop.settings-group.system')).toBe('open');
    first.unmount();

    renderPage();
    await screen.findByTestId('settings-group-board');
    expect(SETTINGS_GROUP_IDS.map((id) => toggle(id).getAttribute('aria-expanded'))).toEqual(['false', 'true', 'true', 'true', 'true', 'true', 'true', 'true']);
  });

  it('still works when the browser will not store anything', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderPage();
    await screen.findByTestId('settings-group-board');
    expect(toggle('system').getAttribute('aria-expanded')).toBe('false');
    await userEvent.setup().click(toggle('system'));
    expect(toggle('system').getAttribute('aria-expanded')).toBe('true');
  });

  it('gives only admins the save button and the edit controls', async () => {
    const admin = renderPage();
    await screen.findByTestId('settings-group-board');
    expect(screen.getAllByRole('button', { name: 'Save settings' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText<HTMLInputElement>('Base branch').disabled).toBe(false);
    admin.unmount();

    api.board.mockResolvedValue(board('dev'));
    renderPage();
    await screen.findByTestId('settings-group-board');
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Base branch').disabled).toBe(true);
  });

  describe('old links', () => {
    it.each([
      ['?section=sub-limit', '/boards/1/knowledge?learned=subs'],
      ['?section=size-threshold', '/boards/1/knowledge?learned=size'],
      ['?section=risk-areas', '/boards/1/knowledge?learned=risk-areas'],
      ['?section=type-learning', '/boards/1/knowledge?learned=intake'],
      ['?section=context-report', '/boards/1/knowledge?learned=context'],
      ['?section=kb-jobs', '/boards/1/knowledge?learned=jobs'],
      ['#dependency-rules', '/boards/1/knowledge?learned=dependency-rules'],
    ])('%s goes to the Knowledge panel', async (suffix, target) => {
      renderPage(`/boards/1/settings${suffix}`);
      expect((await screen.findByTestId('where')).textContent).toBe(target);
    });

    it('leaves unknown sections and the readiness link on Settings', async () => {
      const unknown = renderPage('/boards/1/settings?section=nope');
      await screen.findByTestId('settings-group-board');
      expect(screen.queryByTestId('where')).toBeNull();
      unknown.unmount();

      localStorage.setItem('slop.settings-group.board', 'closed');
      renderPage('/boards/1/settings#readiness');
      await screen.findByTestId('readiness');
      expect(screen.queryByTestId('where')).toBeNull();
      // A link to the checklist opens the group it is in, even when the viewer had closed it.
      expect(toggle('board').getAttribute('aria-expanded')).toBe('true');
    });
  });
});
