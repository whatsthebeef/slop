import { useId } from 'react';
import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

/** A text input that suggests the board's existing groups as you type (the browser matches case-insensitively). */
export const GroupInput = ({ groups, ...props }: { groups: readonly string[] } & Omit<ComponentProps<typeof Input>, 'list'>) => {
  const listId = useId();
  return (
    <>
      <Input list={listId} {...props} />
      <datalist id={listId}>
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </>
  );
};
