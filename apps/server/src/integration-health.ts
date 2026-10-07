import { signInOffered } from '@slop/core';
import type {
  HealthSink,
  IntegrationAction,
  IntegrationHealth,
  IntegrationHealthSource,
  IntegrationId,
} from '@slop/core';
import type { LlmHealthState } from './llm-health.js';

/**
 * What slop knows about each integration, from the calls it makes anyway (adapters report here).
 * `onChange` runs once per change of an integration's state or reason, never for a repeat, so each
 * change reaches the boards once. An integration nothing has reported on yet isn't listed.
 */
export class IntegrationRegistry implements HealthSink, IntegrationHealthSource {
  private readonly entries = new Map<IntegrationId, IntegrationHealth>();

  constructor(
    private readonly onChange: (health: IntegrationHealth) => void = () => undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  report(): readonly IntegrationHealth[] {
    return [...this.entries.values()];
  }

  markOk(id: IntegrationId): void {
    this.set({ id, state: 'ok', reason: '', fix: '', since: this.now() });
  }

  markDegraded(id: IntegrationId, reason: string, fix: string): void {
    this.set({ id, state: 'degraded', reason, fix, since: this.now() });
  }

  markDown(id: IntegrationId, reason: string, fix: string, action?: IntegrationAction): void {
    this.set({
      id,
      state: 'down',
      reason,
      fix,
      since: this.now(),
      ...(action === undefined ? {} : { action }),
    });
  }

  /** Bedrock follows LlmHealth (its worst model); nothing is reported until a call has ended. */
  syncBedrock(state: LlmHealthState, ssoAvailable: boolean): void {
    if (state.state === 'ok') this.markOk('bedrock');
    if (state.state !== 'down') return;
    const offered = signInOffered({ state: 'down', code: state.code, ssoAvailable });
    this.markDown('bedrock', state.reason, state.fix, offered ? 'aws_sign_in' : undefined);
  }

  private set(next: IntegrationHealth): void {
    const previous = this.entries.get(next.id);
    // The same state and reason is a repeat (the action follows the reason, so it can't differ), and keeps `since`.
    if (previous?.state === next.state && previous.reason === next.reason) return;
    this.entries.set(next.id, next);
    // A first "ok" is the baseline, not news.
    if (previous !== undefined || next.state !== 'ok') this.onChange(next);
  }
}
