import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Dockerfile', () => {
  it('pulls base images from the ECR Public Docker library mirror, not Docker Hub', () => {
    const froms = readFileSync(join(__dirname, '../../Dockerfile'), 'utf8')
      .split('\n')
      .filter((line) => /^FROM\s/i.test(line));
    expect(froms.length).toBeGreaterThan(0);
    for (const line of froms) expect(line).toMatch(/^FROM public\.ecr\.aws\/docker\/library\//i);
  });
});
