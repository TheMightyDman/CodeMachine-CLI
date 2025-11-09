import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { spawnProcess } from '../../../../process/spawn.js';
import { buildOpenCodeRunCommand } from './commands.js';
import { metadata } from '../metadata.js';
import { resolveOpenCodeHome } from '../auth.js';
import { formatCommand, formatResult, formatStatus, formatMessage } from '../../../../../shared/formatters/outputMarkers.js';
import { logger } from '../../../../../shared/logging/index.js';
import { createTelemetryCapture } from '../../../../../shared/telemetry/index.js';
import type { ParsedTelemetry } from '../../../core/types.js';
import { PermissionRequiredError } from '../../../errors.js';

export interface RunOpenCodeOptions {
  prompt: string;
  workingDir: string;
  model?: string;
  agent?: string;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: string) => void;
  onErrorData?: (chunk: string) => void;
  onTelemetry?: (telemetry: ParsedTelemetry) => void;
  abortSignal?: AbortSignal;
  timeout?: number; // Timeout in milliseconds (default: 1800000ms = 30 minutes)
}

export interface RunOpenCodeResult {
  stdout: string;
  stderr: string;
}

const ANSI_ESCAPE_SEQUENCE = new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, 'g');
// Allow all categories by default to avoid interactive prompts in CI/non-interactive
// Includes bash wildcard to preserve previous behavior
const DEFAULT_PERMISSION_POLICY = '{"*":"allow","bash":{"*":"allow"}}';
const PARAGRAPH_SEPARATOR_PATTERN = /\n{2,}/;

interface ToolState {
  output?: unknown;
  title?: string;
  input?: Record<string, unknown>;
}

interface ToolPart {
  tool?: string;
  state?: ToolState;
}

interface StepTokens {
  input?: number;
  output?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

interface StepPart {
  reason?: string;
  tokens?: StepTokens;
  cost?: number;
}

interface ErrorPart {
  data?: {
    message?: string;
  };
  message?: string;
  name?: string;
}

interface TextPart {
  text?: string;
}

type OpenCodeEvent = {
  type?: string;
  part?: ToolPart | StepPart | TextPart | ErrorPart;
  error?: ErrorPart;
  properties?: Record<string, unknown>;
  permission?: Record<string, unknown>;
} & Record<string, unknown>;

interface PermissionPayload {
  id?: string;
  type?: string;
  pattern?: string | string[];
  title?: string;
  metadata?: Record<string, unknown>;
}

function shouldApplyDefault(key: string, overrides?: NodeJS.ProcessEnv): boolean {
  return overrides?.[key] === undefined && process.env[key] === undefined;
}

function resolveRunnerEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runnerEnv: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };

  if (shouldApplyDefault('OPENCODE_PERMISSION', env)) {
    runnerEnv.OPENCODE_PERMISSION = DEFAULT_PERMISSION_POLICY;
  }

  // Reduce bootstrapping overhead and interactivity from plugins/LSPs
  if (shouldApplyDefault('OPENCODE_DISABLE_LSP_DOWNLOAD', env)) {
    runnerEnv.OPENCODE_DISABLE_LSP_DOWNLOAD = '1';
  }

  if (shouldApplyDefault('OPENCODE_DISABLE_DEFAULT_PLUGINS', env)) {
    runnerEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
  }

  // Set all three XDG environment variables to subdirectories under OPENCODE_HOME
  // This centralizes all OpenCode data under ~/.codemachine/opencode by default
  const opencodeHome = resolveOpenCodeHome(runnerEnv.OPENCODE_HOME);

  if (shouldApplyDefault('XDG_CONFIG_HOME', env)) {
    runnerEnv.XDG_CONFIG_HOME = path.join(opencodeHome, 'config');
  }

  if (shouldApplyDefault('XDG_CACHE_HOME', env)) {
    runnerEnv.XDG_CACHE_HOME = path.join(opencodeHome, 'cache');
  }

  if (shouldApplyDefault('XDG_DATA_HOME', env)) {
    runnerEnv.XDG_DATA_HOME = path.join(opencodeHome, 'data');
  }

  return runnerEnv;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const toStringArray = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return undefined;
};

