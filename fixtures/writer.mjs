import { readFile } from 'node:fs/promises';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';
const [filename, mode, label, id, expected] = process.argv.slice(2);
const config = parseConfig(
  JSON.parse(await readFile(filename, 'utf8')),
  filename,
);
const engine = new MemoryEngine(
  config,
  process.cwd(),
  process.env.MEMBRAIN_CACHE_DIR,
);
try {
  const saved =
    mode === 'read' || mode === 'read-fast'
      ? await engine.query(
          { scope: 'global' },
          {
            limit: 100,
            ...(mode === 'read-fast' ? { verification: 'fast' } : {}),
          },
        )
      : mode === 'update'
        ? await engine.update({ scope: 'global' }, id, {
            content: `updated by ${label}`,
            expectedRevision: expected,
          })
        : await engine.remember(
            { scope: 'global' },
            {
              content:
                mode === 'retry'
                  ? 'one shared retry'
                  : `concurrent unique memory ${label}`,
              operationId:
                mode === 'retry' ? 'shared-operation' : `writer-${label}`,
            },
          );
  process.stdout.write(JSON.stringify(saved));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: { code: error.code, message: error.message } }),
  );
  process.exitCode = 1;
}
