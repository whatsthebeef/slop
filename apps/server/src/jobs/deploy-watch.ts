import type { DeployService } from '@slop/core';

const EVERY_MS = 2 * 60_000;

/**
 * Gives up on deploys that never started or whose result never came (a lost webhook, a stopped
 * tunnel, a job that failed before reporting), so an environment's queue never sticks.
 */
export class DeployWatch {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly deploys: DeployService,
    private readonly log: (task: string, message: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), EVERY_MS);
  }

  /** One sweep at a time: a slow one isn't overlapped by the next tick. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.deploys.sweep();
    } catch (error) {
      this.log('deploy-watch', String(error));
    } finally {
      this.sweeping = false;
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
