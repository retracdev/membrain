import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  link,
  unlink,
  realpath,
  lstat,
  rmdir,
  readFile,
  utimes,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '../engine/model.js';

export function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
export async function canonical(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
    const parent = path.dirname(input);
    if (parent === input) throw error;
    return path.join(await canonical(parent), path.basename(input));
  }
}
export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
export async function safeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('UNSAFE_PATH', `Expected a real directory at ${directory}.`);
}
export async function regularFile(file: string): Promise<void> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144)
    fail('CORRUPT_STORE', `Unsafe or oversized source file at ${file}.`);
}
export async function flushDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'EBADF'].includes(
        errno(error) ?? '',
      )
    )
      throw error;
  }
}
/** Publish complete bytes without replacing an existing source record. */
export async function publish(
  file: string,
  content: string,
  checkpoint?: (stage: 'flushed' | 'published') => Promise<void>,
): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${randomUUID()}.membrain-tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await checkpoint?.('flushed');
    await link(temporary, file);
    await flushDirectory(path.dirname(file));
    await checkpoint?.('published');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Conservative local filesystem lock. Never steal a lock based on age/PID. */
export async function withLock<T>(
  directory: string,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const lock = path.join(directory, '.membrain-lock');
  const owner = path.join(lock, 'owner.json');
  const token = randomUUID();
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      if (Date.now() - start >= timeoutMs)
        fail(
          'LOCK_BUSY',
          `Lock remains at ${lock}. Close other Membrain commands. After verifying no writer is alive, remove only that lock directory and retry. Locks are never stolen automatically.`,
        );
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }
  await publish(
    owner,
    JSON.stringify({
      token,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    }),
  );
  async function assertOwned(): Promise<void> {
    try {
      if (
        (JSON.parse(await readFile(owner, 'utf8')) as { token?: string })
          .token === token
      )
        return;
    } catch {
      /* fail closed */
    }
    fail(
      'LOCK_LOST',
      `Lock ownership changed at ${lock}; stop other writers and inspect the store.`,
    );
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(owner, now, now).catch(() => undefined);
  }, 5_000);
  heartbeat.unref();
  try {
    return await action(assertOwned);
  } finally {
    clearInterval(heartbeat);
    await assertOwned();
    await unlink(owner);
    await rmdir(lock);
  }
}
