import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonical, errno } from '../storage/files.js';
import { fail } from '../engine/model.js';

export function inputPath(
  input: string,
  cwd: string,
  home = homedir(),
): string {
  if (!input.trim() || /[\u0000-\u001f\u007f]/u.test(input))
    fail(
      'INVALID_PATH',
      'Enter a nonempty filesystem path without control characters.',
    );
  const resolved =
    input === '~'
      ? home
      : /^~[/\\]/u.test(input)
        ? path.resolve(home, input.slice(2))
        : path.resolve(cwd, input);
  if (process.platform === 'win32')
    for (const part of resolved
      .slice(path.parse(resolved).root.length)
      .split(/[\\/]/u)) {
      if (
        /[<>:"|?*]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part)
      )
        fail(
          'INVALID_PATH',
          'This path contains a reserved Windows filename or character.',
        );
    }
  return resolved;
}
export async function validateDirectory(
  input: string,
  mustExist = false,
): Promise<string> {
  let cursor = path.resolve(input);
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        const target = await realpath(cursor);
        const targetStat = await lstat(target);
        if (!targetStat.isDirectory())
          fail('INVALID_PATH', `Expected a directory at ${cursor}.`);
      } else if (!stat.isDirectory())
        fail('INVALID_PATH', `A file blocks the directory path at ${cursor}.`);
      await access(cursor, constants.W_OK | constants.X_OK);
      return canonical(input);
    } catch (error) {
      if (errno(error) !== 'ENOENT') {
        if (['EACCES', 'EPERM', 'EROFS'].includes(errno(error) ?? ''))
          fail(
            'PATH_NOT_WRITABLE',
            `Directory is not writable/searchable at ${cursor}. Check permissions or select another location.`,
          );
        throw error;
      }
      if (mustExist)
        fail(
          'INVALID_PATH',
          `Project root does not exist at ${input}. Choose an existing project directory.`,
        );
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}
