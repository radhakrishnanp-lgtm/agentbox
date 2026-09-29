import type { SecurityOverview } from '@agentbox/shared';
import { Clock, KeyRound, Server, SquareTerminal } from 'lucide-react';
import { Link, PageHeader } from '../components/Layout.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/card.tsx';
import { Alert, Badge, Skeleton } from '../components/ui/feedback.tsx';
import { dateTime, relativeTime } from '../lib/format.ts';
import { useApi } from '../lib/use-api.ts';
import { useSession } from '../state/auth.tsx';

export function Home() {
  const session = useSession();
  const security = useApi<SecurityOverview>('/api/security');

  return (
    <>
      <PageHeader title="Home" description={`Signed in on ${session.deviceName}.`} />

      {security.data && security.data.recoveryCodesRemaining <= 3 ? (
        <Alert tone="warning" title="Running low on recovery codes" className="mb-6">
          {security.data.recoveryCodesRemaining} left. You'll be able to generate a fresh set from
          Security soon.
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader
            icon={<SquareTerminal className="size-5" aria-hidden />}
            title="Terminals"
            description="Your AI CLIs will run here, on this server, in persistent sessions."
            action={<Badge>Next update</Badge>}
          />
          <CardBody className="text-sm text-muted">
            Claude Code, Grok and Kimi will sign in once on this server. No other machine ever holds
            their tokens.
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon={<Server className="size-5" aria-hidden />}
            title="GPU nodes"
            description="Connect servers behind NAT through locked-down reverse tunnels."
            action={<Badge>Coming</Badge>}
          />
          <CardBody className="text-sm text-muted">
            Nodes only get a forwarding-only key. They never see your AI logins.
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Clock className="size-5" aria-hidden />} title="This session" />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Started</dt>
              <dd>{dateTime(session.createdAt)}</dd>
              <dt className="text-muted">Ends at the latest</dt>
              <dd>{dateTime(session.expiresAt)}</dd>
              <dt className="text-muted">Idle sign-out</dt>
              <dd>after {Math.round(session.idleTimeoutSeconds / 60)} minutes without activity</dd>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon={<KeyRound className="size-5" aria-hidden />}
            title="Sign-in methods"
            action={
              <Link
                to="/security"
                className="text-sm text-accent underline-offset-4 hover:underline"
              >
                Manage
              </Link>
            }
          />
          <CardBody>
            {security.status === 'loading' ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-5 w-2/3" />
              </div>
            ) : security.status === 'error' ? (
              <p className="text-sm text-danger">{security.error.message}</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                <li>
                  {security.data.passkeys.length} passkey
                  {security.data.passkeys.length === 1 ? '' : 's'}
                  {security.data.passkeys[0]?.lastUsedAt
                    ? `, last used ${relativeTime(security.data.passkeys[0].lastUsedAt)}`
                    : ''}
                </li>
                <li>Authenticator app {security.data.totpEnabled ? 'on' : 'off'}</li>
                <li>{security.data.recoveryCodesRemaining} recovery codes left</li>
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
