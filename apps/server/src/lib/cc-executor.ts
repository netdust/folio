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
  stderrText: () => Promise<string>;
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
  // The per-run task + relevant document context (parent body + comment thread,
  // flattened to literal text — same source the API-provider path uses, no
  // wiki-link expansion). The systemPrompt is the agent's STANDING identity;
  // taskContext is WHAT to do THIS run + the document(s) it concerns. Optional:
  // a run with no parent/task (e.g. "set up a project for me") supplies none and
  // the agent acts from its identity + tools alone.
  taskContext?: string;
  model: string | undefined;
  mcpToken: string;
  mcpUrl: string | undefined;
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
    stderrText: () => new Response(proc.stderr).text(),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

export async function runClaudeCode(
  input: CcInput,
  deps: { spawn?: SpawnFn } = {},
): Promise<CcOutcome> {
  const spawn = deps.spawn ?? defaultSpawn;

  // Compose the single `-p` prompt: standing identity, then the task + context
  // for this run (if any). `claude -p` takes one prompt string, so we flatten.
  const prompt = input.taskContext && input.taskContext.trim().length > 0
    ? `${input.systemPrompt}\n\n---\n\n${input.taskContext}`
    : input.systemPrompt;
  const argv = ['claude', '-p', prompt];
  if (input.model) argv.push('--model', input.model);

  if (input.mcpToken && input.mcpUrl) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        folio: {
          type: 'http',
          url: input.mcpUrl,
          headers: { Authorization: `Bearer ${input.mcpToken}` },
        },
      },
    });
    argv.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  }

  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FOLIO_MCP_TOKEN: input.mcpToken,
  };

  const handle = spawn({ argv, cwd: input.cwd, env: childEnv });
  // Drain BOTH pipes concurrently. An unread stderr pipe can fill the OS buffer
  // and block (hang) the child; reading both also lets a CLI failure surface its
  // actual error in the failure detail instead of a bare exit code.
  const [transcript, stderrText] = await Promise.all([handle.stdoutText(), handle.stderrText()]);
  const exitCode = await handle.exited;

  if (exitCode !== 0) {
    const stderrTail = stderrText.trim();
    const detail = `claude exited with exit code ${exitCode}${stderrTail ? `: ${stderrTail.slice(0, 500)}` : ''}`;
    return { status: 'failed', transcript, detail };
  }

  const result = transcript.trim().length > 0 ? transcript.trim() : '(no output)';
  return { status: 'completed', transcript, result };
}
