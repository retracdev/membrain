import type { Command } from 'commander';
import { MembrainError } from './errors.js';
import { fail } from './engine/model.js';
import { initContext, buildInitPlan, scopeNames } from './init/plan.js';
import type { InitOptions } from './init/plan.js';
import { applyInitPlan, previewResult } from './init/persist.js';
import { runWizard, setupSummary, terminalPrompts } from './init/wizard.js';
import type { InitResult } from './init/persist.js';

export function registerInitCommand(program: Command): void {
  const command = program
    .command('init')
    .description(
      'configure memory scopes, locations, and optional sync policies safely',
    )
    .option('--non-interactive', 'configure using flags; never prompt')
    .option(
      '--yes',
      'accept safe final defaults; never grants overwrite or automatic-sync permission',
    )
    .option(
      '--overwrite-config',
      'explicitly authorize replacing the reviewed existing config; keeps an exact backup',
    )
    .option(
      '--dry-run',
      'validate and preview without writing files/directories',
    )
    .option(
      '--project-root <path>',
      'existing codebase root (required for new non-Git projects in automation)',
    )
    .option(
      '--project-id <id>',
      'explicit stable project ID; must agree with existing memory/marker',
    )
    .option(
      '--no-project-marker',
      'keep the mapping local; do not create a project marker',
    );
  for (const scope of scopeNames) {
    command
      .option(
        `--${scope}`,
        `configure ${scope} memory at its current/suggested location`,
      )
      .option(
        `--${scope}-path <path>`,
        `configure a custom ${scope} memory location`,
      )
      .option(
        `--${scope}-sync <mode>`,
        `${scope} policy: local (default), manual, automatic`,
      )
      .option(
        `--${scope}-remote <name>`,
        `existing Git remote name for ${scope} sync; empty means commit-only`,
      )
      .option(
        `--${scope}-branch <name>`,
        `${scope} sync branch (required with a remote; must be checked out)`,
      )
      .option(
        `--authorize-${scope}-auto-sync`,
        `explicitly authorize automatic sync of this ${scope} location/target`,
      );
  }
  command.addHelpText(
    'after',
    '\nExamples:\n  membrain init\n  membrain init --non-interactive --global-path ~/fleet/memory --session\n  membrain init --non-interactive --project-root ./my-project --project-path ./memory --dry-run\n\nExisting scopes and memories are preserved. --yes does not select scopes, overwrite config, or authorize automatic sync. No Git commands or agent integration writes run.',
  );
  command.action(async () => {
    const flags = command.opts<InitOptions>();
    if (
      !flags.nonInteractive &&
      (!process.stdin.isTTY || !process.stderr.isTTY)
    )
      fail(
        'INIT_REQUIRES_TTY',
        'Interactive init needs a terminal. For agents/pipes use --non-interactive and explicit scope/path flags; --yes alone does not choose scopes.',
      );
    const context = await initContext(
      program.opts<{ config?: string }>().config,
    );
    let result: InitResult;
    if (flags.nonInteractive) {
      const plan = await buildInitPlan(context, flags);
      result = flags.dryRun
        ? previewResult(plan)
        : await applyInitPlan(plan, flags.overwriteConfig ?? false);
      if (!program.opts<{ json?: boolean }>().json)
        console.log(setupSummary(plan));
    } else {
      try {
        result = await runWizard(context, flags, await terminalPrompts());
      } catch (error) {
        if (
          error instanceof Error &&
          ['ExitPromptError', 'AbortPromptError', 'CancelPromptError'].includes(
            error.name,
          )
        )
          throw new MembrainError(
            'INIT_CANCELLED',
            'Setup was cancelled before applying the reviewed configuration.',
            130,
          );
        throw error;
      }
    }
    if (program.opts<{ json?: boolean }>().json)
      console.log(JSON.stringify(result));
    else {
      console.log(
        `\nSetup ${result.status}. Configuration: ${result.configPath}`,
      );
      if (result.backupPath)
        console.log(`Previous configuration backup: ${result.backupPath}`);
      for (const agent of result.agents)
        console.log(
          `${agent.name}: ${agent.detected ? 'detection hint found' : 'not detected'}; managed integration installation unavailable.`,
        );
      console.log(
        'Session IDs stay explicit. Init performs no synchronization or integration installation. Use skill export --output DIRECTORY separately to review the optional skill.',
      );
    }
  });
}
