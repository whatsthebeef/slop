import { describe, expect, it } from 'vitest';
import { KbPipelineJob, PROBE_MS } from '../src/jobs/kb-pipeline.js';

/** A pipeline with `due` items waiting; each claim can flip the LLM's health, as a real call would. */
class FakePipeline {
  claims = 0;
  constructor(
    private due: number,
    private readonly onClaim: () => void = () => undefined,
  ) {}
  processNext(): Promise<string | null> {
    this.claims++;
    this.onClaim();
    if (this.due === 0) return Promise.resolve(null);
    this.due--;
    return Promise.resolve(`s1k${this.claims}`);
  }
}

describe('KbPipelineJob', () => {
  it('drains every due item while the LLM is up', async () => {
    const pipeline = new FakePipeline(3);
    const job = new KbPipelineJob(pipeline, () => undefined, { isDown: () => false });
    await job.drain();
    // Three items, then the call that finds none due.
    expect(pipeline.claims).toBe(4);
  });

  it('skips claims while the LLM is down, probing with one claim per interval until a call works again', async () => {
    let now = 1_000_000;
    let down = true;
    let recovers = false;
    const pipeline = new FakePipeline(10, () => {
      if (recovers) down = false;
    });
    const job = new KbPipelineJob(pipeline, () => undefined, { isDown: () => down }, () => now);

    // The first drain probes once; the item's call fails again, so the job stops there.
    await job.drain();
    expect(pipeline.claims).toBe(1);
    // Polls within the interval claim nothing.
    now += PROBE_MS - 1;
    await job.drain();
    expect(pipeline.claims).toBe(1);
    // The next probe, a minute after the last claim.
    now += 1;
    await job.drain();
    expect(pipeline.claims).toBe(2);
    await job.drain();
    expect(pipeline.claims).toBe(2);

    // A probe whose call works marks the LLM ok, and the job drains the rest.
    now += PROBE_MS;
    recovers = true;
    await job.drain();
    expect(down).toBe(false);
    expect(pipeline.claims).toBe(11);
  });

  it('stops claiming as soon as a call finds the LLM down mid-drain, and waits an interval to probe', async () => {
    let now = 0;
    let down = false;
    const pipeline = new FakePipeline(5, () => {
      if (pipeline.claims === 2) down = true;
    });
    const job = new KbPipelineJob(pipeline, () => undefined, { isDown: () => down }, () => now);
    await job.drain();
    expect(pipeline.claims).toBe(2);
    now += PROBE_MS / 2;
    await job.drain();
    expect(pipeline.claims).toBe(2);
    now += PROBE_MS / 2;
    await job.drain();
    expect(pipeline.claims).toBe(3);
  });
});
