import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Config, ProjectConfig } from '../config.js';
import { canonical, contains, errno } from '../storage/files.js';
import { choice, fail, isObject, scopes, text } from './model.js';
import type { Scope } from './model.js';

export interface Selection {
  scope?: string;
  project?: string;
  session?: string;
  allProjects?: boolean;
}
export interface Location {
  path: string;
  scope: Scope;
  projectId?: string;
  sessionId?: string;
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function currentProject(
  config: Config,
  cwd: string,
  explicit?: string,
): Promise<ProjectConfig | undefined> {
  const mappings = await Promise.all(
    config.projects.map(async (entry) => ({
      ...entry,
      root: await canonical(entry.root),
      path: await canonical(entry.path),
    })),
  );
  if (explicit !== undefined) {
    const matches = mappings.filter((entry) => entry.projectId === explicit);
    if (!matches.length)
      fail(
        'UNKNOWN_PROJECT',
        'The selected project ID is not configured. Add a project mapping before continuing.',
      );
    if (new Set(matches.map((entry) => entry.path)).size > 1)
      fail(
        'AMBIGUOUS_PROJECT',
        'This project ID maps to multiple memory stores. Correct its configuration.',
      );
    return matches[0];
  }
  const directory = await canonical(cwd);
  let cursor = directory;
  let boundary: string | undefined;
  let marker: string | undefined;
  while (true) {
    const markerPath = path.join(cursor, '.membrain', 'project.json');
    if (await exists(markerPath)) {
      try {
        const value: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
        if (
          !isObject(value) ||
          value.schemaVersion !== 1 ||
          typeof value.projectId !== 'string'
        )
          fail('INVALID_PROJECT_MARKER', 'Invalid project marker.');
        marker = value.projectId;
      } catch {
        fail(
          'INVALID_PROJECT_MARKER',
          `Invalid project marker at ${markerPath}.`,
        );
      }
      boundary = cursor;
      break;
    }
    if (await exists(path.join(cursor, '.git'))) {
      boundary = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (cursor === parent) break;
    cursor = parent;
  }
  const candidates = mappings.filter(
    (entry) =>
      contains(entry.root, directory) &&
      (!boundary || contains(boundary, entry.root)),
  );
  candidates.sort((a, b) => b.root.length - a.root.length);
  if (candidates[0]) {
    if (marker && candidates[0].projectId !== marker)
      fail(
        'INVALID_PROJECT_MARKER',
        'Project marker and local project mapping disagree. Correct the mapping before accessing memory.',
      );
    return candidates[0];
  }
  if (marker) return currentProject(config, cwd, marker);
  return undefined;
}

async function checkRoots(config: Config): Promise<void> {
  const entries = [
    ...(config.global ? [{ path: config.global.path, key: 'global' }] : []),
    ...config.projects.map((entry) => ({
      path: entry.path,
      key: `project:${entry.projectId}`,
    })),
    ...(config.session ? [{ path: config.session.path, key: 'session' }] : []),
  ];
  const resolved = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      path: await canonical(entry.path),
    })),
  );
  for (let i = 0; i < resolved.length; i++)
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      if (a.path === b.path && a.key === b.key) continue;
      if (contains(a.path, b.path) || contains(b.path, a.path))
        fail(
          'OVERLAPPING_STORES',
          'Configured scope storage paths overlap (possibly through symlinks). Use independent storage directories.',
        );
    }
}
function sessionLocation(
  base: string,
  projectId: string | undefined,
  sessionId: string,
): Location {
  text(sessionId, 'sessionId');
  const hash = (input: string) =>
    createHash('sha256').update(input).digest('hex');
  return {
    path: path.join(
      base,
      projectId ? `project-${hash(projectId)}` : 'global',
      hash(sessionId),
    ),
    scope: 'session',
    ...(projectId ? { projectId } : {}),
    sessionId,
  };
}

export async function selectLocations(
  config: Config,
  options: Selection,
  cwd: string,
  write = false,
): Promise<Location[]> {
  await checkRoots(config);
  if (options.allProjects && (write || options.project))
    fail(
      'INVALID_SELECTION',
      '--all-projects is read-only and cannot be combined with --project.',
    );
  const scope =
    options.scope === undefined
      ? undefined
      : choice(options.scope, scopes, 'scope');
  if (
    options.session !== undefined &&
    scope !== undefined &&
    scope !== 'session'
  )
    fail(
      'INVALID_SELECTION',
      '--session requires session scope or the default multi-scope read.',
    );
  const project = await currentProject(config, cwd, options.project);
  if (write && scope === undefined && !project)
    fail(
      'SCOPE_REQUIRED',
      'Outside a configured project, choose --scope global or --scope session explicitly.',
    );
  const selectedScope = write ? (scope ?? 'project') : scope;
  const locations: Location[] = [];
  if ((!selectedScope || selectedScope === 'global') && config.global)
    locations.push({
      path: await canonical(config.global.path),
      scope: 'global',
    });
  if (!selectedScope || selectedScope === 'project') {
    const projects = options.allProjects
      ? config.projects
      : project
        ? [project]
        : [];
    for (const entry of projects)
      locations.push({
        path: await canonical(entry.path),
        scope: 'project',
        projectId: entry.projectId,
      });
  }
  if (
    (!selectedScope || selectedScope === 'session') &&
    options.session &&
    config.session
  ) {
    const projects = options.allProjects
      ? [...new Set(config.projects.map((entry) => entry.projectId))]
      : [project?.projectId];
    for (const id of projects) {
      const location = sessionLocation(
        await canonical(config.session.path),
        id,
        options.session,
      );
      location.path = await canonical(location.path);
      // Reject a symlink partition that escapes its configured base.
      if (!contains(await canonical(config.session.path), location.path))
        fail(
          'UNSAFE_PATH',
          'Session partition escapes the configured session directory.',
        );
      locations.push(location);
    }
  }
  if (selectedScope === 'session' && !options.session)
    fail(
      'SESSION_REQUIRED',
      'Choose --session ID; session memory is never selected implicitly.',
    );
  const unique = [
    ...new Map(locations.map((entry) => [entry.path, entry])).values(),
  ];
  if (write && unique.length !== 1)
    fail(
      'SCOPE_NOT_CONFIGURED',
      'The selected memory scope is not configured. Add its storage path to the configuration.',
    );
  if (!write && selectedScope && !unique.length)
    fail(
      'SCOPE_NOT_CONFIGURED',
      'The selected scope or project is not configured.',
    );
  return unique;
}
