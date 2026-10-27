import { lstat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseConfig, resolveConfigPath } from '../config.js';
import type { Config, StorageConfig, SyncPolicy } from '../config.js';
import { canonical, contains, errno } from '../storage/files.js';
import { choice, fail, isObject, uuid } from '../engine/model.js';
import { detectAgents, detectProject, exists, readMarker } from './detect.js';
import type { AgentDetection, ProjectDetection } from './detect.js';
import { inputPath, validateDirectory } from './paths.js';

export type ScopeName = 'global' | 'project' | 'session';
export interface InitOptions {
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  overwriteConfig?: boolean;
  global?: boolean;
  project?: boolean;
  session?: boolean;
  globalPath?: string;
  projectPath?: string;
  sessionPath?: string;
  projectRoot?: string;
  projectId?: string;
  projectMarker?: boolean;
  globalSync?: string;
  projectSync?: string;
  sessionSync?: string;
  globalRemote?: string;
  projectRemote?: string;
  sessionRemote?: string;
  globalBranch?: string;
  projectBranch?: string;
  sessionBranch?: string;
  authorizeGlobalAutoSync?: boolean;
  authorizeProjectAutoSync?: boolean;
  authorizeSessionAutoSync?: boolean;
}
export interface InitContext {
  configPath: string;
  original?: string;
  config: Config;
  cwd: string;
  project: ProjectDetection;
  agents: AgentDetection[];
}
export interface InitPlan {
  context: InitContext;
  config: Config;
  configChanged: boolean;
  directories: string[];
  marker?: {
    path: string;
    projectId: string;
    create: boolean;
    original?: string;
  };
  project?: { root: string; projectId: string };
  selected: ScopeName[];
}
export const scopeNames: ScopeName[] = ['global', 'project', 'session'];
export function selectedScopes(options: InitOptions): ScopeName[] {
  return scopeNames.filter(
    (scope) =>
      options[scope] ||
      options[`${scope}Path`] !== undefined ||
      options[`${scope}Sync`] !== undefined ||
      options[`${scope}Remote`] !== undefined ||
      options[`${scope}Branch`] !== undefined ||
      (scope === 'project' &&
        (options.projectRoot !== undefined || options.projectId !== undefined)),
  );
}
export async function initContext(
  explicit?: string,
  cwd = process.cwd(),
): Promise<InitContext> {
  const requested = resolveConfigPath(explicit, { cwd });
  if (['readme.md', 'license'].includes(path.basename(requested).toLowerCase()))
    fail(
      'PROTECTED_FILE',
      'README.md and LICENSE cannot be used as initialization configuration targets.',
    );
  const configPath = path.join(
    await canonical(path.dirname(requested)),
    path.basename(requested),
  );
  let original: string | undefined;
  let config: Config = { version: 1, projects: [] };
  try {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)
      fail(
        'INVALID_CONFIG_TARGET',
        'Configuration must be a regular file of at most 1 MiB, not a symlink. Select its real path explicitly.',
      );
    original = await readFile(configPath, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(original);
    } catch {
      fail(
        'INVALID_CONFIG',
        'Existing configuration is not valid JSON. It was preserved; repair it before initialization.',
      );
    }
    config = parseConfig(value, configPath);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  const directory = await canonical(cwd);
  return {
    configPath,
    config,
    cwd: directory,
    ...(original === undefined ? {} : { original }),
    project: await detectProject(config, directory),
    agents: await detectAgents(),
  };
}
export function defaultPaths(context: InitContext): Record<ScopeName, string> {
  return {
    global:
      context.config.global?.path ??
      path.join(path.dirname(context.configPath), 'global'),
    project:
      context.config.projects.find(
        (entry) => entry.root === context.project.root,
      )?.path ??
      context.config.projects.find(
        (entry) => entry.projectId === context.project.projectId,
      )?.path ??
      path.join(context.project.root, '.membrain', 'project'),
    session:
      context.config.session?.path ??
      path.join(path.dirname(context.configPath), 'sessions'),
  };
}

