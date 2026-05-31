/**
 * claude-code backend executor. Spawns the local `claude` CLI in print mode,
 * captures its full stdout as the run transcript, and derives a final result
 * for the run's kind=result comment. Spawning is injected (SpawnFn) so the
 * logic is unit-testable without launching a process.
 *
 * Folio-side auth: the per-run minted token is wired into CC's MCP config via
 * env (FOLIO_MCP_TOKEN), so CC's callbacks into Folio's MCP server carry the
 * agent's exact scopes. Host-side powers (SSH, wp, files) are governed by the
 * machine, outside Folio's envelope.
 */

export interface SpawnHandle {
  stdoutText: () => Promise<string>;
  exited: Promise<number>;
  kill: () => void;
}

export type SpawnFn = (args: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}) => SpawnHandle;

export interface CcInput {
  systemPrompt: string;
  model: string | undefined;
  mcpToken: string;
  cwd: string;
}

export type CcOutcome =
  | { status: 'completed'; transcript: string; result: string }
  | { status: 'failed'; transcript: string; detail: string };

/** Default spawn using Bun.spawn. */
const defaultSpawn: SpawnFn = ({ argv, cwd, env }) => {
  const proc = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdoutText: () => new Response(proc.stdout).text(),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

export async function runClaudeCode(
  input: CcInput,
  deps: { spawn?: SpawnFn } = {},
): Promise<CcOutcome> {
  const spawn = deps.spawn ?? defaultSpawn;

  const argv = ['claude', '-p', input.systemPrompt];
  if (input.model) argv.push('--model', input.model);

  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FOLIO_MCP_TOKEN: input.mcpToken,
  };

  const handle = spawn({ argv, cwd: input.cwd, env: childEnv });
  const transcript = await handle.stdoutText();
  const exitCode = await handle.exited;

  if (exitCode !== 0) {
    return { status: 'failed', transcript, detail: `claude exited with exit code ${exitCode}` };
  }

  const result = transcript.trim().length > 0 ? transcript.trim() : '(no output)';
  return { status: 'completed', transcript, result };
}
