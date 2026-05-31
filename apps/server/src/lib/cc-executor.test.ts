import { describe, expect, test } from 'bun:test';
import { runClaudeCode, type SpawnFn, type CcOutcome } from './cc-executor.ts';

function fakeSpawn(opts: { stdout: string; exitCode: number; stderr?: string }): SpawnFn {
  return () => ({
    stdoutText: async () => opts.stdout,
    stderrText: async () => opts.stderr ?? '',
    exited: Promise.resolve(opts.exitCode),
    kill: () => {},
  });
}

describe('runClaudeCode', () => {
  test('clean exit returns completed + transcript + final result', async () => {
    const outcome: CcOutcome = await runClaudeCode(
      { systemPrompt: 'do the thing', model: undefined, mcpToken: 'tok_123', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: fakeSpawn({ stdout: 'line1\nFINAL RESULT', exitCode: 0 }) },
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.transcript).toContain('line1');
    if (outcome.status === 'completed') expect(outcome.result).toContain('FINAL RESULT');
  });

  test('non-zero exit returns failed with detail', async () => {
    const outcome = await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 't', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: fakeSpawn({ stdout: 'boom', exitCode: 1 }) },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.detail).toMatch(/exit code 1/i);
  });

  test('non-zero exit surfaces the CLI stderr in the failure detail', async () => {
    const outcome = await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 't', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: fakeSpawn({ stdout: '', exitCode: 1, stderr: 'boom: bad config' }) },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.detail).toContain('boom: bad config');
  });

  test('passes --model when provided', async () => {
    let capturedArgs: string[] = [];
    const spy: SpawnFn = (args) => {
      capturedArgs = args.argv;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: 'claude-opus-4-8', mcpToken: 't', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: spy },
    );
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('claude-opus-4-8');
  });

  test('omits --model when not provided', async () => {
    let capturedArgs: string[] = [];
    const spy: SpawnFn = (args) => {
      capturedArgs = args.argv;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 't', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: spy },
    );
    expect(capturedArgs).not.toContain('--model');
  });

  test('wires FOLIO_MCP_TOKEN into the child env', async () => {
    let capturedEnv: Record<string, string> = {};
    const spy: SpawnFn = (args) => {
      capturedEnv = args.env;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 'tok_abc', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: spy },
    );
    expect(capturedEnv.FOLIO_MCP_TOKEN).toBe('tok_abc');
  });

  test('emits --mcp-config + --strict-mcp-config when token and url present', async () => {
    let argv: string[] = [];
    const spy: SpawnFn = (a) => {
      argv = a.argv;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 'tok_x', mcpUrl: 'http://h/mcp', cwd: '/tmp' },
      { spawn: spy },
    );
    expect(argv).toContain('--mcp-config');
    expect(argv).toContain('--strict-mcp-config');
    const cfgIdx = argv.indexOf('--mcp-config') + 1;
    const cfg = JSON.parse(argv[cfgIdx]!);
    expect(cfg.mcpServers.folio.url).toBe('http://h/mcp');
    expect(cfg.mcpServers.folio.headers.Authorization).toBe('Bearer tok_x');
  });

  test('omits --mcp-config when url is absent (v1 one-way)', async () => {
    let argv: string[] = [];
    const spy: SpawnFn = (a) => {
      argv = a.argv;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: '', mcpUrl: undefined, cwd: '/tmp' },
      { spawn: spy },
    );
    expect(argv).not.toContain('--mcp-config');
  });
});
