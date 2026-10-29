import fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';

// Test-only checkpoint after the private SQLite generation is complete, before
// publication. No production crash switches or user configuration are needed.
const original = fs.rename;
const checkpoint = process.argv[4] ?? 'index';
fs.rename = async (...args) => {
  if (
    args[1].endsWith(
      checkpoint === 'index' ? 'index.sqlite' : 'index.sqlite.manifest.json',
    )
  ) {
    process.send({ stage: `before-${checkpoint}-publication` });
    await new Promise(() => {});
  }
  return original(...args);
};
syncBuiltinESMExports();
const [filename, cache] = process.argv.slice(2);
const config = parseConfig(
  JSON.parse(await readFile(filename, 'utf8')),
  filename,
);
await new MemoryEngine(config, process.cwd(), cache).query(
  { scope: 'global' },
  { limit: 10, verification: 'fast' },
);
