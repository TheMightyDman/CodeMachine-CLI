import { formatStatus } from '../../shared/formatters/outputMarkers.js';
import { PermissionRequiredError } from '../../infra/engines/errors.js';
import { PermissionMediator, type PermissionMediatorOptions } from './mediator.js';

export interface PermissionRetryContext {
  engine: string;
  workingDir: string;
  baseEnv?: NodeJS.ProcessEnv;
  mediator?: PermissionMediator;
  maxRetries?: number;
}

type PermissionAwareRunner<T> = (env: NodeJS.ProcessEnv | undefined) => Promise<T>;

const mergeEnv = (base?: NodeJS.ProcessEnv, delta?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined => {
  if (!delta || Object.keys(delta).length === 0) {
    return base ? { ...base } : base;
  }
  return { ...(base ?? {}), ...delta };
};

export async function runWithPermissionMediator<T>(
  runOperation: PermissionAwareRunner<T>,
  context: PermissionRetryContext,
): Promise<T> {
  const mediator = context.mediator ?? PermissionMediator.getInstance();
  const sessionEnv = mediator.getSessionEnv(context.engine);
  let baseEnv = mergeEnv(context.baseEnv, sessionEnv);
  let attemptEnv = baseEnv ? { ...baseEnv } : baseEnv;
  let attempts = 0;
  const maxAttempts = context.maxRetries ?? 3;

  while (true) {
    try {
      return await runOperation(attemptEnv);
    } catch (error) {
      if (!(error instanceof PermissionRequiredError)) {
        throw error;
      }

      if (attempts >= maxAttempts) {
        throw error;
      }
      attempts += 1;

      const mediatorOptions: PermissionMediatorOptions = {
        engine: context.engine,
        workingDir: context.workingDir,
        currentEnv: attemptEnv,
      };

      const decision = await mediator.handle(error, mediatorOptions);
      if (decision.outcome === 'reject') {
        throw new Error(`Permission request rejected: ${error.message}`);
      }

      if (decision.scope === 'always') {
        baseEnv = mergeEnv(baseEnv, decision.envDelta);
        attemptEnv = baseEnv ? { ...baseEnv } : baseEnv;
      } else {
        attemptEnv = mergeEnv(baseEnv, decision.envDelta);
      }

      if (decision.note) {
        try {
          process.stdout.write(formatStatus(`${decision.note} – retrying run`) + '\n');
        } catch {
          // ignore logging failures
        }
      }
    }
  }
}
