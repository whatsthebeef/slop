import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const agent = (name: string): Promise<string> => readFile(new URL(`../../../catalog/agents/agents/${name}.md`, import.meta.url), 'utf8');

describe('catalog agents: human steps and rollout', () => {
  it('has the investigator predict human steps and a rollout', async () => {
    const text = await agent('investigator');
    expect(text).toContain('## Human steps');
    expect(text).toContain('`needsRollout`');
  });

  it('has the implementer write a concrete ## Rollout and never run paid-infrastructure steps', async () => {
    const text = await agent('implementer');
    expect(text).toContain('## Rollout');
    expect(text).toContain('infra/deploy/host-deploy.sh');
    expect(text).toContain('infra/deploy/server-env.sh');
    expect(text).toContain('Never run a step that changes paid infrastructure or IAM');
  });

  it('has the implementer write steps as a short title plus Why / Permissions / Run / Check lines, and say what is not a step', async () => {
    const text = await agent('implementer');
    expect(text).toContain('`Why:`');
    expect(text).toContain('`Permissions:`');
    expect(text).toContain('`Run:` one exact command per line');
    expect(text).toContain('`Check:`');
    expect(text).toContain('What is not a rollout step');
  });

  it('has the implementer put each command-sequence step in a script with its permissions, from the template, and never run it', async () => {
    const text = await agent('implementer');
    expect(text).toContain('`Permissions:`');
    expect(text).toContain('Scripts for steps');
    expect(text).toContain('script: <path>');
    expect(text).toContain('scripts/rollout/<glob-id>-<slug>.sh');
    expect(text).toContain('catalog/scripts/step-template.sh');
    expect(text).toContain('You never run it for real');
  });

  it('has the orchestrator require the script and the permissions before the record is written', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('A step that is a command sequence comes with a script.');
    expect(text).toContain('**Permissions:**');
  });

  it('has the change reviewer check the script is in the diff, follows the template shape and passes bash -n and shellcheck', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('`script: <path>` line is missing');
    expect(text).toContain('catalog/scripts/step-template.sh');
    expect(text).toContain('`bash -n` and `shellcheck`');
    expect(text).toContain('`**Permissions:**` line');
  });

  it('has the change reviewer flag notes, pre-merge reviews and optional setup filed as steps', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('a note with no action posing as a step');
    expect(text).toContain('due before the merge');
    expect(text).toContain('optional setup');
  });

  it('has the change reviewer flag a missing or incomplete Rollout as in scope', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('### 10. Check the rollout');
    expect(text).toMatch(/missing section[\s\S]*`IN-SCOPE`/);
  });

  it('has the orchestrator record the Rollout, list the human steps and forbid paid-infrastructure steps', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('## Rollout          (only when');
    expect(text).toContain('## Human steps');
    expect(text).toContain('Agents never run steps that change paid infrastructure or IAM');
    expect(text).toContain('list the human steps');
  });

  it('has the implementer, orchestrator and change reviewer apply the revert test and file other work as an action glob', async () => {
    for (const name of ['implementer', 'orchestrator']) {
      const text = await agent(name);
      expect(text).toContain('The revert test: if this glob were reverted, would the work still be needed?');
      expect(text).toContain('write a rollout step on this glob');
      expect(text).toContain('create an action glob instead (`create_glob` with category `action`, no type, on the right board');
      expect(text).toContain('Never file optional setup as a blocking step.');
      expect(text).toContain('`complete_action`');
      expect(text).toContain('`dismiss_action`');
      expect(text).toContain('Why / Do this (the script path and run command) / Permissions / Check it worked');
    }
    const orchestrator = await agent('orchestrator');
    expect(orchestrator).toContain('lists each action glob you created, with its ID');
    const reviewer = await agent('change_reviewer');
    expect(reviewer).toContain('fails the revert test');
    expect(reviewer).toContain('action glob');
    expect(await agent('investigator')).toContain('revert test');
  });
});

