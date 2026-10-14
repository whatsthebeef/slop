import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const agent = (name: string): Promise<string> => readFile(new URL(`../../../catalog/agents/agents/${name}.md`, import.meta.url), 'utf8');

describe('catalog agents: test plan', () => {
  it('has the investigator read or draft the test plan and push v1', async () => {
    const text = await agent('investigator');
    expect(text).toContain('### 2b. The test plan');
    expect(text).toContain('`testPlan`');
    expect(text).toContain('`Name | Status | Location | Description`');
    expect(text).toContain('`new`');
    expect(text).toContain('`existing`');
    expect(text).toContain('`adjusted`');
    expect(text).toContain('```` ```atf-specs ````');
    expect(text).toContain('`specs:`');
    expect(text).toContain('`grep:`');
    expect(text).toContain('save_test_plan(id, content, version: 0, runId)');
    expect(text).toContain("kind: 'test_plan'");
    expect(text).toContain("Flag specs that don't exist");
    expect(text).toContain('no new end-to-end specs unless asked');
    expect(text).toContain('investigate-only runs push it too');
  });

  it('has the implementer write new specs, make adjusted changes and record moves', async () => {
    const text = await agent('implementer');
    expect(text).toContain('**Follow the test plan**');
    expect(text).toContain('write each `new` spec and make each `adjusted` change');
    expect(text).toContain('save a new test plan version');
    expect(text).toContain('record the deviation');
  });

  it('has the change reviewer check the test plan against the diff', async () => {
    const text = await agent('change_reviewer');
    expect(text).toContain('### 11. Check the test plan');
    expect(text).toContain('Every `new` or `adjusted` row has a matching spec change in the diff');
    expect(text).toContain('exists at head');
    expect(text).toMatch(/missing from the diff[\s\S]*`IN-SCOPE`/);
  });

  it('has the tester run the planned specs it can and record the rest', async () => {
    const text = await agent('tester');
    expect(text).toContain('## Planned specs');
    expect(text).toContain('.reviews/<id>-tests.md');
    expect(text).toContain('which you could not run and why');
    expect(text).toContain("Chrome can't launch in the sandbox");
  });

  it('has the orchestrator pass the test plan and list it in the final report', async () => {
    const text = await agent('orchestrator');
    expect(text).toContain('`## Test plan`');
    expect(text).toContain('for all four agents');
    expect(text).toContain('Your final report lists the test plan');
  });
});
