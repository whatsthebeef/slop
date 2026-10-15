// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AtfRunnersGroup,
  draftRequest,
  parseClaimRules,
} from '../src/components/settings/atf-runners-group';
import { AtfChip, atfLine } from '../src/components/glob-card';
import { RequestError } from '../src/lib/api';
import type { AtfRun, AtfRunnerView } from '../src/lib/api';

const api = vi.hoisted(() => ({
  atfRunners: vi.fn(),
  createAtfRunner: vi.fn(),
  updateAtfRunner: vi.fn(),
  revokeAtfRunner: vi.fn(),
  health: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  api: { ...api },
}));

const environments = [
  { name: 'staging', allowBranchDeploy: false, role: 'integration' as const },
  { name: 'dev', allowBranchDeploy: true },
];

const runner = (patch: Partial<AtfRunnerView> = {}): AtfRunnerView => ({
  id: 7,
  name: 'GitHub CI',
  method: 'oidc',
  environments: ['staging'],
  enabled: true,
  lastSeenAt: null,
  lastResultAt: null,
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  api.atfRunners.mockResolvedValue([]);
  api.health.mockResolvedValue({ capabilities: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const renderGroup = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AtfRunnersGroup boardId={1} environments={environments} />
    </QueryClientProvider>,
  );

const fillOidc = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('Runner name'), 'GitHub CI');
  await user.type(
    screen.getByLabelText('Issuer URL'),
    'https://token.actions.githubusercontent.com',
  );
  await user.type(screen.getByLabelText('Claim rules'), 'repository=acme/pocket');
  await user.click(screen.getByTestId('runner-env-staging'));
};

describe('the runner list', () => {
  it('shows each runner with its method, environments, state and times, and copes with missing fields', async () => {
    api.atfRunners.mockResolvedValue([
      runner({ lastSeenAt: '2026-10-05T12:00:00.000Z', lastResultAt: '2026-10-05T12:30:00.000Z' }),
      runner({ id: 8, name: 'Old server runner', enabled: false }),
      { id: 9, name: 'Bare' },
    ]);
    renderGroup();
    const first = await screen.findByTestId('runner-7');
    expect(first.textContent).toContain('GitHub CI');
    expect(first.textContent).toContain('OIDC token');
    expect(first.textContent).toContain('Environments: staging');
    expect(first.textContent).not.toContain('last result never');
    expect(screen.getByTestId('runner-8').textContent).toContain('Disabled');
    const bare = screen.getByTestId('runner-9').textContent;
    expect(bare).toContain('Environments: none listed');
    expect(bare).toContain('Last seen never');
  });

  it('says so when there are none', async () => {
    renderGroup();
    expect((await screen.findByTestId('runners-empty')).textContent).toContain('No runners yet');
  });

  it('enables and disables a runner', async () => {
    api.atfRunners.mockResolvedValue([runner()]);
    api.updateAtfRunner.mockResolvedValue(runner({ enabled: false }));
    renderGroup();
    await userEvent.setup().click(await screen.findByTestId('runner-toggle'));
    await waitFor(() => expect(api.updateAtfRunner).toHaveBeenCalledWith(1, 7, { enabled: false }));
  });

  it('renames a runner', async () => {
    const user = userEvent.setup();
    api.atfRunners.mockResolvedValue([runner()]);
    api.updateAtfRunner.mockResolvedValue(runner({ name: 'CI' }));
    renderGroup();
    await user.click(await screen.findByTestId('runner-rename'));
    await user.clear(screen.getByTestId('runner-rename-input'));
    await user.type(screen.getByTestId('runner-rename-input'), 'CI');
    await user.click(screen.getByTestId('runner-rename-save'));
    await waitFor(() => expect(api.updateAtfRunner).toHaveBeenCalledWith(1, 7, { name: 'CI' }));
  });

  it('asks before revoking, and shows the warning when its client could not be removed', async () => {
    const user = userEvent.setup();
    api.atfRunners.mockResolvedValue([runner()]);
    api.revokeAtfRunner.mockResolvedValue({
      value: runner(),
      warning: 'The runner is revoked, but cleanup failed.',
    });
    renderGroup();
    await user.click(await screen.findByTestId('runner-revoke'));
    expect(api.revokeAtfRunner).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('runner-revoke-confirm'));
    await waitFor(() => expect(api.revokeAtfRunner).toHaveBeenCalledWith(1, 7));
    expect((await screen.findByTestId('runner-warning')).textContent).toContain('cleanup failed');
  });

  it('keeps the runner when the confirmation is declined', async () => {
    const user = userEvent.setup();
    api.atfRunners.mockResolvedValue([runner()]);
    renderGroup();
    await user.click(await screen.findByTestId('runner-revoke'));
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.revokeAtfRunner).not.toHaveBeenCalled();
    expect(screen.getByTestId('runner-revoke')).toBeTruthy();
  });
});

