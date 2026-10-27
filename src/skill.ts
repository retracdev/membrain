import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  open,
  link,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { MembrainError } from './errors.js';
import { errno, flushDirectory } from './storage/files.js';

export interface SkillExport {
  skill: 'membrain';
  path: string;
  status: 'created' | 'unchanged' | 'replaced';
}

/** Refuse directory links, including junctions, rather than redirecting an export. */
async function inspectDirectories(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) await inspectDirectories(parent);
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new MembrainError(
        'UNSAFE_SKILL_PATH',
        'Export requires real directories, without symbolic links or junctions. Choose a direct destination path.',
      );
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

async function existing(file: string): Promise<{ bytes?: Buffer } | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new MembrainError(
        'UNSAFE_SKILL_PATH',
        'Existing SKILL.md must be a regular file. Choose another destination; symbolic links and directories are never replaced.',
      );
    // Bound reads of an unrelated file; a large existing file still requires permission.
    return stat.size > 262_144 ? {} : { bytes: await readFile(file) };
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export async function exportSkill(
  output: string,
  overwrite = false,
): Promise<SkillExport> {
  if (!output.trim() || output.includes('\0'))
    throw new MembrainError(
      'INVALID_SKILL_OUTPUT',
      'Supply a non-empty destination directory with --output. No default agent directory is used.',
      2,
    );
  const directory = path.resolve(output);
  const file = path.join(directory, 'SKILL.md');
  const result = (status: SkillExport['status']): SkillExport => ({
    skill: 'membrain',
    path: file,
    status,
  });
  try {
    // Resolve relative to the installed module, never cwd or an agent configuration.
    const bytes = await readFile(
      new URL('../skills/membrain/SKILL.md', import.meta.url),
    );
    await inspectDirectories(directory);
    const previous = await existing(file);
    if (previous?.bytes?.equals(bytes)) return result('unchanged');
    // Use the same snapshot for content and presence. A second lstat could see
    // an identical concurrent publication and incorrectly refuse it as changed.
    const present = previous !== undefined;
    if (present && !overwrite)
      throw new MembrainError(
        'SKILL_EXISTS',
        'SKILL.md already exists with different content. Review it, choose another directory, or explicitly pass --overwrite to replace only that file.',
      );
    await mkdir(directory, { recursive: true });
    await inspectDirectories(directory);
    const temporary = path.join(
      directory,
      `.membrain-skill-${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await inspectDirectories(directory);
      await existing(file); // Reject unsafe targets even with explicit permission.
      if (overwrite) {
        await rename(temporary, file);
      } else {
        try {
          // Publish complete bytes atomically; a concurrent creator cannot be overwritten.
          await link(temporary, file);
        } catch (error) {
          if (errno(error) !== 'EEXIST') throw error;
          if ((await existing(file))?.bytes?.equals(bytes))
            return result('unchanged');
          throw new MembrainError(
            'SKILL_EXISTS',
            'SKILL.md was created concurrently. Inspect it or export to another directory; it was not overwritten.',
          );
        }
      }
      await flushDirectory(directory);
      return result(present ? 'replaced' : 'created');
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (errno(error) !== 'ENOENT') throw error;
      });
    }
  } catch (error) {
    if (error instanceof MembrainError) throw error;
    throw new MembrainError(
      'SKILL_EXPORT_FAILED',
      'Could not export the bundled skill. Check the destination, permissions, free space, package installation, and filesystem hard-link support. Inspect SKILL.md before retrying; no agent settings were changed.',
    );
  }
}
