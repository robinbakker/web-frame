import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Per-TV state. Missing or damaged ownership records never authorize deletion. */
export class ArtState {
  private directory: string;

  constructor(root: string, host: string) {
    this.directory = join(root, createHash('sha256').update(host).digest('hex'));
  }

  private marker(id: string): string {
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.owned`);
  }

  async recordUpload(id: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.marker(id), id, { mode: 0o600 });
  }

  async owns(id: string): Promise<boolean> {
    try {
      return (await readFile(this.marker(id), 'utf8')) === id;
    } catch {
      return false;
    }
  }

  async lastHash(): Promise<string | undefined> {
    try {
      const record = JSON.parse(await readFile(join(this.directory, 'selected.json'), 'utf8'));
      return typeof record.hash === 'string' && (await this.owns(record.id)) ? record.hash : undefined;
    } catch {
      return undefined;
    }
  }

  async forgetUpload(id: string): Promise<void> {
    await unlink(this.marker(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async recordSelection(hash: string, id: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ hash, id }), { mode: 0o600 });
    await rename(temporary, join(this.directory, 'selected.json'));
  }
}
