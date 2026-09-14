/** FIFO serialization; a failed job must never block the jobs behind it. */
export class JobQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

// Screenshot generation, TV sessions, and settings changes share this queue.
// Composite jobs call private helpers rather than enqueueing nested jobs.
export const applicationJobs = new JobQueue();
