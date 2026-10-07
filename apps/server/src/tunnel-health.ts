import type { HealthSink } from '@slop/core';
import { z } from 'zod';

const TUNNELS_URL = 'http://127.0.0.1:4040/api/tunnels';

const tunnels = z.object({ tunnels: z.array(z.object({ public_url: z.string() })) });

/**
 * Local dev only: asks ngrok's local API whether the tunnel for `domain` is up, since GitHub
 * webhooks (and so PR and check updates) only arrive through it.
 */
export class TunnelWatch {
  private timer: NodeJS.Timeout | null = null;
  private misses = 0;

  constructor(
    private readonly domain: string,
    private readonly health: HealthSink,
    private readonly get: (url: string) => Promise<unknown> = async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return body;
    },
    private readonly everyMs = 60_000,
  ) {}

  async check(): Promise<void> {
    const body = await this.get(TUNNELS_URL).catch(() => null);
    const parsed = tunnels.safeParse(body);
    const up =
      parsed.success && parsed.data.tunnels.some((t) => t.public_url.includes(this.domain));
    if (up) {
      this.misses = 0;
      this.health.markOk('tunnel');
      return;
    }
    // One miss is normal while ngrok is still starting (the server comes up first); two in a row is a problem.
    this.misses += 1;
    if (this.misses >= 2)
      this.health.markDegraded(
        'tunnel',
        "The webhook tunnel isn't up, so GitHub events won't arrive",
        `Restart scripts/dev.sh; another ngrok may hold ${this.domain}`,
      );
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.everyMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
