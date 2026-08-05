export type CapabilitySource = 'declared' | 'profile' | 'probed' | 'fallback';
export interface SourcedCapability<T> { value: T; source: CapabilitySource; }
export interface ProviderCapabilities {
  reachable: SourcedCapability<boolean | null>;
  streaming: SourcedCapability<boolean>;
  reasoning: SourcedCapability<boolean>;
  reasoningLevels: SourcedCapability<string[]>;
  toolCalls: SourcedCapability<boolean>;
  streamingToolCalls: SourcedCapability<boolean>;
  parallelToolCalls: SourcedCapability<boolean>;
  jsonSchema: SourcedCapability<boolean>;
  maxOutputTokens: SourcedCapability<number>;
  fingerprint: string | null;
  checkedAt: string | null;
  target?: { provider: string; baseUrl: string; model: string };
  error?: string;
}
export class CapabilityStore {
  constructor(filePath?: string);
  get(target: object): unknown;
  set(target: object, entry: object): void;
}
export function probeCapabilities(target: object, options?: object): Promise<ProviderCapabilities>;
export function fallbackCapabilities(target?: object, declared?: object): ProviderCapabilities;
export function formatCapabilities(capabilities: ProviderCapabilities | null): string;
