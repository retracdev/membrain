import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';

// A dependency capability check, not a memory index implementation.
test('the runtime provides FTS5, parameter binding, and ascending BM25 relevance', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE VIRTUAL TABLE probe USING fts5(content, tokenize = unicode61)',
    );
    const insert = db.prepare('INSERT INTO probe(content) VALUES (?)');
    insert.run('sqlite sqlite sqlite');
    insert.run('sqlite memory architecture development project preferences');
    const results = db
      .prepare(
        'SELECT content, bm25(probe) AS score FROM probe WHERE probe MATCH ? ORDER BY score ASC, rowid ASC',
      )
      .all('sqlite');
    assert.equal(results.length, 2);
    assert.equal(results[0].content, 'sqlite sqlite sqlite');
    assert.ok(results[0].score < results[1].score);
    assert.equal(
      db.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
  } finally {
    db.close();
  }
});
