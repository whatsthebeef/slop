import { ATF_RUNNER_METHODS, validateRunner } from '@slop/core';
import type {
  AtfRunnerConfig,
  AtfRunnerMethod,
  ClaimRules,
  Environment,
  RunnerInput,
} from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, atfRunnersKey, healthKey } from '@/lib/api';
import type { AtfRunnerCredentials, AtfRunnerView } from '@/lib/api';
import { copyOrSelect } from '@/lib/plan-text';
import { useToast } from '@/toast';
import { message } from './form';
import { CheckField, Field, SettingBlock, SettingsGroup } from './group';

const METHOD_LABEL: Record<AtfRunnerMethod, string> = {
  oidc: 'OIDC token (GitHub Actions and other CI)',
  aws_iam: 'AWS IAM role (CodeBuild)',
  client_credentials: 'Client credentials (Cognito app client)',
};

const when = (at: string | null | undefined): string =>
  at == null ? 'never' : new Date(at).toLocaleString();

/** The environments a runner may serve are the board's dev environments. */
const observedNames = (environments: readonly Environment[]): string[] => environments.map((e) => e.name);

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** `claim = value, value` per line; null names the first line that isn't one. */
export const parseClaimRules = (text: string): { rules: ClaimRules } | { bad: string } => {
  const rules = new Map<string, string[]>();
  for (const line of lines(text)) {
    const at = line.indexOf('=');
    const name = at < 0 ? '' : line.slice(0, at).trim();
    const values =
      at < 0
        ? []
        : line
            .slice(at + 1)
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v !== '');
    if (name === '' || values.length === 0)
      return { bad: `"${line}" isn't a claim rule: write claim=value, one per line` };
    rules.set(name, [...(rules.get(name) ?? []), ...values]);
  }
  return { rules: Object.fromEntries(rules) };
};

interface RunnerDraft {
  readonly name: string;
  readonly method: AtfRunnerMethod;
  readonly issuer: string;
  readonly claims: string;
  readonly roleArns: string;
  readonly accounts: string;
  readonly environments: readonly string[];
}

const EMPTY_DRAFT: RunnerDraft = {
  name: '',
  method: 'oidc',
  issuer: '',
  claims: '',
  roleArns: '',
  accounts: '',
  environments: [],
};

/** The request for a draft, or the reason it can't be sent yet (the same messages the server gives). */
export const draftRequest = (
  draft: RunnerDraft,
  observed: readonly string[],
): { input: RunnerInput } | { problem: string } => {
  let config: AtfRunnerConfig = {};
  if (draft.method === 'oidc') {
    const parsed = parseClaimRules(draft.claims);
    if ('bad' in parsed) return { problem: parsed.bad };
    config = { issuer: draft.issuer.trim(), claims: parsed.rules };
  } else if (draft.method === 'aws_iam') {
    const accounts = draft.accounts.split(/[\s,]+/).filter((a) => a !== '');
    config = { roleArns: lines(draft.roleArns), ...(accounts.length > 0 && { accounts }) };
  }
  const input: RunnerInput = {
    name: draft.name,
    method: draft.method,
    config,
    environments: draft.environments,
  };
  const checked = validateRunner(
    { name: input.name, method: input.method, config, environments: input.environments },
    observed,
  );
  return checked.ok ? { input } : { problem: checked.error.message };
};

