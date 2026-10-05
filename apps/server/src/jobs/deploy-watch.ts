import type { DeployService } from '@slop/core';

const EVERY_MS = 2 * 60_000;

/**
 * Gives up on deploys that never started or whose result never came (a lost webhook, a stopped
 * tunnel, a job that failed before reporting), so an environment's queue never sticks.
 */
export class DeployWatch {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deploys: DeployService,
    private readonly log: (task: string, message: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.deploys.sweep().catch((e: unknown) => this.log('deploy-watch', String(e))), EVERY_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }
}
