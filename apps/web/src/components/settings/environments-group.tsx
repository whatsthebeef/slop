import type { AtfIntegration, DeployIntegration } from '@slop/core';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field, SaveButton, SettingBlock, SettingsGroup } from './group';
import type { SettingsForm } from './form';

const CODEBUILD_DEFAULT: DeployIntegration = { provider: 'codebuild', region: 'us-east-1', projects: {} };
const GITHUB_DEFAULT: DeployIntegration = { provider: 'github_actions', workflow: 'slop-deploy.yml' };

/**
 * How branch deploys run: none, CodeBuild (a project per environment) or GitHub
 * Actions (a workflow file). Either runs the repo's `.sstor/deploy.sh <env>`.
 */
const DeploySettings = ({
  deploy,
  environments,
  disabled,
  onChange,
}: {
  deploy: DeployIntegration | null;
  environments: readonly string[];
  disabled: boolean;
  onChange: (deploy: DeployIntegration | null) => void;
}) => (
  <SettingBlock title='Branch deploys' hint="How a glob's branch is put on an environment so it can be tried out." testId='deploy-settings'>
    <Field label='Deploys run with' hint='The service that runs your deploy script for a branch.'>
      {(props) => (
        <Select
          {...props}
          value={deploy?.provider ?? ''}
          disabled={disabled}
          onChange={(e) =>
            onChange(e.target.value === 'codebuild' ? CODEBUILD_DEFAULT : e.target.value === 'github_actions' ? GITHUB_DEFAULT : null)
          }
        >
          <option value=''>No deploys</option>
          <option value='codebuild'>AWS CodeBuild</option>
          <option value='github_actions'>GitHub Actions</option>
        </Select>
      )}
    </Field>
    {deploy?.provider === 'codebuild' && (
      <>
        <Field label='Region' hint='The AWS region the CodeBuild projects are in.'>
          {(props) => <Input {...props} value={deploy.region} disabled={disabled} onChange={(e) => onChange({ ...deploy, region: e.target.value })} />}
        </Field>
        {environments.map((env) => (
          <Field key={env} label={`Project for ${env}`} hint='The CodeBuild project that deploys this environment.'>
            {(props) => (
              <Input
                {...props}
                value={deploy.projects[env] ?? ''}
                disabled={disabled}
                onChange={(e) => {
                  const rest = Object.fromEntries(Object.entries(deploy.projects).filter(([name]) => name !== env));
                  onChange({ ...deploy, projects: e.target.value.trim() === '' ? rest : { ...rest, [env]: e.target.value } });
                }}
              />
            )}
          </Field>
        ))}
        <p className='text-xs text-muted-foreground'>
          Each push to a glob with one of these environments starts the project at exactly that commit; it runs{' '}
          <code>.sstor/deploy.sh &lt;env&gt;</code>. Results come back through EventBridge.
        </p>
      </>
    )}
    {deploy?.provider === 'github_actions' && (
      <Field label='Workflow file' hint='The GitHub Actions workflow that deploys a branch.'>
        {(props) => <Input {...props} value={deploy.workflow} disabled={disabled} onChange={(e) => onChange({ ...deploy, workflow: e.target.value })} />}
      </Field>
    )}
  </SettingBlock>
);

const ATF_PUSH_DEFAULT: AtfIntegration = { provider: 'codebuild', region: 'us-east-1', project: '', mode: 'push' };

/**
 * How the board's ATF stage learns which specs to run after a deploy. Pull (the default, nothing to set): the pipeline's
 * `.sstor/atf-specs.sh` asks slop. Push: slop starts the board's CodeBuild project itself with the list in environment
 * variables. A person sets up the project and the role; slop creates nothing in AWS.
 */
