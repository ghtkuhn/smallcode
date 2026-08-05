export interface WriteDiagnostic {
  validator?: string;
  message: string;
  line: number;
  column: number;
  code?: string;
}

export interface WriteCandidate {
  filePath: string;
  content: string;
  previousContent?: string | null;
  workspaceRoot?: string;
  signal?: AbortSignal;
}

export interface WriteValidator {
  name: string;
  owner?: string;
  extensions?: string[];
  priority?: number;
  timeoutMs?: number;
  match?(filePath: string): boolean;
  validate(candidate: WriteCandidate): WriteDiagnostic[] | { diagnostics: WriteDiagnostic[]; aborted?: boolean } | Promise<WriteDiagnostic[] | { diagnostics: WriteDiagnostic[]; aborted?: boolean }>;
}

export class WriteValidationRegistry {
  constructor(options?: { disablePythonProcess?: boolean });
  register(validator: WriteValidator): () => void;
  unregisterOwner(owner: string): number;
  list(): Array<{ name: string; owner: string; extensions: string[]; priority: number }>;
  validateCandidate(candidate: WriteCandidate, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{
    status: 'pass' | 'fail' | 'skip';
    diagnostics: WriteDiagnostic[];
    validators: string[];
    reason?: string;
    aborted?: boolean;
  }>;
}

export function getWriteValidationRegistry(options?: { disablePythonProcess?: boolean }): WriteValidationRegistry;
export function resetWriteValidationRegistry(): void;
