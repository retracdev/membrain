import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// npm_execpath is provided by npm scripts, including npm.cmd on Windows.
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Run this through npm run pack:check.');
const output = execFileSync(
  process.execPath,
  [npmPath, 'pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    encoding: 'utf8',
  },
);
const [{ files }] = JSON.parse(output);
const paths = files.map((file) => file.path);
for (const required of [
  'dist/cli.js',
  'dist/storage/replay.js',
  'dist/storage/replay-worker.js',
  'dist/storage/revision.js',
  'dist/profile.js',
  'package.json',
  'LICENSE',
  'docs/quick-start.md',
  'skills/membrain/SKILL.md',
]) {
  if (!paths.includes(required))
    throw new Error(`Package is missing ${required}.`);
}
for (const file of paths) {
  if (
    !/^(dist\/.*\.js|docs\/.*\.md|skills\/membrain\/SKILL\.md|package\.json|LICENSE|README\.md)$/u.test(
      file,
    )
  ) {
    throw new Error(`Unexpected package file: ${file}`);
  }
}
const require = createRequire(import.meta.url);
const metadata = require('../package.json');
if (metadata.bin.membrain !== 'dist/cli.js')
  throw new Error('Invalid CLI entry point.');
console.log(
  `Package allowlist passed (${paths.length} files). Nothing was published.`,
);
