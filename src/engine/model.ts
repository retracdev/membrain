import { MembrainError } from '../errors.js';

export const scopes = ['global', 'project', 'session'] as const;
export const types = [
  'fact',
  'decision',
  'preference',
  'constraint',
  'task',
  'note',
] as const;
export const states = ['active', 'superseded', 'deleted'] as const;
export type Scope = (typeof scopes)[number];
export type MemoryType = (typeof types)[number];
export type State = (typeof states)[number];
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Revision {
  schemaVersion: 1;
  id: string;
  revisionId: string;
  parentRevisionIds: string[];
  content: string;
  scope: Scope;
  type: MemoryType;
  projectId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  sourceAgent?: string;
  tags: string[];
  metadata: { [key: string]: Json };
  status: State;
  operationId?: string;
  operationKind?: 'remember' | 'update' | 'forget' | 'promote';
  origin?: {
    id: string;
    revisionId: string;
    scope: 'session';
    sessionId: string;
    projectId?: string;
  };
}
export interface Warning {
  code: string;
  message: string;
}
export interface Entry {
  record: Revision;
  conflict: boolean;
}

export function fail(code: string, message: string): never {
  throw new MembrainError(code, message);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function text(value: unknown, field: string, max = 128): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'INVALID_RECORD',
      `${field} must be nonempty text of at most ${max} characters without unsafe control characters.`,
    );
  }
  return value;
}
export function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value as T))
    fail('INVALID_RECORD', `Invalid ${field}; expected ${allowed.join(', ')}.`);
  return value as T;
}
export function uuid(value: unknown, field = 'id'): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      value,
    )
  ) {
    fail('INVALID_RECORD', `${field} must be a lowercase UUID.`);
  }
  return value;
}
function json(value: unknown, depth = 0): value is Json {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((part: unknown) => json(part, depth + 1));
  return (
    isObject(value) &&
    Object.values(value).every((part) => json(part, depth + 1))
  );
}
export function metadata(value: unknown): { [key: string]: Json } {
  if (!isObject(value) || !json(value) || JSON.stringify(value).length > 16_384)
    fail(
      'INVALID_RECORD',
      'metadata must be a JSON object, at most 16,384 characters and 12 levels deep.',
    );
  return value as { [key: string]: Json };
}
export function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32)
    fail('INVALID_RECORD', 'tags must be an array of at most 32 strings.');
  return [...new Set(value.map((tag: unknown) => text(tag, 'tag')))];
}
export function validateRevision(value: unknown): Revision {
  if (!isObject(value)) fail('INVALID_RECORD', 'Revision must be an object.');
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > 262_144)
    fail('INVALID_RECORD', 'Serialized revision exceeds 256 KiB.');
  const allowed = [
    'schemaVersion',
    'id',
    'revisionId',
    'parentRevisionIds',
    'content',
    'scope',
    'type',
    'projectId',
    'sessionId',
    'createdAt',
    'updatedAt',
    'sourceAgent',
    'tags',
    'metadata',
    'status',
    'operationId',
    'operationKind',
    'origin',
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    value.schemaVersion !== 1
  )
    fail('INVALID_RECORD', 'Unsupported revision schema or fields.');
  uuid(value.id);
  uuid(value.revisionId, 'revisionId');
  if (
    !Array.isArray(value.parentRevisionIds) ||
    value.parentRevisionIds.length > 32 ||
    new Set(value.parentRevisionIds).size !== value.parentRevisionIds.length
  )
    fail('INVALID_RECORD', 'Invalid revision parents.');
  value.parentRevisionIds.forEach((id: unknown) =>
    uuid(id, 'parentRevisionId'),
  );
  text(value.content, 'content', 65_536);
  const scope = choice(value.scope, scopes, 'scope');
  choice(value.type, types, 'type');
  choice(value.status, states, 'status');
  tags(value.tags);
  metadata(value.metadata);
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (
      typeof value[field] !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value[field]) ||
      !Number.isFinite(Date.parse(value[field])) ||
      new Date(value[field] as string).toISOString() !== value[field]
    )
      fail('INVALID_RECORD', `Invalid ${field}.`);
  }
  if (String(value.updatedAt) < String(value.createdAt))
    fail('INVALID_RECORD', 'updatedAt precedes createdAt.');
  if (
    scope === 'global' &&
    (value.projectId !== undefined || value.sessionId !== undefined)
  )
    fail('INVALID_RECORD', 'Global memories cannot have project/session IDs.');
  if (
    scope === 'project' &&
    (value.projectId === undefined || value.sessionId !== undefined)
  )
    fail(
      'INVALID_RECORD',
      'Project memories require a project ID and no session ID.',
    );
  if (scope === 'session' && value.sessionId === undefined)
    fail('INVALID_RECORD', 'Session memories require a session ID.');
  if (
    scope !== 'session' &&
    value.origin === undefined &&
    value.sessionId !== undefined
  )
    fail('INVALID_RECORD', 'Unexpected session ID.');
  for (const field of [
    'projectId',
    'sessionId',
    'sourceAgent',
    'operationId',
  ] as const)
    if (value[field] !== undefined) text(value[field], field);
  if (value.operationId !== undefined)
    choice(
      value.operationKind,
      ['remember', 'update', 'forget', 'promote'] as const,
      'operationKind',
    );
  else if (value.operationKind !== undefined)
    fail('INVALID_RECORD', 'operationKind requires operationId.');
  if (value.origin !== undefined) {
    if (
      !isObject(value.origin) ||
      value.origin.scope !== 'session' ||
      Object.keys(value.origin).some(
        (key) =>
          !['id', 'revisionId', 'scope', 'sessionId', 'projectId'].includes(
            key,
          ),
      )
    )
      fail('INVALID_RECORD', 'Invalid promotion origin.');
    uuid(value.origin.id);
    uuid(value.origin.revisionId);
    text(value.origin.sessionId, 'origin.sessionId');
    if (value.origin.projectId !== undefined)
      text(value.origin.projectId, 'origin.projectId');
  }
  return value as unknown as Revision;
}

