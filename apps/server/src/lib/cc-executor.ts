/**
 * claude-code backend executor. Spawns the local `claude` CLI in print mode,
 * captures its full stdout as the run transcript, and derives a final result
 * for the run's kind=result comment. Spawning is injected (SpawnFn) so the
 * logic is unit-testable without launching a process.
 *
 * Folio-side auth: the per-run minted token is wired into CC's MCP config via
 * env (FOLIO_MCP_TOKEN), so CC's callbacks into Folio's MCP server carry the
 * agent's exact scopes. The spawn is granted `--allowedTools mcp__folio` so the
 * headless `-p` subprocess may call those Folio MCP tools without interactive
 * approval (impossible with no TTY) — scoped to the Folio MCP server ONLY, so
 * the grant confers no host-side bash/file/web powers (S-2 host-power
 * containment). Host-side powers (SSH, wp, files) remain governed by the
 * machine, outside Folio's envelope and outside this grant.
 *
 * Liveness (two guards against a wedged subprocess holding the conversation's
 * active_run_id slot forever — the live bug where `claude -p` sat sleeping and
 * never terminated):
 *   1. stdin is IGNORED (defaultSpawn) — the headless `-p` run is fully
 *      non-interactive, so any stdin read gets immediate EOF instead of
 *      blocking on an inherited descriptor that may never deliver/EOF.
 *   2. A spawn TIMEOUT (CC_TIMEOUT_MS) — runClaudeCode races drain+exit against
 *      a deadline; on expiry it kills the child and returns a `failed` outcome,
 *      freeing the slot with an actionable detail instead of hanging silently.
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
  /** Override the spawn deadline (ms). Tests inject a tiny value; prod uses the
   * CC_TIMEOUT_MS default. */
  timeoutMs?: number;
}

export type CcOutcome =
  | { status: 'completed'; transcript: string; result: string }
  | { status: 'failed'; transcript: string; detail: string };

/**
 * Hard ceiling on a single `claude -p` turn. A real tool-using turn measured
 * ~31s; 3 min is generous headroom. A subprocess that exceeds this is treated
 * as wedged: it is killed and the run fails cleanly, rather than holding the
 * conversation's active_run_id slot indefinitely with no user feedback (the
 * live bug). Tunable here; per-call override via CcInput.timeoutMs (tests).
 */
const CC_TIMEOUT_MS = 180_000;

/** Default spawn using Bun.spawn. */
export const defaultSpawn: SpawnFn = ({ argv, cwd, env }) => {
  // stdin:'ignore' — the headless `claude -p` runs non-interactively: any read
  // on stdin gets immediate EOF instead of an inherited descriptor that may
  // never deliver and never EOF (which would block the child forever if Folio
  // were launched attached to a terminal/PTY). Pipe stdout/stderr to capture.
  const proc = Bun.spawn(argv, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
  const prompt =
    input.taskContext && input.taskContext.trim().length > 0
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
    // Headless `claude -p` runs in default permission mode, where every tool
    // call needs interactive approval that can't happen with no TTY — so the
    // first Folio MCP tool call would be silently denied and the operator would
    // ask the user instead of executing. Grant the Folio MCP tools up front.
    // Scoped to `mcp__folio` (Claude Code namespaces MCP tools as
    // `mcp__<serverName>__<tool>`, so `mcp__folio` matches the whole folio
    // server and NOTHING else) — NOT --dangerously-skip-permissions: the
    // subprocess gets no host-side bash/file/web powers from this grant (S-2
    // host-power containment). Only pushed when the folio MCP server is wired.
    argv.push('--allowedTools', 'mcp__folio');
  }

  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FOLIO_MCP_TOKEN: input.mcpToken,
  };

  const handle = spawn({ argv, cwd: input.cwd, env: childEnv });
  // Drain BOTH pipes concurrently. An unread stderr pipe can fill the OS buffer
  // and block (hang) the child; reading both also lets a CLI failure surface its
  // actual error in the failure detail instead of a bare exit code.
  const drained = Promise.all([handle.stdoutText(), handle.stderrText()]);

  // Race the drain+exit against a deadline. A wedged `claude -p` (the live bug:
  // the subprocess sits sleeping, never exits) would otherwise be awaited
  // forever, holding the conversation slot with no feedback. On expiry we kill
  // the child and fail the run with a clear, actionable detail.
  const timeoutMs = input.timeoutMs ?? CC_TIMEOUT_MS;
  const TIMEOUT = Symbol('cc-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });

  const exitOrTimeout = await Promise.race([handle.exited, deadline]);
  if (timer) clearTimeout(timer);

  if (exitOrTimeout === TIMEOUT) {
    // Kill the wedged subprocess so it releases the conversation's slot. Killing
    // closes the piped streams, so `drained` should settle — but we must NOT
    // re-block the timeout path on it: a buried-read or a fake that does not
    // close on kill would otherwise re-hang the very thing the timeout guards
    // against. Recover partial output OPPORTUNISTICALLY: race the drain against
    // a short grace window, and on a clean timeout return an empty transcript.
    handle.kill();
    const graceMs = Math.min(timeoutMs, 500);
    const drainResult = await Promise.race<[string, string] | null>([
      drained.catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), graceMs)),
    ]);
    const partial = drainResult?.[0]?.trim() ?? '';
    const stderrPartial = drainResult?.[1]?.trim() ?? '';
    const detail = `claude timed out after ${timeoutMs}ms — killed (wedged subprocess holds the conversation slot otherwise)${stderrPartial ? `: ${stderrPartial.slice(0, 500)}` : ''}`;
    return { status: 'failed', transcript: partial, detail };
  }

  const exitCode = exitOrTimeout;
  const [transcript, stderrText] = await drained;

  if (exitCode !== 0) {
    const stderrTail = stderrText.trim();
    const detail = `claude exited with exit code ${exitCode}${stderrTail ? `: ${stderrTail.slice(0, 500)}` : ''}`;
    return { status: 'failed', transcript, detail };
  }

  const result = transcript.trim().length > 0 ? transcript.trim() : '(no output)';
  return { status: 'completed', transcript, result };
}
