import type { AgentKbApproval, AtfIntegration, DeployIntegration, Environment } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, RequestError } from '@/lib/api';
import { reviewFormOf, reviewSettingsOfForm } from '@/lib/review-settings';
import type { ReviewForm } from '@/lib/review-settings';
import { useToast } from '@/toast';

export const message = (error: unknown): string => (error instanceof RequestError ? error.body.message : 'Something went wrong');

/**
 * The board's editable settings, shared by the groups that edit them and saved together (the server takes one update with the
 * board's version). Members and the token save on their own.
 */
export const useSettingsForm = (boardId: number) => {
  const client = useQueryClient();
  const toast = useToast();
  const board = useQuery({ queryKey: ['board', boardId], queryFn: () => api.board(boardId) });
  const [repo, setRepo] = useState('');
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [timeZone, setTimeZone] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [deploy, setDeploy] = useState<DeployIntegration | null>(null);
  const [atf, setAtf] = useState<AtfIntegration | null>(null);
  const [effectCheckGlobs, setEffectCheckGlobs] = useState('');
  const [agentKbApproval, setAgentKbApproval] = useState<AgentKbApproval>('docs');
  const [autoInvestigate, setAutoInvestigate] = useState(true);
  const [review, setReview] = useState<ReviewForm>(reviewFormOf({ enabled: true, model: null, minSeverity: 'medium', ignoredPaths: [], toolCap: null }));

  useEffect(() => {
    if (board.data === undefined) return;
    setEnvs([...board.data.environments]);
    setTimeZone(board.data.timeZone);
    setBaseBranch(board.data.baseBranch);
    setRepo(board.data.repo ?? '');
    setDeploy(board.data.deploy);
    // Optional: an older server doesn't send it.
    setAtf(board.data.atf ?? null);
    setEffectCheckGlobs(String(board.data.effectCheckGlobs));
    setAgentKbApproval(board.data.agentKbApproval);
    setAutoInvestigate(board.data.autoInvestigate);
    setReview(reviewFormOf(board.data.review));
  }, [board.data]);

  const save = useMutation({
    mutationFn: () => {
      if (board.data === undefined) throw new Error('No board');
      return api.updateSettings(boardId, board.data.version, {
        environments: envs,
        timeZone,
        baseBranch,
        repo: repo.trim() === '' ? null : repo.trim(),
        deploy,
        atf,
        agentKbApproval,
        autoInvestigate,
        review: reviewSettingsOfForm(review),
        // Checked by the server (3 to 50); a blank field leaves it as it is.
        ...(effectCheckGlobs.trim() === '' ? {} : { effectCheckGlobs: Number(effectCheckGlobs) }),
      });
    },
    onSuccess: () => {
      toast('Settings saved');
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      void client.invalidateQueries({ queryKey: ['repo-connection', boardId] });
      void client.invalidateQueries({ queryKey: ['board-environments', boardId] });
    },
    onError: (e) => toast(message(e)),
  });

  return {
    board,
    save,
    repo,
    setRepo,
    envs,
    setEnvs,
    timeZone,
    setTimeZone,
    baseBranch,
    setBaseBranch,
    deploy,
    setDeploy,
    atf,
    setAtf,
    effectCheckGlobs,
    setEffectCheckGlobs,
    agentKbApproval,
    setAgentKbApproval,
    autoInvestigate,
    setAutoInvestigate,
    review,
    setReview,
  };
};

export type SettingsForm = ReturnType<typeof useSettingsForm>;
