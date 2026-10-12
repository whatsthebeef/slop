import type { OutboxJob } from '../src/domain/events.js';
import { UNPROCESSED } from '../src/domain/kb.js';
import type { LearningWire, KbTarget } from '../src/domain/kb.js';
import type { KbSignal } from '../src/domain/signals.js';
import { MemoryStore } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';

/** KB items as tests describe them: a submitted gotcha, routed, drafted, or with every field set (`full`). */

export const TARGET: KbTarget = {
  kind: 'doc',
  name: 'build_test_lint',
  section: 'Test',
  newDocument: null,
};
export const OTHER: KbTarget = { ...TARGET, section: 'Lint' };

export const item = (patch: Partial<LearningWire> = {}): LearningWire => ({
  id: 's1k1',
  boardId: 1,
  status: 'open',
  type: 'gotcha',
  statement: 'Generated files live in src/gen/',
  evidence: 'A review finding',
  suggestedTarget: null,
  sourceGlobIds: ['s1t1'],
  source: 'submitted',
  signal: null,
  agentSetVersion: null,
  submittedBy: 'dev@example.com',
  createdAt: NOW,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  document: null,
  outcome: null,
  ...UNPROCESSED,
  version: 1,
  ...patch,
});
export const routed = (patch: Partial<LearningWire> = {}): LearningWire =>
  item({ target: TARGET, processing: 'routed', ...patch });
export const drafted = (patch: Partial<LearningWire> = {}): LearningWire =>
  routed({ draft: { section: 'Test', content: '## Test\n' }, processing: 'drafted', ...patch });
export const document = {
  name: 'architecture',
  area: 'architecture',
  audience: [],
  description: 'Layout',
  content: '# A\n',
};

export const job = (patch: Partial<OutboxJob> = {}): OutboxJob => ({
  id: 1,
  globId: 's1k1',
  kind: 'kb_route',
  state: 'pending',
  attempts: 0,
  lastError: null,
  runAfter: NOW,
  ...patch,
});

/** A MemoryStore with board 1. */
export const newStore = async (): Promise<MemoryStore> => {
  const store = new MemoryStore();
  await store.transaction((tx) =>
    tx.insertBoard({
      name: 'b',
      repo: null,
      baseBranch: 'main',
      timeZone: 'UTC',
      defaultRoutineOwner: null,
      environments: [],
      sensitivePaths: [],
    }),
  );
  return store;
};

export const signal: KbSignal = {
  key: 'finding:x',
  kind: 'finding',
  agent: 'implementer',
  label: 'Findings',
  window: { from: NOW, to: NOW },
  figures: { affected: 3, eligible: 10, rate: 0.3, count: 4 },
  globIds: ['s1t1'],
  examples: ['an example'],
  measuredAt: NOW,
};

/** A drafted item with every field a learning can carry: links of each kind, text and item contradictions, merged evidence, flags. */
export const full = (patch: Partial<LearningWire> = {}): LearningWire =>
  drafted({
    suggestedTarget: 'build doc',
    sourceGlobIds: ['s1t1', 's1t2'],
    source: 'mined',
    signal,
    agentSetVersion: 7,
    catalogCandidate: true,
    catalogReason: 'Holds anywhere',
    occurrenceCount: 3,
    extraEvidence: [
      {
        itemId: 's1k8',
        globIds: ['s1t3'],
        evidence: 'More',
        submittedBy: 'a@example.com',
        at: '2026-10-05T12:01:00.000Z',
      },
      {
        itemId: 's1k8',
        globIds: [],
        evidence: 'Again',
        submittedBy: 'b@example.com',
        at: '2026-10-05T12:02:00.000Z',
      },
    ],
    possiblyCoveredBy: {
      kind: 'item',
      id: 's1k5',
      quote: 'q',
      shortQuote: true,
      claim: 'duplicate',
      ownQuote: 'o',
      tooShort: 'both',
      alsoTarget: { quote: 't', reason: 'r' },
      via: 's1k6',
    },
    contradicts: [
      { kind: 'knowledge', ref: 'build_test_lint § Test', note: 'Says vitest' },
      { kind: 'item', ref: 's1k4', note: 'Conflicts' },
      { kind: 'knowledge', ref: 'other', note: 'Also' },
    ],
    draftedAgainstVersion: 4,
    rationale: 'Why',
    staleSince: NOW,
    staleReason: 'no_recent_evidence',
    staleDismissedAt: null,
    keptApartFrom: ['s1k9'],
    ...patch,
  });
