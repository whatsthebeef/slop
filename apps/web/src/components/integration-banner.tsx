import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api, healthKey } from '@/lib/api';
import type { IntegrationHealthView } from '@/lib/api';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The line for one integration: "AI features paused since 14:02: AWS sign-in expired". */
const line = (item: IntegrationHealthView['integrations'][number]) =>
  `${item.id === 'bedrock' ? 'AI features paused' : item.name} since ${time(item.since)}: ${item.reason ?? item.state}.`;

/** The AWS sign-in's progress: the link and code to approve, or why it failed. */
const SignInProgress = ({ sign }: { sign: NonNullable<IntegrationHealthView['awsSignIn']> }) => {
  if (sign.state === 'waiting') {
    return (
      <span data-testid='aws-sign-in-code'>
        Open{' '}
        <a className='underline' href={sign.verificationUri} target='_blank' rel='noreferrer'>
          the AWS sign-in page
        </a>{' '}
        and confirm the code <strong className='font-mono'>{sign.userCode}</strong>.
      </span>
    );
  }
  if (sign.state === 'failed') return <span>{sign.message}. Try again.</span>;
  return null;
};

/**
 * A banner under the status bar on every board page while an integration needs a person: Bedrock
 * (AWS sign-in expired, no model access), the GitHub App, routine firing and the webhook tunnel,
 * each with its fix. The Sign in to AWS button (admins, local development only) runs the device
 * sign-in on the server; the banner clears by itself once Bedrock answers again.
 */
export const IntegrationBanner = () => {
  const client = useQueryClient();
  const health = useQuery({
    queryKey: healthKey,
    queryFn: api.health,
    // A hint refetches at once; the poll is the backstop (and the way a sign-in's progress shows).
    refetchInterval: (query) => (query.state.data?.awsSignIn?.state === 'waiting' ? 3_000 : 30_000),
  });
  const start = useMutation({
    mutationFn: api.startAwsSignIn,
    onSuccess: () => client.invalidateQueries({ queryKey: healthKey }),
  });
  const items = health.data?.integrations ?? [];
  if (items.length === 0) return null;
  const sign = health.data?.awsSignIn ?? null;
  return (
    <div className='flex flex-col gap-1 border-b border-red/60 bg-red/10 px-5 py-1.5 text-sm' role='status' data-testid='integration-banner'>
      {items.map((item) => (
        <div key={item.id} className='flex flex-wrap items-center gap-2'>
          <span>
            {line(item)} {item.fix}
          </span>
          {item.signIn && sign !== null && (
            <>
              {sign.canStart && sign.state !== 'waiting' && (
                <Button size='sm' disabled={start.isPending} onClick={() => start.mutate()}>
                  Sign in to AWS
                </Button>
              )}
              {!sign.canStart && sign.state !== 'waiting' && <span>Ask a board admin to sign in to AWS.</span>}
              <SignInProgress sign={sign} />
            </>
          )}
        </div>
      ))}
    </div>
  );
};
