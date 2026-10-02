import type { SafeLogger } from '../http/errors.js';

export class ResetQueue {
  private readonly jobs: (() => Promise<void>)[] = [];
  private running = false;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly log: SafeLogger) {}
  enqueue(job: () => Promise<void>, requestId: string): void {
    // A bounded in-process queue keeps lookup/SMTP timing out of the public response.
    if (this.jobs.length >= 32) {
      this.log('RESET_QUEUE_FULL', requestId);
      return;
    }
    this.jobs.push(async () => {
      try {
        await job();
      } catch {
        this.log('RESET_DELIVERY_FAILED', requestId);
      }
    });
    if (!this.running) {
      this.running = true;
      setImmediate(() => {
        void this.run();
      });
    }
  }
  private async run(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (job) await job();
    }
    this.running = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  async idle(): Promise<void> {
    if (!this.running) return;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