function isPermissionPending(payload: PermissionPayload | undefined): boolean {
  if (!payload) return false;
  const statusSource =
    asString(payload.metadata?.status) ??
    asString(payload.metadata?.state) ??
    asString(payload.metadata?.resolution) ??
    '';
  if (!statusSource) return true;
  const normalized = statusSource.toLowerCase();
  if (['approved', 'allow', 'allowed', 'granted', 'denied', 'rejected', 'resolved', 'dismissed'].includes(normalized)) {
    return false;
  }
  return true;
}

function extractPermission(event: OpenCodeEvent): PermissionPayload | undefined {
  if (event.permission && typeof event.permission === 'object') {
    return {
      ...(event.permission as PermissionPayload),
      metadata: asRecord((event.permission as PermissionPayload).metadata),
    };
  }

  const fromProps = asRecord(event.properties);
  if (fromProps && (fromProps.title || fromProps.id || fromProps.type)) {
    const payload: PermissionPayload = {
      id: asString(fromProps.id),
      type: asString(fromProps.type),
      pattern: fromProps.pattern as PermissionPayload['pattern'],
      title: asString(fromProps.title),
      metadata: asRecord(fromProps.metadata ?? fromProps),
    };
    return payload;
  }

  return undefined;
}

const truncate = (value: string, length = 100): string =>
  value.length > length ? `${value.slice(0, length)}...` : value;

function cleanAnsi(text: string, plainLogs: boolean): string {
  if (!plainLogs) return text;
  return text.replace(ANSI_ESCAPE_SEQUENCE, '');
}

function computeTextDelta(previous: string, nextValue: string): { delta: string; snapshot: string } {
  if (!previous) {
    return { delta: nextValue, snapshot: nextValue };
  }

  if (nextValue === previous) {
    return { delta: '', snapshot: previous };
  }

  if (nextValue.startsWith(previous)) {
    return { delta: nextValue.slice(previous.length), snapshot: nextValue };
  }

  return { delta: nextValue, snapshot: nextValue };
}

function removeDuplicateParagraphs(text: string, lastParagraph: { value: string }): string {
  if (!text) {
    return text;
  }

  const segments = text.split(/(\n{2,})/);
  if (segments.length === 1) {
    const normalized = segments[0]?.trim() ?? '';
    if (normalized && normalized === lastParagraph.value) {
      return '';
    }
    if (normalized) {
      lastParagraph.value = normalized;
    }
    return text;
  }

  let output = '';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    if (i % 2 === 1) {
      output += segment;
      continue;
    }

    const normalized = segment.trim();
    if (!normalized) {
      output += segment;
      continue;
    }

    if (normalized === lastParagraph.value) {
      if (i + 1 < segments.length && PARAGRAPH_SEPARATOR_PATTERN.test(segments[i + 1] ?? '')) {
        i += 1;
      }
      continue;
    }

    lastParagraph.value = normalized;
    output += segment;
  }

  return output;
}

function formatToolUse(part: ToolPart | undefined, plainLogs: boolean): string {
  const tool = part?.tool ?? 'tool';
  const base = formatCommand(tool, 'success');
  const state = part?.state ?? {};

  if (tool === 'bash') {
    const outputRaw =
      typeof state?.output === 'string'
        ? state.output
        : state?.output
          ? JSON.stringify(state.output)
          : '';
    const output = cleanAnsi(outputRaw?.trim() ?? '', plainLogs);
    if (output) {
      return `${base}\n${formatResult(output, false)}`;
    }
    return base;
  }

  const previewSource =
    (typeof state?.title === 'string' && state.title.trim()) ||
    (typeof state?.output === 'string' && state.output.trim()) ||
    (state?.input && Object.keys(state.input).length > 0 ? JSON.stringify(state.input) : '');

  if (previewSource) {
    const preview = cleanAnsi(previewSource.trim(), plainLogs);
    return `${base}\n${formatResult(truncate(preview), false)}`;
  }

  return base;
}

