import type { Command } from 'commander';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { automaticAfterMutation } from './cli-sync.js';
import { MemoryEngine } from './engine/engine.js';
import type { Change, Draft } from './engine/engine.js';
import type { Selection } from './engine/scopes.js';
import { choice, fail, metadata, states } from './engine/model.js';
import type { Json } from './engine/model.js';
import type { QueryResult } from './index/search.js';
import { span } from './profile.js';

interface Options extends Selection {
  stdin?: boolean;
  type?: string;
  tag?: string[];
  sourceAgent?: string;
  metadata?: string;
  operationId?: string;
  expectedRevision?: string;
  status?: string;
  clearTags?: boolean;
  yes?: boolean;
  all?: boolean;
  history?: boolean;
  limit?: string;
  offset?: string;
  maxChars?: string;
  rebuildIndex?: boolean;
  readOnly?: boolean;
  literal?: boolean;
  promote?: string;
  to?: string;
}
function integer(
  value: string | undefined,
  fallback: number,
  maximum: number,
  field: string,
  minimum = 1,
): number {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    fail(
      'INVALID_LIMIT',
      `${field} must be an integer from ${minimum} through ${maximum}.`,
    );
  return Number(value);
}
function selection(command: Command, write = false): Command {
  command
    .option('--scope <scope>', 'global, project, or session')
    .option('--project <id>', 'select an explicitly configured project ID')
    .option(
      '--session <id>',
      'select one explicit session, isolated within project context',
    );
  if (!write)
    command.option(
      '--all-projects',
      'explicitly include every configured project (read only)',
    );
  return command;
}
function fields(command: Command): Command {
  return command
    .option(
      '--stdin',
      'read content from standard input instead of an argument',
    )
    .option(
      '--type <type>',
      'fact, decision, preference, constraint, task, or note',
    )
    .option(
      '--tag <tag>',
      'tag (repeatable; replaces all tags on update)',
      (tag: string, previous: string[] | undefined) => [
        ...(previous ?? []),
        tag,
      ],
    )
    .option('--source-agent <name>', 'record the source agent')
    .option('--metadata <json>', 'bounded JSON object with additional metadata')
    .option(
      '--operation-id <id>',
      'idempotency identifier; reuse only for identical input',
    );
}
async function content(
  argument: string | undefined,
  input: boolean | undefined,
  required: boolean,
): Promise<string | undefined> {
  if (argument !== undefined && input)
    fail('INVALID_INPUT', 'Supply a content argument or --stdin, not both.');
  if (!input) {
    if (argument === undefined && required)
      fail(
        'CONTENT_REQUIRED',
        'Supply content as an argument or through --stdin.',
      );
    return argument;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += bytes.length;
    if (size > 262_144)
      fail('INVALID_INPUT', 'Standard input exceeds 256 KiB.');
    chunks.push(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    fail('INVALID_INPUT', 'Standard input is not valid UTF-8.');
  }
}
function draftFields(options: Options): Omit<Draft, 'content'> {
  let extra: { [key: string]: Json } | undefined;
  if (options.metadata !== undefined) {
    try {
      extra = metadata(JSON.parse(options.metadata) as unknown);
    } catch {
      fail('INVALID_METADATA', '--metadata requires a bounded JSON object.');
    }
  }
  return {
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.tag === undefined ? {} : { tags: options.tag }),
    ...(options.sourceAgent === undefined
      ? {}
      : { sourceAgent: options.sourceAgent }),
    ...(extra === undefined ? {} : { metadata: extra }),
    ...(options.operationId === undefined
      ? {}
      : { operationId: options.operationId }),
  };
}

