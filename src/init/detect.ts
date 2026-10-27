import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonical, contains, errno } from '../storage/files.js';
import { fail, isObject } from '../engine/model.js';
import type { Config } from '../config.js';

export interface ProjectDetection {
  root: string;
  kind: 'git' | 'marker' | 'configured' | 'directory';
  projectId?: string;
}
export interface AgentDetection {
  name: string;
  detected: boolean;
  evidence: string[];
  integration: 'unavailable';
  note: string;
}
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
}
export async function readMarker(
  root: string,
): Promise<{ projectId: string; bytes: string } | undefined> {
  const filename = path.join(root, '.membrain', 'project.json');
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      fail(
        'INVALID_PROJECT_MARKER',
        `Project marker must be a small regular file at ${filename}.`,
      );
    const bytes = await readFile(filename, 'utf8');
    const value: unknown = JSON.parse(bytes);
    if (
      !isObject(value) ||
      value.schemaVersion !== 1 ||
      typeof value.projectId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.projectId) ||
      Object.keys(value).some(
        (key) => !['schemaVersion', 'projectId'].includes(key),
      )
    )
      fail(
        'INVALID_PROJECT_MARKER',
        `Invalid project marker at ${filename}. Preserve it and correct it manually.`,
      );
    return { projectId: value.projectId, bytes };
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    if (error instanceof SyntaxError)
      fail(
        'INVALID_PROJECT_MARKER',
        `Project marker is not valid JSON at ${filename}. It was not modified.`,
      );
    throw error;
  }
}
export async function detectProject(
  config: Config,
  cwd: string,
): Promise<ProjectDetection> {
  const directory = await canonical(cwd);
  const mappings = await Promise.all(
    config.projects.map(async (entry) => ({
      ...entry,
      root: await canonical(entry.root),
    })),
  );
  let cursor = directory;
  while (true) {
    const marker = await readMarker(cursor);
    const git = await exists(path.join(cursor, '.git'));
    const matches = mappings
      .filter(
        (entry) =>
          contains(entry.root, directory) && contains(cursor, entry.root),
      )
      .sort((a, b) => b.root.length - a.root.length);
    if (marker || git) {
      const match = matches[0];
      if (match && marker && match.projectId !== marker.projectId)
        fail(
          'INVALID_PROJECT_MARKER',
          'Project marker and configured project disagree; review them before initialization.',
        );
      return {
        root: match?.root ?? cursor,
        kind: git ? 'git' : 'marker',
        ...(match?.projectId || marker?.projectId
          ? { projectId: match?.projectId ?? marker!.projectId }
          : {}),
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const match = mappings
    .filter((entry) => contains(entry.root, directory))
    .sort((a, b) => b.root.length - a.root.length)[0];
  return match
    ? { root: match.root, kind: 'configured', projectId: match.projectId }
    : { root: directory, kind: 'directory' };
}

export async function detectAgents(
  context: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<AgentDetection[]> {
  const env = context.env ?? process.env;
  const home = context.home ?? homedir();
  const platform = context.platform ?? process.platform;
  const results: AgentDetection[] = [];
  for (const [name, command, footprint] of [
    ['Claude Code', 'claude', '.claude'],
    ['Codex', 'codex', '.codex'],
  ] as const) {
    const evidence: string[] = [];
    const extensions =
      platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
    for (const directory of (env.PATH ?? '')
      .split(platform === 'win32' ? ';' : ':')
      .filter(Boolean)) {
      for (const extension of extensions) {
        const filename = path.join(
          directory.replace(/^"|"$/gu, ''),
          `${command}${extension}`,
        );
        try {
          const stat = await lstat(filename);
          if (!stat.isFile() && !stat.isSymbolicLink()) continue;
          await access(
            filename,
            platform === 'win32' ? constants.F_OK : constants.X_OK,
          );
          evidence.push('executable found on PATH');
          break;
        } catch {
          /* an unreadable/missing candidate is not an installation */
        }
      }
      if (evidence.length) break;
    }
    const override =
      command === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR;
    try {
      if ((await lstat(override || path.join(home, footprint))).isDirectory())
        evidence.push(
          'configuration directory present (installation hint only)',
        );
    } catch {
      /* optional hint */
    }
    results.push({
      name,
      detected: evidence.length > 0,
      evidence,
      integration: 'unavailable',
      note: 'Portable skill export is available through membrain skill export --output DIRECTORY. Managed installation is unavailable; nothing will be installed.',
    });
  }
  results.push({
    name: 'T3 Code',
    detected: Boolean(env.T3_ACP_MCP_NODE),
    evidence: env.T3_ACP_MCP_NODE
      ? [
          'T3 runtime transport hint present (not an installation/version check)',
        ]
      : [],
    integration: 'unavailable',
    note: 'No reliable standalone installation probe. Use the CLI or manually review the portable skill; no agent-specific integration is installed.',
  });
  return results;
}