export function scanSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})\b/u,
    /(?:api[_ -]?key|access[_ -]?token|password|secret|authorization)[\\"'\s]*[:=][\\"'\s]*(?:bearer\s+)?[A-Za-z0-9_+/.=-]{8,}/iu,
  ];
  if (patterns.some((pattern) => pattern.test(serialized)))
    fail(
      'SECRET_DETECTED',
      'Possible credential or private key detected. Remove sensitive values before saving; detection is not exhaustive.',
    );
}

export function projectHeads(records: Revision[]): Entry[] {
  const byRevision = new Map(
    records.map((record) => [record.revisionId, record]),
  );
  if (byRevision.size !== records.length)
    fail('CORRUPT_STORE', 'Duplicate revision identifiers.');
  const groups = new Map<string, Revision[]>();
  const parentIds = new Set<string>();
  for (const record of records) {
    const group = groups.get(record.id) ?? [];
    group.push(record);
    groups.set(record.id, group);
    for (const id of record.parentRevisionIds) {
      const parent = byRevision.get(id);
      if (
        !parent ||
        parent.id !== record.id ||
        parent.createdAt !== record.createdAt ||
        parent.scope !== record.scope ||
        parent.projectId !== record.projectId ||
        parent.sessionId !== record.sessionId ||
        parent.updatedAt >= record.updatedAt ||
        (parent.status === 'deleted' && record.status !== 'deleted')
      )
        fail(
          'CORRUPT_STORE',
          'Missing, cyclic, inconsistent, or resurrected revision ancestry. Preserve the source files and inspect their history.',
        );
      parentIds.add(id);
    }
  }
  const entries: Entry[] = [];
  for (const group of groups.values()) {
    if (group.filter((record) => !record.parentRevisionIds.length).length !== 1)
      fail('CORRUPT_STORE', 'Each memory must have exactly one root revision.');
    const heads = group.filter((record) => !parentIds.has(record.revisionId));
    for (const record of heads)
      entries.push({ record, conflict: heads.length !== 1 });
  }
  return entries.sort(
    (a, b) =>
      a.record.id.localeCompare(b.record.id, 'en') ||
      a.record.revisionId.localeCompare(b.record.revisionId, 'en'),
  );
}
