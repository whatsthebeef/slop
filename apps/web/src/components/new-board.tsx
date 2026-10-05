import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useToast } from '@/toast';

/** Creates a board and opens it. */
export const NewBoardForm = ({ onCreated }: { onCreated?: () => void }) => {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createBoard({
        name,
        repo: repo.trim() === '' ? null : repo.trim(),
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    onSuccess: (board) => {
      void client.invalidateQueries({ queryKey: ['me'] });
      onCreated?.();
      void navigate(`/boards/${board.id}`);
    },
    onError: (error) =>
      toast(error instanceof RequestError ? error.body.message : 'Could not create the board'),
  });

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Label>
        Name
        <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </Label>
      <Label>
        Repo (owner/name)
        <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="optional" />
      </Label>
      <Button type="submit" disabled={create.isPending}>
        Create board
      </Button>
    </form>
  );
};
