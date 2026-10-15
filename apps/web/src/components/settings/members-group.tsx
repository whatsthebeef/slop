import { ROLES } from '@slop/core';
import type { Role } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useToast } from '@/toast';
import { message } from './form';
import { SettingBlock, SettingsGroup } from './group';

/** Who is on the board and their roles. Everyone reads; admins change them. */
const Members = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const members = useQuery({ queryKey: ['members', boardId], queryFn: () => api.members(boardId) });
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('dev');
  const setMember = useMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) => api.setMember(boardId, email, role),
    onSuccess: () => {
      setNewEmail('');
      void client.invalidateQueries({ queryKey: ['members', boardId] });
    },
    onError: (e) => toast(message(e)),
  });
  const removeMember = useMutation({
    mutationFn: (email: string) => api.removeMember(boardId, email),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['members', boardId] }),
    onError: (e) => toast(message(e)),
  });
  return (
    <SettingBlock
      title='Members and roles'
      hint={admin ? "Everyone listed can open this board; a person's role decides what they may do. You can change roles and add people." : "Everyone listed can open this board; a person's role decides what they may do. Only admins change them."}
      testId='members'
    >
      {members.data?.map((m) => (
        <div key={m.email} className='flex items-center gap-2 text-sm'>
          <span className='flex-1'>{m.email}</span>
          <Select
            className='w-28'
            aria-label={`Role of ${m.email}`}
            value={m.role}
            disabled={!admin}
            onChange={(e) => {
              const role = ROLES.find((r) => r === e.target.value);
              if (role !== undefined) setMember.mutate({ email: m.email, role });
            }}
          >
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          {admin && (
            <Button variant='ghost' size='sm' onClick={() => removeMember.mutate(m.email)}>
              Remove
            </Button>
          )}
        </div>
      ))}
      {admin && (
        <form
          className='flex gap-2'
          onSubmit={(e) => {
            e.preventDefault();
            setMember.mutate({ email: newEmail, role: newRole });
          }}
        >
          <Input type='email' aria-label='Email of the person to add' placeholder='email' value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
          <Select
            className='w-28'
            aria-label='Role of the person to add'
            value={newRole}
            onChange={(e) => {
              const role = ROLES.find((r) => r === e.target.value);
              if (role !== undefined) setNewRole(role);
            }}
          >
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <Button type='submit'>Add</Button>
        </form>
      )}
    </SettingBlock>
  );
};

/** The board's integration token (the Meet notes script's credential): created and shown once, or revoked. */
const IntegrationToken = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['integration-token', boardId], queryFn: () => api.integrationToken(boardId) });
  // The secret lives only in this state: leaving the page loses it, as the server keeps just its hash.
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['integration-token', boardId] });
  const create = useMutation({
    mutationFn: () => api.createIntegrationToken(boardId),
    onSuccess: (made) => {
      setSecret(made.token);
      void refresh();
    },
    onError: (e) => toast(message(e)),
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeIntegrationToken(boardId),
    onSuccess: () => {
      setSecret(null);
      void refresh();
    },
    onError: (e) => toast(message(e)),
  });
  return (
    <SettingBlock
      title='Integration token'
      hint="Lets an outside script (the Google Meet notes Apps Script) add items to this board's inbox, and nothing else."
      testId='integration-token'
    >
      <p className='text-xs text-muted-foreground'>slop keeps only its hash, so copy the token when it is shown. A new token replaces the old one.</p>
      {status.data !== undefined && (
        <p className='text-sm'>
          {status.data.active ? `Active since ${new Date(status.data.createdAt ?? '').toLocaleString()}` : 'No active token'}
        </p>
      )}
      {secret !== null && (
        <p className='break-all rounded border p-2 font-mono text-xs' data-testid='integration-token-secret'>
          {secret}
        </p>
      )}
      {admin && (
        <div className='flex gap-2'>
          <Button size='sm' variant='outline' disabled={create.isPending} onClick={() => create.mutate()}>
            {status.data?.active === true ? 'Replace token' : 'Create token'}
          </Button>
          {status.data?.active === true && (
            <Button size='sm' variant='outline' disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke
            </Button>
          )}
        </div>
      )}
    </SettingBlock>
  );
};

export const MembersGroup = ({ boardId, admin }: { boardId: number; admin: boolean }) => (
  <SettingsGroup id='members'>
    <Members boardId={boardId} admin={admin} />
    <IntegrationToken boardId={boardId} admin={admin} />
  </SettingsGroup>
);
