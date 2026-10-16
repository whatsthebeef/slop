import { describe, expect, it } from 'vitest';
import { cardTargets, sentence, tipLines } from '../src/index.js';

describe('tooltip sentences', () => {
  it('adds a full stop, leaves finished sentences alone and drops blanks', () => {
    expect(sentence('running checks')).toBe('running checks.');
    expect(sentence('Opens the glob.  ')).toBe('Opens the glob.');
    for (const done of ['Done!', 'Done?', 'Needs a person:', 'Waiting…'])
      expect(sentence(done)).toBe(done);
    expect(sentence('   ')).toBe('');
  });

  it('splits multi-line parts, ends each line in a stop and drops empty lines', () => {
    expect(tipLines(['Checks running on abc\nrunning checks', '', 'Opens the glob.'])).toBe(
      'Checks running on abc.\nrunning checks.\nOpens the glob.',
    );
  });
});

describe('where a status opens the glob', () => {
  it('names a section, never an action or a link', () => {
    for (const target of [
      cardTargets.actions(),
      cardTargets.humanSteps(),
      cardTargets.decision(),
      cardTargets.label(),
      cardTargets.questions(),
    ]) {
      expect(Object.keys(target)).toEqual(['section']);
    }
  });
});