describe('adding a runner', () => {
  it('registers an OIDC runner with its issuer, claim rules and environments', async () => {
    const user = userEvent.setup();
    api.createAtfRunner.mockResolvedValue({ value: runner() });
    renderGroup();
    await screen.findByTestId('runners-empty');
    await fillOidc(user);
    await user.click(screen.getByTestId('runner-add-submit'));
    await waitFor(() =>
      expect(api.createAtfRunner).toHaveBeenCalledWith(1, {
        name: 'GitHub CI',
        method: 'oidc',
        config: {
          issuer: 'https://token.actions.githubusercontent.com',
          claims: { repository: ['acme/pocket'] },
        },
        environments: ['staging'],
      }),
    );
    expect(screen.queryByTestId('runner-credentials')).toBeNull();
  });

  it('only offers environments the board observes', async () => {
    renderGroup();
    await screen.findByTestId('runners-empty');
    expect(screen.getByTestId('runner-env-staging')).toBeTruthy();
    expect(screen.queryByTestId('runner-env-dev')).toBeNull();
  });

  it('refuses a GitHub runner that pins nothing, with the server wording, and sends nothing', async () => {
    const user = userEvent.setup();
    renderGroup();
    await screen.findByTestId('runners-empty');
    await user.type(screen.getByLabelText('Runner name'), 'GitHub CI');
    await user.type(
      screen.getByLabelText('Issuer URL'),
      'https://token.actions.githubusercontent.com',
    );
    await user.type(screen.getByLabelText('Claim rules'), 'ref=refs/heads/main');
    await user.click(screen.getByTestId('runner-env-staging'));
    expect(screen.getByTestId('runner-problem').textContent).toContain(
      'must pin the repository (or sub) claim',
    );
    expect(screen.getByTestId<HTMLButtonElement>('runner-add-submit').disabled).toBe(true);
    expect(api.createAtfRunner).not.toHaveBeenCalled();
  });

  it('registers an AWS IAM runner with role ARNs and accounts', async () => {
    const user = userEvent.setup();
    api.createAtfRunner.mockResolvedValue({ value: runner({ method: 'aws_iam' }) });
    renderGroup();
    await screen.findByTestId('runners-empty');
    await user.selectOptions(screen.getByTestId('runner-method'), 'aws_iam');
    await user.type(screen.getByLabelText('Runner name'), 'CodeBuild');
    await user.type(screen.getByLabelText('Role ARNs'), 'arn:aws:iam::123456789012:role/atf');
    await user.type(screen.getByLabelText('Accounts (optional)'), '123456789012');
    await user.click(screen.getByTestId('runner-env-staging'));
    await user.click(screen.getByTestId('runner-add-submit'));
    await waitFor(() =>
      expect(api.createAtfRunner).toHaveBeenCalledWith(1, {
        name: 'CodeBuild',
        method: 'aws_iam',
        config: { roleArns: ['arn:aws:iam::123456789012:role/atf'], accounts: ['123456789012'] },
        environments: ['staging'],
      }),
    );
  });

  it('refuses a malformed role ARN', async () => {
    const user = userEvent.setup();
    renderGroup();
    await screen.findByTestId('runners-empty');
    await user.selectOptions(screen.getByTestId('runner-method'), 'aws_iam');
    await user.type(screen.getByLabelText('Runner name'), 'CodeBuild');
    await user.type(screen.getByLabelText('Role ARNs'), 'not-an-arn');
    await user.click(screen.getByTestId('runner-env-staging'));
    expect(screen.getByTestId('runner-problem').textContent).toContain('Role ARNs look like');
  });

  it('hides client credentials unless the server can create them', async () => {
    renderGroup();
    await screen.findByTestId('runners-empty');
    const options = () =>
      Array.from(screen.getByTestId<HTMLSelectElement>('runner-method').options).map(
        (o) => o.value,
      );
    expect(options()).toEqual(['oidc', 'aws_iam']);
    cleanup();

    api.health.mockResolvedValue({ capabilities: { atfClientCredentials: true } });
    renderGroup();
    await waitFor(() => expect(options()).toEqual(['oidc', 'aws_iam', 'client_credentials']));
  });

  it('stays without client credentials when the server reports no capabilities at all', async () => {
    api.health.mockResolvedValue({});
    renderGroup();
    await screen.findByTestId('runners-empty');
    expect(
      Array.from(screen.getByTestId<HTMLSelectElement>('runner-method').options).map(
        (o) => o.value,
      ),
    ).not.toContain('client_credentials');
  });

  it('shows a server refusal as a message and keeps the form', async () => {
    const user = userEvent.setup();
    api.createAtfRunner.mockRejectedValue(
      new RequestError(422, {
        code: 'invalid_input',
        message: 'Another runner of this board already has that name',
      }),
    );
    renderGroup();
    await screen.findByTestId('runners-empty');
    await fillOidc(user);
    await user.click(screen.getByTestId('runner-add-submit'));
    await waitFor(() => expect(api.createAtfRunner).toHaveBeenCalled());
    expect(screen.getByLabelText<HTMLInputElement>('Runner name').value).toBe('GitHub CI');
  });
});