const AtfSettings = ({
  atf,
  disabled,
  onChange,
}: {
  atf: AtfIntegration | null;
  disabled: boolean;
  onChange: (atf: AtfIntegration | null) => void;
}) => (
  <SettingBlock
    title='Acceptance tests after a deploy'
    hint='How the acceptance-test stage finds out which specs to run once a deploy has finished.'
    testId='atf-settings'
  >
    <Field label='The ATF stage gets its spec list' hint='Either the pipeline asks slop for the list, or slop starts the test project itself.'>
      {(props) => (
        <Select
          {...props}
          value={atf?.mode === 'push' ? 'push' : 'pull'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === 'push' ? (atf ?? ATF_PUSH_DEFAULT) : null)}
        >
          <option value='pull'>By asking slop (the pipeline calls the spec list endpoint)</option>
          <option value='push'>From slop starting the CodeBuild project</option>
        </Select>
      )}
    </Field>
    {atf?.mode === 'push' && (
      <>
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field label='Region' hint='The AWS region of the ATF project.'>
            {(props) => <Input {...props} value={atf.region} disabled={disabled} onChange={(e) => onChange({ ...atf, region: e.target.value })} />}
          </Field>
          <Field label='ATF project' hint='The CodeBuild project slop starts to run the specs.'>
            {(props) => <Input {...props} value={atf.project} disabled={disabled} onChange={(e) => onChange({ ...atf, project: e.target.value })} />}
          </Field>
        </div>
        <Field label='Role slop assumes to start it' hint="Blank means slop uses its own role.">
          {(props) => (
            <Input
              {...props}
              value={atf.roleArn ?? ''}
              disabled={disabled}
              placeholder='arn:aws:iam::123456789012:role/slop-start-atf'
              onChange={(e) => {
                const roleArn = e.target.value.trim();
                onChange({
                  provider: atf.provider,
                  region: atf.region,
                  project: atf.project,
                  mode: atf.mode,
                  ...(roleArn === '' ? {} : { roleArn }),
                });
              }}
            />
          )}
        </Field>
        <p className='text-xs text-muted-foreground'>
          When started, slop gives the project <code>SLOP_ATF_SPECS</code>, <code>SLOP_ATF_GREP</code>,{' '}
          <code>SLOP_ENVIRONMENT</code> and <code>SLOP_SHA</code>. Someone with AWS access must allow{' '}
          <code>codebuild:StartBuild</code> on the project for slop's role (or for the role above, which must trust slop's
          role for <code>sts:AssumeRole</code>). A failed start never blocks anything.
        </p>
        <p className='text-xs text-muted-foreground'>
          Only a server admin can turn push mode on or change its project or role, and only for projects and role accounts on
          the server's allow-list.
        </p>
        {atf.externalId !== undefined && (
          <p className='text-xs text-muted-foreground' data-testid='atf-external-id'>
            ExternalId slop sends when it assumes the role: <code>{atf.externalId}</code>. Put it in the role's trust policy as an{' '}
            <code>sts:ExternalId</code> condition.
          </p>
        )}
      </>
    )}
  </SettingBlock>
);

export const EnvironmentsGroup = ({ admin, form }: { admin: boolean; form: SettingsForm }) => {
  const { envs, setEnvs } = form;
  return (
    <SettingsGroup id='environments'>
      <SettingBlock title='Environments' hint="The dev environments a glob's branch can be deployed to." testId='environments'>
        <ul className='grid gap-0.5 text-xs text-muted-foreground' data-testid='environment-hints'>
          <li>Branch deploys: glob branches may be deployed to this environment. Each new code glob gets a free one.</li>
          <li>Slop does not track the rest of the pipeline; a step that must also run there is ticked by a person.</li>
        </ul>
        {envs.map((env, i) => (
          <div key={i} className='flex flex-wrap items-center gap-2'>
            <Input
              className='min-w-32 flex-1'
              aria-label='Environment name'
              value={env.name}
              disabled={!admin}
              onChange={(e) => setEnvs(envs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <label className='flex shrink-0 items-center gap-1 text-xs'>
              <input
                type='checkbox'
                disabled={!admin}
                checked={env.allowBranchDeploy}
                onChange={(e) => setEnvs(envs.map((x, j) => (j === i ? { ...x, allowBranchDeploy: e.target.checked } : x)))}
              />
              branch deploys
            </label>
            {admin && (
              <Button variant='ghost' size='sm' onClick={() => setEnvs(envs.filter((_, j) => j !== i))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {admin && (
          <div>
            <Button variant='outline' size='sm' onClick={() => setEnvs([...envs, { name: '', allowBranchDeploy: true }])}>
              Add environment
            </Button>
          </div>
        )}
      </SettingBlock>
      <DeploySettings
        deploy={form.deploy}
        environments={envs.filter((e) => e.allowBranchDeploy && e.name.trim() !== '').map((e) => e.name)}
        disabled={!admin}
        onChange={form.setDeploy}
      />
      <AtfSettings atf={form.atf} disabled={!admin} onChange={form.setAtf} />
      <SaveButton visible={admin} pending={form.save.isPending} invalid={false} onSave={() => form.save.mutate()} />
    </SettingsGroup>
  );
};
