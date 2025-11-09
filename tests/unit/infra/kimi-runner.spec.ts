import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as spawnModule from '../../../src/infra/process/spawn.js';
import { runKimi } from '../../../src/infra/engines/providers/kimi/index.js';
import type { ParsedTelemetry } from '../../../src/infra/engines/core/types.js';

describe('Kimi runner integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats print mode JSONL output', async () => {
    const spawnSpy = vi.spyOn(spawnModule, 'spawnProcess').mockImplementation(async (options) => {
      options.onStdout?.(
        `${JSON.stringify({
          role: 'assistant',
          parts: [{ type: 'text', text: 'hi from kimi' }],
        })}\n`,
      );
      options.onStdout?.(
        `${JSON.stringify({
          role: 'tool',
          name: 'bash',
          content: 'ls -la',
        })}\n`,
      );
      options.onStdout?.(
        `${JSON.stringify({
          role: '_usage',
          token_count: {
            input: 12,
            output: 5,
            cached: 2,
          },
        })}\n`,
      );
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    const chunks: string[] = [];
    const telemetry: ParsedTelemetry[] = [];

    await runKimi({
      prompt: 'describe repo',
      workingDir: '/tmp/workspace',
      env: { CODEMACHINE_KIMI_MODE: 'print' },
      onData: (chunk) => chunks.push(chunk),
      onTelemetry: (capture) => telemetry.push(capture),
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.includes('hi from kimi'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('Command: bash'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('⎿ ls -la'))).toBe(true);
    expect(telemetry).toEqual([{ tokensIn: 12, tokensOut: 5, cached: 2 }]);
  });

  it('maps wire JSON-RPC events to markers and telemetry', async () => {
    const fakeChild = {
      stdin: {
        destroyed: false,
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      },
      killed: false,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    const spawnSpy = vi.spyOn(spawnModule, 'spawnProcess').mockImplementation(async (options) => {
      options.onSpawn?.(fakeChild);

      options.onStdout?.(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: {
            event: {
              type: 'tool_call',
              id: 'task-1',
              name: 'fetch_url',
            },
          },
        })}\n`,
      );

      options.onStdout?.(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: {
            event: {
              type: 'tool_result',
              id: 'task-1',
              output: 'fetched!',
            },
          },
        })}\n`,
      );

      options.onStdout?.(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'status_update',
          params: {
            message: 'Context usage update',
            context_usage: {
              token_count: {
                total: 8,
                output: 3,
              },
            },
          },
        })}\n`,
      );

      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    const chunks: string[] = [];
    const telemetry: ParsedTelemetry[] = [];

    await runKimi({
      prompt: 'wire please',
      workingDir: '/tmp/workspace',
      env: { CODEMACHINE_KIMI_MODE: 'wire' },
      onData: (chunk) => chunks.push(chunk),
      onTelemetry: (capture) => telemetry.push(capture),
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnOptions = spawnSpy.mock.calls[0]?.[0];
    expect(spawnOptions?.keepStdinOpen).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('Command: fetch_url'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('⎿ fetched!'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('Context usage update'))).toBe(true);
    expect(telemetry).toEqual([{ tokensIn: 8, tokensOut: 3, cached: undefined }]);
  });
});
