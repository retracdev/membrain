#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { loadConfig } from './config.js';
import { MembrainError } from './errors.js';
import { registerMemoryCommands } from './cli-memory.js';
import { registerInitCommand } from './cli-init.js';
import { registerSyncCommand } from './cli-sync.js';
import { registerSkillCommand } from './cli-skill.js';
import { errno } from './storage/files.js';

const metadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('membrain')
  .description(
    "Your agents change. Their memory shouldn't.\nLocal memory engine with optional Git synchronization.",
  )
  .version(metadata.version)
  .option('--config <path>', 'read configuration from this path')
  .option('--json', 'output data or errors as JSON (help/version remain text)')
  .showHelpAfterError()
  .exitOverride()
  .configureOutput({ writeErr: () => undefined });

program.action(() => {
  program.outputHelp();
});

program
  .command('status')
  .description('inspect configuration without creating files or invoking Git')
  .action(async () => {
    const options = program.opts<{ config?: string; json?: boolean }>();
    const loaded = await loadConfig(options.config);
    const result = {
      phase: 'synchronization',
      ...loaded,
      synchronization: 'available',
      skillExport: 'available',
    };
    if (options.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`Configuration: ${loaded.configPath}`);
    console.log(
      loaded.configured
        ? 'Configuration is valid.'
        : 'No configuration found; no scopes enabled.',
    );
    if (loaded.config.global) {
      console.log(
        `Global: ${loaded.config.global.path} (${loaded.config.global.sync.mode})`,
      );
    }
    for (const project of loaded.config.projects) {
      console.log(
        `Project ${project.projectId}: ${project.path} (${project.sync.mode})`,
      );
    }
    if (loaded.config.session) {
      console.log(
        `Session base: ${loaded.config.session.path} (${loaded.config.session.sync.mode})`,
      );
    }
    console.log(
      'Local memory engine ready. Optional Git synchronization and portable skill export are available. Skill installation and removal are manual.',
    );
  });

const planned = [['doctor', 'diagnose storage and integrations']] as const;

registerMemoryCommands(program);
registerInitCommand(program);
registerSyncCommand(program);
registerSkillCommand(program);

for (const [name, description] of planned) {
  program
    .command(name)
    .argument('[arguments...]')
    .description(`${description} (planned)`)
    .action(() => {
      throw new MembrainError(
        'NOT_IMPLEMENTED',
        `${name} is deferred to a separately scoped diagnostic task. See docs/implementation-plan.md.`,
      );
    });
}

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const failure =
      error instanceof MembrainError
        ? error
        : error instanceof CommanderError
          ? new MembrainError(
              'USAGE_ERROR',
              `${error.message}\nRun membrain --help.`,
              2,
            )
          : errno(error)?.startsWith('E')
            ? new MembrainError(
                'FILESYSTEM_ERROR',
                'Local filesystem operation failed. Check storage/cache paths, permissions, free space, and hard-link support. Inspect complete revisions before retrying with the same operation ID.',
              )
            : new MembrainError(
                'INTERNAL_ERROR',
                'Unexpected failure. Run again or report a reproducible issue.',
              );
    if (
      program.opts<{ json?: boolean }>().json ||
      process.argv.includes('--json')
    ) {
      console.error(
        JSON.stringify({
          error: { code: failure.code, message: failure.message },
        }),
      );
    } else {
      console.error(`${failure.code}: ${failure.message}`);
    }
    process.exitCode = failure.exitCode;
  }
}
