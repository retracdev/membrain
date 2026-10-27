import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../dist/engine/engine.js';
import { parseConfig } from '../dist/config.js';
import { literalQuery } from '../dist/index/search.js';
import { cases, memories, semanticGap } from '../fixtures/relevance.mjs';

test('competing-memory relevance corpus, identifiers, Unicode, and literal SQL', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-ranking-'));
  assert.equal(path.dirname(directory), os.tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new MemoryEngine(
    parseConfig(
      { version: 1, global: { path: path.join(directory, 'source') } },
      path.join(directory, 'config.json'),
    ),
    directory,
    path.join(directory, 'cache'),
  );
  const keys = new Map();
  for (const { key, ...draft } of memories)
    keys.set(
      (await engine.remember({ scope: 'global' }, draft)).record.id,
      key,
    );
  for (const item of cases) {
    const result = await engine.query(
      { scope: 'global' },
      { query: item.query, literal: item.literal ?? false, limit: 10 },
    );
    assert.equal(
      keys.get(result.results[0]?.record.id),
      item.expected,
      item.query,
    );
  }
  // The regression report explicitly retains this unsolved semantic limitation.
  const gap = await engine.query(
    { scope: 'global' },
    { query: semanticGap.query, limit: 10 },
  );
  assert.equal(keys.get(gap.results[0]?.record.id), 'appearance');
  assert.equal(
    gap.results.some((item) => keys.get(item.record.id) === 'language'),
    false,
  );
});

test('query normalization stays bounded and offers full literal tokens', () => {
  assert.equal(literalQuery('Which database do I use?'), '"database" OR "use"');
  assert.equal(literalQuery('WHERE EXISTS', true), '"where" OR "exists"');
  assert.equal(literalQuery('OR'), '"or"');
  assert.equal(
    literalQuery('AtlasWorker42 Next.js FTS5'),
    '"atlasworker42" OR "next" OR "js" OR "fts5"',
  );
  assert.throws(() => literalQuery('x'.repeat(2049)), {
    code: 'INVALID_QUERY',
  });
  assert.throws(
    () =>
      literalQuery(Array.from({ length: 65 }, (_, i) => `term${i}`).join(' ')),
    { code: 'INVALID_QUERY' },
  );
});
