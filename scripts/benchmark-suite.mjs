import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const label = process.argv[2] ?? 'current';
if (!/^[a-z0-9-]+$/u.test(label)) throw new Error('Use a simple report label.');
const counts = (process.argv[3] ?? '100,1000,10000').split(',');
const samples = process.argv[4] ?? '30';
const kind = process.argv[5] ?? 'global';
if (!['global', 'mixed'].includes(kind))
  throw new Error('Use global or mixed.');
const gate = process.argv[6] === '--gate';
if (process.argv[6] !== undefined && !gate)
  throw new Error('Unknown suite option.');
if (
  gate &&
  (kind !== 'global' || !counts.includes('10000') || Number(samples) < 30)
)
  throw new Error(
    'The latency gate needs global 10000 with at least 30 samples.',
  );
const output = new URL('../coverage/performance/', import.meta.url);
await mkdir(output, { recursive: true });
for (const count of counts) {
  if (!/^\d+$/u.test(count)) throw new Error('Use comma-separated counts.');
  const stdout = [];
  const stderr = [];
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          kind === 'mixed' ? './benchmark-mixed.mjs' : './benchmark.mjs',
          import.meta.url,
        ),
      ),
      count,
      samples,
    ],
    { shell: false },
  );
  child.stdout.on('data', (data) => stdout.push(data));
  child.stderr.on('data', (data) => {
    stderr.push(data);
    process.stderr.write(data);
  });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await writeFile(
    new URL(`${label}-${count}.log`, output),
    Buffer.concat(stderr),
  );
  if (status !== 0) throw new Error(`Benchmark failed (${status}).`);
  const report = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  await writeFile(
    new URL(`${label}-${count}.json`, output),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      label,
      count,
      coldMs: report.coldCliRecallMs,
      warm: report.warmCliRecall,
      peakRssKiB: report.warmProfile.resources.maxRSS,
    }),
  );
  if (gate && count === '10000' && report.warmCliRecall.p95Ms > 1000) {
    console.error('Warm recall p95 exceeds the 1000 ms release gate.');
    process.exitCode = 1;
  }
}
