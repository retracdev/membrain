import { readStore } from '../dist/storage/store.js';
const snapshot = await readStore({ path: process.argv[2], scope: 'global' });
console.log(
  JSON.stringify({
    fingerprint: snapshot.fingerprint,
    revisions: snapshot.records.length,
    heads: snapshot.entries.length,
    warnings: snapshot.warnings,
  }),
);
