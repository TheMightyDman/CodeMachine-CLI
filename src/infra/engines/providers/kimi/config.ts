export interface KimiConfig {
  workingDir: string;
  model?: string;
  mcpConfigFiles?: string[];
}

export type KimiRunMode = 'print' | 'wire';

export function resolveModel(model?: string): string | undefined {
  if (model && model.trim().length > 0) {
    return model.trim();
  }

  const envModel = process.env.KIMI_MODEL_NAME?.trim();
  return envModel ? envModel : undefined;
}

export function resolveRunMode(env?: NodeJS.ProcessEnv): KimiRunMode {
  const source = env?.CODEMACHINE_KIMI_MODE ?? process.env.CODEMACHINE_KIMI_MODE ?? '';
  const normalized = source.trim().toLowerCase();
  return normalized === 'wire' ? 'wire' : 'print';
}

export function resolveMcpConfigFiles(env?: NodeJS.ProcessEnv): string[] | undefined {
  const source = env?.KIMI_MCP_CONFIG_FILES ?? process.env.KIMI_MCP_CONFIG_FILES;
  if (!source) {
    return undefined;
  }

  const files = source
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return files.length > 0 ? files : undefined;
}
