import { spawn } from 'node:child_process';
import { MembrainError } from '../errors.js';

export class GitError extends MembrainError {
  constructor(
    public readonly status: number,
    public readonly diagnostic: string,
  ) {
    super(
      'GIT_FAILED',
      'Git failed. Inspect repository state and authentication, then retry explicit sync.',
    );
  }
}
export class Git {
  private sshCommand: string | null | undefined;
  constructor(
    public readonly cwd: string,
    private readonly hooksPath: string,
    private readonly signal?: AbortSignal,
    private readonly indexFile?: string,
  ) {}
  async run(args: string[], input?: Buffer, network = false): Promise<Buffer> {
    const env = { ...process.env };
    // Caller repository redirection must never turn a scoped operation into another repo.
    for (const key of Object.keys(env))
      if (
        /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_COUNT|_PARAMETERS|_KEY_.*|_VALUE_.*)?|NAMESPACE|PREFIX|SHALLOW_FILE|REPLACE_REF_BASE|TRACE.*)$/iu.test(
          key,
        )
      )
        delete env[key];
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      LC_ALL: 'C',
    });
    for (const key of [
      'GIT_GLOB_PATHSPECS',
      'GIT_NOGLOB_PATHSPECS',
      'GIT_ICASE_PATHSPECS',
    ])
      delete env[key];
    // check-ignore consumes literal pathnames, and rejects the literal pathspec flag.
    if (args[0] === 'check-ignore') delete env.GIT_LITERAL_PATHSPECS;
    if (this.indexFile) env.GIT_INDEX_FILE = this.indexFile;
    if (network && !env.GIT_SSH_COMMAND && !env.GIT_SSH) {
      if (this.sshCommand === undefined)
        this.sshCommand =
          (await this.optional(['config', '--get', 'core.sshCommand'])) ?? null;
      env.GIT_SSH_COMMAND = this.sshCommand ?? 'ssh -oBatchMode=yes';
    }
    const flags = [
      '--no-optional-locks',
      '-c',
      `core.hooksPath=${this.hooksPath}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'merge.autoStash=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'protocol.ext.allow=never',
    ];
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(
          new MembrainError(
            'SYNC_INTERRUPTED',
            'Synchronization was cancelled before Git started. Local memories are retained.',
          ),
        );
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', [...flags, ...args], {
          cwd: this.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: 'pipe',
        });
      } catch {
        reject(
          new MembrainError(
            'GIT_UNAVAILABLE',
            'Git could not start. Install Git or keep this scope local.',
          ),
        );
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error, value?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => {
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(
          new MembrainError(
            'SYNC_INTERRUPTED',
            'Synchronization interrupted. Inspect the reported stage and any locks before retrying.',
          ),
        );
      };
      const timer = setTimeout(
        () => {
          child.kill();
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(
            new MembrainError(
              'GIT_TIMEOUT',
              'Git timed out. Local memories are retained; check connectivity/authentication and retry explicit sync.',
            ),
          );
        },
        network ? 30000 : 15000,
      );
      this.signal?.addEventListener('abort', abort, { once: true });
      if (this.signal?.aborted) {
        abort();
        return;
      }
      child.on('error', () =>
        finish(
          new MembrainError(
            'GIT_UNAVAILABLE',
            'Git could not start. Install Git or keep this scope local.',
          ),
        ),
      );
      child.stdout?.on('data', (bytes: Buffer) => {
        size += bytes.length;
        if (size > 64 * 1024 * 1024) {
          child.kill();
          finish(
            new MembrainError(
              'SYNC_LIMIT',
              'Git output exceeded the 64 MiB safety limit. Use smaller dedicated memory repositories.',
            ),
          );
        } else out.push(bytes);
      });
      child.stderr?.on('data', (bytes: Buffer) => {
        if (err.reduce((n, item) => n + item.length, 0) < 65536)
          err.push(bytes);
      });
      child.on('close', (code) =>
        finish(
          code === 0
            ? undefined
            : new GitError(code ?? -1, Buffer.concat(err).toString('utf8')),
          Buffer.concat(out),
        ),
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
  async text(args: string[], input?: Buffer, network = false): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(await this.run(args, input, network))
      .replace(/\r?\n$/u, '');
  }
  async optional(
    args: string[],
    codes = [1, 128],
  ): Promise<string | undefined> {
    try {
      return await this.text(args);
    } catch (error) {
      if (error instanceof GitError && codes.includes(error.status))
        return undefined;
      throw error;
    }
  }
}
export function nul(values: string[]): Buffer {
  return Buffer.from(`${values.join('\0')}\0`);
}
