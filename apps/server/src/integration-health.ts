import { INTEGRATION_NAMES, integrationNotification, integrationSource } from '@slop/core';
import type { HealthSink, NotificationSink, IntegrationId, IntegrationReport, IntegrationStatus } from '@slop/core';

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
    /** Each change raises or clears the integration's board notification. */
    private readonly notifications: NotificationSink | null = null,
    /** Whether the in-app AWS sign-in exists on this server (known only after the registry is built). */
    private readonly serverUsesSso: () => boolean = () => false,
    private readonly onError: (message: string) => void = () => undefined,
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
    this.syncNotification(next);
  }

  private syncNotification(status: IntegrationStatus): void {
    if (this.notifications === null) return;
    const raised = integrationNotification(status, this.serverUsesSso());
    const done = raised === null ? this.notifications.clear(null, integrationSource(status.id)) : this.notifications.raise(raised);
    done.catch((error: unknown) => this.onError(`notification for ${status.id}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Every integration that has reported, ok ones included. */
  list(): IntegrationStatus[] {
    return [...this.statuses.values()];
  }
}
