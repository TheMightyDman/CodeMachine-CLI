import type { ChildProcess } from 'node:child_process';

import { execa } from 'execa';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildKimiPrintCommand, buildKimiWireCommand } from './commands.js';
import type { KimiConfig } from '../config.js';
import { formatCommand, formatResult, formatStatus, formatThinking } from '../../../../../shared/formatters/outputMarkers.js';
import { metadata } from '../metadata.js';

const ANSI_ESCAPE_SEQUENCE = new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, 'g');

export interface KimiUsageSnapshot {
  tokensIn?: number;
  tokensOut?: number;
  cached?: number;
}

interface KimiRunnerHooks {
  onData?: (chunk: string) => void;
  onErrorData?: (chunk: string) => void;
  onUsageSnapshot?: (snapshot: KimiUsageSnapshot) => void;
}

interface BaseRunnerOptions extends KimiRunnerHooks {
  prompt: string;
  workingDir: string;
  env?: NodeJS.ProcessEnv;
  config: KimiConfig;
  abortSignal?: AbortSignal;
  timeout?: number;
  plainLogs: boolean;
}

export interface RunKimiResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type KimiJson = { [key: string]: unknown };

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const asArray = <T = unknown>(value: unknown): T[] | undefined => (Array.isArray(value) ? (value as T[]) : undefined);
const asObject = (value: unknown): KimiJson | undefined =>
  value && typeof value === 'object' ? (value as KimiJson) : undefined;

function normalizeChunk(chunk: string, plainLogs: boolean): string {
  let result = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (plainLogs) {
    result = result.replace(ANSI_ESCAPE_SEQUENCE, '');
  }
  return result;
}

function handleNotFoundError(error: unknown, command: string, args: string[]): never {
  const err = error as NodeJS.ErrnoException;
  const message = err?.message ?? '';
  const combined = `${message}`.toLowerCase();
  if (
    err?.code === 'ENOENT' ||
    combined.includes('command not found') ||
    combined.includes('not recognized as an internal or external command')
  ) {
    const full = `${command} ${args.join(' ')}`.trim();
    throw new Error(`'${command}' is not available when executing "${full}". Install ${metadata.name} via:\n  ${metadata.installCommand}`);
  }

  throw error;
}

function maybeThrowAuthError(stdout: string, stderr: string): void {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (combined.includes('kimi_api_key') || combined.includes('llm not set') || combined.includes('api key')) {
    if (process.env.LOG_LEVEL === 'debug' || process.env.CODEMACHINE_DEBUG_KIMI_ENV === '1') {
      const snippetStdout = stdout.split('\n').slice(0, 10).join('\n');
      const snippetStderr = stderr.split('\n').slice(0, 10).join('\n');
      console.error(`[DEBUG] Kimi auth failure stdout:\n${snippetStdout}`);
      console.error(`[DEBUG] Kimi auth failure stderr:\n${snippetStderr}`);
    }
    throw new Error(
      `Kimi CLI could not find KIMI_API_KEY.\n` +
        `Set it in your shell before running CodeMachine, e.g.:\n` +
        `  export KIMI_API_KEY="sk-..."\n` +
        `Optional overrides:\n` +
        `  export KIMI_BASE_URL="https://api.moonshot.cn/v1"\n` +
        `  export KIMI_MODEL_NAME="moonshot-v1-128k"\n` +
        `Run \`codemachine auth status\` to inspect stored keys and file locations.`,
    );
  }
}

function emitAssistantContent(payload: KimiJson | null | undefined, hooks: KimiRunnerHooks): void {
  if (!payload) return;
  const partsCandidate = asArray<KimiJson | string>(payload.parts) ?? asArray<KimiJson | string>(payload.content);

  if (partsCandidate) {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const part of partsCandidate) {
      if (!part) continue;
      if (typeof part === 'string') {
        textParts.push(part);
        continue;
      }

      const fragment = part as KimiJson;
      const type = asString(fragment.type);
      const text = asString(fragment.text);

      if (type === 'text' && text) {
        textParts.push(text);
      } else if (type === 'thinking' && text) {
        thinkingParts.push(text);
      }
    }

    if (thinkingParts.length > 0) {
      hooks.onData?.(formatThinking(thinkingParts.join('')) + '\n');
    }

    if (textParts.length > 0) {
      const chunk = textParts.join('');
      hooks.onData?.(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    }
    return;
  }

  const text = asString(payload.text);
  if (text) {
    hooks.onData?.(text.endsWith('\n') ? text : `${text}\n`);
  }
}

