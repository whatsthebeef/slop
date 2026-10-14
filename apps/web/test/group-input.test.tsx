// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupInput } from '../src/components/group-input';
import { groupNames } from '../src/lib/group-names';

afterEach(cleanup);

const options = (input: HTMLElement) =>
  [...(document.getElementById(input.getAttribute('list') ?? '')?.querySelectorAll('option') ?? [])].map((o) => o.value);

describe('GroupInput', () => {
  it('offers the board’s groups through a datalist', () => {
    render(<GroupInput aria-label='Group' groups={['a', 'b']} />);
    expect(options(screen.getByLabelText('Group'))).toEqual(['a', 'b']);
  });

  it('gives two inputs on one page different datalist ids', () => {
    render(
      <>
        <GroupInput aria-label='one' groups={['a']} />
        <GroupInput aria-label='two' groups={['a']} />
      </>,
    );
    expect(screen.getByLabelText('one').getAttribute('list')).not.toBe(screen.getByLabelText('two').getAttribute('list'));
  });
});

describe('groupNames', () => {
  it('sorts by open globs using the group, then by name, and skips globs without one', () => {
    expect(
      groupNames([
        { group: 'b', list: 'doing' },
        { group: 'a', list: 'doing' },
        { group: 'c', list: 'doing' },
        { group: 'c', list: 'planning' },
        { group: 'z', list: 'signed_off' },
        { group: null, list: 'doing' },
      ]),
    ).toEqual(['c', 'a', 'b', 'z']);
  });
});
