import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, isObject } from '../engine/model.js';
import { errno, flushDirectory, publish } from '../storage/files.js';
import { span } from '../profile.js';

const maximumImage = 256 * 1024 * 1024;
export const manifestPath = (file: string): string => `${file}.manifest.json`;

/** Exact bytes from a previously validated generation; no live SQLite handle. */
export async function readGeneration(
  file: string,
): Promise<Buffer | undefined> {
  const finish = span('index.image');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      fail('UNSAFE_CACHE_PATH', 'Index is not a regular file.');
    // Bound transient image memory. Larger stores retain ordinary verification.
    if (stat.size > maximumImage) return undefined;
    const marker = manifestPath(file);
    const markerStat = await lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink())
      fail('UNSAFE_CACHE_PATH', 'Index manifest is not a safe regular file.');
    if (markerStat.size > 1024) throw new Error('Oversized index manifest');
    const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
    if (
      !isObject(value) ||
      value.version !== 1 ||
      Object.keys(value).some((key) => !['version', 'sha256'].includes(key)) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    )
      throw new Error('Invalid index manifest');
    const image = Buffer.alloc(stat.size);
    const started = performance.now();
    let offset = 0;
    while (offset < image.length) {
      const { bytesRead } = await handle.read(
        image,
        offset,
        image.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error('Incomplete index image');
      offset += bytesRead;
    }
    channel('membrain.performance').publish({
      name: 'fs.indexImage',
      calls: 1,
      durationMs: performance.now() - started,
      bytes: image.length,
    });
    if (
      (await handle.stat()).size !== image.length ||
      createHash('sha256').update(image).digest('hex') !== value.sha256
    )
      throw new Error('Changed index generation');
    return image;
  } finally {
    await handle.close();
    finish();
  }
}

async function replace(
  temporary: string,
  file: string,
  assertOwned: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await assertOwned();
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= 40 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(errno(error) ?? '')
      )
        throw error;
      await delay(25);
    }
  }
}

/** A mismatch between these two atomic replacements always requires recovery. */
export async function publishGeneration(
  temporary: string,
  file: string,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const marker = manifestPath(file);
  const existing = await lstat(marker).catch((error: unknown) => {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    fail('UNSAFE_CACHE_PATH', 'Index manifest is not a safe regular file.');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(temporary))
    hash.update(bytes as Buffer);
  const staging = path.join(path.dirname(file), `${randomUUID()}.membrain-tmp`);
  try {
    await publish(
      staging,
      `${JSON.stringify({ version: 1, sha256: hash.digest('hex') })}\n`,
    );
    await replace(temporary, file, assertOwned);
    await replace(staging, marker, assertOwned);
    await flushDirectory(path.dirname(file));
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}
