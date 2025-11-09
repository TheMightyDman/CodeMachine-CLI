import { selectFromMenu } from '../../cli/presentation/selection-menu.js';
import { PermissionRequiredError, type PermissionRequestContext } from '../../infra/engines/errors.js';
import { buildOpenCodePermissionUpdate, type PermissionPolicyUpdate } from './opencode-policy.js';

export type PermissionDecisionScope = 'once' | 'always';

export interface PermissionDecision {
  outcome: 'allow' | 'reject';
  scope: PermissionDecisionScope;
  envDelta?: NodeJS.ProcessEnv;
  note?: string;
}

export interface PermissionMediatorOptions {
  engine: string;
  workingDir: string;
  currentEnv?: NodeJS.ProcessEnv;
}

type PolicyBuilder = (
  request: PermissionRequestContext,
  currentEnv?: NodeJS.ProcessEnv,
) => PermissionPolicyUpdate | null;

const policyAdapters: Record<string, PolicyBuilder> = {
  opencode: buildOpenCodePermissionUpdate,
};

function describeRequest(request: PermissionRequestContext): string {
  const scope = Array.isArray(request.pattern) ? request.pattern.join(', ') : request.pattern;
  const path = request.path ?? (request.metadata && typeof request.metadata.path === 'string' ? request.metadata.path : undefined);
  const capability = request.capability ?? 'operation';
  if (path) {
    return `${capability} on ${path}`;
  }
  if (scope) {
    return `${capability} (${scope})`;
  }
  if (request.title) {
    return request.title;
  }
  return capability;
}

export class PermissionMediator {
  private static instance: PermissionMediator | null = null;
  private readonly sessionEnv = new Map<string, NodeJS.ProcessEnv>();

  static getInstance(): PermissionMediator {
    if (!PermissionMediator.instance) {
      PermissionMediator.instance = new PermissionMediator();
    }
    return PermissionMediator.instance;
  }

  getSessionEnv(engine: string): NodeJS.ProcessEnv | undefined {
    const stored = this.sessionEnv.get(engine);
    if (!stored) return undefined;
    return { ...stored };
  }

  private updateSessionEnv(engine: string, delta?: NodeJS.ProcessEnv): void {
    if (!delta || Object.keys(delta).length === 0) {
      return;
    }
    const existing = this.sessionEnv.get(engine) ?? {};
    this.sessionEnv.set(engine, { ...existing, ...delta });
  }

  private buildPolicy(engine: string, request: PermissionRequestContext, env?: NodeJS.ProcessEnv): PermissionPolicyUpdate | null {
    const adapter = policyAdapters[engine];
    if (!adapter) return null;
    return adapter(request, env);
  }

  async handle(error: PermissionRequiredError, options: PermissionMediatorOptions): Promise<PermissionDecision> {
    const { engine } = options;

    const adapterResult = this.buildPolicy(engine, error.request, options.currentEnv);
    if (!adapterResult) {
      throw new Error(
        `Permission request for ${engine} cannot be auto-resolved. Please configure the engine manually or update your policy.`,
      );
    }

    if (!process.stdout.isTTY) {
      throw new Error(
        `Permission required: ${describeRequest(error.request)}. Re-run in an interactive terminal or preconfigure OPENCODE_PERMISSION.`,
      );
    }

    const choice = await selectFromMenu<PermissionDecisionScope | 'reject'>({
      message: `Allow ${describeRequest(error.request)}?`,
      choices: [
        { title: 'Allow once', value: 'once', description: 'Grant permission for the current command only.' },
        { title: 'Always allow', value: 'always', description: 'Remember this approval for the current session.' },
        { title: 'Reject', value: 'reject', description: 'Cancel the current operation.' },
      ],
    });

    if (!choice || choice === 'reject') {
      return { outcome: 'reject', scope: 'once' };
    }

    if (choice === 'always') {
      this.updateSessionEnv(engine, adapterResult.envDelta);
    }

    return {
      outcome: 'allow',
      scope: choice,
      envDelta: adapterResult.envDelta,
      note: adapterResult.summary,
    };
  }
}
