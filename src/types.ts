/**
 * Structural executor contracts for root consumers without external peer declaration dependencies.
 */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  prelude?: string;
}

export interface ConnectorBinding {
  name: string;
  binding: {
    callTool(method: string, args: unknown): Promise<unknown>;
  };
}

export interface ExecuteOptions {
  connectors?: ConnectorBinding[];
}

export interface Executor {
  execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
}
