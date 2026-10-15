import { EFFECT_CHECK_GLOBS_MAX, EFFECT_CHECK_GLOBS_MIN } from '@slop/core';
import { Input, Select } from '@/components/ui/input';
import { MAX_REVIEW_TOOL_CAP, REVIEW_SEVERITY_CHOICES, toolCapInvalid } from '@/lib/review-settings';
import { CheckField, Field, SaveButton, SettingBlock, SettingsGroup } from './group';
import type { SettingsForm } from './form';

export const AutomationGroup = ({ admin, form }: { admin: boolean; form: SettingsForm }) => {
  const { review, setReview } = form;
  return (
    <SettingsGroup id='automation'>
      <SettingBlock title='Investigating' hint='What slop does with a glob as soon as it is created.'>
        <CheckField
          label='Investigate big globs in Planning automatically'
          hint='A glob in Planning that intake flags as big gets a routine run that investigates it (no branch, no commits).'
          disabled={!admin}
          checked={form.autoInvestigate}
          onChange={form.setAutoInvestigate}
          testId='auto-investigate'
        />
      </SettingBlock>
      <SettingBlock title='Independent review' hint='A second pair of eyes on each change before a person looks at it.'>
        <CheckField
          label='Review changes automatically'
          hint='Off stops the automatic reviews; Review code on a glob still works.'
          disabled={!admin}
          checked={review.enabled}
          onChange={(enabled) => setReview({ ...review, enabled })}
          testId='review-enabled'
        />
        <Field label='Reviewer model' hint="A Bedrock model ID; blank uses the server's default.">
          {(props) => (
            <Input
              {...props}
              value={review.model}
              placeholder='Server default'
              disabled={!admin}
              onChange={(e) => setReview({ ...review, model: e.target.value })}
              data-testid='review-model'
            />
          )}
        </Field>
        <Field label='Comment on GitHub from this severity up' hint="Lower ones are listed in the review's summary instead.">
          {(props) => (
            <Select
              {...props}
              className='w-32'
              value={review.minSeverity}
              disabled={!admin}
              onChange={(e) => {
                const severity = REVIEW_SEVERITY_CHOICES.find((s) => s === e.target.value);
                if (severity !== undefined) setReview({ ...review, minSeverity: severity });
              }}
              data-testid='review-min-severity'
            >
              {REVIEW_SEVERITY_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label='Paths the reviewer skips' hint="One glob per line, on top of the merge policy's size-ignored paths.">
          {(props) => (
            <textarea
              {...props}
              className='min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs'
              value={review.ignoredPaths}
              disabled={!admin}
              onChange={(e) => setReview({ ...review, ignoredPaths: e.target.value })}
              data-testid='review-ignored-paths'
            />
          )}
        </Field>
        <Field label='Reviewer tool calls per review' hint={`How many lookups the reviewer may make, 1 to ${String(MAX_REVIEW_TOOL_CAP)}; blank uses the default.`}>
          {(props) => (
            <Input
              {...props}
              type='number'
              min={1}
              max={MAX_REVIEW_TOOL_CAP}
              step={1}
              className='w-24'
              value={review.toolCap}
              disabled={!admin}
              onChange={(e) => setReview({ ...review, toolCap: e.target.value })}
              aria-invalid={toolCapInvalid(review)}
              data-testid='review-tool-cap'
            />
          )}
        </Field>
      </SettingBlock>
      <SettingBlock title='Knowledge' hint='Who may approve the changes agents propose to the board knowledge.'>
        <CheckField
          label='Agents may approve agent-file and contradicting items'
          hint='Off: agents approve documents only. The local-run spec, merge policy and whole documents always need a person.'
          disabled={!admin}
          checked={form.agentKbApproval === 'docs_and_agent_files'}
          onChange={(on) => form.setAgentKbApproval(on ? 'docs_and_agent_files' : 'docs')}
          testId='agent-kb-approval'
        />
        <Field
          label='Effect checks: globs compared before and after an approved change'
          hint={`How many globs on each side slop compares to see whether an approved change worked (${String(EFFECT_CHECK_GLOBS_MIN)} to ${String(EFFECT_CHECK_GLOBS_MAX)}).`}
        >
          {(props) => (
            <Input
              {...props}
              type='number'
              min={EFFECT_CHECK_GLOBS_MIN}
              max={EFFECT_CHECK_GLOBS_MAX}
              step={1}
              className='w-24'
              value={form.effectCheckGlobs}
              disabled={!admin}
              onChange={(e) => form.setEffectCheckGlobs(e.target.value)}
              data-testid='effect-check-globs'
            />
          )}
        </Field>
      </SettingBlock>
      <SaveButton visible={admin} pending={form.save.isPending} invalid={toolCapInvalid(review)} onSave={() => form.save.mutate()} />
    </SettingsGroup>
  );
};
