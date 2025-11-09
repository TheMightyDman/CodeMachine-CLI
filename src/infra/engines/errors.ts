export interface PermissionRequestContext {
  engine: string;
  id?: string;
  title?: string;
  capability?: string;
  pattern?: string | string[];
  path?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export class PermissionRequiredError extends Error {
  public readonly engine: string;
  public readonly request: PermissionRequestContext;

  constructor(message: string, context: PermissionRequestContext) {
    super(message);
    this.name = 'PermissionRequiredError';
    this.engine = context.engine;
    this.request = context;
  }
}
