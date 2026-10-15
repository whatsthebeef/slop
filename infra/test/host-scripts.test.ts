import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const deployDir = join(__dirname, '../deploy');

// A stub `aws` that records every call and answers the lookups the scripts make; `cdk` just records its arguments.
const AWS_STUB = `#!/bin/bash
echo "aws $*" >> "$STUB_DIR/calls.log"
case "$*" in
  *"OutputKey=='DeployProject'"*) echo deploy-proj ;;
  *"OutputKey=='InstanceId'"*) cat "$STUB_DIR/instance" 2>/dev/null || echo i-0abc ;;
  *"OutputKey=='PublicUrl'"*) echo https://slop.example.test ;;
  *"batch-get-projects"*) echo conn-arn ;;
  *"AWS::CloudFront::Distribution"*) echo DIST1 ;;
  *"AWS::SNS::Topic"*) echo topic-arn ;;
  *"AWS::IAM::Role"*) printf 'role-a\\trole-b\\n' ;;
  *"Aliases.Items"*) echo slop.example.test ;;
  *"ACMCertificateArn"*) echo cert-arn ;;
  *"list-subscriptions-by-topic"*) echo ops@example.test ;;
  *"list-role-policies"*) echo Policy1 ;;
  *"get-role-policy"*) printf 'arn:aws:codebuild:r:1:project/build-a\\tarn:aws:codebuild:r:1:project/build-b\\n' ;;
  *"LaunchTime"*) cat "$STUB_DIR/launch" 2>/dev/null || echo 2026-10-01T00:00:00Z ;;
  *"ImageId"*) echo ami-123 ;;
  *"describe-volumes"*"Attachments"*) echo "\${STUB_VOLUME_ATTACHED:-}" ;;
  *"describe-volumes"*) cat "$STUB_DIR/vstate" 2>/dev/null || echo in-use ;;
  *"detach-volume"*) echo available > "$STUB_DIR/vstate" ;;
  *"attach-volume"*) echo in-use > "$STUB_DIR/vstate" ;;
  *"VolumeAttachment"*) echo "\${STUB_STACK_ATTACHMENT:-}" ;;
  *"/dev/sdf"*) echo "\${STUB_SDF:-vol-456}" ;;
  *"create-snapshot"*) echo snap-1 ;;
  *"send-command"*) echo cmd-1 ;;
  *"get-command-invocation"*"Status"*) echo Success ;;
  *"ssm get-parameter"*) cat "$STUB_DIR/param"; echo ;;
  *"ssm put-parameter"*)
    while [ $# -gt 0 ]; do [ "$1" = --value ] && { printf '%s' "$2" > "$STUB_DIR/param.written"; }; shift; done ;;
  *"describe-change-set"*) cat "$STUB_DIR/changes" 2>/dev/null || printf 'Add\\tAttach\\tAWS::EC2::VolumeAttachment\\tNone\\tNone\\n' ;;
  *"execute-change-set"*) echo in-use > "$STUB_DIR/vstate" ;;
  *"start-build"*) echo build-1 ;;
  *"batch-get-builds"*) echo "\${STUB_BUILD_STATUS:-SUCCEEDED}" ;;
esac
`;
// `cdk deploy --no-execute` only creates the change set; executing it leaves the data volume attached by the stack.
const CDK_STUB = `#!/bin/bash
echo "cdk $*" >> "$STUB_DIR/calls.log"
exit 0
`;
const CURL_STUB = `#!/bin/bash
echo "curl $*" >> "$STUB_DIR/calls.log"
[ -z "$STUB_CURL_FAIL" ]
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slop-host-scripts-'));
  for (const [name, body] of [
    ['aws', AWS_STUB],
    ['cdk', CDK_STUB],
    ['curl', CURL_STUB],
  ] as const) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'calls.log'), '');
});

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(deployDir, script), ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      STUB_DIR: dir,
      SERVER_ENV_POLL_SECONDS: '0',
      HOST_DEPLOY_POLL_SECONDS: '0',
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    calls: readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean),
  };
}

describe('host-deploy.sh', () => {
  const context =
    '-c stage=prod -c deployConnectionArn=conn-arn -c domainName=slop.example.test -c certificateArn=cert-arn ' +
    '-c alertEmail=ops@example.test -c deployProjects=build-a,build-b -c hostAmiId=ami-123 -c hostDataVolumeId=vol-456';
  const created = (calls: string[]) =>
    calls.map((c) => c.replace(/host-deploy-\d{8}T\d{6}Z/, 'host-deploy-CS'));
  const executed = (calls: string[]) => calls.some((c) => c.includes('execute-change-set'));
  const setChanges = (rows: string[][]) =>
    writeFileSync(join(dir, 'changes'), rows.map((r) => r.join('\t')).join('\n') + '\n');
  const HOST = ['Modify', 'Host', 'AWS::EC2::Instance'];

  it('derives the cdk context, shows the diff and stops without --yes', () => {
    const r = run('host-deploy.sh', []);
    expect(r.code).toBe(2);
    expect(r.err).toContain('refusing to deploy without --yes');
    expect(r.calls).toContain(`cdk diff slop-prod-host ${context}`);
    expect(executed(r.calls)).toBe(false);
  });

  const noExecute = '--no-execute --change-set-name host-deploy-CS --require-approval never';
  it('deploys with --yes using the same context', () => {
    const r = run('host-deploy.sh', ['--yes']);
    expect(r.code).toBe(0);
    expect(created(r.calls)).toContain(`cdk deploy slop-prod-host ${context} ${noExecute}`);
    expect(executed(r.calls)).toBe(true);
  });

  it('adds a project to the grants read from the stack', () => {
    const r = run('host-deploy.sh', ['--add-project', 'atf-proj', '--add-project', 'build-a']);
    expect(r.out).toContain('deployProjects=build-a,build-b,atf-proj');
    expect(r.calls).toContain(
      `cdk diff slop-prod-host ${context.replace('build-a,build-b', 'build-a,build-b,atf-proj')}`,
    );
  });

  it('refuses an invalid project name before any cdk call', () => {
    const r = run('host-deploy.sh', ['--add-project', 'bad name', '--yes']);
    expect(r.code).toBe(2);
    expect(r.calls.some((c) => c.startsWith('cdk'))).toBe(false);
  });

  describe('the data volume', () => {
    const attached = { STUB_VOLUME_ATTACHED: 'attached' };
    const noCdk = (calls: string[]) => calls.filter((c) => c.startsWith('cdk'));

    it('--data-volume overrides the /dev/sdf lookup', () => {
      const r = run('host-deploy.sh', ['--data-volume', 'vol-789', '--yes'], { STUB_SDF: '' });
      expect(r.code).toBe(0);
      expect(created(r.calls)).toContain(
        `cdk deploy slop-prod-host ${context.replace('vol-456', 'vol-789')} ${noExecute}`,
      );
    });

    it('refuses prod without a data volume', () => {
      const r = run('host-deploy.sh', ['--yes'], { STUB_SDF: 'None' });
      expect(r.code).toBe(2);
      expect(r.err).toContain('--data-volume');
      expect(noCdk(r.calls)).toEqual([]);
    });

    it('stops before cdk when the volume is attached outside the stack', () => {
      const r = run('host-deploy.sh', ['--yes'], attached);
      expect(r.code).toBe(3);
      expect(r.err).toContain('has no AWS::EC2::VolumeAttachment');
      expect(r.err).toContain('--hand-over-volume');
      expect(noCdk(r.calls)).toEqual([]);
    });

    it('deploys as usual when the stack already owns the attachment', () => {
      const r = run('host-deploy.sh', ['--yes'], { ...attached, STUB_STACK_ATTACHMENT: 'att-1' });
      expect(r.code).toBe(0);
    });

    it('--hand-over-volume snapshots, detaches, deploys, then mounts and restarts', () => {
      const r = run('host-deploy.sh', ['--hand-over-volume', '--yes'], {
        ...attached,
        HANDOVER_POLL_SECONDS: '0',
      });
      expect(r.code).toBe(0);
      const at = (needle: string) => r.calls.findIndex((c) => c.includes(needle));
      const order = [
        'create-snapshot',
        'snapshot-completed',
        'send-command',
        'detach-volume',
        'execute-change-set',
      ].map(at);
      expect(order.every((i) => i >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(r.calls.filter((c) => c.includes('send-command'))).toHaveLength(2);
      expect(r.calls.some((c) => c.includes('attach-volume'))).toBe(false);
    });

    it('--hand-over-volume re-attaches the volume when the deploy fails', () => {
      const awsStub = readFileSync(join(dir, 'aws'), 'utf8').replace(
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate" ;;',
        '*"execute-change-set"*) exit 1 ;;',
      );
      writeFileSync(join(dir, 'aws'), awsStub);
      writeFileSync(
        join(dir, 'cdk'),
        '#!/bin/bash\necho "cdk $*" >> "$STUB_DIR/calls.log"\nexit 0\n',
      );
      const r = run('host-deploy.sh', ['--hand-over-volume', '--yes'], {
        ...attached,
        HANDOVER_POLL_SECONDS: '0',
      });
      expect(r.code).toBe(1);
      expect(
        r.calls.some(
          (c) => c.startsWith('aws ec2 attach-volume') && c.includes('--device /dev/sdf'),
        ),
      ).toBe(true);
    });

    it('--hand-over-volume changes nothing when the confirmation is declined', () => {
      const r = run('host-deploy.sh', ['--hand-over-volume'], attached);
      expect(r.code).toBe(2);
      expect(
        r.calls.some((c) => c.includes('create-snapshot') || c.includes('detach-volume')),
      ).toBe(false);
    });
  });

  describe('the change set', () => {
    it('refuses a change set that replaces the instance, and executes nothing', () => {
      setChanges([[...HOST, 'True', 'ImageId']]);
      const r = run('host-deploy.sh', ['--yes']);
      expect(r.code).toBe(4);
      expect(r.err).toContain('would be replaced');
      expect(r.err).toContain('--allow-replace');
      expect(r.err).toContain('HOST.md');
      expect(executed(r.calls)).toBe(false);
    });

    it('refuses a Conditional replacement and a volume added in prod', () => {
      setChanges([[...HOST, 'Conditional', 'BlockDeviceMappings']]);
      expect(run('host-deploy.sh', ['--yes']).code).toBe(4);
      setChanges([['Add', 'DataVolume', 'AWS::EC2::Volume', 'None', 'None']]);
      const r = run('host-deploy.sh', ['--yes']);
      expect(r.code).toBe(4);
      expect(r.err).toContain('data volume');
      expect(run('host-deploy.sh', ['--yes', '--stage', 'dev']).code).toBe(0);
    });

    it('--allow-replace executes the reviewed change set', () => {
      setChanges([[...HOST, 'True', 'ImageId']]);
      const r = run('host-deploy.sh', ['--yes', '--allow-replace']);
      expect(r.code).toBe(0);
      expect(r.err).toContain('--allow-replace');
      const create = r.calls.findIndex((c) => c.startsWith('cdk deploy'));
      const run_ = r.calls.find((c) => c.includes('execute-change-set'));
      expect(create).toBeGreaterThanOrEqual(0);
      expect(run_).toMatch(/--change-set-name host-deploy-\d{8}T\d{6}Z/);
      expect(r.calls.filter((c) => c.startsWith('cdk deploy'))).toHaveLength(1);
    });

    it('deploys nothing when there are no changes', () => {
      setChanges([]);
      writeFileSync(join(dir, 'changes'), '');
      const r = run('host-deploy.sh', ['--yes']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('No changes');
      expect(executed(r.calls)).toBe(false);
    });
  });

  describe('redeploying slop after the host deploy', () => {
    const builds = (calls: string[]) => calls.filter((c) => c.includes('start-build'));

    it('does not redeploy when the instance is unchanged', () => {
      const r = run('host-deploy.sh', ['--yes']);
      expect(r.code).toBe(0);
      expect(builds(r.calls)).toEqual([]);
    });

    it('redeploys and checks the public URL when the launch time changed (stop/start)', () => {
      // the first read is before the deploy; the stub's execute-change-set moves the launch time
      const awsStub = readFileSync(join(dir, 'aws'), 'utf8').replace(
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate" ;;',
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate"; echo 2026-10-15T18:03:00Z > "$STUB_DIR/launch" ;;',
      );
      writeFileSync(join(dir, 'aws'), awsStub);
      const r = run('host-deploy.sh', ['--yes']);
      expect(r.code).toBe(0);
      expect(builds(r.calls)).toEqual([
        'aws codebuild start-build --project-name deploy-proj --query build.id --output text',
      ]);
      expect(r.calls).toContain('curl -fsS -m 10 https://slop.example.test/auth/config');
      expect(r.calls.some((c) => c.includes('instance-status-ok'))).toBe(true);
    });

    it('redeploys when the instance id changed (replacement)', () => {
      setChanges([[...HOST, 'True', 'ImageId']]);
      const awsStub = readFileSync(join(dir, 'aws'), 'utf8').replace(
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate" ;;',
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate"; echo i-0new > "$STUB_DIR/instance" ;;',
      );
      writeFileSync(join(dir, 'aws'), awsStub);
      const r = run('host-deploy.sh', ['--yes', '--allow-replace']);
      expect(r.code).toBe(0);
      expect(builds(r.calls)).toHaveLength(1);
    });

    it('fails, with the build log, when the redeploy build fails or the URL does not answer', () => {
      writeFileSync(join(dir, 'launch'), 'x');
      const awsStub = readFileSync(join(dir, 'aws'), 'utf8').replace(
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate" ;;',
        '*"execute-change-set"*) echo in-use > "$STUB_DIR/vstate"; echo y > "$STUB_DIR/launch" ;;',
      );
      writeFileSync(join(dir, 'aws'), awsStub);
      const failed = run('host-deploy.sh', ['--yes'], { STUB_BUILD_STATUS: 'FAILED' });
      expect(failed.code).toBe(1);
      expect(failed.calls.some((c) => c.includes('get-log-events'))).toBe(true);
      writeFileSync(join(dir, 'launch'), 'x');
      const down = run('host-deploy.sh', ['--yes'], { STUB_CURL_FAIL: '1' });
      expect(down.code).toBe(1);
      expect(down.err).toContain('does not answer');
    });
  });

  it('only reads from aws, apart from executing its change set', () => {
    const r = run('host-deploy.sh', ['--stage', 'dev', '--yes']);
    expect(
      r.calls
        .filter((c) => c.startsWith('aws '))
        .every((c) => /\b(describe|get|list|batch-get|execute-change-set|wait)\b/.test(c)),
    ).toBe(true);
    expect(r.calls.some((c) => c.startsWith('cdk diff slop-dev-host -c stage=dev'))).toBe(true);
  });
});

describe('server-env.sh', () => {
  const original = 'AUTH_MODE=cognito\nFOO=old\n\nBAR=keep me  \nDUP=1\nDUP=2\n';
  beforeEach(() => writeFileSync(join(dir, 'param'), original));
  const written = () => readFileSync(join(dir, 'param.written'), 'utf8');

  it('changes only the named lines, byte for byte elsewhere', () => {
    const r = run('server-env.sh', ['set', 'FOO=new', 'ADDED=x=y', '--unset', 'DUP']);
    expect(r.code).toBe(0);
    expect(written()).toBe('AUTH_MODE=cognito\nFOO=new\n\nBAR=keep me  \nADDED=x=y\n');
    expect(r.out).not.toContain('new');
    expect(r.calls.some((c) => c.includes('start-build'))).toBe(false);
  });

  it('keeps a missing final newline', () => {
    writeFileSync(join(dir, 'param'), 'A=1\nB=2');
    run('server-env.sh', ['set', 'A=3']);
    expect(written()).toBe('A=3\nB=2');
  });

  it('writes nothing when nothing changes, and on --dry-run', () => {
    expect(
      run('server-env.sh', ['set', 'FOO=old']).calls.some((c) => c.includes('put-parameter')),
    ).toBe(false);
    expect(
      run('server-env.sh', ['set', 'FOO=new', '--dry-run']).calls.some((c) =>
        c.includes('put-parameter'),
      ),
    ).toBe(false);
  });

  it('starts the build only with --redeploy, and waits for it', () => {
    const r = run('server-env.sh', ['set', 'FOO=new', '--redeploy']);
    expect(r.code).toBe(0);
    expect(r.calls).toContain(
      'aws codebuild start-build --project-name deploy-proj --query build.id --output text',
    );
    expect(r.calls.some((c) => c.includes('batch-get-builds'))).toBe(true);
    expect(
      run('server-env.sh', ['--stage', 'prod', 'set', 'FOO=new', '--redeploy'], {
        STUB_BUILD_STATUS: 'FAILED',
      }).code,
    ).toBe(1);
  });

  it('rejects bad input', () => {
    expect(run('server-env.sh', ['set', 'bad key=1']).code).toBe(2);
    expect(run('server-env.sh', ['FOO=1']).code).toBe(2);
  });
});
