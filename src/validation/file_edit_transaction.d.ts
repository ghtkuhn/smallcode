import type { WriteValidationRegistry, WriteDiagnostic } from './write_validation';

export function prepareFileEdit(options: {
  filePath: string;
  content: string;
  previousContent?: string | null;
  workspaceRoot?: string;
  signal?: AbortSignal;
  registry?: WriteValidationRegistry;
}): Promise<{
  ok: boolean;
  filePath?: string;
  content?: string;
  previousContent?: string | null;
  kind?: 'prewrite_validation' | 'cancelled';
  cancelled?: boolean;
  error?: string;
  diagnostics?: WriteDiagnostic[];
  validation: unknown;
}>;

export function commitValidatedEdit(prepared: { ok: true; filePath: string; content: string; validation: unknown }): { path: string; validation: unknown };
