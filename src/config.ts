import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MembrainError } from './errors.js';

export type SyncPolicy =
  | { mode: 'local' }
  | { mode: 'manual'; remote?: string; branch?: string }
  | {
      mode: 'automatic';
      authorized: true;
      remote?: string;
      branch?: string;
    };

export interface StorageConfig {
  path: string;
  sync: SyncPolicy;
}

export interface ProjectConfig extends StorageConfig {
  projectId: string;
  root: string;
}

export interface Config {
  version: 1;
  global?: StorageConfig;
  projects: ProjectConfig[];
  session?: StorageConfig;
}

interface ConfigContext {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface LoadedConfig {
  configPath: string;
  configured: boolean;
  config: Config;
}

function invalid(field: string, reason: string): never {
  throw new MembrainError(
    'INVALID_CONFIG',
    `Configuration ${field}: ${reason}.`,
  );
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(field, 'contains unsupported keys');
  }
}

function string(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    invalid(field, 'must be a nonempty string without control characters');
  }
  return value;
}

function resolvePath(value: string, base: string, home: string): string {
  if (value === '~') return home;
  if (/^~[/\\]/u.test(value)) return path.resolve(home, value.slice(2));
  return path.resolve(base, value);
}

function syncPolicy(value: unknown, field: string): SyncPolicy {
  if (value === undefined) return { mode: 'local' };
  const record = object(value, field);
  if (record.mode === 'local') {
    keys(record, ['mode'], field);
    return { mode: 'local' };
  }
  if (record.mode !== 'manual' && record.mode !== 'automatic') {
    invalid(field, 'mode must be local, manual, or automatic');
  }
  keys(
    record,
    record.mode === 'automatic'
      ? ['mode', 'authorized', 'remote', 'branch']
      : ['mode', 'remote', 'branch'],
    field,
  );
  const target: { remote?: string; branch?: string } = {};
  if (record.remote !== undefined) {
    target.remote = string(record.remote, `${field}.remote`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(target.remote)) {
      invalid(`${field}.remote`, 'must be a Git remote name, not a URL');
    }
  }
  if (record.branch !== undefined) {
    target.branch = string(record.branch, `${field}.branch`);
    if (target.branch.startsWith('-')) {
      invalid(`${field}.branch`, 'must not start with a hyphen');
    }
  }
  if (record.mode === 'automatic') {
    if (record.authorized !== true) {
      invalid(field, 'automatic synchronization requires authorized: true');
    }
    return { mode: 'automatic', authorized: true, ...target };
  }
  return { mode: 'manual', ...target };
}

/** Read-only configuration schema; the engine owns scope discovery and memory writes. */
export function parseConfig(
  value: unknown,
  configPath: string,
  home = homedir(),
): Config {
  const record = object(value, 'root');
  keys(record, ['version', 'global', 'projects', 'session'], 'root');
  if (record.version !== 1)
    invalid('version', 'only schema version 1 is supported');
  const base = path.dirname(configPath);
  function storage(
    input: unknown,
    field: string,
    project = false,
  ): StorageConfig {
    const entry = object(input, field);
    keys(
      entry,
      project ? ['path', 'sync', 'root', 'projectId'] : ['path', 'sync'],
      field,
    );
    return {
      path: resolvePath(string(entry.path, `${field}.path`), base, home),
      sync: syncPolicy(entry.sync, `${field}.sync`),
    };
  }
  const config: Config = { version: 1, projects: [] };
  if (record.global !== undefined)
    config.global = storage(record.global, 'global');
  if (record.session !== undefined) {
    config.session = storage(record.session, 'session');
  }
  if (record.projects !== undefined) {
    if (!Array.isArray(record.projects))
      invalid('projects', 'must be an array');
    config.projects = record.projects.map((input: unknown, index: number) => {
      const field = `projects[${index}]`;
      const entry = object(input, field);
      const projectId = string(entry.projectId, `${field}.projectId`);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(projectId)) {
        invalid(`${field}.projectId`, 'must be a portable identifier');
      }
      return {
        ...storage(input, field, true),
        projectId,
        root: resolvePath(string(entry.root, `${field}.root`), base, home),
      };
    });
    const roots = config.projects.map((entry) =>
      process.platform === 'win32' ? entry.root.toLowerCase() : entry.root,
    );
    if (new Set(roots).size !== roots.length) {
      invalid('projects', 'project roots must be unique');
    }
  }
  return config;
}

export function resolveConfigPath(
  explicit?: string,
  context: ConfigContext = {},
): string {
  const cwd = context.cwd ?? process.cwd();
  const home = context.home ?? homedir();
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const override = explicit ?? env.MEMBRAIN_CONFIG;
  if (override !== undefined) {
    return resolvePath(string(override, 'path'), cwd, home);
  }
  const directory =
    platform === 'win32'
      ? path.resolve(env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : path.resolve(env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(directory, 'membrain', 'config.json');
}

export async function loadConfig(explicit?: string): Promise<LoadedConfig> {
  const configPath = resolveConfigPath(explicit);
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'ENOENT' &&
      explicit === undefined &&
      !process.env.MEMBRAIN_CONFIG
    ) {
      return {
        configPath,
        configured: false,
        config: { version: 1, projects: [] },
      };
    }
    throw new MembrainError(
      'CONFIG_READ_FAILED',
      `Cannot read configuration at ${configPath}. Check the path and permissions.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new MembrainError(
      'INVALID_CONFIG',
      `Configuration at ${configPath} is not valid JSON. Repair it before continuing.`,
    );
  }
  return {
    configPath,
    configured: true,
    config: parseConfig(value, configPath),
  };
}