/** The client secret, shown once with copy buttons; closing it drops it from state, and nothing stores it. */
const CredentialsNotice = ({
  credentials,
  onClose,
}: {
  credentials: AtfRunnerCredentials;
  onClose: () => void;
}) => {
  const secret = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const rows: { key: string; label: string; value: string | undefined }[] = [
    { key: 'clientId', label: 'Client ID', value: credentials.clientId },
    { key: 'clientSecret', label: 'Client secret', value: credentials.clientSecret },
    { key: 'tokenUrl', label: 'Token URL', value: credentials.tokenUrl },
    { key: 'scope', label: 'Scope', value: credentials.scope },
  ];
  return (
    <div
      role="alert"
      className="grid gap-2 rounded-md border border-destructive p-3 text-sm"
      data-testid="runner-credentials"
    >
      <p className="font-medium">Copy the client secret now: it won&apos;t be shown again.</p>
      <p className="text-xs text-muted-foreground">
        Slop does not keep it. If it is lost, revoke the runner and register another.
      </p>
      {rows.map(({ key, label, value }) =>
        value === undefined ? null : (
          <div key={key} className="flex items-end gap-2">
            <Field label={label} hint="" className="flex-1">
              {(props) => (
                <Input
                  {...props}
                  readOnly
                  ref={key === 'clientSecret' ? secret : undefined}
                  value={value}
                  className="font-mono text-xs"
                  data-testid={`credential-${key}`}
                />
              )}
            </Field>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Copy ${label}`}
              data-testid={`copy-${key}`}
              onClick={() =>
                void copyOrSelect(
                  value,
                  typeof navigator === 'undefined' ? undefined : navigator.clipboard,
                  () => secret.current?.select(),
                ).then((ok) => setCopied(ok ? label : null))
              }
            >
              Copy
            </Button>
          </div>
        ),
      )}
      <p className="text-xs text-muted-foreground" role="status">
        {copied === null ? '' : `${copied} copied.`}
      </p>
      <div>
        <Button size="sm" onClick={onClose} data-testid="credentials-done">
          I have saved it
        </Button>
      </div>
    </div>
  );
};

const AddRunner = ({
  boardId,
  observed,
  clientCredentials,
  onCreated,
}: {
  boardId: number;
  observed: readonly string[];
  clientCredentials: boolean;
  onCreated: (credentials: AtfRunnerCredentials | null) => void;
}) => {
  const toast = useToast();
  const [draft, setDraft] = useState<RunnerDraft>(EMPTY_DRAFT);
  const [pending, setPending] = useState(false);
  const request = draftRequest(draft, observed);
  const problem = 'problem' in request && draft.name.trim() !== '' ? request.problem : null;
  const methods = ATF_RUNNER_METHODS.filter((m) => m !== 'client_credentials' || clientCredentials);
  const set = (patch: Partial<RunnerDraft>) => setDraft({ ...draft, ...patch });

  const submit = () => {
    if (!('input' in request)) return;
    setPending(true);
    // Not a mutation: its result would keep the secret in react-query's cache after the notice is closed.
    api
      .createAtfRunner(boardId, request.input)
      .then((created) => {
        setDraft(EMPTY_DRAFT);
        onCreated(created.credentials ?? null);
      })
      .catch((e: unknown) => toast(message(e)))
      .finally(() => setPending(false));
  };

  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      aria-label="Add a runner"
      data-testid="runner-add"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field
        label="Runner name"
        hint="Shown on results when the board has more than one runner. Unique on the board."
      >
        {(props) => (
          <Input
            {...props}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            data-testid="runner-name"
          />
        )}
      </Field>
      <Field
        label="How it proves who it is"
        hint="Each runner has its own identity; the board token is not one of these."
      >
        {(props) => (
          <select
            {...props}
            className="h-9 w-full rounded-md border bg-card px-3 text-sm"
            value={draft.method}
            onChange={(e) => {
              const method = methods.find((m) => m === e.target.value);
              if (method !== undefined) set({ method });
            }}
            data-testid="runner-method"
          >
            {methods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {draft.method === 'oidc' && (
        <>
          <Field
            label="Issuer URL"
            hint="The https URL that signs its tokens, e.g. https://token.actions.githubusercontent.com for GitHub Actions."
          >
            {(props) => (
              <Input
                {...props}
                value={draft.issuer}
                onChange={(e) => set({ issuer: e.target.value })}
                data-testid="runner-issuer"
              />
            )}
          </Field>
          <Field
            label="Claim rules"
            hint="One per line as claim=value (several values with commas; * may end a value). GitHub Actions must pin repository or sub, e.g. repository=acme/pocket."
          >
            {(props) => (
              <textarea
                {...props}
                className="min-h-16 w-full rounded-md border bg-card px-3 py-2 font-mono text-xs"
                value={draft.claims}
                onChange={(e) => set({ claims: e.target.value })}
                data-testid="runner-claims"
              />
            )}
          </Field>
        </>
      )}
      {draft.method === 'aws_iam' && (
        <>
          <Field
            label="Role ARNs"
            hint="One per line, e.g. arn:aws:iam::123456789012:role/atf-codebuild. A trailing * matches a prefix."
          >
            {(props) => (
              <textarea
                {...props}
                className="min-h-16 w-full rounded-md border bg-card px-3 py-2 font-mono text-xs"
                value={draft.roleArns}
                onChange={(e) => set({ roleArns: e.target.value })}
                data-testid="runner-role-arns"
              />
            )}
          </Field>
          <Field
            label="Accounts (optional)"
            hint="12-digit AWS account IDs, separated by commas; they can only narrow what the server allows."
          >
            {(props) => (
              <Input
                {...props}
                value={draft.accounts}
                onChange={(e) => set({ accounts: e.target.value })}
                data-testid="runner-accounts"
              />
            )}
          </Field>
        </>
      )}
      {draft.method === 'client_credentials' && (
        <p className="text-xs text-muted-foreground">
          Slop creates the client and shows its ID and secret once, right after you add the runner.
        </p>
      )}
      <fieldset className="grid gap-1">
        <legend className="text-xs font-medium text-muted-foreground">
          Environments it serves
        </legend>
        {observed.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No environment has a pipeline role yet, so there is nothing a runner can serve. Set a
            role under Environments and deploys.
          </p>
        ) : (
          observed.map((env) => (
            <CheckField
              key={env}
              label={env}
              hint=""
              disabled={false}
              checked={draft.environments.includes(env)}
              onChange={(on) =>
                set({
                  environments: on
                    ? [...draft.environments, env]
                    : draft.environments.filter((e) => e !== env),
                })
              }
              testId={`runner-env-${env}`}
            />
          ))
        )}
      </fieldset>
      {problem !== null && (
        <p className="text-xs text-destructive" role="status" data-testid="runner-problem">
          {problem}
        </p>
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={pending || !('input' in request)}
          data-testid="runner-add-submit"
        >
          Add runner
        </Button>
      </div>
    </form>
  );
};

const RunnerRow = ({
  boardId,
  runner,
  onWarning,
}: {
  boardId: number;
  runner: AtfRunnerView;
  onWarning: (warning: string) => void;
}) => {
  const client = useQueryClient();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: atfRunnersKey(boardId) });
  const update = useMutation({
    mutationFn: (change: { name?: string; enabled?: boolean }) =>
      api.updateAtfRunner(boardId, runner.id, change),
    onSuccess: () => {
      setRenaming(null);
      void refresh();
    },
    onError: (e) => toast(message(e)),
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeAtfRunner(boardId, runner.id),
    onSuccess: (answer) => {
      setConfirming(false);
      if (answer.warning !== undefined) onWarning(answer.warning);
      void refresh();
    },
    onError: (e) => toast(message(e)),
  });
  const enabled = runner.enabled !== false;
  const environments = runner.environments ?? [];
  return (
    <li className="grid gap-1 rounded-md border p-3 text-sm" data-testid={`runner-${runner.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{runner.name}</span>
        {runner.method !== undefined && (
          <span className="text-xs text-muted-foreground">{METHOD_LABEL[runner.method]}</span>
        )}
        <span
          className={enabled ? 'text-xs' : 'text-xs text-muted-foreground'}
          data-testid="runner-state"
        >
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Environments: {environments.length === 0 ? 'none listed' : environments.join(', ')}
      </p>
      <p className="text-xs text-muted-foreground">
        Last seen {when(runner.lastSeenAt)} · last result {when(runner.lastResultAt)}
      </p>
      {renaming !== null ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ name: renaming });
          }}
        >
          <Field label="New name" hint="" className="flex-1">
            {(props) => (
              <Input
                {...props}
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                data-testid="runner-rename-input"
              />
            )}
          </Field>
          <Button
            type="submit"
            size="sm"
            disabled={update.isPending || renaming.trim() === ''}
            data-testid="runner-rename-save"
          >
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setRenaming(null)}>
            Cancel
          </Button>
        </form>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <span className="text-xs">
            Revoke {runner.name}? Its credential stops working for good and the name is freed.
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
            data-testid="runner-revoke-confirm"
          >
            Revoke
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ enabled: !enabled })}
            data-testid="runner-toggle"
          >
            {enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRenaming(runner.name)}
            data-testid="runner-rename"
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirming(true)}
            data-testid="runner-revoke"
          >
            Revoke
          </Button>
        </div>
      )}
    </li>
  );
};