describe('client credentials are shown once', () => {
  const issue = async () => {
    const user = userEvent.setup();
    api.health.mockResolvedValue({ capabilities: { atfClientCredentials: true } });
    api.createAtfRunner.mockResolvedValue({
      value: runner({ method: 'client_credentials' }),
      credentials: {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        tokenUrl: 'https://auth.example/oauth2/token',
        scope: 'slop/atf.read-specs slop/atf.write-results',
      },
    });
    renderGroup();
    await waitFor(() =>
      expect(screen.getByTestId('runner-method').querySelectorAll('option')).toHaveLength(3),
    );
    await user.selectOptions(screen.getByTestId('runner-method'), 'client_credentials');
    await user.type(screen.getByLabelText('Runner name'), 'Jenkins');
    await user.click(screen.getByTestId('runner-env-staging'));
    await user.click(screen.getByTestId('runner-add-submit'));
    return user;
  };

  it('shows the id and secret with a notice, and drops them when closed', async () => {
    const user = await issue();
    const notice = await screen.findByTestId('runner-credentials');
    expect(notice.textContent).toContain("won't be shown again");
    expect(screen.getByTestId<HTMLInputElement>('credential-clientId').value).toBe('client-abc');
    expect(screen.getByTestId<HTMLInputElement>('credential-clientSecret').value).toBe(
      'secret-xyz',
    );
    expect(screen.getByTestId('copy-clientSecret')).toBeTruthy();
    await user.click(screen.getByTestId('credentials-done'));
    expect(screen.queryByTestId('runner-credentials')).toBeNull();
    expect(document.body.textContent).not.toContain('secret-xyz');
  });

  it('drops the secret when the group is collapsed, and never writes it to storage', async () => {
    const user = await issue();
    await screen.findByTestId('runner-credentials');
    await user.click(screen.getByTestId('settings-group-runners-toggle'));
    expect(screen.queryByTestId('runner-credentials')).toBeNull();
    await user.click(screen.getByTestId('settings-group-runners-toggle'));
    expect(screen.queryByTestId('runner-credentials')).toBeNull();
    expect(document.body.textContent).not.toContain('secret-xyz');
    for (const store of [localStorage, sessionStorage])
      for (let i = 0; i < store.length; i += 1)
        expect(store.getItem(store.key(i) ?? '')).not.toContain('secret-xyz');
  });

  it('copies a value through the clipboard', async () => {
    const user = await issue();
    await user.click(await screen.findByTestId('copy-clientSecret'));
    // user-event installs its own clipboard on setup.
    expect(await navigator.clipboard.readText()).toBe('secret-xyz');
  });
});

describe('the draft helpers', () => {
  it('parses claim rules per line and names a bad line', () => {
    expect(parseClaimRules('repository = acme/a, acme/b\nsub=repo:acme/*')).toEqual({
      rules: { repository: ['acme/a', 'acme/b'], sub: ['repo:acme/*'] },
    });
    expect(parseClaimRules('nonsense')).toEqual({
      bad: '"nonsense" isn\'t a claim rule: write claim=value, one per line',
    });
  });

  it('builds a client-credentials request with no config', () => {
    expect(
      draftRequest(
        {
          name: 'J',
          method: 'client_credentials',
          issuer: '',
          claims: '',
          roleArns: '',
          accounts: '',
          environments: ['staging'],
        },
        ['staging'],
      ),
    ).toEqual({
      input: { name: 'J', method: 'client_credentials', config: {}, environments: ['staging'] },
    });
  });
});

describe('the runner name on results', () => {
  const run = (patch: Partial<AtfRun> = {}): AtfRun => ({
    id: 1,
    scope: 'branch',
    environment: null,
    sha: 'abcdef1234567',
    passed: 3,
    failed: 0,
    skipped: 0,
    url: null,
    at: '2026-10-05T12:00:00.000Z',
    failing: false,
    ...patch,
  });

  it('names the runner in the line and the chip tooltip only when the server sent a name', () => {
    expect(atfLine(run())).not.toContain('runner:');
    expect(atfLine(run({ runnerName: 'GitHub CI' }))).toContain('· runner: GitHub CI');
    render(
      <AtfChip
        runs={[run({ runnerName: 'GitHub CI' }), run({ id: 2, runnerName: 'CodeBuild' })]}
      />,
    );
    expect(document.body.textContent).toContain('runner: GitHub CI');
    expect(document.body.textContent).toContain('runner: CodeBuild');
    cleanup();
    render(<AtfChip runs={[run()]} />);
    expect(document.body.textContent).not.toContain('runner:');
  });
});