export function recallResult(data: QueryResult, budget: number): object {
  const finish = span('cli.recallBudget');
  const results: object[] = [];
  let truncated = false;
  for (const hit of data.results) {
    const record = hit.record;
    const base = {
      id: record.id,
      revisionId: record.revisionId,
      scope: record.scope,
      type: record.type,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      tags: record.tags.slice(0, 8),
      score: hit.score,
    };
    let low = 0;
    let high = record.content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = {
        ...base,
        content: record.content.slice(0, middle),
        truncated: middle < record.content.length || record.tags.length > 8,
      };
      if (JSON.stringify([...results, candidate]).length <= budget)
        low = middle;
      else high = middle - 1;
    }
    if (low > 0 && /[\uD800-\uDBFF]/u.test(record.content.charAt(low - 1)))
      low--;
    if (!low) {
      truncated = true;
      break;
    }
    const shortened = low < record.content.length || record.tags.length > 8;
    results.push({
      ...base,
      content: record.content.slice(0, low),
      truncated: shortened,
    });
    truncated ||= shortened;
  }
  finish();
  return {
    untrusted: true,
    results,
    truncated,
    maxChars: budget,
    budgetUnit: 'serialized-results-utf16',
    warnings: data.warnings,
    index: data.index,
  };
}

export function registerMemoryCommands(program: Command): void {
  let configuration: Config;
  async function engine(): Promise<MemoryEngine> {
    const finish = span('cli.configuration');
    configuration = (
      await loadConfig(program.opts<{ config?: string }>().config)
    ).config;
    finish();
    return new MemoryEngine(configuration);
  }
  function output(data: unknown): void {
    const finish = span('cli.serialization');
    console.log(
      JSON.stringify(
        data,
        null,
        program.opts<{ json?: boolean }>().json ? undefined : 2,
      ),
    );
    finish();
  }
  const remember = fields(
    selection(
      program
        .command('remember')
        .argument('[content]')
        .description(
          'save locally; authorized automatic policy may then attempt Git sync',
        ),
      true,
    ),
  )
    .option(
      '--promote <id>',
      'copy an active session memory to a permanent scope',
    )
    .option('--to <scope>', 'promotion destination: project or global');
  remember.action(async (argument: string | undefined) => {
    const options = remember.opts<Options>();
    const service = await engine();
    if (options.promote) {
      if (
        argument !== undefined ||
        options.stdin ||
        options.type ||
        options.tag ||
        options.metadata ||
        options.sourceAgent ||
        options.scope ||
        !options.to
      )
        fail(
          'INVALID_PROMOTION',
          'Promotion requires --promote ID --session ID --to project|global, with optional --project/--operation-id only.',
        );
      output(
        await automaticAfterMutation(
          configuration,
          await service.promote(
            options,
            options.promote,
            options.to,
            options.operationId,
          ),
        ),
      );
    } else {
      if (options.to) fail('INVALID_PROMOTION', '--to requires --promote.');
      output(
        await automaticAfterMutation(
          configuration,
          await service.remember(options, {
            content: (await content(argument, options.stdin, true))!,
            ...draftFields(options),
          }),
        ),
      );
    }
  });
  const update = fields(
    selection(
      program
        .command('update')
        .argument('<id>')
        .argument('[content]')
        .description('append a revision while preserving memory identity'),
      true,
    ),
  )
    .option('--clear-tags', 'remove all tags; cannot be combined with --tag')
    .option(
      '--expected-revision <id>',
      'reject concurrent changes since this revision',
    )
    .option(
      '--status <state>',
      'active or superseded; deleted memories cannot be restored',
    );
  update.action(async (id: string, argument: string | undefined) => {
    const options = update.opts<Options>();
    if (options.clearTags && options.tag)
      fail('INVALID_UPDATE', 'Use --clear-tags or --tag, not both.');
    const value = await content(argument, options.stdin, false);
    const change: Change = {
      ...draftFields(options),
      ...(options.clearTags ? { tags: [] } : {}),
      ...(value === undefined ? {} : { content: value }),
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      ...(options.status === undefined
        ? {}
        : {
            status: choice(
              options.status,
              ['active', 'superseded'] as const,
              'status',
            ),
          }),
    };
    const service = await engine();
    output(
      await automaticAfterMutation(
        configuration,
        await service.update(options, id, change),
      ),
    );
  });
  const forget = selection(
    program
      .command('forget')
      .argument('[id]')
      .description('remove a memory from future searches; retain its history'),
    true,
  )
    .option('--yes', 'explicitly confirm logical deletion without a prompt')
    .option(
      '--expected-revision <id>',
      'reject concurrent changes since this revision',
    )
    .option('--operation-id <id>', 'idempotency identifier')
    .option('--all', 'discard current memories in one explicit session');
  forget.action(async (id: string | undefined) => {
    const options = forget.opts<Options>();
    if (!options.yes)
      fail(
        'CONFIRMATION_REQUIRED',
        'Deletion requires --yes. This memory will be removed from future searches. Its history will be retained for synchronization and recovery.',
      );
    const service = await engine();
    if (options.all) {
      if (
        id ||
        options.scope !== 'session' ||
        !options.session ||
        options.expectedRevision ||
        options.operationId
      )
        fail(
          'INVALID_SELECTION',
          '--all requires --scope session --session ID --yes and no individual ID/revision/operation.',
        );
      output(
        await automaticAfterMutation(
          configuration,
          await service.discardSession(options),
        ),
      );
    } else {
      if (!id)
        fail(
          'INVALID_SELECTION',
          'Supply a memory ID, or explicitly discard one session with --all.',
        );
      output(
        await automaticAfterMutation(
          configuration,
          await service.forget(options, id, {
            ...(options.expectedRevision
              ? { expectedRevision: options.expectedRevision }
              : {}),
            ...(options.operationId
              ? { operationId: options.operationId }
              : {}),
          }),
        ),
      );
    }
  });
  for (const name of ['search', 'recall', 'list'] as const) {
    let command = selection(
      program
        .command(name)
        .description(
          name === 'recall'
            ? 'retrieve bounded, untrusted reference context'
            : name === 'search'
              ? 'search active memory using literal keywords and BM25'
              : 'list memory heads or explicit revision history',
        ),
    );
    if (name !== 'list')
      command = command
        .argument('<query>')
        .option(
          '--literal',
          'keep every query word, including English function words',
        );
    command
      .option(
        '--limit <count>',
        name === 'recall'
          ? 'results, 1..100 (default 5)'
          : 'results, 1..100 (default 10)',
      )
      .option(
        '--tag <tag>',
        'require this exact tag (repeatable)',
        (tag: string, previous: string[] | undefined) => [
          ...(previous ?? []),
          tag,
        ],
      )
      .option(
        '--read-only',
        'reuse a current index without cache writes; fail if maintenance is needed',
      )
      .option(
        '--rebuild-index',
        'rebuild the disposable SQLite index from validated JSONL',
      );
    if (name === 'list')
      command
        .option(
          '--status <state>',
          'active (default), superseded, deleted, or all',
        )
        .option('--history', 'include ancestor revisions, marked historical');
    if (name === 'recall')
      command.option(
        '--max-chars <count>',
        'serialized result budget, 1..65536 (default 4000)',
      );
    else
      command.option(
        '--offset <count>',
        'skip 0..1000000 ordered results for pagination',
      );
    command.action(async (query?: string) => {
      const options = command.opts<Options>();
      const result = await (
        await engine()
      ).query(options, {
        limit: integer(
          options.limit,
          name === 'recall' ? 5 : 10,
          100,
          '--limit',
        ),
        ...(options.offset === undefined
          ? {}
          : { offset: integer(options.offset, 0, 1_000_000, '--offset', 0) }),
        ...(name === 'list' ? {} : { query: query! }),
        ...(options.status
          ? {
              state: choice(
                options.status,
                [...states, 'all'] as const,
                'status',
              ),
            }
          : {}),
        ...(options.tag ? { tags: options.tag } : {}),
        ...(options.history === undefined ? {} : { history: options.history }),
        ...(options.rebuildIndex === undefined
          ? {}
          : { rebuild: options.rebuildIndex }),
        ...(options.readOnly === undefined
          ? {}
          : { readOnly: options.readOnly }),
        ...(options.literal === undefined ? {} : { literal: options.literal }),
      });
      output(
        name === 'recall'
          ? recallResult(
              result,
              integer(options.maxChars, 4_000, 65_536, '--max-chars'),
            )
          : { untrusted: true, ...result },
      );
    });
  }
}
