import { createTelemetryCapture } from '../../../../../shared/telemetry/index.js';
import type { EngineRunOptions, EngineRunResult, ParsedTelemetry } from '../../../core/types.js';
import { metadata } from '../metadata.js';
import type { KimiConfig, KimiRunMode } from '../config.js';
import { resolveModel, resolveRunMode, resolveMcpConfigFiles } from '../config.js';
import { runKimiPrint, runKimiWire, type KimiUsageSnapshot, type RunKimiResult } from './runner.js';

const SKIP_ENV = 'CODEMACHINE_SKIP_KIMI';
const PLAIN_LOG_ENV = 'CODEMACHINE_PLAIN_LOGS';
const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_MAX_CONTEXT = '262144';

export function shouldSkipKimi(env?: NodeJS.ProcessEnv): boolean {
  const value = env?.[SKIP_ENV] ?? process.env[SKIP_ENV];
  return value === '1' || value === 'true';
}

function isPlainLogsEnabled(env?: NodeJS.ProcessEnv): boolean {
  const value = env?.[PLAIN_LOG_ENV] ?? process.env[PLAIN_LOG_ENV];
  return value === '1' || value === 'true';
}

function applyEnvDefaults(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (!env) return env;
  const next = { ...env };
  if (!next.KIMI_MODEL_NAME && metadata.defaultModel) {
    next.KIMI_MODEL_NAME = metadata.defaultModel;
  }
  if (!next.KIMI_BASE_URL) {
    next.KIMI_BASE_URL = DEFAULT_BASE_URL;
  }
  if (!next.KIMI_MODEL_MAX_CONTEXT_SIZE) {
    next.KIMI_MODEL_MAX_CONTEXT_SIZE = DEFAULT_MAX_CONTEXT;
  }
  return next;
}

function buildConfig(options: EngineRunOptions): { config: KimiConfig; mode: KimiRunMode; plainLogs: boolean } {
  const model = resolveModel(options.model ?? metadata.defaultModel);
  const config: KimiConfig = {
    workingDir: options.workingDir,
    model,
    mcpConfigFiles: resolveMcpConfigFiles(options.env),
  };

  const mode = resolveRunMode(options.env);
  const plainLogs = isPlainLogsEnabled(options.env);

  return { config, mode, plainLogs };
}

function emitTelemetrySnapshot(
  snapshot: KimiUsageSnapshot,
  onTelemetry?: (telemetry: ParsedTelemetry) => void,
  capture?: ReturnType<typeof createTelemetryCapture>,
): void {
  if (snapshot.tokensIn === undefined && snapshot.tokensOut === undefined) {
    return;
  }

  const tokensIn = snapshot.tokensIn ?? 0;
  const tokensOut = snapshot.tokensOut ?? 0;
  const telemetry: ParsedTelemetry = {
    tokensIn,
    tokensOut,
    cached: snapshot.cached,
  };

  onTelemetry?.(telemetry);

  if (capture) {
    const syntheticLine = JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: tokensIn,
        output_tokens: tokensOut,
        cached_input_tokens: snapshot.cached ?? 0,
      },
    });
    capture.captureFromStreamJson(syntheticLine);
  }
}

function ensureRunnableEnvironment(): void {
  if (process.platform === 'win32') {
    throw new Error(`${metadata.name} currently supports macOS and Linux. Run inside WSL or use a supported platform to enable this engine.`);
  }
}

export async function runKimi(options: EngineRunOptions): Promise<EngineRunResult> {
  const { prompt, workingDir, env, onData, onErrorData, onTelemetry, abortSignal, timeout } = options;

  if (!prompt) {
    throw new Error('runKimi requires a prompt.');
  }

  if (!workingDir) {
    throw new Error('runKimi requires a working directory.');
  }

  if (shouldSkipKimi(env)) {
    const preview = prompt.length > 160 ? `${prompt.slice(0, 160)}...` : prompt;
    onData?.(`[dry-run] Kimi skipped: ${preview}\n`);
    return { stdout: '', stderr: '' };
  }

  ensureRunnableEnvironment();

  const effectiveEnv = applyEnvDefaults(env);
  const { config, mode, plainLogs } = buildConfig({ ...options, env: effectiveEnv });
  const telemetryCapture = createTelemetryCapture('kimi', config.model, prompt, workingDir);

  const runnerOptions = {
    prompt,
    workingDir,
    env: effectiveEnv,
    config,
    abortSignal,
    timeout,
    plainLogs,
    onData,
    onErrorData,
    onUsageSnapshot: (snapshot: KimiUsageSnapshot) => emitTelemetrySnapshot(snapshot, onTelemetry, telemetryCapture),
  };

  let result: RunKimiResult;
  if (mode === 'wire') {
    result = await runKimiWire(runnerOptions);
  } else {
    result = await runKimiPrint(runnerOptions);
  }

  telemetryCapture.logCapturedTelemetry(result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
