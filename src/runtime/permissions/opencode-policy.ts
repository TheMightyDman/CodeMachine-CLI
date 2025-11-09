import type { PermissionRequestContext } from '../../infra/engines/errors.js';

export interface PermissionPolicyUpdate {
  envDelta: NodeJS.ProcessEnv;
  summary: string;
}

function parsePolicy(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // ignore malformed policy and fall back to empty object
  }
  return {};
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function normalizeCapability(request: PermissionRequestContext): string | undefined {
  if (request.capability && typeof request.capability === 'string') {
    return request.capability;
  }

  const metadata = request.metadata ?? {};
  const metaCapability = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).type : undefined;
  if (typeof metaCapability === 'string') {
    return metaCapability;
  }

  return undefined;
}

function normalizePatterns(pattern: string | string[] | undefined, metadata?: Record<string, unknown>): string[] {
  if (Array.isArray(pattern)) {
    return pattern.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (typeof pattern === 'string' && pattern.length > 0) {
    return [pattern];
  }
  const metaPattern = metadata ? (metadata.pattern as string | string[] | undefined) : undefined;
  if (Array.isArray(metaPattern)) {
    return metaPattern.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (typeof metaPattern === 'string' && metaPattern.length > 0) {
    return [metaPattern];
  }
  return ['*'];
}

export function buildOpenCodePermissionUpdate(
  request: PermissionRequestContext,
  currentEnv?: NodeJS.ProcessEnv,
): PermissionPolicyUpdate | null {
  const capability = normalizeCapability(request);
  if (!capability) {
    return null;
  }

  const existingPolicy = currentEnv?.OPENCODE_PERMISSION ?? process.env.OPENCODE_PERMISSION;
  const policy = parsePolicy(existingPolicy);

  if (capability === 'bash') {
    const bashPolicy = ensureObject(policy.bash);
    const patterns = normalizePatterns(request.pattern, request.metadata);
    for (const entry of patterns) {
      bashPolicy[entry || '*'] = 'allow';
    }
    policy.bash = bashPolicy;
    return {
      envDelta: { OPENCODE_PERMISSION: JSON.stringify(policy) },
      summary: `Allowed bash ${patterns.join(', ')}`,
    };
  }

  policy[capability] = 'allow';
  return {
    envDelta: { OPENCODE_PERMISSION: JSON.stringify(policy) },
    summary: `Allowed capability ${capability}`,
  };
}