function emitToolMessage(payload: KimiJson | null | undefined, hooks: KimiRunnerHooks): void {
  const toolName = (payload && (asString(payload.name) ?? asString(payload.tool_name))) ?? 'tool';
  const status: 'success' | 'error' = (payload && asString(payload.status)) === 'error' || payload?.is_error === true ? 'error' : 'success';

  let content = '';
  const contentArray = payload ? asArray(payload.content) : undefined;

  if (contentArray) {
    content = contentArray.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
  } else if (payload) {
    content =
      asString(payload.content) ??
      asString(payload.output) ??
      asString(payload.text) ??
      '';
  }

  const trimmed = content.trim();
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;

  let message = formatCommand(toolName, status);
  if (preview) {
    message += `\n${formatResult(preview, status === 'error')}`;
  }

  hooks.onData?.(message + '\n');
}

function emitUsageSnapshot(payload: KimiJson | null | undefined, hooks: KimiRunnerHooks): void {
  if (!payload) return;
  const rawTokens = payload.token_count ?? payload.usage ?? payload.context_usage ?? payload.tokens;
  if (rawTokens === undefined) return;

  if (typeof rawTokens === 'number') {
    hooks.onUsageSnapshot?.({ tokensIn: rawTokens });
    return;
  }

  const tokens = asObject(rawTokens);
  if (!tokens) return;

  const tokensIn =
    asNumber(tokens.total) ??
    asNumber(tokens.input) ??
    asNumber(tokens.prompt) ??
    asNumber(tokens.request);

  const tokensOut =
    asNumber(tokens.output) ??
    asNumber(tokens.completion) ??
    asNumber(tokens.response);

  const cached =
    asNumber(tokens.cached) ??
    asNumber(tokens.cache) ??
    asNumber(tokens.cached_input);

  hooks.onUsageSnapshot?.({
    tokensIn,
    tokensOut,
    cached,
  });
}

function emitCheckpoint(payload: KimiJson | null | undefined, hooks: KimiRunnerHooks): void {
  const id = payload ? asString(payload.id) ?? asString(payload.checkpoint_id) : undefined;
  const label = id ? `Checkpoint ${id}` : 'Checkpoint reached';
  hooks.onData?.(formatStatus(label) + '\n');
}

