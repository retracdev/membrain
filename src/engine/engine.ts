import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { MembrainError } from '../errors.js';
import { literalQuery, queryIndex, queryStores } from '../index/search.js';
import type { QueryOptions, QueryResult } from '../index/search.js';
import {
  appendRevision,
  readStore,
  writeStore,
  withRevision,
  withRevisions,
} from '../storage/store.js';
import type { Snapshot } from '../storage/store.js';
import { selectLocations } from './scopes.js';
import type { Location, Selection } from './scopes.js';
import {
  choice,
  fail,
  metadata,
  scanSecrets,
  tags,
  text,
  types,
  uuid,
  validateRevision,
} from './model.js';
import type { Json, Revision, Warning } from './model.js';
import { span } from '../profile.js';

export interface Draft {
  content: string;
  type?: string;
  tags?: string[];
  sourceAgent?: string;
  metadata?: { [key: string]: Json };
  operationId?: string;
}
export interface Change extends Partial<Draft> {
  expectedRevision?: string;
  status?: 'active' | 'superseded';
}
export interface Saved {
  record: Revision;
  replayed: boolean;
  deduplicated: boolean;
  warnings: Warning[];
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function semantic(
  record: Pick<Revision, 'content' | 'type' | 'tags' | 'metadata'> & {
    origin?: Revision['origin'];
  },
): string {
  return stable({
    content: record.content,
    type: record.type,
    tags: [...record.tags].sort(),
    metadata: record.metadata,
    ...(record.origin ? { origin: record.origin } : {}),
  });
}
function nextRevision(
  previous: Revision,
  changes: Partial<Revision>,
): Revision {
  const base = { ...previous };
  delete base.operationId;
  delete base.operationKind;
  return validateRevision({
    ...base,
    ...changes,
    revisionId: randomUUID(),
    parentRevisionIds: [previous.revisionId],
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(previous.updatedAt) + 1),
    ).toISOString(),
  });
}
function head(snapshot: Snapshot, id: string): Revision {
  const matches = snapshot.entries.filter((entry) => entry.record.id === id);
  if (!matches.length)
    fail(
      'NOT_FOUND',
      'Memory was not found in the selected scopes. Specify its --project, --scope, or --session if needed.',
    );
  if (matches.length !== 1 || matches[0]!.conflict)
    fail(
      'REVISION_CONFLICT',
      'Memory has competing revisions. Preserve both histories; inspect list --history --status all before resolving outside this phase.',
    );
  return matches[0]!.record;
}

export class MemoryEngine {
  constructor(
    private readonly config: Config,
    private readonly cwd = process.cwd(),
    private readonly cacheRoot?: string,
  ) {}