function policy(
  scope: ScopeName,
  options: InitOptions,
  previous: StorageConfig | undefined,
  directory: string,
): SyncPolicy {
  const mode = choice(
    options[`${scope}Sync`] ?? previous?.sync.mode ?? 'local',
    ['local', 'manual', 'automatic'] as const,
    `${scope} synchronization mode`,
  );
  const remoteOption = options[`${scope}Remote`];
  const branchOption = options[`${scope}Branch`];
  if (mode === 'local') {
    if (remoteOption !== undefined || branchOption !== undefined)
      fail(
        'INVALID_SYNC_POLICY',
        'Local mode cannot have a remote/branch. Choose manual or automatic explicitly.',
      );
    return { mode: 'local' };
  }
  const old = previous?.sync.mode === 'local' ? undefined : previous?.sync;
  const remote =
    (remoteOption === undefined ? old?.remote : remoteOption)?.trim() ||
    undefined;
  const branch =
    (branchOption === undefined ? old?.branch : branchOption)?.trim() ||
    undefined;
  if (remote && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote))
    fail(
      'INVALID_SYNC_POLICY',
      'Use a Git remote name (for example origin), not a URL or credentials.',
    );
  if (
    branch &&
    (!/^[^\s\u0000-\u001f\u007f~^:?*\\[\]]+$/u.test(branch) ||
      branch.startsWith('-') ||
      branch.startsWith('/') ||
      branch.endsWith('/') ||
      branch.endsWith('.') ||
      branch.includes('..') ||
      branch.includes('@{') ||
      branch.includes('//') ||
      branch === '@' ||
      branch
        .split('/')
        .some((part) => part.startsWith('.') || part.endsWith('.lock')))
  )
    fail(
      'INVALID_SYNC_POLICY',
      'Branch is not a valid portable Git branch name.',
    );
  if (remote && !branch)
    fail(
      'INVALID_SYNC_POLICY',
      'A remote requires an explicit branch. No Git repository or remote will be created.',
    );
  const target = {
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
  };
  if (mode === 'manual') return { mode, ...target };
  const authorization =
    scope === 'global'
      ? options.authorizeGlobalAutoSync
      : scope === 'project'
        ? options.authorizeProjectAutoSync
        : options.authorizeSessionAutoSync;
  const unchanged =
    previous?.sync.mode === 'automatic' &&
    previous.path === directory &&
    previous.sync.remote === remote &&
    previous.sync.branch === branch;
  if (!authorization && !unchanged)
    fail(
      'AUTO_SYNC_AUTHORIZATION_REQUIRED',
      `Automatic ${scope} synchronization requires --authorize-${scope}-auto-sync for this location/target. --yes does not grant authorization.`,
    );
  return { mode: 'automatic', authorized: true, ...target };
}

interface StoreIdentity {
  scope: string;
  projectId?: string;
  sessionId?: string;
}
async function storeIdentity(
  directory: string,
): Promise<StoreIdentity | undefined> {
  const filename = path.join(directory, 'store.json');
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      fail(
        'STORE_IDENTITY_MISMATCH',
        `Unsafe or unrelated store.json at ${directory}; it was preserved.`,
      );
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (
      !isObject(value) ||
      value.schemaVersion !== 1 ||
      !['global', 'project', 'session'].includes(String(value.scope)) ||
      Object.keys(value).some(
        (key) =>
          ![
            'schemaVersion',
            'storeId',
            'scope',
            'projectId',
            'sessionId',
          ].includes(key),
      )
    )
      fail(
        'STORE_IDENTITY_MISMATCH',
        `Unsupported or unrelated store.json at ${directory}; it was preserved.`,
      );
    uuid(value.storeId, 'storeId');
    return value as unknown as StoreIdentity;
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      if (await exists(path.join(directory, 'records')))
        fail(
          'STORE_IDENTITY_MISMATCH',
          `A records directory exists without store.json at ${directory}. Inspect/recover it before initialization.`,
        );
      return undefined;
    }
    if (error instanceof SyntaxError)
      fail(
        'STORE_IDENTITY_MISMATCH',
        `Invalid store.json at ${directory}; it was preserved.`,
      );
    throw error;
  }
}

