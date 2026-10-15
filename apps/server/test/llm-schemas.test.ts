import { describe, expect, it } from 'vitest';
import * as schemas from '@slop/core';
import type { LlmSchema } from '@slop/core';

const all: readonly LlmSchema[] = [
  ...Object.values(schemas).filter(
    (v): v is LlmSchema => typeof v === 'object' && 'name' in v && 'schema' in v,
  ),
  schemas.findingClassSchema(['bug', 'other']),
];

/** Every object node in a schema, so the structured-output rules can be checked on each. */
const objectsIn = (node: unknown): readonly Record<string, unknown>[] => {
  if (Array.isArray(node)) return node.flatMap(objectsIn);
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Record<string, unknown>;
  return [
    ...(record.type === 'object' ? [record] : []),
    ...Object.values(record).flatMap(objectsIn),
  ];
};

describe('pipeline answer schemas', () => {
  it('has a schema per step with a unique name', () => {
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });

  it.each(all.map((s) => [s.name, s] as const))(
    '%s: every object is closed and lists all its properties as required',
    (_name, schema) => {
      const objects = objectsIn(schema.schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const o of objects) {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(
          Object.keys(o.properties as object).sort(),
        );
      }
    },
  );

  it('the dedupe answer with quotes, backslashes and backticks round-trips through JSON', () => {
    const quote = 'Run `pnpm test` with "quiet" reporters in C:\\work\\slop';
    const answer = JSON.stringify({
      fact: quote,
      checked: [],
      suppressedBy: null,
      duplicateOf: null,
      coveredBy: null,
      contradicts: [],
    });
    expect(JSON.parse(answer)).toMatchObject({ fact: quote });
  });
});
