import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Keeps uploaded PDFs on local disk, named by their SHA-256 hash. In production this would be object storage (S3). */
@Injectable()
export class FileStorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(config.get<string>('STORAGE_DIR') ?? './storage');
  }

  /** Returns the stored path relative to the storage folder. */
  async save(hash: string, buffer: Buffer): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const relative = `${hash}.pdf`;
    await writeFile(path.join(this.root, relative), buffer);
    return relative;
  }

  read(relative: string): Promise<Buffer> {
    return readFile(this.resolve(relative));
  }

  stream(relative: string): ReadStream {
    return createReadStream(this.resolve(relative));
  }

  async delete(relative: string): Promise<void> {
    await rm(this.resolve(relative), { force: true });
  }

  /** Stored paths come from the database, but never let one point outside the storage folder. */
  private resolve(relative: string): string {
    const full = path.resolve(this.root, relative);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Invalid storage path: ${relative}`);
    return full;
  }
}
