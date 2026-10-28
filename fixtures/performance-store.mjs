import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectLocations } from '../dist/engine/scopes.js';

// Callers own a disposable directory. No discovery of real configuration/data.
export async function populateFixture(
  config,
  cwd,
  count = 1000,
  selections = [
    { scope: 'global' },
    { scope: 'project', project: 'alpha' },
    { scope: 'project', project: 'beta' },
    { scope: 'session', project: 'alpha', session: 'work' },
    { scope: 'session', project: 'alpha', session: 'hidden' },
  ],
) {
  const locations = [];
  for (const selection of selections)
    locations.push((await selectLocations(config, selection, cwd, true))[0]);
  for (const location of locations) {
    await mkdir(path.join(location.path, 'records'), { recursive: true });
    await writeFile(
      path.join(location.path, 'store.json'),
      JSON.stringify({
        schemaVersion: 1,
        storeId: randomUUID(),
        scope: location.scope,
        ...(location.projectId ? { projectId: location.projectId } : {}),
        ...(location.sessionId ? { sessionId: location.sessionId } : {}),
      }),
    );
  }
  const records = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < count) {
        const i = next++;
        const location = locations[i % locations.length];
        const base = {
          schemaVersion: 1,
          id: randomUUID(),
          revisionId: randomUUID(),
          parentRevisionIds: [],
          content: `Historical SQLite design ${i}.`,
          scope: location.scope,
          ...(location.projectId ? { projectId: location.projectId } : {}),
          ...(location.sessionId ? { sessionId: location.sessionId } : {}),
          type: i % 2 ? 'decision' : 'preference',
          tags: ['sqlite', `topic-${i % 7}`],
          metadata: { fixture: i },
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const current = {
          ...base,
          revisionId: randomUUID(),
          parentRevisionIds: [base.revisionId],
          updatedAt: '2026-01-01T00:00:00.001Z',
          content: `SQLite current design ${i}. ${'Keep durable history and validate external changes. '.repeat(i % 20)}`,
        };
        const folder = path.join(location.path, 'records', base.id);
        await mkdir(folder);
        await Promise.all(
          [base, current].map((record) =>
            writeFile(
              path.join(folder, `${record.revisionId}.jsonl`),
              `${JSON.stringify(record)}\n`,
            ),
          ),
        );
        records.push({ location, base, current });
      }
    }),
  );
  return records;
}