export async function buildInitPlan(
  context: InitContext,
  options: InitOptions,
): Promise<InitPlan> {
  const selected = selectedScopes(options);
  if (!selected.length && context.original === undefined)
    fail(
      'SCOPE_REQUIRED',
      'Select scopes interactively, or pass --global, --project, --session, or their --*-path flags with --non-interactive. --yes never selects scopes.',
    );
  const defaults = defaultPaths(context);
  const candidate: Config = {
    ...context.config,
    projects: context.config.projects.map((entry) => ({ ...entry })),
  };
  const plan: InitPlan = {
    context,
    config: candidate,
    configChanged: false,
    directories: [],
    selected,
  };
  for (const scope of selected) {
    if (scope === 'project') continue;
    const directory = await validateDirectory(
      inputPath(options[`${scope}Path`] ?? defaults[scope], context.cwd),
    );
    const identity = await storeIdentity(directory);
    if (
      identity &&
      (identity.scope !== scope ||
        identity.projectId !== undefined ||
        identity.sessionId !== undefined ||
        scope === 'session')
    )
      fail(
        'STORE_IDENTITY_MISMATCH',
        `Existing store at ${directory} does not belong to the selected ${scope} scope/base.`,
      );
    const previous = context.config[scope];
    candidate[scope] = {
      path: directory,
      sync: policy(
        scope,
        options,
        previous
          ? { ...previous, path: await canonical(previous.path) }
          : undefined,
        directory,
      ),
    };
  }
  if (selected.includes('project')) {
    if (
      context.project.kind === 'directory' &&
      options.projectRoot === undefined
    )
      fail(
        'PROJECT_ROOT_REQUIRED',
        'For a non-Git project, supply --project-root explicitly or select/confirm the root in the interactive wizard.',
      );
    const root = await validateDirectory(
      inputPath(options.projectRoot ?? context.project.root, context.cwd),
      true,
    );
    const matches = await Promise.all(
      candidate.projects.map(async (entry) => ({
        entry,
        root: await canonical(entry.root),
      })),
    );
    const existing = matches.filter((entry) => entry.root === root);
    if (existing.length > 1)
      fail(
        'AMBIGUOUS_PROJECT',
        'Several configured project roots resolve to the same directory; correct their mappings first.',
      );
    const previous = existing[0]?.entry;
    const marker = await readMarker(root);
    const links = context.config.projects.filter(
      (entry) => marker && entry.projectId === marker.projectId,
    );
    if (
      !previous &&
      !options.projectPath &&
      new Set(await Promise.all(links.map((entry) => canonical(entry.path))))
        .size > 1
    )
      fail(
        'AMBIGUOUS_PROJECT',
        'This project ID has several memory locations. Select --project-path explicitly.',
      );
    const linked = links[0];
    const directory = await validateDirectory(
      inputPath(
        options.projectPath ??
          previous?.path ??
          linked?.path ??
          path.join(root, '.membrain', 'project'),
        context.cwd,
      ),
    );
    const identity = await storeIdentity(directory);
    if (
      identity &&
      (identity.scope !== 'project' ||
        typeof identity.projectId !== 'string' ||
        identity.sessionId !== undefined)
    )
      fail(
        'STORE_IDENTITY_MISMATCH',
        'The selected project location belongs to another scope.',
      );
    const ids = [
      options.projectId,
      previous?.projectId,
      marker?.projectId,
      identity?.projectId,
    ].filter((id): id is string => id !== undefined);
    if (new Set(ids).size > 1)
      fail(
        'PROJECT_ID_MISMATCH',
        'Project flag, mapping, marker, and existing memory must agree on the project ID. No identity or memory was overwritten.',
      );
    const projectId = ids[0] ?? randomUUID();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(projectId))
      fail(
        'INVALID_PROJECT_ID',
        'Project ID must be a portable identifier of at most 128 characters.',
      );
    const entry = {
      root,
      projectId,
      path: directory,
      sync: policy(
        'project',
        options,
        previous
          ? { ...previous, path: await canonical(previous.path) }
          : undefined,
        directory,
      ),
    };
    if (previous)
      candidate.projects[candidate.projects.indexOf(previous)] = entry;
    else candidate.projects.push(entry);
    plan.project = { root, projectId };
    if (options.projectMarker !== false) {
      const markerPath = path.join(root, '.membrain', 'project.json');
      if (markerPath === context.configPath)
        fail(
          'INVALID_PATH',
          'Configuration and project marker must be separate files.',
        );
      await validateDirectory(path.dirname(markerPath));
      if (
        (await canonical(path.dirname(markerPath))) !== path.dirname(markerPath)
      )
        fail(
          'UNSAFE_MARKER_PATH',
          'The .membrain marker directory cannot be redirected by a symlink.',
        );
      plan.marker = {
        path: markerPath,
        projectId,
        create: !marker,
        ...(marker ? { original: marker.bytes } : {}),
      };
    }
  }
  plan.config = parseConfig(candidate, context.configPath);
  const roots = [
    ...(plan.config.global
      ? [{ key: 'global', path: plan.config.global.path }]
      : []),
    ...plan.config.projects.map((entry) => ({
      key: `project:${entry.projectId}`,
      path: entry.path,
    })),
    ...(plan.config.session
      ? [{ key: 'session', path: plan.config.session.path }]
      : []),
  ];
  const resolved = await Promise.all(
    roots.map(async (entry) => ({
      ...entry,
      path: await canonical(entry.path),
    })),
  );
  for (let i = 0; i < resolved.length; i++)
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      if (a.key === b.key && a.path === b.path) continue;
      if (contains(a.path, b.path) || contains(b.path, a.path))
        fail(
          'OVERLAPPING_STORES',
          'Memory scope directories overlap, possibly through symlinks. Choose independent directories; a containing Git repository may be shared.',
        );
    }
  for (const entry of resolved) {
    if (
      contains(context.configPath, entry.path) ||
      (plan.marker && contains(plan.marker.path, entry.path))
    )
      fail(
        'INVALID_PATH',
        'A memory directory conflicts with the configuration or marker file path.',
      );
  }
  await validateDirectory(path.dirname(context.configPath));
  const directories = [
    path.dirname(context.configPath),
    ...resolved.map((entry) => entry.path),
    ...(plan.marker ? [path.dirname(plan.marker.path)] : []),
  ];
  for (const directory of [...new Set(directories)]) {
    await validateDirectory(directory);
    if (!(await exists(directory))) plan.directories.push(directory);
  }
  plan.configChanged =
    context.original === undefined ||
    JSON.stringify(plan.config) !== JSON.stringify(context.config);
  return plan;
}
