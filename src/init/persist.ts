import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  errno,
  flushDirectory,
  publish,
  safeDirectory,
  withLock,
} from '../storage/files.js';
import { fail } from '../engine/model.js';
import type { InitPlan } from './plan.js';

export interface InitResult {
  status: 'initialized' | 'unchanged' | 'dry-run' | 'cancelled';
  configPath: string;
  config: InitPlan['config'];
  agents: InitPlan['context']['agents'];
  project?: InitPlan['project'];
  createdDirectories: string[];
  createdFiles: string[];
  backupPath?: string;
  synchronization: 'available';
  integrations: 'not-available';
}
export function previewResult(
  plan: InitPlan,
  status: InitResult['status'] = 'dry-run',
): InitResult {
  return {
    status,
    configPath: plan.context.configPath,
    config: plan.config,
    agents: plan.context.agents,
    ...(plan.project ? { project: plan.project } : {}),
    createdDirectories: plan.directories,
    createdFiles: [
      ...(plan.configChanged ? [plan.context.configPath] : []),
      ...(plan.marker?.create ? [plan.marker.path] : []),
    ],
    synchronization: 'available',
    integrations: 'not-available',
  };
}
async function currentBytes(filename: string): Promise<string | undefined> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(
        'CONFIG_CHANGED',
        `A configuration/marker target changed type at ${filename}. Review it and run init again.`,
      );
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}
async function writableProbe(directory: string): Promise<void> {
  const filename = path.join(directory, `.${randomUUID()}.membrain-tmp`);
  let owned = false;
  try {
    await publish(filename, '');
    owned = true;
  } finally {
    if (owned) await unlink(filename).catch(() => undefined);
  }
}
export async function applyInitPlan(
  plan: InitPlan,
  overwrite = false,
): Promise<InitResult> {
  if (plan.configChanged && plan.context.original !== undefined && !overwrite)
    fail(
      'OVERWRITE_CONFIRMATION_REQUIRED',
      'Changing an existing configuration requires --overwrite-config in non-interactive mode, or explicit confirmation of the interactive preview. --yes is not overwrite permission.',
    );
  const result = previewResult(plan, 'unchanged');
  result.createdDirectories = [];
  result.createdFiles = [];
  const parent = path.dirname(plan.context.configPath);
  await safeDirectory(parent);
  return withLock(parent, async (assertOwned) => {
    if ((await currentBytes(plan.context.configPath)) !== plan.context.original)
      fail(
        'CONFIG_CHANGED',
        'Configuration changed after the setup preview. Nothing was overwritten; run init again to review the new configuration.',
      );
    if (
      plan.marker &&
      (await currentBytes(plan.marker.path)) !== plan.marker.original
    )
      fail(
        'PROJECT_MARKER_CHANGED',
        'Project marker changed after the setup preview. It was preserved; run init again.',
      );
    try {
      for (const directory of plan.directories) {
        await safeDirectory(directory);
        result.createdDirectories.push(directory);
      }
      const probes = [
        parent,
        ...(plan.config.global ? [plan.config.global.path] : []),
        ...plan.config.projects.map((entry) => entry.path),
        ...(plan.config.session ? [plan.config.session.path] : []),
        ...(plan.marker ? [path.dirname(plan.marker.path)] : []),
      ];
      for (const directory of [...new Set(probes)])
        await writableProbe(directory);
      await assertOwned();
      if (plan.marker?.create) {
        await publish(
          plan.marker.path,
          `${JSON.stringify({ schemaVersion: 1, projectId: plan.marker.projectId }, null, 2)}\n`,
        );
        result.createdFiles.push(plan.marker.path);
      }
      if (plan.configChanged) {
        if (
          (await currentBytes(plan.context.configPath)) !==
          plan.context.original
        )
          fail(
            'CONFIG_CHANGED',
            'Configuration changed during setup. Review existing files before rerunning; it was not overwritten.',
          );
        const serialized = `${JSON.stringify(plan.config, null, 2)}\n`;
        if (plan.context.original === undefined) {
          await assertOwned();
          await publish(plan.context.configPath, serialized);
        } else {
          const backupPath = path.join(
            parent,
            `${path.basename(plan.context.configPath)}.${randomUUID()}.membrain-backup`,
          );
          await publish(backupPath, plan.context.original);
          result.backupPath = backupPath;
          const temporary = path.join(parent, `.${randomUUID()}.membrain-tmp`);
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(serialized);
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            await assertOwned();
            if (
              (await currentBytes(plan.context.configPath)) !==
              plan.context.original
            )
              fail(
                'CONFIG_CHANGED',
                'Configuration changed before replacement. The original and its backup were preserved; review them before rerunning.',
              );
            await rename(temporary, plan.context.configPath);
            await flushDirectory(parent);
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
        }
        result.createdFiles.push(plan.context.configPath);
      }
      result.status =
        plan.configChanged ||
        result.createdFiles.length ||
        result.createdDirectories.length
          ? 'initialized'
          : 'unchanged';
      return result;
    } catch (error) {
      if (
        result.createdFiles.length ||
        result.createdDirectories.length ||
        result.backupPath
      )
        fail(
          'INIT_PARTIAL',
          `Setup did not finish. Some reviewed directories/files may exist; memories were not removed. Configuration: ${plan.context.configPath}.${result.backupPath ? ` Exact previous configuration backup: ${result.backupPath}.` : ''} Inspect the files and rerun init; existing project markers/IDs will be reused. Cause: ${errno(error) ?? (error instanceof Error ? error.name : 'filesystem failure')}.`,
        );
      throw error;
    }
  });
}
