// One headless claude -p run (DESIGN.md 2.1): no tools, no MCP servers from
// the box (--strict-mcp-config), only project settings, a budget cap. The
// run is killed when the signal aborts.

import { mkdirSync } from "node:fs";

// The claude CLI, found on PATH.
export const CLAUDE = "claude";

export type ClaudeResult = { structured?: unknown; text: string; sessionId: string; usd: number };
export type ClaudeRun = (opts: {
  model: string;
  system: string;
  prompt: string;
  schema?: object;
  // Keep the session so a later run can resume it (the consult); else none is kept.
  keepSession?: boolean;
  resume?: string;
  maxUsd: number;
  cwd: string;
  signal?: AbortSignal;
  // Tests run a stand-in program.
  bin?: string;
}) => Promise<ClaudeResult>;

// Only what claude needs: never the app's token or other ISOMUX_* values.
const ENV_KEYS = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"];
export function runEnv(): Record<string, string> {
  return Object.fromEntries(ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
}

export const runClaude: ClaudeRun = async (o) => {
  mkdirSync(o.cwd, { recursive: true });
  const args = [
    o.bin ?? CLAUDE, "-p", "--model", o.model, "--strict-mcp-config", "--setting-sources", "project", "--tools", "",
    "--max-budget-usd", String(o.maxUsd), "--output-format", "json", "--system-prompt", o.system,
  ];
  if (!o.keepSession) args.push("--no-session-persistence");
  if (o.resume) args.push("--resume", o.resume);
  if (o.schema) args.push("--json-schema", JSON.stringify(o.schema));
  // Its own process group (setsid), so a kill reaches any child it started.
  const proc = Bun.spawn(["setsid", ...args], { cwd: o.cwd, env: runEnv(), stdin: new Blob([o.prompt]), stdout: "pipe", stderr: "pipe" });
  let onAbort = () => {};
  const aborted = new Promise<never>((_, rej) => {
    onAbort = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      rej(new Error("the run was stopped"));
    };
  });
  aborted.catch(() => {});
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // An abort does not wait for the pipes: a child may hold them open.
    const [out, err, code] = await Promise.race([Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), aborted]);
    let d: { is_error?: boolean; result?: string; structured_output?: unknown; session_id?: string; total_cost_usd?: number; subtype?: string };
    try {
      d = JSON.parse(out);
    } catch {
      throw new Error(`claude -p exited ${code}: ${(err || out).slice(0, 300)}`);
    }
    if (d.is_error || code !== 0) throw new Error(`claude -p failed (${d.subtype ?? code}): ${String(d.result ?? err).slice(0, 300)}`);
    return { structured: d.structured_output, text: d.result ?? "", sessionId: d.session_id ?? "", usd: d.total_cost_usd ?? 0 };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
  }
};
