import type { HealthSink } from '@slop/core';

/**
 * Local development only: asks ngrok's local API once a minute whether the tunnel for `domain` is
 * up, since GitHub webhooks and connectors need it and ngrok reports a failed tunnel only in its
 * own window. Reports the outcome; an unreachable ngrok counts as down.
 */
export class TunnelWatch {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly domain: string,
    private readonly health: HealthSink,
    private readonly fetchTunnels: () => Promise<string> = async () =>
      (await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(3000) })).text(),
  ) {}

  async check(): Promise<void> {
    const up = await this.fetchTunnels().then((body) => body.includes(this.domain), () => false);
    this.health.report(
      'tunnel',
      up
        ? { state: 'ok' }
        : {
            state: 'down',
            reason: `The ngrok tunnel to ${this.domain} isn't up, so GitHub webhooks won't arrive`,
            fix: 'Stop any other ngrok holding the endpoint (ERR_NGROK_334) and restart the tunnel with scripts/dev.sh',
          },
    );
  }

  start(intervalMs = 60_000): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