export async function runKimiPrint(options: BaseRunnerOptions): Promise<RunKimiResult> {
  const { prompt, workingDir, env, abortSignal, timeout, config, plainLogs } = options;
  const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };

  // Emit an initial status line mirroring other engines
  try {
    options.onData?.(formatStatus('Kimi is analyzing your request...') + '\n');
  } catch {
    // ignore status emission failures
  }

  const { command, args } = buildKimiPrintCommand({
    prompt,
    workingDir,
    model: config.model,
    mcpConfigFiles: config.mcpConfigFiles,
  });
  const binary = process.env.CODEMACHINE_KIMI_BINARY?.trim() || command;

  if (process.env.LOG_LEVEL === 'debug' || process.env.CODEMACHINE_DEBUG_KIMI_ENV === '1') {
    const key = mergedEnv.KIMI_API_KEY;
    const preview = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : 'none';
    const from = key ? (env?.KIMI_API_KEY ? 'passed' : 'process') : 'missing';
    console.error(`[DEBUG] Kimi runKimiPrint: childEnvHasKey=${Boolean(key)} source=${from} length=${key?.length ?? 0} preview=${preview} HOME=${mergedEnv.HOME}`);
    try {
      const which = await execa('which', [binary], { env: mergedEnv, reject: false });
      console.error(`[DEBUG] Kimi binary path: ${which.stdout || 'not found'}`);
    } catch (err) {
      console.error(`[DEBUG] Kimi binary path lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const result = await spawnProcess({
      command: binary,
      args,
      cwd: workingDir,
      env: mergedEnv,
      onStdout: (chunk) => {
        const normalized = normalizeChunk(chunk, plainLogs);
        const lines = normalized.split('\n');
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const json = JSON.parse(line) as KimiJson;
            const role = asString(json.role);
            switch (role) {
              case 'assistant':
                emitAssistantContent(json, options);
                break;
              case 'tool':
                emitToolMessage(json, options);
                break;
              case '_usage':
                emitUsageSnapshot(json, options);
                break;
              case '_checkpoint':
                emitCheckpoint(json, options);
                break;
              default:
                break;
            }
          } catch {
            options.onData?.(rawLine.endsWith('\n') ? rawLine : `${rawLine}\n`);
          }
        }
      },
      onStderr: (chunk) => {
        const normalized = normalizeChunk(chunk, plainLogs);
        options.onErrorData?.(normalized);
      },
      signal: abortSignal,
      stdioMode: 'pipe',
      timeout,
    });

    if (result.exitCode !== 0) {
      maybeThrowAuthError(result.stdout, result.stderr);
      const errorOutput = result.stderr.trim() || result.stdout.trim() || 'no error output';
      throw new Error(`Kimi CLI exited with code ${result.exitCode}: ${errorOutput.split('\n').slice(0, 10).join('\n')}`);
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    handleNotFoundError(error, binary, args);
  }
}

interface WireState {
  buffer: string;
  toolNames: Map<string, string>;
  child?: ChildProcess;
}

function applyPrefix(text: string, prefix?: string): string {
  if (!prefix) {
    return text;
  }

  const markerMatch = text.match(/^\[(?:GRAY|GREEN|RED|ORANGE|CYAN)\]/);
  if (markerMatch) {
    return `${markerMatch[0]}${prefix}: ${text.slice(markerMatch[0].length)}`;
  }

  return `${prefix}: ${text}`;
}

function handleWireEvent(eventInput: KimiJson | null | undefined, hooks: KimiRunnerHooks, state: WireState, prefix?: string): void {
  if (!eventInput) {
    return;
  }

  const type = asString(eventInput.type);
  if (!type) {
    return;
  }

  const event = eventInput;

  switch (type) {
    case 'content_part': {
      const text = asString(event.text) ?? asString(event.content);
      if (text) {
        hooks.onData?.(applyPrefix(text.endsWith('\n') ? text : `${text}\n`, prefix));
      } else {
        const contentType = asString(event.content_type) ?? 'content';
        const preview = JSON.stringify(asObject(event.data) ?? event).slice(0, 120);
        hooks.onData?.(applyPrefix(formatStatus(`Kimi emitted ${contentType}: ${preview}`) + '\n', prefix));
      }
      break;
    }
    case 'tool_call': {
      const toolName = asString(event.name) ?? asString(event.tool_name) ?? 'tool';
      const id = asString(event.id);
      if (id) {
        state.toolNames.set(id, toolName);
      }
      hooks.onData?.(applyPrefix(formatCommand(toolName, 'started') + '\n', prefix));
      break;
    }
    case 'tool_call_part': {
      const id = asString(event.id);
      const toolName = asString(event.name) ?? asString(event.tool_name) ?? (id ? state.toolNames.get(id) : undefined) ?? 'tool';
      const preview = asString(event.preview) ?? JSON.stringify(asObject(event.input) ?? {}).slice(0, 120);
      const chunk = (formatCommand(toolName, 'started') + (preview ? `\n${formatResult(preview, false)}` : '')) + '\n';
      hooks.onData?.(applyPrefix(chunk, prefix));
      break;
    }
    case 'tool_result': {
      const id = asString(event.id);
      const toolName = (id && state.toolNames.get(id)) ?? asString(event.name) ?? 'tool';
      const isError = asString(event.status) === 'error' || event.is_error === true;
      let preview = '';
      preview =
        (asString(event.output)?.trim()) ??
        (asString(event.text)?.trim()) ??
        (asString(event.content)?.trim()) ??
        (asObject(event.output) ? JSON.stringify(event.output).slice(0, 200) : '');
      let message = formatCommand(toolName, isError ? 'error' : 'success');
      if (preview) {
        message += `\n${formatResult(preview, isError)}`;
      }
      hooks.onData?.(applyPrefix(message + '\n', prefix));
      if (id) {
        state.toolNames.delete(id);
      }
      break;
    }
    case 'status_update': {
      const message = asString(event.message);
      if (message) {
        hooks.onData?.(applyPrefix(formatStatus(message) + '\n', prefix));
      }
      emitUsageSnapshot(asObject(event.context_usage) ?? asObject(event.usage), hooks);
      break;
    }
    case 'step_begin':
      hooks.onData?.(applyPrefix(formatStatus('Kimi started a new step') + '\n', prefix));
      break;
    case 'step_interrupted':
      hooks.onData?.(applyPrefix(formatStatus('Kimi interrupted the current step') + '\n', prefix));
      break;
    case 'compaction_begin':
      hooks.onData?.(applyPrefix(formatStatus('Kimi is compacting the transcript') + '\n', prefix));
      break;
    case 'compaction_end':
      hooks.onData?.(applyPrefix(formatStatus('Kimi finished compaction') + '\n', prefix));
      break;
    case 'subagent_event': {
      const taskId =
        asString(event.task_tool_call_id) ??
        (typeof event.task_tool_call_id === 'number' ? String(event.task_tool_call_id) : undefined);
      const prefixLabel = taskId ? `Subagent ${taskId}` : 'Subagent';
      const nested = asObject(event.event);
      if (nested) {
        handleWireEvent(nested, hooks, state, prefixLabel);
      }
      break;
    }
    default:
      break;
  }
}

function autoApproveRequest(id: string, params: KimiJson | null | undefined, hooks: KimiRunnerHooks, child?: ChildProcess): void {
  if (!child?.stdin || child.stdin.destroyed) {
    return;
  }

  const title =
    (params && (asString(params.title) ?? asString(params.message))) ??
    (asObject(params?.request) ? asString((params.request as KimiJson).title) ?? asString((params.request as KimiJson).message) : undefined) ??
    'Kimi approval';
  hooks.onData?.(formatStatus(`Auto-approved: ${title}`) + '\n');

  const response = {
    jsonrpc: '2.0',
    id,
    result: {
      approved: true,
      action: 'approve',
    },
  };

  try {
    child.stdin.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Ignore write errors
  }
}

export async function runKimiWire(options: BaseRunnerOptions): Promise<RunKimiResult> {
  const { prompt, workingDir, env, abortSignal, timeout, config, plainLogs } = options;
  const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };

  // Emit an initial status line before wiring up events
  try {
    options.onData?.(formatStatus('Kimi is analyzing your request...') + '\n');
  } catch {
    // ignore status emission failures
  }

  const { command, args } = buildKimiWireCommand({
    workingDir,
    model: config.model,
    mcpConfigFiles: config.mcpConfigFiles,
  });
  const binary = process.env.CODEMACHINE_KIMI_BINARY?.trim() || command;

  if (process.env.LOG_LEVEL === 'debug' || process.env.CODEMACHINE_DEBUG_KIMI_ENV === '1') {
    const key = mergedEnv.KIMI_API_KEY;
    const preview = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : 'none';
    const from = key ? (env?.KIMI_API_KEY ? 'passed' : 'process') : 'missing';
    console.error(`[DEBUG] Kimi runKimiWire: childEnvHasKey=${Boolean(key)} source=${from} length=${key?.length ?? 0} preview=${preview} HOME=${mergedEnv.HOME}`);
    try {
      const which = await execa('which', [binary], { env: mergedEnv, reject: false });
      console.error(`[DEBUG] Kimi binary path: ${which.stdout || 'not found'}`);
    } catch (err) {
      console.error(`[DEBUG] Kimi binary path lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const state: WireState = {
    buffer: '',
    toolNames: new Map(),
  };

  const runRequestId = `run-${Date.now()}`;

  const sendJsonRpc = (payload: unknown) => {
    if (!state.child?.stdin || state.child.stdin.destroyed) {
      return;
    }
    try {
      state.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Ignore write errors
    }
  };

  const processLine = (line: string) => {
    if (!line) return;
    try {
      const json = JSON.parse(line) as KimiJson;
      const method = asString(json.method);
      const id = asString(json.id);
      const params = asObject(json.params);
      const error = asObject(json.error);

      if (method === 'event' && params) {
        handleWireEvent(asObject(params.event), options, state);
      } else if (method === 'request' && id) {
        autoApproveRequest(id, params, options, state.child);
      } else if (id === runRequestId && error) {
        const message = asString(error.message) ?? 'Unknown wire error';
        options.onErrorData?.(`${formatCommand('Kimi Error', 'error')}\n${formatResult(message, true)}\n`);
      } else if (method === 'status_update') {
        handleWireEvent({ type: 'status_update', ...(params ?? {}) }, options, state);
      } else if (error) {
        const message = asString(error.message) ?? 'Unknown error';
        options.onErrorData?.(`${formatCommand('Kimi Error', 'error')}\n${formatResult(message, true)}\n`);
      }
    } catch {
      options.onErrorData?.((line.endsWith('\n') ? line : `${line}\n`));
    }
  };

  try {
    const result = await spawnProcess({
      command: binary,
      args,
      cwd: workingDir,
      env: mergedEnv,
      onStdout: (chunk) => {
        const normalized = normalizeChunk(chunk, plainLogs);
        state.buffer += normalized;

        let index;
        while ((index = state.buffer.indexOf('\n')) !== -1) {
          const line = state.buffer.slice(0, index).trim();
          state.buffer = state.buffer.slice(index + 1);
          processLine(line);
        }
      },
      onStderr: (chunk) => {
        const normalized = normalizeChunk(chunk, plainLogs);
        options.onErrorData?.(normalized);
      },
      signal: abortSignal,
      stdioMode: 'pipe',
      timeout,
      keepStdinOpen: true,
      onSpawn: (child) => {
        state.child = child;
        setTimeout(() => {
          sendJsonRpc({
            jsonrpc: '2.0',
            id: runRequestId,
            method: 'run',
            params: {
              input: prompt,
              work_dir: workingDir,
            },
          });
        }, 10);
      },
    });

    if (state.buffer.trim().length > 0) {
      processLine(state.buffer.trim());
      state.buffer = '';
    }

    if (result.exitCode !== 0) {
      maybeThrowAuthError(result.stdout, result.stderr);
      const errorOutput = result.stderr.trim() || result.stdout.trim() || 'no error output';
      throw new Error(`Kimi wire mode exited with code ${result.exitCode}: ${errorOutput.split('\n').slice(0, 10).join('\n')}`);
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    handleNotFoundError(error, binary, args);
  }
}
