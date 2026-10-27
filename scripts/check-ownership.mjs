import { execFileSync } from 'node:child_process';

// Check the index and working tree together. This never writes the owner's file.
const changed = execFileSync(
  'git',
  ['diff', 'HEAD', '--name-only', '--', 'README.md'],
  {
    encoding: 'utf8',
  },
).trim();
if (changed) {
  console.error(
    'Root README.md is owner-maintained. Remove agent-authored README changes before proceeding.',
  );
  process.exitCode = 1;
}

if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  const base = process.env.MEMBRAIN_BASE_SHA;
  if (!base || !/^[a-f0-9]{40}$/u.test(base)) {
    throw new Error('The ownership check requires the pull request base SHA.');
  }
  const committed = execFileSync(
    'git',
    ['diff', base, 'HEAD', '--name-only', '--', 'README.md'],
    {
      encoding: 'utf8',
    },
  ).trim();
  if (committed) {
    console.error(
      'Pull requests must not modify the owner-maintained root README.md.',
    );
    process.exitCode = 1;
  }
}
