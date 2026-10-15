import { useEffect, useState } from 'react';
import { ContextSection } from '@/components/context-report';
import { LEARNED_PANELS } from '@/lib/learned';
import type { LearnedPanelId } from '@/lib/learned';
import { Escalations } from './escalations';
import { DependencyRules } from './dependency-rules';
import { IntakePanel } from './intake';
import { KnowledgeJobs } from './jobs';
import { LearnedPanel } from './panel';
import { RiskAreas } from './risk-areas';
import { SizePanel } from './size';
import { SubLimit } from './subs';

/** A panel's body, by id. Members read it; admins also get its actions. */
const PanelBody = ({ id, boardId, admin }: { id: LearnedPanelId; boardId: number; admin: boolean }) => {
  switch (id) {
    case 'size':
      return <SizePanel boardId={boardId} admin={admin} />;
    case 'subs':
      return <SubLimit boardId={boardId} admin={admin} />;
    case 'risk-areas':
      return <RiskAreas boardId={boardId} admin={admin} />;
    case 'escalations':
      return <Escalations boardId={boardId} admin={admin} />;
    case 'dependency-rules':
      return <DependencyRules boardId={boardId} admin={admin} />;
    case 'intake':
      return <IntakePanel boardId={boardId} admin={admin} />;
    case 'context':
      return <ContextSection boardId={boardId} admin={admin} />;
    case 'jobs':
      return <KnowledgeJobs boardId={boardId} admin={admin} />;
  }
};

/**
 * "What slop has learned" on the Knowledge page: one collapsible panel per topic, all collapsed unless a link asks for one
 * (`?learned=<panel>`, which also scrolls to it). A closed panel loads nothing.
 */
export const LearnedArea = ({ boardId, admin, linked }: { boardId: number; admin: boolean; linked: LearnedPanelId | null }) => {
  const [open, setOpen] = useState<readonly LearnedPanelId[]>(linked === null ? [] : [linked]);
  useEffect(() => {
    if (linked === null) return;
    setOpen((now) => (now.includes(linked) ? now : [...now, linked]));
    document.getElementById(`learned-${linked}`)?.scrollIntoView({ block: 'start' });
  }, [linked]);
  return (
    <section className='grid gap-3' data-testid='learned-area'>
      <h2 className='border-t pt-6 text-base font-semibold'>What slop has learned</h2>
      <p className='text-xs text-muted-foreground'>
        Values slop worked out from how the board's work went. Each topic shows what it is now, what it started from and its history;
        {admin ? ' as an admin you can also reset or re-run them.' : ' admins can also reset or re-run them.'}
      </p>
      {LEARNED_PANELS.map((panel) => {
        const isOpen = open.includes(panel.id);
        return (
          <LearnedPanel
            key={panel.id}
            id={panel.id}
            title={panel.title}
            blurb={panel.blurb}
            open={isOpen}
            onToggle={() => setOpen(isOpen ? open.filter((id) => id !== panel.id) : [...open, panel.id])}
          >
            <PanelBody id={panel.id} boardId={boardId} admin={admin} />
          </LearnedPanel>
        );
      })}
    </section>
  );
};
