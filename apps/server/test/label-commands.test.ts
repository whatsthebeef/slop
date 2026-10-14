import { describe, expect, it } from 'vitest';
import { LABEL_COMMAND_KINDS, parseLabelCommand } from '../src/http/labels.js';

describe('parseLabelCommand (REST and review_label)', () => {
  it('reads the draft kinds from the flat MCP input, ignoring the routing fields', () => {
    const route = { id: 's1f1', version: 3, label: 'CR' };
    expect(parseLabelCommand({ ...route, kind: 'save_draft_item', text: 'Fix the header' })).toEqual({
      kind: 'save_draft_item',
      text: 'Fix the header',
    });
    expect(parseLabelCommand({ ...route, kind: 'save_draft_item', text: 'Edit', itemId: '2' })).toEqual({
      kind: 'save_draft_item',
      text: 'Edit',
      itemId: '2',
    });
    expect(parseLabelCommand({ ...route, kind: 'remove_draft_item', itemId: '2' })).toEqual({
      kind: 'remove_draft_item',
      itemId: '2',
    });
    expect(parseLabelCommand({ ...route, kind: 'send_items' })).toEqual({ kind: 'send_items' });
  });

  it('refuses incomplete draft commands', () => {
    expect(parseLabelCommand({ kind: 'save_draft_item' })).toBeNull();
    expect(parseLabelCommand({ kind: 'remove_draft_item' })).toBeNull();
  });

  it('lists every kind the schema accepts', () => {
    expect(LABEL_COMMAND_KINDS).toEqual(expect.arrayContaining(['save_draft_item', 'remove_draft_item', 'send_items']));
  });
});
