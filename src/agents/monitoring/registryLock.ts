import * as logger from '../../shared/logging/logger.js';
import { acquireFileLock, LockBusyError, cleanupStaleLock } from '../../shared/fs/fileLock.js';

/**
 * Service for managing file system lock on the agent registry
 * Prevents race conditions when multiple processes access registry.json simultaneously
 *
 * Uses a simple sentinel file that is created with O_EXCL semantics.
 */
export class RegistryLockService {
  private registryPath: string;
  private releaseHandle: (() => Promise<void>) | null = null;
  private lockFilePath: string;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
    this.lockFilePath = `${registryPath}.lock`;
    cleanupStaleLock(this.lockFilePath).catch(err => {
      logger.debug(`Failed to cleanup stale registry lock (${this.lockFilePath}): ${err}`);
    });
  }

  /**
   * Acquire an exclusive lock on the registry file
   * Returns a release function to unlock the file
   *
   * Ensures the file exists before attempting to lock
   */
  async acquireLock(): Promise<() => Promise<void>> {
    try {
      const lockPath = this.registryPath;

      // Ensure registry file exists before locking so downstream code never sees ENOENT
      // Use synchronous operations to prevent race conditions during file creation
      const { existsSync, mkdirSync, writeFileSync } = await import('fs');
      const { dirname } = await import('path');

      if (!existsSync(lockPath)) {
        const dir = dirname(lockPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Create minimal valid registry file synchronously
        // This ensures the file is fully written before we try to lock it
        const initialData = JSON.stringify({ lastId: 0, agents: {} }, null, 2);
        writeFileSync(lockPath, initialData, 'utf-8');
        logger.debug(`Created registry file for locking: ${lockPath}`);
      }

      const release = await acquireFileLock(this.lockFilePath, {
        staleMs: 45_000,
        retries: 10,
        retryDelayMs: 150,
        description: 'registry',
      });

      this.releaseHandle = release;
      logger.debug(`Acquired lock for registry: ${this.registryPath}`);

      return release;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LockBusyError) {
        logger.warn(`Registry lock degraded (best-effort): ${message}`);
        return async () => {};
      }
      logger.error(`CRITICAL: Failed to acquire lock for registry ${this.registryPath}: ${message}`);
      throw new Error(`Failed to acquire registry lock: ${message}`);
    }
  }

  /**
   * Release the registry lock
   */
  async releaseLock(): Promise<void> {
    if (this.releaseHandle) {
      try {
        await this.releaseHandle();
        logger.debug(`Released lock for registry: ${this.registryPath}`);
      } catch (error) {
        logger.warn(`Failed to release lock for registry ${this.registryPath}: ${error}`);
      }
      this.releaseHandle = null;
    }
  }

  /**
   * Execute a function with registry lock held
   * Automatically acquires and releases the lock
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /**
   * Check if the registry is currently locked by this instance
   */
  isLocked(): boolean {
    return this.releaseHandle !== null;
  }
}
