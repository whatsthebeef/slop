import { describe, expect, it } from 'vitest';
import { CAPABILITY_NAMES } from '@slop/core';
import { capabilityRows } from '../src/lib/capabilities';

describe('the System capabilities list', () => {
  it('lists every capability in order, on or off as the server said', () => {
    const rows = capabilityRows({ fileAttachments: true, attachmentEvents: false });
    expect(rows.map((r) => r.name)).toEqual([...CAPABILITY_NAMES]);
    expect(rows.find((r) => r.name === 'fileAttachments')?.state).toBe('on');
    expect(rows.find((r) => r.name === 'attachmentEvents')?.state).toBe('off');
    expect(rows.find((r) => r.name === 'slack')?.state).toBe('unknown');
  });

  it('shows everything as not reported when an older API sends none', () => {
    expect(capabilityRows(undefined).every((r) => r.state === 'unknown')).toBe(true);
  });
});
