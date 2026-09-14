import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** Windows readers/virus scanners can briefly deny replacement of an otherwise writable file. */
export async function replaceFile(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || attempt === 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) {
        throw error;
      }
      // Keep the old file intact during every retry; never fall back to delete-then-write.
      await setTimeout(10 * 2 ** attempt);
    }
  }
}