describe('catalog agents: an action waits for its script', () => {
  for (const name of ['implementer', 'orchestrator']) {
    it(`has the ${name} relate an action to the glob that builds its script and name the script`, async () => {
      const text = await agent(name);
      expect(text).toContain('An action that runs a script written by this glob or another open glob waits for it');
      expect(text).toContain('`gate: start`, `until: merged` and the reason "builds its script"');
      expect(text).toContain('`script: <repo path>`');
      expect(text).toContain('refuses Done on the action');
    });

    it(`keeps board-specific paths out of the ${name}'s action rule`, async () => {
      const rule = (await agent(name)).split('\n').find((l) => l.startsWith('- **An action that runs a script')) ?? '';
      expect(rule).not.toBe('');
      expect(rule).not.toMatch(/pocketlab|scripts\/rollout\/s\d+t\d+/i);
    });
  }
});

describe('catalog agents: pre-checks, prerequisites and off-process changes', () => {
  it('has the implementer put pre-checks inside scripted infrastructure steps and say when one cannot be pre-checked', async () => {
    const text = await agent('implementer');
    expect(text).toContain('A scripted infrastructure step carries its pre-checks inside the script.');
    expect(text).toContain('`precheck_iam_policy`');
    expect(text).toContain('`precheck_cfn_change_set`');
    expect(text).toContain('`precheck_buildspec`');
    expect(text).toContain('`precheck_policy_json`');
    expect(text).toContain('A step that cannot be pre-checked');
    expect(text).toContain('bash catalog/scripts/step-template.test.sh');
  });

  it('has the investigator tie risk paths and rollout steps to pre-checks and list prerequisites', async () => {
    const text = await agent('investigator');
    expect(text).toContain('is a same, never a sub');
    expect(text).toContain('implies a script with pre-checks');
    expect(text).toContain('each prerequisite the step needs');
  });

  it("has the change reviewer check each step's prerequisites and the pre-checks inside scripted infrastructure steps", async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain("a rollout step whose prerequisites don't exist");
    expect(text).toContain('s14t13');
    expect(text).toMatch(/missing prerequisite is an `IN-SCOPE` finding/);
    expect(text).toContain('whose script has no pre-checks inside it');
    expect(text).toContain('no `trap` cleanup of temporary resources');
  });

  it('has the orchestrator merge rollout globs with Merge and continue and work the checklist from get_glob', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('A glob with rollout steps is merged with Merge and continue.');
    expect(text).toContain('`sstor --glob <id>`');
    expect(text).toContain('call `get_glob` to see which steps are still due');
  });

  it('has the orchestrator start the next generation on a failed step and read the failure attachment', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain("A failed step starts the glob's next generation.");
    expect(text).toContain('report it with `fail_human_step`');
    expect(text).toContain('the glob id, step id and the error as a note');
    expect(text).toContain('strip credentials');
    expect(text).toContain('`Rollout step failed (generation N)`');
    expect(text).toContain('fresh branch from master');
    expect(text).toContain('returns it in full by default');
  });

  it('lists risk_path among the orchestrator\'s escalate_to_same criteria', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('`open_findings`, `risk_path` or `other`');
  });

  it('has the orchestrator update the steps for changes made outside the flow with the existing step tools, never running paid steps', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('Changes made outside the flow.');
    expect(text).toContain('`complete_human_step` with a `note`');
    expect(text).toContain('`dismiss_human_step` with a reason');
    expect(text).toContain('`add_human_step`');
    expect(text).toContain('an edit is a dismiss plus an add');
    expect(text).toContain('never run steps that change paid infrastructure or IAM');
  });
});

describe('catalog agents: relations carry a reason and reach across boards', () => {
  for (const name of ['implementer', 'orchestrator']) {
    it(`has the ${name} pass relations explicitly with a reason, as holds or supersedes where they fit`, async () => {
      const text = await agent(name);
      expect(text).toContain("A prerequisite on another board's glob is a relation to that glob (cross-board), not prose");
      expect(text).toContain('`holds` (alias `follows_up`');
      expect(text).toContain('`supersedes`');
      expect(text).toContain('never rely on prose alone');
    });
  }

  it('has the orchestrator pass reasons, read the reply and report a failed rollout step', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('`needs`/`after` WITH `reason`');
    expect(text).toContain('`relations: [{to, reason}]`');
    expect(text).toContain('`ignoredAfter`, `waitingFor`, `holds` and `typeNote`');
    expect(text).toContain('fix the plan if an id was ignored');
    expect(text).toContain('`fail_human_step`');
    expect(text).toContain('this step failed: is there a fix glob?');
  });

  it('has the implementer read ignoredAfter and put the order between rollout steps in Why and a relation', async () => {
    const text = await agent('implementer');
    expect(text).toContain('read `ignoredAfter` and `waitingFor` in the reply');
    expect(text).toContain("An ordering between rollout steps goes in the step's `Why:`");
  });

  it('has the investigator say agents pass the relation reason through on create', async () => {
    const text = await agent('investigator');
    expect(text).toContain('agents pass it through on create');
    expect(text).toContain('A glob on another board is a valid `to`.');
  });
});