function formatStepEvent(type: string, part: StepPart | undefined): string {
  if (type === 'step_start') {
    return formatStatus('OpenCode started a new step');
  }

  const reason = typeof part?.reason === 'string' ? part.reason : undefined;
  const tokens = part?.tokens;
  const cache = tokens ? (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) : 0;
  const tokenSummary = tokens
    ? `Tokens ${tokens.input ?? 0}in/${tokens.output ?? 0}out${cache > 0 ? ` (${cache} cached)` : ''}`
    : undefined;

  const segments = ['OpenCode finished a step'];
  if (reason) segments.push(`Reason: ${reason}`);
  if (tokenSummary) segments.push(tokenSummary);

  return formatStatus(segments.join(' | '));
}

function formatErrorEvent(error: ErrorPart | undefined, plainLogs: boolean): string {
  const dataMessage =
    typeof error?.data?.message === 'string'
      ? error.data.message
      : typeof error?.message === 'string'
        ? error.message
        : typeof error?.name === 'string'
          ? error.name
          : 'OpenCode reported an unknown error';

  const cleaned = cleanAnsi(dataMessage, plainLogs);
  return `${formatCommand('OpenCode Error', 'error')}\n${formatResult(cleaned, true)}`;
}

function resolveTimeoutMs(passed?: number): number {
  if (typeof passed === 'number' && passed > 0) return passed;
  const override = process.env.CODEMACHINE_OPENCODE_TIMEOUT_MS;
  const parsed = override ? Number(override) : NaN;
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  // Default to 5 minutes instead of 30 to fail fast when providers hang
  return 300_000;
}

