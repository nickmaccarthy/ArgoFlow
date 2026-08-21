import type {ResourceState} from './host';

export type EventHealth = 'Ready' | 'Active' | 'Blocked' | 'Failed' | 'Unknown';
export type EventResourceState = 'loading' | 'missing' | 'unsupported' | 'stale' | 'permission' | 'ready';

export interface EventCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface EventHealthEvidence {
  state: EventHealth;
  reason: string;
  condition?: EventCondition;
}

export interface EventManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {name?: string; namespace?: string; generation?: number; resourceVersion?: string};
  status?: {observedGeneration?: number; conditions?: EventCondition[]; phase?: string; status?: string};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function eventManifest(resource?: ResourceState): EventManifest | undefined {
  if (!resource) return undefined;
  if (resource.manifest !== undefined) {
    if (typeof resource.manifest === 'string') {
      try {
        return JSON.parse(resource.manifest) as EventManifest;
      } catch {
        return undefined;
      }
    }
    return isRecord(resource.manifest) ? resource.manifest as EventManifest : undefined;
  }
  return resource.metadata ? resource as EventManifest : undefined;
}

export function eventResourceState(resource: ResourceState | undefined, kind: string): EventResourceState {
  if (!resource) return 'loading';
  const error = typeof resource.error === 'string' ? resource.error : resource.error?.message;
  const status = typeof resource.error === 'string' ? undefined : resource.error?.status;
  if (status === 401 || status === 403 || /forbidden|unauthori[sz]ed|permission denied/i.test(error || '')) return 'permission';

  const manifest = eventManifest(resource);
  if (!manifest?.metadata?.name) return 'missing';
  if ((manifest.kind && manifest.kind !== kind) || (manifest.apiVersion && !manifest.apiVersion.startsWith('argoproj.io/'))) return 'unsupported';
  if (
    typeof manifest.metadata.generation === 'number' &&
    typeof manifest.status?.observedGeneration === 'number' &&
    manifest.status.observedGeneration < manifest.metadata.generation
  ) return 'stale';
  return 'ready';
}

/** Conditions are controller evidence; an absent condition is never treated as health. */
export function eventHealth(conditions?: EventCondition[], phase?: string): EventHealthEvidence {
  const normalized = (conditions ?? []).map(condition => ({
    condition,
    status: condition.status?.toLocaleLowerCase(),
    type: condition.type?.toLocaleLowerCase() || 'condition'
  }));
  const failed = normalized.find(item => (item.status === 'true' || item.status === 'false') && /failed|error/.test(item.type));
  if (failed) return evidence('Failed', failed.condition);
  const blocked = normalized.find(item => item.status === 'false');
  if (blocked) return evidence('Blocked', blocked.condition);
  const active = normalized.find(item => item.status === 'true' && /active|running|processing/.test(item.type));
  if (active) return evidence('Active', active.condition);
  const ready = normalized.find(item => item.status === 'true');
  if (ready) return evidence('Ready', ready.condition);

  const reported = phase?.toLocaleLowerCase();
  if (reported === 'active' || reported === 'running' || reported === 'processing') return {state: 'Active', reason: `Controller reports ${phase}`};
  if (reported === 'failed' || reported === 'error') return {state: 'Failed', reason: `Controller reports ${phase}`};
  if (reported === 'blocked') return {state: 'Blocked', reason: `Controller reports ${phase}`};
  if (reported === 'ready' || reported === 'healthy' || reported === 'succeeded' || reported === 'success') return {state: 'Ready', reason: `Controller reports ${phase}`};
  return {state: 'Unknown', reason: conditions?.length ? 'Controller conditions are not recognized' : 'No controller condition evidence'};
}

export function safeEventText(value?: string, limit = 500): string | undefined {
  if (!value) return undefined;
  const structured = redactStructured(value);
  if (structured !== undefined) return structured.slice(0, limit);
  return value
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/(["']?[A-Za-z0-9_-]*(?:token|password|secret|authorization|credential|api[-_ ]?key|payload|headers?)[A-Za-z0-9_-]*["']?)\s*[:=]\s*(?:\[[A-Z]+\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1=[REDACTED]')
    .slice(0, limit);
}

/** Retains dependency wiring while redacting quoted free-form values. */
export function safeExpression(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const expression = value
    .replace(/\b([\w.]*(?:token|password|secret|authorization|credential|api[-_ ]?key|payload|headers?)[\w.]*)\s*(==|=|:)\s*([^\s&|()]+)/gi, (_match, key: string, operator: string, raw: string) => `${key} ${operator} ${/^["']/.test(raw) ? raw : '[REDACTED]'}`)
    .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '$1[REDACTED]$1')
    .slice(0, 500);
  return /^[\w\s.!&|()<>=[\]'"+-]+$/.test(expression) ? expression : 'Expression configured';
}

function redactStructured(value: string): string | undefined {
  try {
    return JSON.stringify(redactValue(JSON.parse(value)));
  } catch {
    return undefined;
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sensitiveKey(key) ? '[REDACTED]' : redactValue(nested)]));
}

function sensitiveKey(key: string): boolean {
  return /token|password|secret|authorization|credential|api[-_ ]?key|payload|headers?/i.test(key);
}

function evidence(state: EventHealth, condition: EventCondition): EventHealthEvidence {
  const safe = safeCondition(condition);
  const label = safe.type || 'Controller condition';
  const detail = safe.message || safe.reason;
  return {state, reason: detail ? `${label}: ${detail}` : `${label} is ${safe.status || state}`, condition: safe};
}

function safeCondition(condition: EventCondition): EventCondition {
  return {
    type: typeof condition.type === 'string' ? condition.type.slice(0, 100) : undefined,
    status: typeof condition.status === 'string' ? condition.status.slice(0, 32) : undefined,
    reason: safeEventText(condition.reason, 200),
    message: safeEventText(condition.message, 500),
    lastTransitionTime: typeof condition.lastTransitionTime === 'string' ? condition.lastTransitionTime.slice(0, 64) : undefined
  };
}
