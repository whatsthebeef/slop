import { INTEGRATION_NAMES } from '@slop/core';
import type { HealthSink, IntegrationId, IntegrationReport, IntegrationStatus } from '@slop/core';

/**
 * The server's health registry behind the core `HealthSink` port: what each integration last
 * reported. The listener runs once per change (a new state, or a different reason while not ok),
 * not on every repeated report, so a failing call in a loop doesn't flood the hints.
 */
export class IntegrationRegistry implements HealthSink {
  private readonly statuses = new Map<IntegrationId, IntegrationStatus>();

  constructor(
    private readonly onChange: (status: IntegrationStatus) => void = () => undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  report(id: IntegrationId, report: IntegrationReport): void {
    const previous = this.statuses.get(id);
    // Nothing reported yet and all is well: nothing to say.
    if (previous === undefined && report.state === 'ok') return;
    const reason = report.state === 'ok' ? null : report.reason;
    if (previous !== undefined && previous.state === report.state && previous.reason === reason) return;
    const next: IntegrationStatus = {
      id,
      name: INTEGRATION_NAMES[id],
      state: report.state,
      reason,
      fix: report.state === 'ok' ? null : report.fix,
      since: this.now(),
    };
    this.statuses.set(id, next);
    this.onChange(next);
  }

  /** Every integration that has reported, ok ones included. */
  list(): IntegrationStatus[] {
    return [...this.statuses.values()];
  }
}
