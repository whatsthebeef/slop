// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import { viewSections } from '../src/components/glob-view/sections';
import type { GlobView, ListedHumanStep } from '../src/lib/api';
import { hasDueSteps } from '../src/lib/human-steps';
import { groupText, stageGroups } from '@slop/core';
import { glob as coreGlob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const step = (over: Partial<ListedHumanStep> & Pick<ListedHumanStep, 'id' | 'state'>): ListedHumanStep => ({
  kind: 'rollout',
  title: `Step ${over.id}`,
  who: 'admin',
  due: 'after_merge',
  blocks: ['sign_off'],
  ...over,
});

const show = (
  humanSteps: ListedHumanStep[],
  handlers = { onComplete: vi.fn(() => Promise.resolve(true)), onDismiss: vi.fn(() => Promise.resolve(true)) },
  status: GlobView['status'] = 'in_progress',
) => {
  const glob = { ...coreGlob(), status, list: 'doing', branch: 's1t1', currentRun: null, humanSteps } as GlobView;
  render(
    <MemoryRouter>
      <HumanSteps glob={glob} canAdd onAdd={vi.fn(() => Promise.resolve(true))} {...handlers} />
    </MemoryRouter>,
  );
  return handlers;
};

describe('due steps block', () => {
  it('is a needs-a-person block of the shared family: head with the count, the steps as its body, no Markdown', () => {
    show([step({ id: 'a', state: 'due', detail: 'Do this: **run** it' })]);
    const block = screen.getByTestId('due-steps');
    expect(block.getAttribute('data-block')).toBe('person');
    expect(block.querySelector('[data-testid="block-head"]')?.textContent).toBe('A step needs you');
    expect(block.querySelector('[data-testid="block-body"] [data-testid="due-step"]')).not.toBeNull();
  });

  it('renders each due step as a card with its text, who, script command, Done and Dismiss', async () => {
    const detail = 'Why: the host needs it\nDo this: run the script\nPermissions: admin\nCheck it worked: it prints ok';
    const h = show([step({ id: 'a', state: 'due', detail, script: { path: 'scripts/x.sh' } }), step({ id: 'b', state: 'due' })]);
    expect(screen.getByTestId('due-steps').textContent).toContain('2 steps need you');
    expect(screen.getAllByTestId('due-step')).toHaveLength(2);
    const first = screen.getAllByTestId('due-step')[0] as HTMLElement;
    expect(first.querySelector('[data-testid="step-detail"]')?.textContent).toBe(detail);
    expect(first.querySelector('[data-testid="step-script-path"]')?.textContent).toBe('bash scripts/x.sh');
    expect(first.querySelector('[data-testid="step-who"]')?.textContent).toBe('for the admin');
    await userEvent.click(first.querySelector('[data-testid="due-done"]') as HTMLElement);
    expect(h.onComplete).toHaveBeenCalledWith('a');
    await userEvent.click(first.querySelector('[data-testid="due-dismiss"]') as HTMLElement);
    await userEvent.type(screen.getByTestId('dismiss-reason'), 'wrong');
    await userEvent.click(screen.getByTestId('dismiss-confirm'));
    expect(h.onDismiss).toHaveBeenCalledWith('a', 'wrong');
  });

  it('shows a due step in Planning as read-only text: no Done, Dismiss or It failed', () => {
    show([step({ id: 'a', state: 'due' })], undefined, 'planning');
    expect(screen.getByTestId('due-step')).toBeTruthy();
    expect(screen.queryByTestId('due-done')).toBeNull();
    expect(screen.queryByTestId('due-dismiss')).toBeNull();
    expect(screen.queryByTestId('due-failed')).toBeNull();
  });

  it('lays a structured step out as Why, Before you start, Run (script command once, then each command in a copy box) and Check it worked', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    show([
      step({
        id: 'a',
        state: 'due',
        why: 'The buildspec declares an atf report group',
        permissions: 'An AWS session in the prod account',
        script: { path: 'scripts/x.sh' },
        commands: ['aws sso login', 'aws codebuild list-report-groups'],
        verify: 'The list shows the atf group',
      }),
    ]);
    const card = screen.getByTestId('due-step');
    const text = card.textContent;
    expect(card.querySelector('[data-testid="step-why"]')?.textContent).toContain('Why:The buildspec declares an atf report group');
    expect(card.querySelector('[data-testid="step-permissions"]')?.textContent).toContain('An AWS session in the prod account');
    expect(card.querySelector('[data-testid="step-verify"]')?.textContent).toContain('The list shows the atf group');
    expect(card.querySelectorAll('[data-testid="step-script-path"]')).toHaveLength(1);
    expect(text.split('scripts/x.sh')).toHaveLength(2);
    const commands = [...card.querySelectorAll('[data-testid="step-command"]')].map(
      (c) => c.textContent,
    );
    expect(commands).toEqual(['aws sso login', 'aws codebuild list-report-groups']);
    expect(card.querySelectorAll('button[data-testid="step-command-copy"]')).toHaveLength(2);
    expect(text).not.toContain('`');
    await userEvent.click(
      card.querySelectorAll('[data-testid="step-command-copy"]')[1] as HTMLElement,
    );
    expect(write).toHaveBeenCalledWith('aws codebuild list-report-groups');
  });

  describe('run order (s15b164)', () => {
    const order = (commands: string[] | undefined, path = 'scripts/rollout/s14t14.sh') => {
      show([step({ id: 'a', state: 'due', script: { path }, commands })]);
      const run = screen.getByTestId('step-run');
      return [...run.querySelectorAll('[data-testid="step-command"], [data-testid="step-script-path"]')].map((c) => c.textContent);
    };

    it('shows commands that already run the script as written, with no extra script row', () => {
      const cmds = ['git checkout master', 'git pull', 'bash scripts/rollout/s14t14.sh --dry-run', 'bash scripts/rollout/s14t14.sh', 'unset AWS_PROFILE'];
      expect(order(cmds)).toEqual(cmds);
      expect(screen.getAllByTestId('step-script-path')).toHaveLength(2);
    });

    it('inserts the script run between the setup and the cleanup', () => {
      expect(order(['git checkout master', 'git pull', 'aws sso login --profile p', 'export AWS_PROFILE=p', 'unset AWS_PROFILE'])).toEqual([
        'git checkout master',
        'git pull',
        'aws sso login --profile p',
        'export AWS_PROFILE=p',
        'bash scripts/rollout/s14t14.sh',
        'unset AWS_PROFILE',
      ]);
    });

    it('shows just the run command for a script-only step', () => {
      expect(order(undefined)).toEqual(['bash scripts/rollout/s14t14.sh']);
    });

    it("puts the script after the setup in s14b3's step", () => {
      expect(
        order(['git checkout master', 'git pull', 'aws sso login --sso-session pl', 'export AWS_PROFILE=x', 'unset AWS_PROFILE'], 'scripts/rollout/s14t14-nonprod-permission-set.sh'),
      ).toEqual([
        'git checkout master',
        'git pull',
        'aws sso login --sso-session pl',
        'export AWS_PROFILE=x',
        'bash scripts/rollout/s14t14-nonprod-permission-set.sh',
        'unset AWS_PROFILE',
      ]);
    });
  });

  it('leaves empty fields out, so an old free-text step still renders as its detail alone', () => {
    show([step({ id: 'a', state: 'due', detail: 'Just do it', commands: [] })]);
    const card = screen.getByTestId('due-step');
    expect(screen.getByTestId('step-detail').textContent).toBe('Just do it');
    for (const id of ['step-why', 'step-permissions', 'step-run', 'step-verify', 'step-command'])
      expect(card.querySelector(`[data-testid="${id}"]`)).toBeNull();
  });

  it('renders the step text as Markdown, with a copy button on code blocks', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    show([
      step({
        id: 'a',
        state: 'due',
        detail: '**Why** `code`\n\n```\nmake ship\n```',
        why: 'Needs **admin** rights',
        permissions: 'Use `sudo`',
        verify: 'See **green**',
      }),
    ]);
    const card = screen.getByTestId('due-step');
    expect(card.textContent).not.toMatch(/\*\*|`/);
    expect(card.querySelectorAll('strong')).toHaveLength(3);
    expect(card.querySelectorAll('code').length).toBeGreaterThanOrEqual(2);
    await userEvent.click(card.querySelector('[data-testid="step-code-copy"]') as HTMLElement);
    expect(write).toHaveBeenCalledWith('make ship');
  });

  it('shows a step title as plain text with no Markdown markers', () => {
    show([step({ id: 'a', state: 'due', title: 'Run **the** `thing`' })]);
    expect(screen.getByTestId('step-title').textContent).toBe('Run the thing');
  });

  it('collapses steps not yet due into one quiet line that expands', async () => {
    show([step({ id: 'a', state: 'pending' }), step({ id: 'b', state: 'pending' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(screen.getByTestId('quiet-toggle').textContent).toBe('After the merge: 2 steps, not due yet ▸');
    expect(screen.queryAllByTestId('human-step')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('quiet-toggle'));
    expect(screen.getAllByTestId('human-step')).toHaveLength(2);
  });

  it('shows no block and no quiet line when nothing is due or pending', () => {
    show([step({ id: 'a', state: 'done' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(screen.queryByTestId('quiet-toggle')).toBeNull();
  });

  it('words the quiet line', () => {
    expect(groupText({ stage: 'after_merge', steps: [step({ id: 'a', state: 'pending' })] })).toBe('After the merge: 1 step, not due yet');
    expect(groupText({ stage: 'production', steps: [step({ id: 'a', state: 'pending' }), step({ id: 'b', state: 'pending' })] })).toBe(
      'After the deploy to production: 2 steps, not due yet',
    );
  });
});

describe('steps grouped by stage', () => {
  const deploy = (id: string, env: string, state: ListedHumanStep['state'] = 'pending') => step({ id, state, due: `after_deploy:${env}` as ListedHumanStep['due'] });

  it('orders after the merge first, then the board environments, unknown environments last', () => {
    const groups = stageGroups([deploy('a', 'production'), deploy('b', 'qa'), step({ id: 'c', state: 'pending' }), deploy('d', 'staging')], ['staging', 'production']);
    expect(groups.map((g) => g.stage)).toEqual(['after_merge', 'staging', 'production', 'qa']);
  });

  const showWith = (humanSteps: ListedHumanStep[], patch: Partial<GlobView> = {}) => {
    const glob = { ...coreGlob(), list: 'doing', branch: 's1t1', currentRun: null, humanSteps, ...patch } as GlobView;
    render(
      <MemoryRouter>
        <HumanSteps
          glob={glob}
          canAdd
          environments={['staging', 'production']}
          baseBranch='main'
          onAdd={vi.fn(() => Promise.resolve(true))}
          onComplete={vi.fn(() => Promise.resolve(true))}
          onDismiss={vi.fn(() => Promise.resolve(true))}
        />
      </MemoryRouter>,
    );
  };

  it('renders a not-due environment group as one quiet line, in stage order, with no Mark deployed button', () => {
    showWith([deploy('a', 'production'), deploy('b', 'production'), step({ id: 'c', state: 'pending' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    const lines = screen.getAllByTestId('quiet-toggle').map((el) => el.textContent);
    expect(lines).toEqual(['After the merge: 1 step, not due yet ▸', 'After the deploy to production: 2 steps, not due yet ▸']);
    expect(screen.queryByTestId('mark-deployed')).toBeNull();
  });

  it('shows a downstream step as a non-blocking step in the needs-you block, and says the rest of the pipeline when quiet', () => {
    showWith([step({ id: 'a', state: 'due', due: 'downstream', blocks: [] })]);
    expect(screen.getByTestId('due-step').querySelector('[data-testid="step-downstream"]')?.textContent).toBe("doesn't block");
    expect(groupText({ stage: 'downstream', steps: [step({ id: 'a', state: 'pending', due: 'downstream' })] })).toBe('Rest of the pipeline: 1 step, not due yet');
  });

  it('says where a step runs: the glob\'s dev environment, else the base branch; nothing for a downstream step', () => {
    showWith([step({ id: 'a', state: 'due' }), step({ id: 'b', state: 'due', due: 'downstream', blocks: [] })], { environment: 'dev' });
    const runs = screen.getAllByTestId('step-runs-on');
    expect(runs.map((r) => r.textContent)).toEqual(['Runs on dev']);
    cleanup();
    showWith([step({ id: 'a', state: 'due' })], { environment: null });
    expect(screen.getByTestId('step-runs-on').textContent).toBe('Runs against main');
  });

  it('puts only due steps in the needs-you block, the other stage stays quiet', () => {
    showWith([deploy('a', 'staging', 'due'), deploy('b', 'production')]);
    expect(screen.getAllByTestId('due-step')).toHaveLength(1);
    expect(screen.getByTestId('due-steps').textContent).toContain('A step needs you');
    expect(screen.getAllByTestId('quiet-toggle').map((el) => el.textContent)).toEqual(['After the deploy to production: 1 step, not due yet ▸']);
  });

  it('lists only the next stage, greyed and open, once the glob is merged and waiting on a deploy', () => {
    const glob = { ...coreGlob(), status: 'reviewing', pr: { number: 1, state: 'merged', headSha: 'abc' }, list: 'doing', branch: 's1t1', currentRun: null, humanSteps: [deploy('a', 'staging'), deploy('b', 'production')] } as GlobView;
    render(
      <MemoryRouter>
        <HumanSteps glob={glob} canAdd environments={['staging', 'production']} onAdd={vi.fn(() => Promise.resolve(true))} onComplete={vi.fn(() => Promise.resolve(true))} onDismiss={vi.fn(() => Promise.resolve(true))} />
      </MemoryRouter>,
    );
    const groups = screen.getAllByTestId('quiet-steps');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.getAttribute('data-stage')).toBe('staging');
    expect(groups[0]?.getAttribute('data-upcoming')).toBe('true');
    expect(screen.getAllByTestId('step-title')).toHaveLength(1);
  });

  it('marks a due once step with a once marker in the needs-you block', () => {
    showWith([step({ id: 'a', state: 'due', due: 'once' }), step({ id: 'b', state: 'due' })]);
    const cards = screen.getAllByTestId('due-step');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('[data-testid="step-once"]')?.textContent).toBe('once');
    expect(cards[1]?.querySelector('[data-testid="step-once"]')).toBeNull();
  });

  it('flags a step whose environment the board no longer has, with Dismiss still on offer', async () => {
    showWith([step({ id: 'a', state: 'pending', due: 'after_deploy:prod', unknownEnvironment: 'prod' })]);
    await userEvent.click(screen.getAllByTestId('quiet-toggle')[0] as HTMLElement);
    expect(screen.getByTestId('step-unknown-environment').textContent).toContain('no environment “prod”');
    expect(screen.getByTestId('step-dismiss')).toBeTruthy();
  });

  it('shows an empty due block while the glob is merging with an after-merge step pending', () => {
    showWith([step({ id: 'a', state: 'pending' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
  });
});

describe('where the steps sit in the glob view', () => {
  it('puts the due steps block with the other blocks that need a person, and leaves More steps with the collapsibles', () => {
    const order = viewSections(false, true);
    expect(order.indexOf('due-steps')).toBe(order.indexOf('escalation') - 1);
    expect(order.indexOf('due-steps')).toBeGreaterThan(order.indexOf('labels'));
    expect(order.indexOf('due-steps')).toBeLessThan(order.indexOf('actions'));
    expect(order.indexOf('human-steps')).toBeGreaterThan(order.indexOf('actions'));
    expect(new Set(order).size).toBe(order.length);
    const decision = viewSections(true, true);
    expect(decision.indexOf('due-steps')).toBeGreaterThan(decision.indexOf('decision'));
    expect(decision.indexOf('due-steps')).toBe(decision.indexOf('escalation') - 1);
    expect(decision.indexOf('human-steps')).toBeGreaterThan(decision.indexOf('actions'));
  });

  it('keeps the usual place when nothing is due', () => {
    expect(viewSections(false, false).indexOf('human-steps')).toBe(viewSections(false, false).indexOf('choices') - 1);
  });

  it('counts only live, due work steps', () => {
    expect(hasDueSteps(undefined)).toBe(false);
    expect(hasDueSteps([step({ id: 'a', state: 'pending' }), step({ id: 'b', state: 'dismissed' })])).toBe(false);
    expect(hasDueSteps([step({ id: 'machine:merge', state: 'due' })])).toBe(false);
    expect(hasDueSteps([step({ id: 'a', state: 'due' })])).toBe(true);
  });
});

describe('the two parts of the Human steps', () => {
  const split = (part: 'due' | 'rest', humanSteps: ListedHumanStep[]) => {
    const glob = { ...coreGlob(), list: 'doing', branch: 's1t1', currentRun: null, humanSteps } as GlobView;
    render(
      <MemoryRouter>
        <HumanSteps part={part} glob={glob} canAdd onAdd={vi.fn(() => Promise.resolve(true))} onComplete={vi.fn(() => Promise.resolve(true))} onDismiss={vi.fn(() => Promise.resolve(true))} />
      </MemoryRouter>,
    );
  };

  it('the due part holds only the due-steps block, with the step text once', () => {
    split('due', [step({ id: 'a', state: 'due', detail: 'Why: x' })]);
    expect(screen.getByTestId('due-steps').textContent).toContain('Why: x');
    expect(screen.queryByTestId('human-steps-toggle')).toBeNull();
    expect(screen.queryByTestId('add-step')).toBeNull();
  });

  it('the rest part holds the More steps toggle and Add step, not the due block', () => {
    split('rest', [step({ id: 'a', state: 'due' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(screen.getByTestId('human-steps-toggle').textContent).toContain('More steps (0)');
    expect(screen.getByTestId('add-step')).not.toBeNull();
  });
});

describe('three kinds of step (s15t246)', () => {
  it("s14b3's shape: a due merge beside a question and a rollout shows only the question and the rollout as blocks", () => {
    show([
      step({ id: 'machine:merge', kind: 'merge', title: 'Merge and continue', who: 'anyone', due: 'now', state: 'due', blocks: ['reviewing'] }),
      step({ id: 'machine:answer:q1', kind: 'answer', title: 'Answer: which env?', who: 'anyone', due: 'now', state: 'due', blocks: [] }),
      step({ id: 'r1', kind: 'rollout', state: 'due' }),
    ]);
    const kinds = screen.getAllByTestId('step-group').map((n) => n.textContent);
    expect(kinds).toEqual(expect.arrayContaining(['Answer', 'Do']));
    expect(kinds).not.toContain('merge');
    expect(screen.queryByText('Merge and continue')).toBeNull();
  });

  it('shows no step block for a conflict, an upload, a stuck run or pairing', () => {
    show(
      ['resolve_conflict', 'upload_file', 'unstick', 'pair'].map((kind) =>
        step({ id: `machine:${kind}`, kind: kind as ListedHumanStep['kind'], who: 'anyone', due: 'now', state: 'due', blocks: [] }),
      ),
    );
    expect(screen.queryAllByTestId('human-step')).toHaveLength(0);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(hasDueSteps([step({ id: 'machine:resolve_conflict', kind: 'resolve_conflict', state: 'due' })])).toBe(false);
  });

  it('labels a review label as Decide', () => {
    show([step({ id: 'machine:rl', kind: 'review_label', who: 'qa', due: 'now', state: 'due', blocks: [] })]);
    expect(screen.getByTestId('step-group').textContent).toBe('Decide');
  });
});