describe('catalog agents: when a step falls due (once, per environment, after the merge)', () => {
  for (const name of ['implementer', 'orchestrator']) {
    it(`has the ${name} choose once, dev-environment or after-merge timing for each command`, async () => {
      const text = await agent(name);
      expect(text).toContain('**When a step falls due: once, on the dev environment, or after the merge.**');
      expect(text).toContain('Work either takes effect by deploying it');
      expect(text).toContain('by doing it');
      expect(text).toContain('end its title with `(once)` and give it no `env`');
      expect(text).toContain('done once and never reopened');
      expect(text).toContain("using only names from `get_board`'s `environments`");
      expect(text).toContain('`downstream`');
      expect(text).toContain("names come from the board's environments knowledge doc");
      expect(text).not.toMatch(/promotion order|report-deploy|Mark deployed/);
      expect(text).toContain('can fall due before the merge');
      expect(text).toContain('Only a step that needs the base branch to have the change is a plain after-merge step');
      expect(text).toContain('Split mixed commands into separate steps');
    });
  }

  it('has the investigator say when each human step falls due', async () => {
    const text = await agent('investigator');
    expect(text).toContain('`once` (environment-independent and one-shot');
    expect(text).toContain('only names from `get_board`');
    expect(text).toContain('`downstream`');
  });

  it('has the change reviewer flag misfiled steps as in scope', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('steps filed at the wrong time (each is `IN-SCOPE`)');
    expect(text).toContain('not marked `(once)`');
    expect(text).toContain('`downstream`');
    expect(text).toContain('commands for a branch-deploy environment held back until after the merge');
  });
});

describe('catalog agents: actions that take effect by doing', () => {
  it('has the orchestrator prepare an action: write it, dry run, review, push to the action record, mark ready, never run it', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('## Preparing an action');
    expect(text).toContain('with purpose `prepare`');
    expect(text).toContain('a dry run (`--check` or `--dry-run`, read-only)');
    expect(text).toContain("commit and push only to the action's own branch");
    expect(text).toContain("put_artifact(id, kind: 'rollout_script'");
    expect(text).toContain('**Never run a command that changes paid infrastructure or IAM, and never run the script itself**');
    expect(text).toContain('Call `mark_ready(id, runId)`. That ends the run');
    expect(text).toContain('Action run failed (round N)');
    expect(text).toContain('treat it as in-scope feedback');
    expect(text).toContain('labels, environments, rollout steps, after-deploy steps and Arm label');
  });

  it('has the orchestrator say work that takes effect by doing is a prepared action, and when a once step stays', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('**Takes effect by deploying or by doing.**');
    expect(text).toContain('`prepare: true`');
    expect(text).toContain('a `once` step stays for work that ships with a change');
  });

  it('has the investigator recommend an action rather than a same when the change takes effect by doing', async () => {
    const text = await agent('investigator');
    expect(text).toContain('## Takes effect by');
    expect(text).toContain('recommend an **action**');
    expect(text).toContain('rather than a `same`');
    expect(text).toContain('A shipped change that also needs one one-shot command afterwards stays a `same` with a `once` step');
  });

  it('has the implementer and change reviewer each carry one line about prepared actions', async () => {
    expect(await agent('implementer')).toContain('**A prepared action is written, never run.**');
    expect(await agent('change_reviewer')).toContain('should be a prepared action');
  });

  it('keeps board-specific names out of the new text', async () => {
    const orchestrator = await agent('orchestrator');
    const investigator = await agent('investigator');
    const sections = [
      orchestrator.slice(orchestrator.indexOf('## Preparing an action'), orchestrator.indexOf('## Investigate-only runs')),
      investigator.slice(investigator.indexOf('## Takes effect by'), investigator.indexOf('## Human steps')),
    ];
    for (const text of sections) {
      expect(text.length).toBeGreaterThan(200);
      expect(text).not.toMatch(/\bs\d+[a-z]\d+\b|pocketlab/i);
    }
  });
});
