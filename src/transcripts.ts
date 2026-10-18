import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Source = "claude" | "codex";

export type Transcript = { path: string; source: Source; mtimeMs: number };

export type Delta = {
  source: Source;
  session?: string;
  cwd?: string;
  /** First user prompt of the session, so a late delta still has its framing. */
  opener?: string;
  text: string;
  toolCalls: number;
  userTurns: number;
  /** Total line count of the file at read time; the next review starts here. */
  lines: number;
};

const HOME = homedir();

export function discover(sources: Source[]): Transcript[] {
  const out: Transcript[] = [];
  if (sources.includes("claude")) {
    const root = join(HOME, ".claude", "projects");
    for (const proj of safeReaddir(root)) {
      // Top-level session files only; subagent transcripts are covered by their parent.
      for (const f of safeReaddir(join(root, proj))) {
        if (f.endsWith(".jsonl")) push(out, join(root, proj, f), "claude");
      }
    }
  }
  if (sources.includes("codex")) {
    const walk = (d: string) => {
      for (const e of safeReaddir(d)) {
        const p = join(d, e);
        if (e.endsWith(".jsonl")) push(out, p, "codex");
        else if (!e.includes(".")) walk(p);
      }
    };
    walk(join(HOME, ".codex", "sessions"));
  }
  return out;
}

function push(out: Transcript[], path: string, source: Source) {
  try {
    out.push({ path, source, mtimeMs: statSync(path).mtimeMs });
  } catch {}
}

function safeReaddir(d: string): string[] {
  try {
    return existsSync(d) ? readdirSync(d) : [];
  } catch {
    return [];
  }
}

export function sourceOf(path: string): Source {
  if (path.includes("/.codex/")) return "codex";
  if (path.includes("/.claude/")) return "claude";
  // Elsewhere (a backup, a copy), go by the first line: Codex rollouts open with session_meta.
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    return /"type":\s*"session_meta"/.test(buf.toString("utf8", 0, n)) ? "codex" : "claude";
  } catch {
    return "claude";
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[+${s.length - n}]` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Read a transcript from line `from` onward and condense it into a reviewer-friendly log. */
export function readDelta(path: string, from: number, maxChars: number): Delta {
  const source = sourceOf(path);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const d: Delta = { source, text: "", toolCalls: 0, userTurns: 0, lines: lines.length };
  const parts: string[] = [];

  lines.forEach((raw, i) => {
    let rec: any;
    try {
      rec = JSON.parse(raw);
    } catch {
      return;
    }
    const entries = source === "claude" ? claudeEntries(rec, d) : codexEntries(rec, d);
    if (i < from) {
      if (!d.opener) d.opener = entries.find((e) => e.startsWith("USER: "))?.slice(6);
      return;
    }
    for (const e of entries) {
      if (e.startsWith("USER: ")) d.userTurns++;
      if (e.startsWith("TOOL ")) d.toolCalls++;
      parts.push(e);
    }
  });

  let text = parts.join("\n");
  if (text.length > maxChars) {
    // Keep the start (what was asked) and the end (where it landed).
    const head = Math.floor(maxChars * 0.25);
    text = `${text.slice(0, head)}\n\n…[${text.length - maxChars} chars elided]…\n\n${text.slice(-(maxChars - head))}`;
  }
  d.text = text;
  return d;
}

function claudeEntries(rec: any, d: Delta): string[] {
  if (rec.sessionId && !d.session) d.session = rec.sessionId;
  if (rec.cwd && !d.cwd) d.cwd = rec.cwd;
  if (rec.isMeta || rec.isSidechain) return [];
  const msg = rec.message;
  if (!msg || (rec.type !== "user" && rec.type !== "assistant")) return [];
  const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  const out: string[] = [];
  for (const c of content) {
    if (c.type === "text" && c.text) {
      if (rec.type === "user") {
        if (/^<(command-|local-command|system-reminder)/.test(c.text.trim())) continue;
        out.push(`USER: ${clip(c.text.trim(), 3000)}`);
      } else out.push(`AGENT: ${clip(c.text.trim(), 2000)}`);
    } else if (c.type === "tool_use") {
      out.push(`TOOL ${c.name}: ${clip(oneLine(summarizeInput(c.input)), 300)}`);
    } else if (c.type === "tool_result") {
      const body = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join(" ");
      if (body) out.push(`  ${c.is_error ? "ERROR" : "→"} ${clip(oneLine(body), c.is_error ? 600 : 250)}`);
    }
  }
  return out;
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (input.command) return input.command;
  if (input.file_path) return `${input.file_path}${input.old_string ? " (edit)" : ""}`;
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  if (input.prompt) return input.prompt;
  return JSON.stringify(input);
}

function codexEntries(rec: any, d: Delta): string[] {
  const p = rec.payload ?? {};
  if (rec.type === "session_meta") {
    d.session ??= p.id;
    d.cwd ??= p.cwd;
    return [];
  }
  if (rec.type === "turn_context" && p.cwd) d.cwd ??= p.cwd;
  if (rec.type !== "response_item") return [];
  const text = (c: any[]) => (c ?? []).map((x: any) => x.text ?? "").join("\n").trim();
  switch (p.type) {
    case "message":
      if (p.role === "user") {
        const t = text(p.content);
        if (!t || t.startsWith("<environment_context>") || t.startsWith("<user_instructions>")) return [];
        return [`USER: ${clip(t, 3000)}`];
      }
      if (p.role === "assistant") return [`AGENT: ${clip(text(p.content), 2000)}`];
      return [];
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
      return [`TOOL ${p.name ?? p.type}: ${clip(oneLine(String(p.input ?? p.arguments ?? JSON.stringify(p.action ?? ""))), 300)}`];
    case "function_call_output":
    case "custom_tool_call_output": {
      const o = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
      return [`  → ${clip(oneLine(o), 250)}`];
    }
  }
  return [];
}
