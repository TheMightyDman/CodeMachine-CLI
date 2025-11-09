import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export class LockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockBusyError';
  }
}

export interface AcquireLockOptions {
  staleMs?: number;
  retries?: number;
  retryDelayMs?: number;
  description?: string;
}

interface LockMetadata {
  pid: number;
  createdAt: number;
  description?: string;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES = 8;
const DEFAULT_RETRY_DELAY_MS = 120;

/**
 * Acquire an exclusive file lock using O_EXCL semantics.
 * The lock is represented by a sentinel file containing metadata about the owner.
 */
export async function acquireFileLock(lockPath: string, options: AcquireLockOptions = {}): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const description = options.description;

  await fs.mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      const metadata: LockMetadata = {
        pid: process.pid,
        createdAt: Date.now(),
        ...(description ? { description } : {})
      };
      try {
        await handle.writeFile(JSON.stringify(metadata));
        await handle.sync();
      } catch {
        // Ignore write/sync issues; lock file still signals ownership
      }

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await handle.close();
        } catch {
          // Ignore double-close errors
        }
        try {
          await fs.unlink(lockPath);
        } catch (error) {
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw err;
      }

      const cleared = await tryClearStaleLock(lockPath, staleMs);
      if (cleared) {
        continue;
      }

      if (attempt === retries) {
        throw new LockBusyError(`Lock is currently held: ${lockPath}`);
      }

      await delay(retryDelayMs);
    }
  }

  throw new LockBusyError(`Unable to acquire lock after ${retries + 1} attempts: ${lockPath}`);
}

/**
 * Remove lock file if it appears stale or its owning process is no longer alive.
 */
export async function cleanupStaleLock(lockPath: string, staleMs: number = DEFAULT_STALE_MS): Promise<void> {
  try {
    await tryClearStaleLock(lockPath, staleMs);
  } catch {
    // Best effort cleanup
  }
}

async function tryClearStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const metadata = parseMetadata(raw);
    const isStale = Date.now() - metadata.createdAt > staleMs;
    if (isStale || !isProcessAlive(metadata.pid)) {
      await fs.unlink(lockPath);
      return true;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return true;
    }
    // Malformed lock file → treat as stale
    await fs.unlink(lockPath).catch(() => {});
    return true;
  }
  return false;
}

function parseMetadata(raw: string): LockMetadata {
  try {
    const parsed = JSON.parse(raw) as LockMetadata;
    if (typeof parsed.pid === 'number' && typeof parsed.createdAt === 'number') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {
    pid: -1,
    createdAt: 0,
  };
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || Number.isNaN(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