/** The group's content. It holds the one-time secret in its state, so collapsing the group (which unmounts it) drops the secret. */
const RunnersBody = ({
  boardId,
  environments,
}: {
  boardId: number;
  environments: readonly Environment[];
}) => {
  const client = useQueryClient();
  const runners = useQuery({
    queryKey: atfRunnersKey(boardId),
    queryFn: () => api.atfRunners(boardId),
  });
  const health = useQuery({ queryKey: healthKey, queryFn: api.health });
  const [credentials, setCredentials] = useState<AtfRunnerCredentials | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const clientCredentials = health.data?.capabilities?.atfClientCredentials === true;
  return (
    <>
      <SettingBlock
        title="Runners"
        hint="Each system that runs acceptance tests registers here and pulls specs and posts results with its own credential."
        testId="atf-runners"
      >
        {credentials !== null && (
          <CredentialsNotice credentials={credentials} onClose={() => setCredentials(null)} />
        )}
        {warning !== null && (
          <p role="alert" className="text-xs text-destructive" data-testid="runner-warning">
            {warning}
          </p>
        )}
        {runners.data === undefined ? (
          <p className="text-sm text-muted-foreground">
            {runners.isError ? message(runners.error) : 'Loading…'}
          </p>
        ) : runners.data.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="runners-empty">
            No runners yet. Pipelines using the board token keep working until you register one.
          </p>
        ) : (
          <ul className="grid gap-2">
            {runners.data.map((r) => (
              <RunnerRow key={r.id} boardId={boardId} runner={r} onWarning={setWarning} />
            ))}
          </ul>
        )}
      </SettingBlock>
      <SettingBlock
        title="Add a runner"
        hint="Choose how it proves who it is and which environments it may serve."
      >
        <AddRunner
          boardId={boardId}
          observed={observedNames(environments)}
          clientCredentials={clientCredentials}
          onCreated={(issued) => {
            setCredentials(issued);
            void client.invalidateQueries({ queryKey: atfRunnersKey(boardId) });
          }}
        />
      </SettingBlock>
    </>
  );
};

/** Board settings, ATF runners (admins only): the systems that run the acceptance tests, each with its own identity. */
export const AtfRunnersGroup = ({
  boardId,
  environments,
}: {
  boardId: number;
  environments: readonly Environment[];
}) => (
  <SettingsGroup id="runners">
    <RunnersBody boardId={boardId} environments={environments} />
  </SettingsGroup>
);
