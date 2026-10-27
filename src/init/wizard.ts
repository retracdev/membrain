import { MembrainError } from '../errors.js';
import path from 'node:path';
import type { StorageConfig } from '../config.js';
import { buildInitPlan, defaultPaths, scopeNames } from './plan.js';
import type { InitContext, InitOptions, InitPlan, ScopeName } from './plan.js';
import { inputPath, validateDirectory } from './paths.js';
import { applyInitPlan, previewResult } from './persist.js';
import type { InitResult } from './persist.js';
import { canonical } from '../storage/files.js';
import { readMarker } from './detect.js';

export interface InitPrompts {
  note(message: string): void;
  scopes(defaults: ScopeName[]): Promise<ScopeName[]>;
  input(
    message: string,
    defaultValue: string,
    validate?: (value: string) => Promise<true | string>,
  ): Promise<string>;
  select(
    message: string,
    choices: { value: string; name: string }[],
    defaultValue: string,
  ): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
}
export async function terminalPrompts(
  context: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    signal?: AbortSignal;
  } = {
    output: process.stderr,
  },
): Promise<InitPrompts> {
  const { checkbox, input, select, confirm } =
    await import('@inquirer/prompts');
  return {
    note: (message) => {
      (context.output ?? process.stderr).write(`${message}\n`);
    },
    scopes: (defaults) =>
      checkbox(
        {
          message:
            'Which memory scopes would you like to configure? Skipped scopes are kept.',
          choices: scopeNames.map((value) => ({
            value,
            name:
              value === 'global'
                ? 'Global — preferences and knowledge across projects'
                : value === 'project'
                  ? 'Project — decisions and context for this codebase'
                  : 'Session — temporary, isolated task context',
            checked: defaults.includes(value),
          })),
        },
        context,
      ),
    input: (message, defaultValue, validate) =>
      input(
        { message, default: defaultValue, ...(validate ? { validate } : {}) },
        context,
      ),
    select: (message, choices, defaultValue) =>
      select({ message, choices, default: defaultValue }, context),
    confirm: (message, defaultValue) =>
      confirm({ message, default: defaultValue }, context),
  };
}
export function setupSummary(plan: InitPlan): string {
  const describe = (storage: StorageConfig) => {
    const sync = storage.sync;
    return sync.mode === 'local'
      ? 'local'
      : `${sync.mode}; remote: ${sync.remote ?? 'none (commit-only)'}; branch: ${sync.branch ?? 'current branch (no remote)'}${sync.mode === 'automatic' ? '; authorization recorded' : ''}`;
  };
  const lines = [
    `Configuration: ${plan.context.configPath}`,
    plan.context.original === undefined
      ? 'Create a new configuration.'
      : plan.configChanged
        ? 'Replace this configuration after confirmation; keep an exact backup.'
        : 'Keep existing configuration bytes unchanged.',
  ];
  if (plan.config.global)
    lines.push(
      `Global: ${plan.config.global.path} (${describe(plan.config.global)})`,
    );
  for (const entry of plan.config.projects)
    lines.push(
      `Project ${entry.projectId}: ${entry.root} → ${entry.path} (${describe(entry)})`,
    );
  if (plan.config.session)
    lines.push(
      `Session base: ${plan.config.session.path} (${describe(plan.config.session)}); IDs remain explicit.`,
    );
  if (plan.marker)
    lines.push(
      `${plan.marker.create ? 'Create' : 'Keep'} project marker: ${plan.marker.path}`,
    );
  if (plan.directories.length)
    lines.push(
      `Create directories (including missing parents):\n${plan.directories.map((item) => `  ${item}`).join('\n')}`,
    );
  lines.push(
    'Init itself runs no Git commands and creates no repositories, commits, pushes, or agent files. Automatic scopes can synchronize after subsequent memory mutations.',
  );
  return lines.join('\n');
}
function previousScope(
  context: InitContext,
  scope: ScopeName,
): StorageConfig | undefined {
  return scope === 'project'
    ? (context.config.projects.find(
        (entry) => entry.root === context.project.root,
      ) ??
        context.config.projects.find(
          (entry) => entry.projectId === context.project.projectId,
        ))
    : context.config[scope];
}
async function choosePolicy(
  ui: InitPrompts,
  scope: ScopeName,
  options: InitOptions,
  previous: StorageConfig | undefined,
): Promise<void> {
  const mode = await ui.select(
    `${scope}: how should Membrain manage Git?`,
    [
      {
        value: 'local',
        name: 'Local only — Membrain never manages Git (default)',
      },
      {
        value: 'manual',
        name: 'Manual — only an explicit sync command',
      },
      {
        value: 'automatic',
        name: 'Automatic — after memory mutations; explicit authorization required',
      },
    ],
    options[`${scope}Sync`] ?? previous?.sync.mode ?? 'local',
  );
  options[`${scope}Sync`] = mode;
  if (mode === 'local') {
    delete options[`${scope}Remote`];
    delete options[`${scope}Branch`];
    return;
  }
  ui.note(
    'Git sharing can expose sensitive context; deletion does not erase Git history. Only immutable source/owned marker files are managed; hooks and content filters are disabled/rejected. Remote sync uses existing Git authentication without prompts. Repositories must already exist.',
  );
  const old = previous?.sync.mode === 'local' ? undefined : previous?.sync;
  const remote = await ui.input(
    `${scope}: existing Git remote name (leave blank for commit-only use)`,
    options[`${scope}Remote`] ?? old?.remote ?? '',
  );
  options[`${scope}Remote`] = remote;
  options[`${scope}Branch`] = await ui.input(
    `${scope}: branch${remote.trim() ? ' (required with a remote)' : ' (optional)'}`,
    options[`${scope}Branch`] ?? old?.branch ?? '',
  );
  if (mode === 'automatic') {
    const authorized =
      scope === 'global'
        ? options.authorizeGlobalAutoSync
        : scope === 'project'
          ? options.authorizeProjectAutoSync
          : options.authorizeSessionAutoSync;
    const same =
      previous?.sync.mode === 'automatic' &&
      previous.path === options[`${scope}Path`] &&
      previous.sync.remote === (remote.trim() || undefined) &&
      previous.sync.branch === (options[`${scope}Branch`]?.trim() || undefined);
    if (!authorized && !same) {
      const consent = await ui.confirm(
        `Authorize automatic Git commits/synchronization after memory mutations for this ${scope} location and target?`,
        false,
      );
      if (!consent) {
        ui.note(
          'Automatic synchronization was not authorized. Choose local or manual instead.',
        );
        return choosePolicy(ui, scope, options, previous);
      }
      if (scope === 'global') options.authorizeGlobalAutoSync = true;
      else if (scope === 'project') options.authorizeProjectAutoSync = true;
      else options.authorizeSessionAutoSync = true;
    }
  }
}
export async function runWizard(
  context: InitContext,
  flags: InitOptions,
  ui: InitPrompts,
): Promise<InitResult> {
  ui.note(
    `Membrain setup\nYour agents change. Their memory shouldn't.\n${context.original === undefined ? 'No existing configuration found.' : 'Existing configuration found; memories and unselected scopes will be preserved.'}`,
  );
  ui.note(
    `Detected project: ${context.project.root} (${context.project.kind}).`,
  );
  ui.note(
    `Agents: ${context.agents.map((agent) => `${agent.name}: ${agent.detected ? 'detected hint' : 'not detected'}`).join('; ')}.\nIntegrations are not available for managed installation; nothing will be installed. Portable skill export is a separate explicit command.`,
  );
  const defaults = defaultPaths(context);
  const baseDefaults: ScopeName[] =
    context.original === undefined
      ? ['global', 'project']
      : scopeNames.filter((scope) => Boolean(previousScope(context, scope)));
  const answers: InitOptions = { ...flags };
  while (true) {
    for (const key of [
      'authorizeGlobalAutoSync',
      'authorizeProjectAutoSync',
      'authorizeSessionAutoSync',
    ] as const) {
      delete answers[key];
      if (flags[key]) answers[key] = true;
    }
    const selected = await ui.scopes(baseDefaults);
    for (const scope of scopeNames) {
      delete answers[scope];
      if (!selected.includes(scope)) {
        delete answers[`${scope}Path`];
        delete answers[`${scope}Sync`];
        delete answers[`${scope}Remote`];
        delete answers[`${scope}Branch`];
        if (scope === 'project') {
          delete answers.projectRoot;
          delete answers.projectId;
        }
        continue;
      }
      answers[scope] = true;
      let previous = previousScope(context, scope);
      let suggested = defaults[scope];
      if (scope === 'project') {
        const priorRoot = answers.projectRoot ?? context.project.root;
        answers.projectRoot = await ui.input(
          'Project root — confirm the codebase you intend to configure',
          answers.projectRoot ?? context.project.root,
          async (value) => {
            try {
              await validateDirectory(inputPath(value, context.cwd), true);
              return true;
            } catch (error) {
              return error instanceof Error
                ? error.message
                : 'Choose an existing writable project directory.';
            }
          },
        );
        answers.projectRoot = await canonical(
          inputPath(answers.projectRoot, context.cwd),
        );
        if (
          answers.projectRoot !==
          (await canonical(inputPath(priorRoot, context.cwd)))
        ) {
          for (const suffix of ['Path', 'Sync', 'Remote', 'Branch'] as const) {
            const key = `project${suffix}` as const;
            delete answers[key];
            if (flags[key] !== undefined) answers[key] = flags[key];
          }
        }
        previous = undefined;
        for (const entry of context.config.projects)
          if ((await canonical(entry.root)) === answers.projectRoot) {
            previous = entry;
            break;
          }
        const marker = await readMarker(answers.projectRoot);
        const linked = context.config.projects.filter(
          (entry) => marker && entry.projectId === marker.projectId,
        );
        if (
          !previous &&
          new Set(
            await Promise.all(linked.map((entry) => canonical(entry.path))),
          ).size > 1
        ) {
          ui.note(
            'This project ID has multiple memory locations. Review the project path explicitly.',
          );
        }
        suggested =
          previous?.path ??
          linked[0]?.path ??
          path.join(answers.projectRoot, '.membrain', 'project');
      }
      answers[`${scope}Path`] = await ui.input(
        `${scope}: memory storage directory`,
        answers[`${scope}Path`] ?? suggested,
        async (value) => {
          try {
            await validateDirectory(inputPath(value, context.cwd));
            return true;
          } catch (error) {
            return error instanceof Error
              ? error.message
              : 'Choose a writable directory.';
          }
        },
      );
      answers[`${scope}Path`] = await canonical(
        inputPath(answers[`${scope}Path`]!, context.cwd),
      );
      await choosePolicy(ui, scope, answers, previous);
    }
    if (selected.includes('project'))
      answers.projectMarker =
        flags.projectMarker === false
          ? false
          : await ui.confirm(
              'Create/keep a portable .membrain/project.json marker? It stores only the project ID.',
              true,
            );
    let plan: InitPlan;
    try {
      plan = await buildInitPlan(context, answers);
    } catch (error) {
      if (!(error instanceof MembrainError)) throw error;
      ui.note(error.message);
      if (await ui.confirm('Review setup choices again?', true)) continue;
      return {
        status: 'cancelled',
        configPath: context.configPath,
        config: context.config,
        agents: context.agents,
        createdDirectories: [],
        createdFiles: [],
        synchronization: 'available',
        integrations: 'not-available',
      };
    }
    ui.note(`\nReview setup\n${setupSummary(plan)}`);
    if (flags.dryRun) return previewResult(plan);
    let overwrite = flags.overwriteConfig ?? false;
    if (plan.configChanged && context.original !== undefined && !overwrite) {
      overwrite = await ui.confirm(
        'Replace the existing configuration with these exact changes and keep an exact backup?',
        false,
      );
      if (!overwrite)
        return {
          ...previewResult(plan, 'cancelled'),
          config: context.config,
          createdDirectories: [],
          createdFiles: [],
        };
    } else if (!flags.yes && !(await ui.confirm('Save this setup?', true)))
      return {
        ...previewResult(plan, 'cancelled'),
        config: context.config,
        createdDirectories: [],
        createdFiles: [],
      };
    return applyInitPlan(plan, overwrite);
  }
}
