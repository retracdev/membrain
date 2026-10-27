import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryEngine } from '../dist/engine/engine.js';
import { parseConfig } from '../dist/config.js';
import { literalQuery } from '../dist/index/search.js';
import { cases, memories, semanticGap } from '../fixtures/relevance.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-relevance-'));
assert.equal(path.dirname(directory), os.tmpdir());
try {
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
  const results = [];
  for (const item of [...cases, semanticGap]) {
    const result = await engine.query(
      { scope: 'global' },
      { query: item.query, literal: item.literal ?? false, limit: 100 },
    );
    const db = new Database(result.index.path, { readonly: true });
    let baseline;
    try {
      baseline = db
        .prepare(
          `SELECT e.id FROM fts JOIN entries e ON e.revisionId=fts.revisionId WHERE fts MATCH ? ORDER BY bm25(fts,1.0,0.5),e.id COLLATE BINARY LIMIT 1`,
        )
        .get(literalQuery(item.query, true));
    } finally {
      db.close();
    }
    const first = keys.get(result.results[0]?.record.id);
    if (item.expected) assert.equal(first, item.expected, item.query);
    results.push({
      query: item.query,
      baselineTop: keys.get(baseline?.id) ?? null,
      phase6Top: first ?? null,
      desired: item.expected ?? item.desired,
      passed: first === (item.expected ?? item.desired),
      knownSemanticGap: !item.expected,
    });
  }
  console.log(
    JSON.stringify(
      {
        corpus: memories.length,
        regressionCases: cases.length,
        passed: results.filter((item) => item.passed).length,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
