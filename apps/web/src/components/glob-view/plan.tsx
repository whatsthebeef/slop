import { ClipboardCheck, FileText } from 'lucide-react';
import { useState } from 'react';
import { DocEditor, PlanEditor } from '../plan-editor';
import { TEST_PLAN_TEMPLATE, TestPlanEmpty, TestPlanPreview } from '../test-plan-view';
import type { GlobViewContext } from './context';

type Tab = 'plan' | 'test-plan';

const TEST_PLAN_TAB: Tab = 'test-plan';

/** The plan section: plan.md, and for a glob that is built (not a decision) the Test plan beside it. */
export const PlanSection = ({ ctx }: { ctx: GlobViewContext }) => {
  const params = new URLSearchParams(window.location.search);
  const startExpanded = params.get('section') === 'plan';
  // A deep link (`?section=plan&tab=test-plan`) opens the test plan; the tab then follows clicks.
  const [tab, setTab] = useState<Tab>(params.get('tab') === TEST_PLAN_TAB ? TEST_PLAN_TAB : 'plan');
  if (ctx.glob.category === 'decision')
    return <PlanEditor globId={ctx.glob.id} startExpanded={startExpanded} />;
  const canInvestigate = ctx.glob.allowedActions?.includes('investigate') === true;
  const tabs = [
    { id: 'plan', label: 'plan.md', icon: FileText },
    { id: TEST_PLAN_TAB, label: 'Test plan', icon: ClipboardCheck },
  ] as const;
  return (
    <div className="grid gap-2">
      <div role="tablist" aria-label="Plan documents" className="flex gap-1 border-b text-xs">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`plan-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="plan-tabpanel"
            className={`flex items-center gap-1 border-b-2 px-2 py-1 ${tab === id ? 'border-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab(id)}
          >
            <Icon aria-hidden className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="plan-tabpanel" aria-labelledby={`plan-tab-${tab}`}>
        {tab === 'plan' ? (
          <PlanEditor globId={ctx.glob.id} startExpanded={startExpanded} />
        ) : (
          <DocEditor
            globId={ctx.glob.id}
            kind="test_plan"
            startExpanded={startExpanded}
            template={TEST_PLAN_TEMPLATE}
            preview={(p) => <TestPlanPreview globId={ctx.glob.id} {...p} />}
            empty={(write) => (
              <TestPlanEmpty
                onWrite={write}
                canInvestigate={canInvestigate}
                busy={ctx.busy}
                onInvestigate={() => void ctx.onAction('investigate')}
              />
            )}
          />
        )}
      </div>
    </div>
  );
};
