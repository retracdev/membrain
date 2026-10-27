import { randomUUID } from 'node:crypto';
import { lstat, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Config, SyncPolicy } from '../config.js';
import { MembrainError } from '../errors.js';
import type { Location, Selection } from '../engine/scopes.js';
import { selectLocations } from '../engine/scopes.js';
import { fail, scanSecrets } from '../engine/model.js';
import {
  canonical,
  contains,
  errno,
  safeDirectory,
  withLock,
  flushDirectory,
} from '../storage/files.js';
import { exists, readMarker } from '../init/detect.js';
import { Git, GitError, nul } from './git.js';
import {
  blobs,
  decode,
  gitSources,
  localSources,
  managed,
  normalized,
  relative,
  union,
  validateUnion,
  treeFiles,
} from './records.js';
import type { Owner, TreeFile } from './records.js';

export interface SyncItem {
  scope: string;
  path: string;
  projectId?: string;
  sessionId?: string;
  mode: SyncPolicy['mode'];
}
export interface SyncResult {
  scopes: SyncItem[];
  repository?: string;
  status:
    | 'skipped'
    | 'up-to-date'
    | 'committed'
    | 'synchronized'
    | 'pending'
    | 'conflict'
    | 'error';
  stage: string;
  code?: string;
  message?: string;
  commit?: string;
  recoveryRef?: string;
  remote?: string;
  branch?: string;
}
export interface SyncReport {
  ok: boolean;
  trigger: 'manual' | 'automatic';
  results: SyncResult[];
}
export interface SyncOptions {
  trigger?: 'manual' | 'automatic';
  signal?: AbortSignal;
}
interface Target {
  location: Location;
  policy: SyncPolicy;
  item: SyncItem;
}
interface Repository {
  root: string;
  gitDir: string;
  commonDir: string;
  targets: Target[];
}
function problem(error: unknown): { code: string; message: string } {
  if (error instanceof GitError) {
    if (
      /unknown (?:option|switch)|unrecognized option/iu.test(error.diagnostic)
    )
      return {
        code: 'UNSUPPORTED_GIT_VERSION',
        message:
          'Installed Git does not support a required safety option. Upgrade Git (2.43+ recommended) before retrying; Membrain will not weaken synchronization safeguards.',
      };
    if (
      /not a git repository|must be run in a work tree/iu.test(error.diagnostic)
    )
      return {
        code: 'NO_GIT_REPOSITORY',
        message:
          'Memory storage must be in an existing Git worktree. Initialize/prepare it yourself explicitly, or keep local mode; Membrain never creates repositories.',
      };
    if (/No such remote|not a valid remote name/iu.test(error.diagnostic))
      return {
        code: 'UNKNOWN_GIT_REMOTE',
        message:
          'The configured Git remote name does not exist. Configure the intended remote yourself or choose commit-only synchronization.',
      };
    if (
      /Author identity unknown|unable to auto-detect email|empty ident name/iu.test(
        error.diagnostic,
      )
    )
      return {
        code: 'GIT_IDENTITY_REQUIRED',
        message:
          'Git commit identity is missing. Configure user.name/user.email with your Git tools, then retry; saved memories are retained.',
      };
    if (
      /Authentication failed|Permission denied|could not read Username|publickey|terminal prompts disabled|Host key verification failed/iu.test(
        error.diagnostic,
      )
    )
      return {
        code: 'GIT_AUTHENTICATION_FAILED',
        message:
          'Git authentication failed without prompting. Configure existing Git/SSH credentials outside Membrain, then retry sync.',
      };
    if (
      /non-fast-forward|fetch first|rejected|failed to push/iu.test(
        error.diagnostic,
      )
    )
      return {
        code: 'PUSH_REJECTED',
        message:
          'Remote rejected the push. Both histories remain intact; retry explicit sync after reviewing the remote or server policy.',
      };
    return {
      code: 'GIT_UNAVAILABLE_OR_OFFLINE',
      message:
        'Git could not complete the operation. Check Git identity, repository state, remote availability, connectivity and permissions; local memories are retained. Raw Git output is withheld to avoid exposing credentials.',
    };
  }
  return error instanceof MembrainError
    ? { code: error.code, message: error.message }
    : {
        code: 'SYNC_FAILED',
        message:
          'Synchronization stopped after a local filesystem failure. Inspect the reported stage/repository and retry; no rollback or memory deletion was attempted.',
      };
}
async function policyFor(
  config: Config,
  location: Location,
): Promise<SyncPolicy> {
  if (location.scope === 'global') return config.global!.sync;
  if (location.scope === 'session') return config.session!.sync;
  const matches = [];
  for (const project of config.projects)
    if ((await canonical(project.path)) === location.path)
      matches.push(project.sync);
  if (
    !matches.length ||
    new Set(matches.map((policy) => JSON.stringify(policy))).size !== 1
  )
    fail(
      'SYNC_POLICY_AMBIGUOUS',
      'Mappings of the same physical store must have identical synchronization policies. Review local/worktree mappings before enabling Git.',
    );
  return matches[0]!;
}
async function discover(target: Target): Promise<Repository> {
  let cursor = target.location.path;
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor)
      fail(
        'NO_GIT_REPOSITORY',
        'Memory storage is not in an existing Git repository. Initialize one yourself explicitly or keep local mode.',
      );
    cursor = parent;
  }
  const bootstrap = new Git(
    cursor,
    path.join(cursor, '.git', 'membrain-disabled-hooks'),
  );
  const root = await canonical(
    await bootstrap.text(['rev-parse', '--show-toplevel']),
  );
  if (!contains(root, target.location.path))
    fail(
      'NO_GIT_REPOSITORY',
      'Memory storage must be inside the selected Git worktree.',
    );
  const gitDir = await canonical(
    await bootstrap.text(['rev-parse', '--absolute-git-dir']),
  );
  const common = await bootstrap.text([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const commonDir = await canonical(common);
  // Symlinked storage roots/parents within a tree cannot be safely represented by Git.
  let check = root;
  for (const part of path
    .relative(root, target.location.path)
    .split(path.sep)
    .filter(Boolean)) {
    check = path.join(check, part);
    try {
      if ((await lstat(check)).isSymbolicLink())
        fail(
          'UNSAFE_SYNC_PATH',
          'Git synchronization cannot follow symlinked memory storage. Select a real directory in its containing repository.',
        );
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  }
  return { root, gitDir, commonDir, targets: [target] };
}
async function lockStores<T>(
  locations: Location[],
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const assertions: (() => Promise<void>)[] = [];
  async function next(index: number): Promise<T> {
    const location = locations[index];
    if (!location)
      return action(async () => {
        for (const assertion of assertions) await assertion();
      });
    await safeDirectory(location.path);
    return withLock(location.path, async (assertion) => {
      assertions.push(assertion);
      try {
        return await next(index + 1);
      } finally {
        assertions.pop();
      }
    });
  }
  return next(0);
}
function lockFile(file: string, owners: Owner[]): boolean {
  return owners.some((owner) =>
    file.startsWith(`${owner.prefix ? `${owner.prefix}/` : ''}.membrain-lock/`),
  );
}
async function preflight(
  git: Git,
  owners: Owner[],
  markers: Map<string, string>,
): Promise<string[]> {
  const status = await git.text([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  const changed: string[] = [];
  const statOnly: string[] = [];
  for (const item of status.split('\0').filter(Boolean)) {
    const state = item.slice(0, 2);
    const file = item.slice(3);
    if (state === '??' && lockFile(file, owners)) continue;
    if (!managed(file, owners, markers))
      fail(
        'UNRELATED_CHANGES',
        'Repository has unrelated dirty, staged or untracked files. Commit/review them yourself, or use a dedicated memory repository; Membrain did not stash, reset or stage them.',
      );
    if (state === ' M') {
      statOnly.push(file);
      continue;
    }
    if (state !== '??' && state !== 'A ')
      fail(
        'IMMUTABLE_WORKTREE_CHANGE',
        'A managed path was modified, removed, conflicted or staged differently from its working copy. Immutable sources may only be added. Inspect Git status and preserve all copies before retrying.',
      );
    changed.push(file);
  }
  if (statOnly.length) {
    // Git can report stat-only modifications with optional index refresh disabled
    // (notably after LF/CRLF checkout). Verify actual Git content/mode differences.
    const paths = [
      ...new Set([
        ...owners.map((owner) => owner.prefix || '.'),
        ...markers.keys(),
      ]),
    ];
    const differences = (
      await git.run([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        '--',
        ...paths,
      ])
    )
      .toString('utf8')
      .split('\0');
    if (statOnly.some((file) => differences.includes(file)))
      fail(
        'IMMUTABLE_WORKTREE_CHANGE',
        'A managed file has a content or mode change, beyond Git checkout line-ending conversion. Preserve the source and review it manually before sync.',
      );
  }
  return changed;
}
async function inspectRepository(
  git: Git,
  repository: Repository,
  branch?: string,
): Promise<{ head?: string; branch: string }> {
  const indexFlags = (await git.run(['ls-files', '-v', '-z']))
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (indexFlags.some((entry) => entry[0] !== 'H'))
    fail(
      'UNSUPPORTED_INDEX',
      'Skip-worktree, assume-unchanged or unmerged index entries prevent reliable safety checks. Review these flags yourself before synchronization.',
    );
  for (const name of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-apply',
    'rebase-merge',
    'BISECT_LOG',
    'index.lock',
    'HEAD.lock',
  ])
    if (await exists(path.join(repository.gitDir, name)))
      fail(
        'GIT_OPERATION_IN_PROGRESS',
        'Another Git operation or unresolved merge is present. Complete/review it yourself before syncing; Membrain will not abort it.',
      );
  if ((await git.text(['rev-parse', '--is-shallow-repository'])) === 'true')
    fail(
      'UNSUPPORTED_REPOSITORY',
      'Shallow repositories cannot prove outgoing history safety. Use a complete dedicated memory checkout.',
    );
  if (
    (await git.optional(['config', '--get', 'core.sparseCheckout'])) ===
      'true' ||
    (await git.optional(['config', '--get', 'extensions.partialClone']))
  )
    fail(
      'UNSUPPORTED_REPOSITORY',
      'Sparse/partial checkouts are not supported for synchronization. Use a complete memory checkout.',
    );
  if (await exists(path.join(repository.commonDir, 'info', 'grafts')))
    fail(
      'UNSUPPORTED_REPOSITORY',
      'Legacy grafts prevent reliable history validation. Use an ordinary complete checkout.',
    );
  const current = await git.optional(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    [1],
  );
  if (!current)
    fail(
      'DETACHED_HEAD',
      'Synchronization requires a checked-out branch. Select the intended branch yourself; Membrain never changes branches.',
    );
  if (branch && branch !== current)
    fail(
      'WRONG_SYNC_BRANCH',
      'Configured sync branch must equal the checked-out branch. Check out the intended branch yourself or review configuration.',
    );
  await git.run(['check-ref-format', `refs/heads/${branch ?? current}`]);
  const head = await git.optional(['rev-parse', '--verify', 'HEAD']);
  return { ...(head ? { head } : {}), branch: current };
}
async function attributes(git: Git, files: string[]): Promise<void> {
  if (!files.length) return;
  const output = (
    await git.run(
      [
        'check-attr',
        '-z',
        '--stdin',
        'filter',
        'working-tree-encoding',
        'ident',
      ],
      nul(files),
    )
  )
    .toString('utf8')
    .split('\0');
  for (let i = 0; i + 2 < output.length; i += 3)
    if (!['unspecified', 'unset'].includes(output[i + 2]!))
      fail(
        'UNSAFE_GIT_ATTRIBUTES',
        'A managed path has a clean/smudge filter, encoding conversion or ident expansion. Disable these for memory files before synchronization; Membrain will not run configured content filters.',
      );
}
async function notIgnored(git: Git, files: string[]): Promise<void> {
  if (!files.length) return;
  try {
    const ignored = await git.run(
      ['check-ignore', '--no-index', '-z', '--stdin'],
      nul(files),
    );
    if (ignored.length)
      fail(
        'IGNORED_MEMORY_FILES',
        'New memory files are ignored by Git. Review ignores yourself; Membrain never force-adds them.',
      );
  } catch (error) {
    if (!(error instanceof GitError && error.status === 1)) throw error;
  }
}
async function auditHistory(
  git: Git,
  tip: string,
  exclude: string | undefined,
  owners: Owner[],
  markers: Map<string, string>,
): Promise<void> {
  const commits = await git.text([
    'rev-list',
    '--parents',
    tip,
    ...(exclude ? [`^${exclude}`] : []),
  ]);
  if (!commits) return;
  scanSecrets(
    await git.text([
      'log',
      '--no-show-signature',
      '--format=%an%x00%ae%x00%cn%x00%ce%x00%B',
      '-z',
      tip,
      ...(exclude ? [`^${exclude}`] : []),
    ]),
  );
  const files: TreeFile[] = [];
  for (const line of commits.split('\n').filter(Boolean)) {
    const [commit, ...parents] = line.split(' ');
    for (const parent of parents.length ? parents : [undefined]) {
      const args = parent ? [parent, commit!] : ['--root', commit!];
      const changes = (
        await git.run([
          'diff-tree',
          '--no-commit-id',
          '--no-renames',
          '--no-abbrev',
          '-r',
          '--raw',
          '-z',
          ...args,
        ])
      )
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      for (let i = 0; i < changes.length; i += 2) {
        const header = changes[i]!.split(' ');
        const state = header[4]!;
        const file = changes[i + 1]!;
        if (!managed(file, owners, markers))
          fail(
            'UNRELATED_HISTORY',
            'Incoming/outgoing history changes unrelated or unselected paths. Synchronization stopped; inspect the reported stage. Use owner-managed Git or a dedicated memory branch/repository with shared history.',
          );
        if (state !== 'A')
          fail(
            'IMMUTABLE_HISTORY_CHANGE',
            'Git history modifies/deletes a previously published immutable memory path. Preserve both histories and resolve manually; only additive source history can synchronize.',
          );
        if (header[1] !== '100644' || !header[3])
          fail(
            'UNSAFE_SYNC_PATH',
            'History contains a non-regular managed source path.',
          );
        files.push({ mode: header[1]!, oid: header[3]!, file });
      }
    }
  }
  const contents = await blobs(git, files);
  for (const file of files)
    decode(
      file.file,
      contents.get(file.oid)!,
      managed(file.file, owners, markers)!,
    );
}
async function validateTargets(git: Git, remote: string): Promise<void> {
  const urls = (await git.text(['remote', 'get-url', '--all', remote])).split(
    '\n',
  );
  const pushes = (
    await git.text(['remote', 'get-url', '--push', '--all', remote])
  ).split('\n');
  if (
    urls.length !== 1 ||
    pushes.length !== 1 ||
    urls[0] !== pushes[0] ||
    (await git.optional(['config', '--get', `remote.${remote}.mirror`])) ===
      'true'
  )
    fail(
      'AMBIGUOUS_REMOTE',
      'Sync needs one matching fetch/push URL and a non-mirror remote. Review Git configuration; no URL is logged.',
    );
}
async function synchronize(
  repository: Repository,
  config: Config,
  options: SyncOptions,
): Promise<SyncResult> {
  const result: SyncResult = {
    scopes: repository.targets.map((target) => target.item),
    repository: repository.root,
    status: 'pending',
    stage: 'preflight',
  };
  const state = path.join(repository.commonDir, 'membrain-sync');
  const git = new Git(
    repository.root,
    path.join(state, 'disabled-hooks'),
    options.signal,
  );
  let recovery: string | undefined;
  try {
    await safeDirectory(state);
    return await withLock(state, async (repositoryOwned) =>
      lockStores(
        repository.targets
          .map((target) => target.location)
          .sort((a, b) => (a.path < b.path ? -1 : 1)),
        async (storesOwned) => {
          const assertOwned = async () => {
            await repositoryOwned();
            await storesOwned();
            if (options.signal?.aborted)
              fail(
                'SYNC_INTERRUPTED',
                'Synchronization interrupted; inspect the durable stage before retrying.',
              );
          };
          const saveProgress = async (stage: string) => {
            result.stage = stage;
            const temporary = path.join(state, `.${randomUUID()}.membrain-tmp`);
            const handle = await open(temporary, 'wx', 0o600);
            try {
              await handle.writeFile(
                `${JSON.stringify({ ...result, status: stage === 'complete' ? result.status : 'pending' }, null, 2)}\n`,
              );
              await handle.sync();
            } finally {
              await handle.close();
            }
            await rename(temporary, path.join(state, 'progress.json'));
            await flushDirectory(state);
          };
          const policies = repository.targets
            .map((target) => target.policy)
            .filter((policy) => policy.mode !== 'local');
          const targets = new Set(
            policies.map((policy) =>
              JSON.stringify({ remote: policy.remote, branch: policy.branch }),
            ),
          );
          if (targets.size !== 1)
            fail(
              'SYNC_TARGET_CONFLICT',
              'Scopes sharing a worktree must select the same remote/branch in one sync. Use separate repositories for independent targets.',
            );
          const policy = policies[0]!;
          const remote = policy.remote;
          const branch = policy.branch;
          if (remote && !branch)
            fail(
              'INVALID_SYNC_POLICY',
              'Remote synchronization requires an explicitly configured branch. Review init preferences.',
            );
          const owners: Owner[] = repository.targets.map((target) => ({
            location: target.location,
            prefix: relative(repository.root, target.location.path),
          }));
          const markers = new Map<string, string>();
          for (const entry of config.projects) {
            if (
              !owners.some(
                (owner) =>
                  owner.location.scope === 'project' &&
                  owner.location.projectId === entry.projectId &&
                  owner.location.path === path.resolve(entry.path),
              )
            )
              continue;
            const marker = await readMarker(entry.root);
            if (marker && contains(repository.root, entry.root)) {
              if (marker.projectId !== entry.projectId)
                fail(
                  'SYNC_IDENTITY_CONFLICT',
                  'Project marker and configured ID disagree.',
                );
              const file = path.join(entry.root, '.membrain', 'project.json');
              if ((await canonical(file)) !== path.resolve(file))
                fail(
                  'UNSAFE_SYNC_PATH',
                  'Owned project markers cannot be symlinked.',
                );
              markers.set(relative(repository.root, file), entry.projectId);
            }
          }
          const before = await inspectRepository(git, repository, branch);
          result.branch = before.branch;
          if (remote) result.remote = remote;
          const originalHead = before.head;
          const local = await localSources(repository.root, owners, markers);
          await attributes(git, [...local.keys()]);
          await preflight(git, owners, markers);
          let trackedNames = new Set<string>();
          // Detect hidden tracked changes even when assume-unchanged/skip-worktree is set.
          if (originalHead) {
            const tracked = await gitSources(
              git,
              originalHead,
              owners,
              markers,
            );
            trackedNames = new Set(tracked.keys());
            for (const [file, source] of tracked)
              if (
                !local.has(file) ||
                normalized(local.get(file)!.bytes) !== normalized(source.bytes)
              )
                fail(
                  'IMMUTABLE_WORKTREE_CHANGE',
                  'A tracked source differs from authoritative local files, including a hidden Git index change. Restore/review it manually before synchronization.',
                );
          }
          await notIgnored(
            git,
            [...local.keys()].filter((file) => !trackedNames.has(file)),
          );
          let remoteHead: string | undefined;
          if (remote) {
            await validateTargets(git, remote);
            let advertised: string | undefined;
            try {
              advertised = await git.text(
                [
                  'ls-remote',
                  '--exit-code',
                  '--refs',
                  remote,
                  `refs/heads/${branch!}`,
                ],
                undefined,
                true,
              );
            } catch (error) {
              if (!(error instanceof GitError && error.status === 2))
                throw error;
            }
            if (advertised) {
              recovery = `refs/membrain/fetch/${randomUUID()}`;
              result.recoveryRef = recovery;
              await saveProgress('fetching');
              await git.run(
                [
                  'fetch',
                  '--no-tags',
                  '--no-recurse-submodules',
                  '--no-write-fetch-head',
                  '--no-auto-maintenance',
                  '--refmap=',
                  '--',
                  remote,
                  `refs/heads/${branch!}:${recovery}`,
                ],
                undefined,
                true,
              );
              remoteHead = await git.text(['rev-parse', '--verify', recovery]);
              await saveProgress('fetched');
              if (
                originalHead &&
                !(await git.optional(
                  ['merge-base', originalHead, remoteHead],
                  [1],
                ))
              )
                fail(
                  'UNRELATED_HISTORIES',
                  'Local and remote branches have no common history. Clone the intended remote or prepare shared history explicitly; Membrain never joins unrelated histories.',
                );
              await auditHistory(
                git,
                remoteHead,
                originalHead,
                owners,
                markers,
              );
              const incoming = await gitSources(
                git,
                remoteHead,
                owners,
                markers,
              );
              await attributes(git, [...incoming.keys()]);
              validateUnion(union(local, incoming), owners);
            }
            if (originalHead)
              await auditHistory(
                git,
                originalHead,
                remoteHead,
                owners,
                markers,
              );
          }
          const unchangedHead = async (expected: string | undefined) => {
            await assertOwned();
            const current = await git.optional([
              'rev-parse',
              '--verify',
              'HEAD',
            ]);
            const currentBranch = await git.optional(
              ['symbolic-ref', '--quiet', '--short', 'HEAD'],
              [1],
            );
            if (current !== expected || currentBranch !== before.branch)
              fail(
                'GIT_HEAD_CHANGED',
                'Git HEAD/branch changed concurrently. No reset was attempted; inspect Git state and retry.',
              );
            return preflight(git, owners, markers);
          };
          const changed = await unchangedHead(originalHead);
          if (changed.length) {
            if (changed.some((file) => !local.has(file)))
              fail(
                'INVALID_SYNC_SOURCE',
                'Changed Git paths are not part of the validated local snapshot.',
              );
            try {
              const blocked = await git.run(
                ['check-ignore', '--no-index', '-z', '--stdin'],
                nul(changed),
              );
              if (blocked.length)
                fail(
                  'IGNORED_MEMORY_FILES',
                  'Selected memory files are ignored by Git. Review ignores yourself; Membrain never force-adds them.',
                );
            } catch (error) {
              if (!(error instanceof GitError && error.status === 1))
                throw error;
            }
            await saveProgress('staging');
            await assertOwned();
            await git.run(
              ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
              nul(changed),
            );
            await saveProgress('staged');
            await unchangedHead(originalHead);
            await git.run(
              [
                'commit',
                '--only',
                '--no-verify',
                '--no-gpg-sign',
                '-m',
                'Membrain: synchronize memory revisions',
                '--pathspec-from-file=-',
                '--pathspec-file-nul',
              ],
              nul(changed),
            );
            result.commit = await git.text(['rev-parse', '--verify', 'HEAD']);
            await saveProgress('committed');
          }
          let head = await git.optional(['rev-parse', '--verify', 'HEAD']);
          let imported = false;
          if (remoteHead && head !== remoteHead) {
            await unchangedHead(head);
            await saveProgress('merging');
            let candidate = remoteHead;
            const base = head
              ? await git.text(['merge-base', head, remoteHead])
              : undefined;
            if (head && base !== head && base !== remoteHead) {
              const indexFile = path.join(state, `${randomUUID()}.index`);
              const privateGit = new Git(
                repository.root,
                path.join(state, 'disabled-hooks'),
                options.signal,
                indexFile,
              );
              try {
                await privateGit.run(['read-tree', head]);
                const localTree = new Map(
                  (await treeFiles(git, head, owners, markers)).map((file) => [
                    file.file,
                    file,
                  ]),
                );
                const incoming = (
                  await treeFiles(git, remoteHead, owners, markers)
                ).filter((file) => !localTree.has(file.file));
                if (incoming.length)
                  await privateGit.run(
                    ['update-index', '-z', '--index-info'],
                    Buffer.from(
                      `${incoming.map((file) => `${file.mode} ${file.oid}\t${file.file}`).join('\0')}\0`,
                    ),
                  );
                const tree = await privateGit.text(['write-tree']);
                candidate = await privateGit.text([
                  'commit-tree',
                  tree,
                  '-p',
                  head,
                  '-p',
                  remoteHead,
                  '-m',
                  'Membrain: merge validated immutable revisions',
                ]);
                await auditHistory(git, candidate, remoteHead, owners, markers);
                validateUnion(
                  await gitSources(git, candidate, owners, markers),
                  owners,
                );
              } finally {
                await unlink(indexFile).catch(() => undefined);
              }
            }
            if (base !== remoteHead) {
              await unchangedHead(head);
              await git.run([
                'merge',
                '--ff-only',
                '--no-edit',
                '--no-stat',
                '--no-autostash',
                candidate,
              ]);
              imported = true;
            }
            head = await git.text(['rev-parse', '--verify', 'HEAD']);
            await saveProgress('merged');
          }
          if (head) {
            await unchangedHead(head);
            const committed = await gitSources(git, head, owners, markers);
            validateUnion(union(local, committed), owners);
            if (remote) {
              await auditHistory(git, head, remoteHead, owners, markers);
              if (head !== remoteHead) {
                await saveProgress('pushing');
                await assertOwned();
                await git.run(
                  [
                    'push',
                    '--no-follow-tags',
                    '--no-signed',
                    '--recurse-submodules=no',
                    '--',
                    remote,
                    `${head}:refs/heads/${branch!}`,
                  ],
                  undefined,
                  true,
                );
                await saveProgress('pushed');
              }
            }
          }
          result.status = remote
            ? imported || result.commit || (head && head !== remoteHead)
              ? 'synchronized'
              : 'up-to-date'
            : result.commit
              ? 'committed'
              : 'up-to-date';
          if (recovery) {
            await git.run(['update-ref', '-d', recovery, remoteHead!]);
            delete result.recoveryRef;
          }
          await saveProgress('complete');
          return result;
        },
      ),
    );
  } catch (error) {
    const failure = problem(error);
    Object.assign(result, failure);
    result.status = /CONFLICT/u.test(failure.code)
      ? 'conflict'
      : /OFFLINE|TIMEOUT|AUTHENTICATION|PUSH_REJECTED|INTERRUPTED/u.test(
            failure.code,
          )
        ? 'pending'
        : 'error';
    return result;
  }
}

export async function synchronizeMemories(
  config: Config,
  selection: Selection = {},
  cwd = process.cwd(),
  options: SyncOptions = {},
): Promise<SyncReport> {
  const trigger = options.trigger ?? 'manual';
  const results: SyncResult[] = [];
  const groups = new Map<string, Repository>();
  const locations = await selectLocations(config, selection, cwd);
  for (const location of locations) {
    let item: SyncItem = { ...location, mode: 'local' };
    try {
      const policy = await policyFor(config, location);
      item = { ...location, mode: policy.mode };
      if (
        policy.mode === 'local' ||
        (trigger === 'automatic' && policy.mode !== 'automatic')
      ) {
        results.push({
          scopes: [item],
          status: selection.scope && trigger === 'manual' ? 'error' : 'skipped',
          stage: 'policy',
          ...(selection.scope && trigger === 'manual'
            ? {
                code: 'LOCAL_SYNC_DISABLED',
                message:
                  'This scope is local-only. Configure manual synchronization explicitly; Membrain ran no Git operation for it.',
              }
            : {}),
        });
        continue;
      }
      if (policy.mode === 'automatic' && policy.authorized !== true)
        fail(
          'AUTO_SYNC_AUTHORIZATION_REQUIRED',
          'Automatic synchronization is not authorized in local configuration.',
        );
      const repository = await discover({ location, policy, item });
      const previous = groups.get(repository.root);
      if (previous) previous.targets.push({ location, policy, item });
      else groups.set(repository.root, repository);
    } catch (error) {
      results.push({
        scopes: [item],
        status: 'error',
        stage: 'discovery',
        ...problem(error),
      });
    }
  }
  for (const repository of groups.values())
    results.push(await synchronize(repository, config, options));
  return {
    ok: results.every((result) =>
      ['skipped', 'up-to-date', 'committed', 'synchronized'].includes(
        result.status,
      ),
    ),
    trigger,
    results,
  };
}