export async function runOpenCode(options: RunOpenCodeOptions): Promise<RunOpenCodeResult> {
  const {
    prompt,
    workingDir,
    model,
    agent,
    env,
    onData,
    onErrorData,
    onTelemetry,
    abortSignal,
    timeout,
  } = options;

  if (!prompt) {
    throw new Error('runOpenCode requires a prompt.');
  }

  if (!workingDir) {
    throw new Error('runOpenCode requires a working directory.');
  }

  const runnerEnv = resolveRunnerEnv(env);
  const plainLogs =
    (env?.CODEMACHINE_PLAIN_LOGS ?? process.env.CODEMACHINE_PLAIN_LOGS ?? '').toString() === '1';
  const { command, args } = buildOpenCodeRunCommand({ model, agent });

  try {
    onData?.(formatStatus('OpenCode is analyzing your request...') + '\n');
  } catch {
    // ignore logging failures
  }

  logger.debug(
    `OpenCode runner - prompt length: ${prompt.length}, lines: ${prompt.split('\n').length}, agent: ${
      agent ?? 'build'
    }, model: ${model ?? 'default'}`,
  );
  logger.debug(
    `OpenCode env: PERMISSION=${runnerEnv.OPENCODE_PERMISSION ? 'set' : 'unset'} CONFIG_DIR=${runnerEnv.OPENCODE_CONFIG_DIR ?? 'unset'} DISABLE_LSP=${runnerEnv.OPENCODE_DISABLE_LSP_DOWNLOAD ?? 'unset'} DISABLE_PLUGINS=${runnerEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS ?? 'unset'}`,
  );

  const telemetryCapture = createTelemetryCapture('opencode', model, prompt, workingDir);
  let pendingPermissionError: PermissionRequiredError | null = null;
  let capturedChild: ChildProcess | null = null;
  let jsonBuffer = '';
  let lastTextSnapshot = '';
  const lastParagraph = { value: '' };
  const effectiveTimeout = resolveTimeoutMs(timeout);
  let lastActivity = Date.now();
  let heartbeat: NodeJS.Timeout | null = null;
  const shouldTailDiagnostics = (process.env.CODEMACHINE_OPENCODE_TAIL_ON_STALL === '1') || (process.env.LOG_LEVEL === 'debug');
  let diagNotified = false;

  async function getLatestOpenCodeLogPath(): Promise<string | null> {
    try {
      const base = process.env.XDG_DATA_HOME
        ? require('node:path').resolve(require('node:os').homedir(), process.env.XDG_DATA_HOME)
        : require('node:path').join(require('node:os').homedir(), '.local', 'share');
      const logDir = require('node:path').join(base, 'opencode', 'log');
      const { readdir, stat } = await import('node:fs/promises');
      const entries = await readdir(logDir);
      const candidates: Array<{ path: string; mtime: number }> = [];
      for (const name of entries) {
        if (!name.endsWith('.log')) continue;
        const full = require('node:path').join(logDir, name);
        try {
          const s = await stat(full);
          candidates.push({ path: full, mtime: s.mtimeMs });
        } catch { /* ignore */ }
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.mtime - a.mtime);
      return candidates[0].path;
    } catch {
      return null;
    }
  }

  const processLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    let parsed: OpenCodeEvent;
    try {
      parsed = JSON.parse(line) as OpenCodeEvent;
    } catch {
      const fallback = cleanAnsi(line, plainLogs);
      if (fallback) {
        const suffix = fallback.endsWith('\n') ? '' : '\n';
        onData?.(fallback + suffix);
      }
      return;
    }

    telemetryCapture.captureFromStreamJson(line);

    if (onTelemetry) {
      const captured = telemetryCapture.getCaptured();
      if (captured?.tokens) {
        const totalIn =
          (captured.tokens.input ?? 0) + (captured.tokens.cached ?? 0);
        onTelemetry({
          tokensIn: totalIn,
          tokensOut: captured.tokens.output ?? 0,
          cached: captured.tokens.cached,
          cost: captured.cost,
          duration: captured.duration,
        });
      }
    }

    let formatted: string | null = null;
    switch (parsed.type) {
      case 'tool_use':
        formatted = formatToolUse(parsed.part as ToolPart | undefined, plainLogs);
        break;
      case 'step_start':
      case 'step_finish':
        formatted = formatStepEvent(parsed.type ?? 'step_finish', parsed.part as StepPart | undefined);
        break;
      case 'text': {
        const textPart = parsed.part as TextPart | undefined;
        const textValue =
          typeof textPart?.text === 'string'
            ? cleanAnsi(textPart.text, plainLogs)
            : '';
        if (textValue) {
          const { delta, snapshot } = computeTextDelta(lastTextSnapshot, textValue);
          lastTextSnapshot = snapshot;
          const deduped = removeDuplicateParagraphs(delta, lastParagraph);
          formatted = deduped || null;
        }
        break;
      }
      case 'error':
        formatted = formatErrorEvent(parsed.error ?? (parsed.part as ErrorPart | undefined), plainLogs);
        break;
      case 'permission':
      case 'permission.updated':
      case 'permission.requested':
      case 'permission_required': {
        if (!pendingPermissionError) {
          const payload = extractPermission(parsed);
          if (payload && isPermissionPending(payload)) {
            const metadata = payload.metadata ?? {};
            const path = asString(metadata.path ?? metadata.target);
            const message = payload.title ?? payload.type ?? payload.id ?? 'OpenCode permission required';
            pendingPermissionError = new PermissionRequiredError(message, {
              engine: 'opencode',
              id: payload.id,
              title: payload.title,
              capability: payload.type,
              pattern: payload.pattern,
              path,
              metadata,
              raw: parsed,
            });
            try {
              onData?.(formatStatus(`OpenCode requested approval: ${message}`) + '\n');
            } catch {
              // ignore log failures
            }
            if (capturedChild && !capturedChild.killed) {
              try {
                capturedChild.kill('SIGTERM');
                setTimeout(() => {
                  if (capturedChild && !capturedChild.killed) {
                    capturedChild.kill('SIGKILL');
                  }
                }, 500);
              } catch {
                // ignore kill errors
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }

    if (formatted) {
      const suffix = formatted.endsWith('\n') ? '' : '\n';
      onData?.(formatted + suffix);
    }
  };

  const normalizeChunk = (chunk: string): string => {
    let result = chunk;

    // Convert line endings to \n
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Handle carriage returns that cause line overwrites
    result = result.replace(/^.*\r([^\r\n]*)/gm, '$1');

    // Strip ANSI sequences in plain mode
    if (plainLogs) {
      result = result.replace(ANSI_ESCAPE_SEQUENCE, '');
    }

    // Collapse excessive newlines
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
  };

  let result;
  try {
    // Heartbeat status while waiting for output
    heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > 10_000) {
        try {
          onData?.(formatStatus('Waiting on OpenCode response…') + '\n');
        } catch {
          // ignore
        }
        if (shouldTailDiagnostics && !diagNotified && (now - lastActivity) > 30_000) {
          diagNotified = true;
          getLatestOpenCodeLogPath().then(async (p) => {
            if (!p) return;
            try {
              const { readFile } = await import('node:fs/promises');
              const text = await readFile(p, 'utf8');
              const lines = text.split('\n');
              const tail = lines.slice(-60).join('\n');
              onErrorData?.(`[OpenCode log tail] ${p}\n${tail}\n`);
            } catch { /* ignore */ }
          }).catch(() => {});
        }
        lastActivity = now; // throttle status lines
      }
    }, 10_000);

    result = await spawnProcess({
      command,
      args,
      cwd: workingDir,
      env: runnerEnv,
      stdinInput: prompt,
      // Close stdin after writing the prompt to avoid CLIs waiting for EOF
      keepStdinOpen: false,
      stdioMode: 'pipe',
      onStdout: (chunk) => {
        const normalized = normalizeChunk(chunk);
        // Auto-approval path retained, but stdin is closed by default; env permission should prevent prompts.
        jsonBuffer += normalized;

        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() ?? '';

        for (const line of lines) {
          processLine(line);
        }
        lastActivity = Date.now();
      },
      onStderr: (chunk) => {
        const normalized = normalizeChunk(chunk);
        const cleaned = cleanAnsi(normalized, plainLogs);
        onErrorData?.(cleaned);
        lastActivity = Date.now();
      },
      signal: abortSignal,
      timeout: effectiveTimeout,
      onSpawn: (child) => {
        capturedChild = child;
      },
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    const message = err?.message ?? '';
    const notFound =
      err?.code === 'ENOENT' ||
      /not recognized as an internal or external command/i.test(message) ||
      /command not found/i.test(message);

    if (notFound) {
      const installMessage = [
        `'${command}' is not available on this system.`,
        'Install OpenCode via:',
        '  npm i -g opencode-ai@latest',
        '  brew install opencode',
        '  scoop bucket add extras && scoop install extras/opencode',
        '  choco install opencode',
        'Docs: https://opencode.ai/docs',
      ].join('\n');
      logger.error(`${metadata.name} CLI not found when executing: ${command} ${args.join(' ')}`);
      throw new Error(installMessage);
    }

    throw error;
  }

  if (jsonBuffer.trim()) {
    processLine(jsonBuffer);
    jsonBuffer = '';
  }

  capturedChild = null;

  if (pendingPermissionError) {
    throw pendingPermissionError;
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const sample = (stderr || stdout || 'no error output').split('\n').slice(0, 10).join('\n');

    logger.error('OpenCode CLI execution failed', {
      exitCode: result.exitCode,
      sample,
      command: `${command} ${args.join(' ')}`,
    });

    throw new Error(`OpenCode CLI exited with code ${result.exitCode}`);
  }

  if (heartbeat) {
    clearInterval(heartbeat);
  }

  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
