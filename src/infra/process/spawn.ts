import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'child_process';

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  stdioMode?: 'pipe' | 'inherit';
  timeout?: number; // Timeout in milliseconds
  stdinInput?: string; // Data to write to stdin
  keepStdinOpen?: boolean; // Keep stdin open for interactive protocols
  onSpawn?: (child: ChildProcess) => void; // Callback invoked immediately after spawn
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Global registry of active child processes
 * Used to ensure proper cleanup on process termination
 */
const activeProcesses = new Set<ChildProcess>();

/**
 * Kill all active child processes
 * Called during cleanup to ensure no orphaned processes
 */
export function killAllActiveProcesses(): void {
  for (const child of activeProcesses) {
    try {
      if (!child.killed) {
        child.kill('SIGTERM');
        // Force kill after 1 second if still running
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }
  activeProcesses.clear();
}

export function spawnProcess(options: SpawnOptions): Promise<SpawnResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    onStdout,
    onStderr,
    signal,
    stdioMode = 'pipe',
    timeout,
    stdinInput,
    keepStdinOpen = false,
    onSpawn,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    // Use cross-spawn which properly handles .cmd files on Windows without shell issues
    // It automatically finds .cmd wrappers and handles argument escaping correctly
    const child = crossSpawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: stdioMode === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
      signal,
    });

    const closeChildStdin = () => {
      if (child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.end();
        } catch {
          try {
            child.stdin.destroy();
          } catch {
            // Ignore errors during stdin cleanup
          }
        }
      }
    };

    // Track this child process for cleanup
    activeProcesses.add(child);

    // Remove from tracking when process exits
    const removeFromTracking = () => {
      activeProcesses.delete(child);
    };

    onSpawn?.(child);

    let timeoutId: NodeJS.Timeout | null = null;
    let timedOut = false;
    let timeoutError: Error | null = null;

    const clearTimeoutIfNeeded = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    if (typeof timeout === 'number' && timeout > 0) {
      timeoutId = setTimeout(() => {
        if (child.killed) {
          return;
        }
        timedOut = true;
        timeoutError = new Error(`Process timed out after ${timeout}ms`);
        timeoutError.name = 'TimeoutError';
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 1000);
        } catch {
          // ignore kill errors
        }
      }, timeout);
    }

    // Handle abort signal explicitly (in case cross-spawn doesn't handle it properly)
    if (signal) {
      const abortHandler = () => {
        if (!child.killed) {
          try {
            child.kill('SIGTERM');
            // Force kill after 1 second if still running
            setTimeout(() => {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            }, 1000);
          } catch {
            // Ignore kill errors
          }
        }
        closeChildStdin();
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Write to stdin if data is provided
    if (child.stdin) {
      if (stdinInput !== undefined) {
        if (keepStdinOpen) {
          try {
            child.stdin.write(stdinInput);
          } catch {
            // Ignore write errors; process likely exited
          }
        } else {
          child.stdin.end(stdinInput);
        }
      } else if (!keepStdinOpen && stdioMode === 'pipe') {
        child.stdin.end();
      }
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    if (stdioMode === 'pipe' && child.stdout) {
      child.stdout.on('data', (data: Buffer | string) => {
        const text = data.toString();
        stdoutChunks.push(text);
        onStdout?.(text);
      });
    }

    if (stdioMode === 'pipe' && child.stderr) {
      child.stderr.on('data', (data: Buffer | string) => {
        const text = data.toString();
        stderrChunks.push(text);
        onStderr?.(text);
      });
    }

    child.once('error', (error: Error) => {
      removeFromTracking();
      closeChildStdin();
      clearTimeoutIfNeeded();
      rejectOnce(error);
    });

    child.once('close', (code: number | null) => {
      removeFromTracking();
      closeChildStdin();
      clearTimeoutIfNeeded();
      if (timedOut && timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      const exitCode = code ?? 0;
      resolveOnce({
        exitCode,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    });
  });
}
