import type { Capabilities, CapabilityName, GlobService } from '@slop/core';

/** How long a bucket probe's answer is reused: /api/health is read often, and a bucket request is a paid call. */
const PROBE_TTL_MS = 60_000;
/** How long a probe may take before the bucket counts as unreachable. */
const PROBE_TIMEOUT_MS = 3_000;

/** What the server has switched on, as read from its configuration (the bucket is probed, the rest is configuration). */
export interface CapabilitySwitches {
  /** The attachments bucket; null when none is configured. */
  readonly bucket: { unreachableReason(signal?: AbortSignal): Promise<string | null> } | null;
  readonly attachmentQueueConfigured: boolean;
  readonly slackConfigured: boolean;
  /** The code index's job is running on this server. */
  readonly codeIndexRuns: boolean;
  readonly deployResultsConfigured: boolean;
}

/**
 * The capabilities `/api/health` reports and human steps check against. File attachments are on only when the bucket is
 * configured and answers; the answer is cached for a minute and a failing probe means off, never an error.
 */
export class CapabilityReader {
  private probe: { readonly at: number; readonly reason: string | null } | null = null;

  constructor(
    private readonly switches: CapabilitySwitches,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<Capabilities> {
    return {
      fileAttachments: (await this.bucketReason()) === null,
      attachmentEvents: this.switches.attachmentQueueConfigured,
      slack: this.switches.slackConfigured,
      codeIndex: this.switches.codeIndexRuns,
      deployResults: this.switches.deployResultsConfigured,
    };
  }

  /** Why a capability is off, for those that can say (a false "off" is hard to diagnose without it). */
  async reasons(): Promise<Partial<Record<CapabilityName, string>>> {
    const reason = await this.bucketReason();
    return reason === null ? {} : { fileAttachments: reason };
  }

  private async bucketReason(): Promise<string | null> {
    const { bucket } = this.switches;
    if (bucket === null) return 'bucket not configured';
    if (this.probe !== null && this.now() - this.probe.at < PROBE_TTL_MS) return this.probe.reason;
    const reason = await bucket.unreachableReason(AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => 'timeout');
    this.probe = { at: this.now(), reason };
    return reason;
  }
}

const EVERY_MS = 60_000;

/** Every minute: ticks the human steps whose capability check is now on (`GlobService.tickCapabilitySteps`), board by board. */
export class CapabilityWatch {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    /** The IDs of the boards to tick. */
    private readonly boards: () => Promise<readonly number[]>,
    private readonly globs: Pick<GlobService, 'tickCapabilitySteps'>,
    private readonly capabilities: Pick<CapabilityReader, 'read'>,
    private readonly log: (task: string, message: string) => void,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), EVERY_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; returns how many steps it ticked. Skipped while the last one still runs. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const capabilities = await this.capabilities.read();
      let ticked = 0;
      for (const boardId of await this.boards()) ticked += await this.globs.tickCapabilitySteps(boardId, capabilities);
      return ticked;
    } catch (error) {
      this.log('capabilities', error instanceof Error ? error.message : String(error));
      return 0;
    } finally {
      this.running = false;
    }
  }
}
