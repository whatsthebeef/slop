import type { IntegrationHealth } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api, RequestError } from '@/lib/api';
import type { AwsSignInView } from '@/lib/api';
import { healthKey } from '@/lib/live';

const signInKey = ['aws-sign-in'] as const;

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A setup page the fix names (e.g. /setup/github-app), linked as "How to fix". */
const setupPath = (fix: string): string | null => /\/setup\/[\w-]+/.exec(fix)?.[0] ?? null;

const headline = (h: IntegrationHealth): string =>
  h.id === 'bedrock'
    ? `AI features paused since ${timeOf(h.since)}: ${h.reason}.`
    : `${h.reason} (since ${timeOf(h.since)}).`;

/** Only AWS's own https link is opened, whatever the server sends. */
const safeLink = (href: string): string | null => (href.startsWith('https://') ? href : null);

/** Starts a flow when it opens (the server shares one flow between requests), then follows it every 3 seconds. */
const SignInDialog = ({ onClose }: { onClose: () => void }) => {
  const client = useQueryClient();
  const start = useMutation({ mutationFn: api.awsSignInStart });
  const { mutate } = start;
  useEffect(() => {
    mutate();
  }, [mutate]);
  const status = useQuery({
    queryKey: signInKey,
    queryFn: api.awsSignInStatus,
    enabled: start.data?.state === 'waiting',
    // A reopened dialog must not show the last flow's result.
    gcTime: 0,
    initialData: start.data,
    refetchInterval: (query) => (query.state.data?.state === 'waiting' ? 3_000 : false),
  });
  const failure: AwsSignInView | undefined = start.isError
    ? {
        state: 'failed',
        message:
          start.error instanceof RequestError
            ? start.error.body.message
            : 'Could not start the sign-in',
      }
    : undefined;
  const view: AwsSignInView | undefined = failure ?? status.data ?? start.data;

  useEffect(() => {
    if (view?.state === 'done') void client.invalidateQueries({ queryKey: healthKey });
  }, [view?.state, client]);

  const link = view?.state === 'waiting' ? safeLink(view.verificationUriComplete) : null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Sign in to AWS" data-testid="aws-sign-in-dialog">
        <div className="grid gap-3 text-sm">
          {view?.state === 'waiting' && (
            <>
              <p>
                Open the AWS sign-in page, check that it shows this code, and approve. This page
                updates when you are done.
              </p>
              <p className="font-mono text-lg font-semibold">{view.userCode}</p>
              {link !== null && (
                <a className="underline" href={link} target="_blank" rel="noreferrer">
                  Open the AWS sign-in page
                </a>
              )}
            </>
          )}
          {view?.state === 'done' && <p>Signed in. AI features resume shortly.</p>}
          {view?.state === 'failed' && (
            <p role="alert">{view.message}. Close this and try again.</p>
          )}
          {(view === undefined || view.state === 'idle') && <p>Starting…</p>}
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {view?.state === 'done' ? 'Close' : 'Cancel'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * What isn't working (AI access, the GitHub App, routines, the webhook tunnel), on every board
 * page, with the fix. The AWS sign-in button shows only to a board admin of a local server that can
 * run the device flow; other people are told to ask one.
 */
export const IntegrationBanner = () => {
  const health = useQuery({ queryKey: healthKey, queryFn: api.health, refetchInterval: 60_000 });
  const [signingIn, setSigningIn] = useState(false);
  const problems = (health.data?.integrations ?? []).filter((h) => h.state !== 'ok');
  if (problems.length === 0) return null;
  const canStart = health.data?.awsSignIn.canStart === true;

  return (
    <div className="mx-5 mt-3 grid gap-1" data-testid="integration-banner">
      {problems.map((h) => {
        const setup = setupPath(h.fix);
        return (
          <div
            key={h.id}
            role="status"
            className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
              h.state === 'degraded' ? 'border-amber/60 bg-amber/15' : 'border-red/60 bg-red/10'
            }`}
            data-testid={`integration-${h.id}`}
          >
            <span>
              {headline(h)} {h.action === 'aws_sign_in' && canStart ? '' : `${h.fix}.`}
              {h.action === 'aws_sign_in' && !canStart && ' Ask a board admin to sign in.'}
            </span>
            {setup !== null && (
              <a className="underline" href={setup}>
                How to fix
              </a>
            )}
            {h.action === 'aws_sign_in' && canStart && (
              <Button size="sm" variant="outline" onClick={() => setSigningIn(true)}>
                Sign in to AWS
              </Button>
            )}
          </div>
        );
      })}
      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} />}
    </div>
  );
};