  private protectedRoots(): string[] {
    return [
      ...(this.config.global ? [this.config.global.path] : []),
      ...this.config.projects.map((entry) => entry.path),
      ...(this.config.session ? [this.config.session.path] : []),
    ];
  }
  private async snapshots(selection: Selection): Promise<Snapshot[]> {
    const finishSelection = span('engine.scopeResolution');
    const locations = await selectLocations(this.config, selection, this.cwd);
    finishSelection();
    const finishSources = span('engine.sourceReplay');
    const snapshots = await Promise.all(
      locations.map((item) => readStore(item)),
    );
    finishSources();
    const finishIdentity = span('engine.crossScopeIdentity');
    const ids = new Map<string, string>();
    const revisions = new Set<string>();
    for (const snapshot of snapshots)
      for (const record of snapshot.records) {
        if (
          (ids.has(record.id) &&
            ids.get(record.id) !== snapshot.location.path) ||
          revisions.has(record.revisionId)
        )
          fail(
            'CORRUPT_STORE',
            'Duplicate memory/revision IDs across selected stores.',
          );
        ids.set(record.id, snapshot.location.path);
        revisions.add(record.revisionId);
      }
    finishIdentity();
    return snapshots;
  }
  async query(
    selection: Selection,
    options: QueryOptions,
  ): Promise<QueryResult> {
    if (options.query !== undefined) literalQuery(options.query);
    try {
      if (options.verification === 'fast') {
        return await queryStores(
          await selectLocations(this.config, selection, this.cwd),
          options,
          this.protectedRoots(),
          this.cacheRoot,
        );
      }
      const snapshots = await this.snapshots(selection);
      return await queryIndex(
        snapshots,
        options,
        this.protectedRoots(),
        this.cacheRoot,
      );
    } catch (error) {
      if (error instanceof MembrainError) throw error;
      fail(
        'INDEX_FAILED',
        'Cannot open or rebuild the local SQLite index. Check MEMBRAIN_CACHE_DIR, permissions, disk space, and SQLite installation; JSONL source records were not removed.',
      );
    }
  }
  private async afterSave(
    location: Location,
    record: Revision,
    replayed = false,
    deduplicated = false,
    publicationWarnings: Warning[] = [],
    verifiedSnapshot?: Snapshot,
  ): Promise<Saved> {
    const warnings: Warning[] = [...publicationWarnings];
    try {
      const result = await queryIndex(
        [withRevision(verifiedSnapshot ?? (await readStore(location)), record)],
        { limit: 1, verification: 'fast' },
        this.protectedRoots(),
        this.cacheRoot,
      );
      warnings.push(...result.warnings);
    } catch {
      warnings.push({
        code: 'INDEX_PENDING',
        message:
          'Memory is safely saved in JSONL. The search index could not be refreshed; fix cache/source diagnostics and retry a read with --rebuild-index. Reuse the same operation ID if retrying the write.',
      });
    }
    return { record, replayed, deduplicated, warnings };
  }
  private async create(
    selection: Selection,
    draft: Draft,
    origin?: Revision['origin'],
  ): Promise<Saved> {
    const [location] = await selectLocations(
      this.config,
      selection,
      this.cwd,
      true,
    );
    if (!location) fail('SCOPE_NOT_CONFIGURED', 'No writable scope selected.');
    const payload = {
      content: text(draft.content, 'content', 65_536),
      type: choice(draft.type ?? 'note', types, 'type'),
      tags: tags(draft.tags ?? []),
      metadata: metadata(draft.metadata ?? {}),
      ...(draft.sourceAgent === undefined
        ? {}
        : { sourceAgent: text(draft.sourceAgent, 'sourceAgent') }),
      ...(origin ? { origin } : {}),
    };
    const operationId =
      draft.operationId === undefined
        ? undefined
        : text(draft.operationId, 'operationId');
    const operationKind = origin ? 'promote' : 'remember';
    scanSecrets({
      ...payload,
      operationId,
      projectId: location.projectId,
      sessionId: location.sessionId,
    });
    const warnings: Warning[] = [];
    let verifiedSnapshot: Snapshot | undefined;
    const result = await writeStore(location, async (snapshot, assertOwned) => {
      verifiedSnapshot = snapshot;
      if (operationId) {
        const previous = snapshot.records.find(
          (record) => record.operationId === operationId,
        );
        if (previous) {
          if (
            previous.operationKind !== operationKind ||
            semantic(previous) !== semantic(payload)
          )
            fail(
              'OPERATION_CONFLICT',
              'This operation ID was already used for different input.',
            );
          return {
            record: head(snapshot, previous.id),
            replayed: true,
            deduplicated: false,
          };
        }
      }
      const duplicate = snapshot.entries.find(
        (entry) =>
          !entry.conflict &&
          entry.record.status === 'active' &&
          semantic(entry.record) === semantic(payload),
      );
      if (duplicate && !operationId)
        return {
          record: duplicate.record,
          replayed: false,
          deduplicated: true,
        };
      const timestamp = new Date().toISOString();
      const record = duplicate
        ? nextRevision(duplicate.record, {
            ...(operationId ? { operationId, operationKind } : {}),
          })
        : validateRevision({
            schemaVersion: 1,
            id: randomUUID(),
            revisionId: randomUUID(),
            parentRevisionIds: [],
            ...payload,
            scope: location.scope,
            ...(location.projectId ? { projectId: location.projectId } : {}),
            ...(location.sessionId ? { sessionId: location.sessionId } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
            status: 'active',
            ...(operationId ? { operationId, operationKind } : {}),
          });
      warnings.push(...(await appendRevision(location, record, assertOwned)));
      return { record, replayed: false, deduplicated: Boolean(duplicate) };
    });
    return this.afterSave(
      location,
      result.record,
      result.replayed,
      result.deduplicated,
      warnings,
      verifiedSnapshot,
    );
  }
  async remember(selection: Selection, draft: Draft): Promise<Saved> {
    return this.create(selection, draft);
  }

  async promote(
    selection: Selection,
    id: string,
    to: string,
    operationId?: string,
  ): Promise<Saved> {
    uuid(id);
    choice(to, ['global', 'project'] as const, 'promotion destination');
    if (!selection.session)
      fail('SESSION_REQUIRED', 'Promotion requires --session ID.');
    const snapshots = await this.snapshots({ ...selection, scope: 'session' });
    const source = snapshots.find((snapshot) =>
      snapshot.records.some((record) => record.id === id),
    );
    if (!source) fail('NOT_FOUND', 'Session memory was not found.');
    const record = head(source, id);
    if (record.status !== 'active')
      fail('INACTIVE_MEMORY', 'Only active session memories can be promoted.');
    const origin: NonNullable<Revision['origin']> = {
      id: record.id,
      revisionId: record.revisionId,
      scope: 'session',
      sessionId: record.sessionId!,
      ...(record.projectId ? { projectId: record.projectId } : {}),
    };
    const destination: Selection = {
      scope: to,
      ...(selection.project ? { project: selection.project } : {}),
    };
    return this.create(
      destination,
      {
        content: record.content,
        type: record.type,
        tags: record.tags,
        metadata: record.metadata,
        ...(record.sourceAgent ? { sourceAgent: record.sourceAgent } : {}),
        operationId:
          operationId ??
          `promote:${createHash('sha256').update(stable(origin)).digest('hex')}`,
      },
      origin,
    );
  }

  private async locate(selection: Selection, id: string): Promise<Location> {
    uuid(id);
    const matches = (await this.snapshots(selection)).filter((snapshot) =>
      snapshot.records.some((record) => record.id === id),
    );
    if (matches.length !== 1)
      fail(
        'NOT_FOUND',
        'Memory was not found in the selected scopes; specify its project or session.',
      );
    return matches[0]!.location;
  }
  private async mutate(
    selection: Selection,
    id: string,
    change: Change,
    deleting: boolean,
  ): Promise<Saved> {
    const location = await this.locate(selection, id);
    if (change.operationId !== undefined)
      text(change.operationId, 'operationId');
    if (change.expectedRevision !== undefined)
      uuid(change.expectedRevision, 'expectedRevision');
    const operationKind = deleting ? 'forget' : 'update';
    const warnings: Warning[] = [];
    let verifiedSnapshot: Snapshot | undefined;
    const result = await writeStore(location, async (snapshot, assertOwned) => {
      verifiedSnapshot = snapshot;
      const previous = head(snapshot, id);
      const patch = {
        ...(change.content === undefined
          ? {}
          : { content: text(change.content, 'content', 65_536) }),
        ...(change.type === undefined
          ? {}
          : { type: choice(change.type, types, 'type') }),
        ...(change.tags === undefined ? {} : { tags: tags(change.tags) }),
        ...(change.metadata === undefined
          ? {}
          : { metadata: metadata(change.metadata) }),
        ...(change.sourceAgent === undefined
          ? {}
          : { sourceAgent: text(change.sourceAgent, 'sourceAgent') }),
        ...(change.status === undefined
          ? {}
          : {
              status: choice(
                change.status,
                ['active', 'superseded'] as const,
                'status',
              ),
            }),
        ...(deleting ? { status: 'deleted' as const } : {}),
      };
      scanSecrets({ ...patch, operationId: change.operationId });
      if (change.operationId) {
        const replay = snapshot.records.find(
          (record) => record.operationId === change.operationId,
        );
        if (replay) {
          if (
            replay.id !== id ||
            replay.operationKind !== operationKind ||
            Object.entries(patch).some(
              ([key, value]) =>
                stable(replay[key as keyof Revision]) !== stable(value),
            ) ||
            (change.expectedRevision !== undefined &&
              !replay.parentRevisionIds.includes(change.expectedRevision))
          )
            fail(
              'OPERATION_CONFLICT',
              'This operation ID was already used for different input.',
            );
          return { record: previous, replayed: true, deduplicated: false };
        }
      }
      if (
        change.expectedRevision !== undefined &&
        change.expectedRevision !== previous.revisionId
      )
        fail(
          'STALE_REVISION',
          'Memory changed since the expected revision. Recall/list its current revision before retrying.',
        );
      if (previous.status === 'deleted') {
        if (deleting)
          return { record: previous, replayed: false, deduplicated: true };
        fail(
          'DELETED_MEMORY',
          'Deleted memories cannot be updated or silently restored. Save a new memory explicitly.',
        );
      }
      const record = nextRevision(previous, {
        ...patch,
        ...(change.operationId
          ? { operationId: change.operationId, operationKind }
          : {}),
      });
      warnings.push(...(await appendRevision(location, record, assertOwned)));
      return { record, replayed: false, deduplicated: false };
    });
    return this.afterSave(
      location,
      result.record,
      result.replayed,
      result.deduplicated,
      warnings,
      verifiedSnapshot,
    );
  }
  async update(
    selection: Selection,
    id: string,
    change: Change,
  ): Promise<Saved> {
    if (
      change.content === undefined &&
      change.type === undefined &&
      change.tags === undefined &&
      change.metadata === undefined &&
      change.sourceAgent === undefined &&
      change.status === undefined
    )
      fail('INVALID_UPDATE', 'Supply content or a field to update.');
    return this.mutate(selection, id, change, false);
  }
  async forget(
    selection: Selection,
    id: string,
    change: Pick<Change, 'operationId' | 'expectedRevision'> = {},
  ): Promise<Saved> {
    return this.mutate(selection, id, change, true);
  }
  async discardSession(
    selection: Selection,
  ): Promise<{ records: Revision[]; warnings: Warning[] }> {
    const [location] = await selectLocations(
      this.config,
      { ...selection, scope: 'session' },
      this.cwd,
      true,
    );
    if (!location) fail('SESSION_REQUIRED', 'Select a configured session.');
    const records: Revision[] = [];
    const publicationWarnings: Warning[] = [];
    let verifiedSnapshot: Snapshot | undefined;
    await writeStore(location, async (snapshot, assertOwned) => {
      verifiedSnapshot = snapshot;
      if (snapshot.entries.some((entry) => entry.conflict))
        fail(
          'REVISION_CONFLICT',
          'Session contains conflicting heads. Inspect history before discarding it.',
        );
      for (const entry of snapshot.entries) {
        if (entry.record.status === 'deleted') continue;
        const record = nextRevision(entry.record, { status: 'deleted' });
        try {
          publicationWarnings.push(
            ...(await appendRevision(location, record, assertOwned)),
          );
        } catch {
          fail(
            'PARTIAL_DISCARD',
            `Session discard stopped after saving ${records.length} tombstones. Retry the same discard; already deleted memories are skipped.`,
          );
        }
        records.push(record);
      }
    });
    if (records.length)
      verifiedSnapshot = withRevisions(verifiedSnapshot!, records);
    const warnings = records.length
      ? (
          await this.afterSave(
            location,
            records[records.length - 1]!,
            false,
            false,
            publicationWarnings,
            verifiedSnapshot,
          )
        ).warnings
      : [];
    return { records, warnings };
  }
}
