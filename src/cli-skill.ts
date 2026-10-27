import type { Command } from 'commander';
import { exportSkill } from './skill.js';

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description(
      'export the optional portable skill without editing agent settings',
    );
  skill.action(() => {
    skill.outputHelp();
  });
  skill
    .command('export')
    .description('write only SKILL.md into an explicitly selected directory')
    .requiredOption(
      '--output <directory>',
      'destination skill directory (no default; creates missing directories)',
    )
    .option(
      '--overwrite',
      'explicitly permit replacing a different SKILL.md; other files are untouched',
    )
    .addHelpText(
      'after',
      '\nExample: membrain skill export --output ./exported/membrain --json\nReview the exported file and install it manually if desired. No agents are detected or configured.',
    )
    .action(async (options: { output: string; overwrite?: boolean }) => {
      const result = await exportSkill(options.output, options.overwrite);
      if (program.opts<{ json?: boolean }>().json)
        console.log(JSON.stringify(result));
      else
        console.log(
          `Skill ${result.status}: ${result.path}\nOnly SKILL.md was exported. No agent settings or hooks were changed.\nReview before use; agents may discover files placed in their skill directories.`,
        );
    });
}
