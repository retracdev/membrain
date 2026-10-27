import type { Command } from 'commander';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import type { Selection } from './engine/scopes.js';
import type { Revision, Warning } from './engine/model.js';
import type { Saved } from './engine/engine.js';
import { synchronizeMemories } from './sync/sync.js';
import type { SyncReport } from './sync/sync.js';

export function registerSyncCommand(program: Command): void {
  const command = program
    .command('sync')
    .description(
      'synchronize explicitly selected manual/authorized scopes using existing Git repositories',
    )
    .option(
      '--scope <scope>',
      'global, project, or session; explicit local scopes fail without Git',
    )
    .option('--project <id>', 'select a configured project')
    .option(
      '--session <id>',
      'one explicit isolated session; never all sessions',
    )
    .option(
      '--all-projects',
      'explicitly include all configured projects (cannot combine with --project)',
    );
  command.addHelpText(
    'after',
    '\nDefault: global and current project; local scopes are skipped. Sessions require --session.\nUnrelated dirty/staged files or outgoing history stop sync without stashing/resetting.\nNo repository initialization, force push, hooks or background service. Existing Git credentials are used non-interactively.',
  );
  command.action(async () => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const report = await synchronizeMemories(
        (await loadConfig(program.opts<{ config?: string }>().config)).config,
        command.opts<Selection>(),
        process.cwd(),
        { signal: controller.signal },
      );
      console.log(
        JSON.stringify(
          report,
          null,
          program.opts<{ json?: boolean }>().json ? undefined : 2,
        ),
      );
      if (!report.ok) process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  });
}

export async function automaticAfterMutation(
  config: Config,
  data: Saved | { records: Revision[]; warnings: Warning[] },
): Promise<unknown> {
  if (
    'record' in data &&
    (data.replayed || (data.deduplicated && !data.record.operationId))
  )
    return data;
  const records = 'record' in data ? [data.record] : data.records;
  const reports: SyncReport[] = [];
  const selected = new Set<string>();
  for (const record of records) {
    const policies =
      record.scope === 'global'
        ? [config.global?.sync]
        : record.scope === 'session'
          ? [config.session?.sync]
          : config.projects
              .filter((entry) => entry.projectId === record.projectId)
              .map((entry) => entry.sync);
    if (!policies.some((policy) => policy?.mode === 'automatic')) continue;
    const selection: Selection = {
      scope: record.scope,
      ...(record.projectId ? { project: record.projectId } : {}),
      ...(record.sessionId ? { session: record.sessionId } : {}),
    };
    const key = JSON.stringify(selection);
    if (selected.has(key)) continue;
    selected.add(key);
    try {
      reports.push(
        await synchronizeMemories(config, selection, process.cwd(), {
          trigger: 'automatic',
        }),
      );
    } catch {
      reports.push({
        ok: false,
        trigger: 'automatic',
        results: [
          {
            scopes: [],
            stage: 'selection',
            status: 'pending',
            code: 'AUTO_SYNC_PENDING',
            message:
              'Memory was saved locally. Automatic synchronization could not select/validate its scope; review configuration and retry explicit sync.',
          },
        ],
      });
    }
  }
  if (!reports.length) return data;
  return {
    ...data,
    synchronization: reports,
    warnings: [
      ...data.warnings,
      ...(reports.some((report) => !report.ok)
        ? [
            {
              code: 'SYNC_PENDING',
              message:
                'Memory was saved locally; automatic Git synchronization is pending. Inspect synchronization results and retry membrain sync after addressing the reported issue.',
            },
          ]
        : []),
    ],
  };
}
