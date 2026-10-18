import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { projectFor } from "./journal";
import { sourceOf, type Transcript } from "./transcripts";

/**
 * History that isn't a Claude Code or Codex transcript, for backfills. Each importer turns
 * one store into sessions with readable text, in the same shape the harvesters read. They
 * open databases read-only, and skip anything they can't parse.
 */

export type Imported = {
  origin: string; // "zed", "conductor", "opencode", "prompts"
  session: string;
  cwd?: string;
  project: string;
  start: string;
  end: string;
  userTurns: number;
  toolCalls: number;
  opener: string;
  text: string;
};

const HOME = homedir();
const iso = (v: string | number | undefined) => (v === undefined ? "" : new Date(typeof v === "number" ? v : v).toISOString());
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[+${s.length - n}]` : s);
const opener = (s: string) => s.replace(/\s+/g, " ").slice(0, 160);

function open(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    // immutable: some apps keep these open, and a read-only handle on a WAL database still
    // needs to create the -shm file. Immutable reads only what's in the main file.
    return new Database(`file:${path}?immutable=1`, { readonly: true });
  } catch {
    return null;
  }
}

/** Zed's agent threads: SQLite rows of zstd-compressed JSON. */
export function zedThreads(): Imported[] {
  const db = open(join(HOME, "Library", "Application Support", "Zed", "threads", "threads.db"));
  if (!db) return [];
  const out: Imported[] = [];
  const rows = db.query("select id, summary, created_at, updated_at, data_type, data from threads").all() as any[];
  for (const r of rows) {
    let j: any;
    try {
      const raw = r.data_type === "zstd" ? zstdDecompressSync(r.data) : Buffer.from(r.data);
      j = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    const lines: string[] = [];
    let users = 0, tools = 0, first = "";
    for (const m of j.messages ?? []) {
      if (m?.User) {
        const t = (m.User.content ?? []).map((c: any) => c.Text ?? "").join("\n").trim();
        if (!t) continue;
        users++;
        first ||= t;
        lines.push(`USER: ${t}`);
      } else if (m?.Agent) {
        const t = (m.Agent.content ?? []).map((c: any) => c.Text ?? "").join("\n").trim();
        const used = (m.Agent.content ?? []).filter((c: any) => c.ToolUse).map((c: any) => c.ToolUse.name);
        tools += used.length;
        if (t) lines.push(`AGENT: ${clip(t, 2000)}`);
        if (used.length) lines.push(`TOOLS: ${used.join(", ")}`);
      } else if (m?.role) {
        // Older shape: role plus segments.
        const t = (m.segments ?? []).map((s: any) => s.text ?? "").join("\n").trim();
        if (!t) continue;
        if (m.role === "user") (users++, (first ||= t), lines.push(`USER: ${t}`));
        else lines.push(`AGENT: ${clip(t, 2000)}`);
      }
    }
    if (!users) continue;
    const cwd = j.initial_project_snapshot?.worktree_snapshots?.[0]?.worktree_path as string | undefined;
    const worktrees = (j.initial_project_snapshot?.worktree_snapshots ?? []).map((w: any) => basename(w.worktree_path ?? "")).filter(Boolean);
    out.push({
      origin: "zed",
      session: `zed-${r.id}`,
      cwd,
      project: cwd ? projectFor(cwd) : "unknown",
      start: iso(r.created_at ?? r.updated_at),
      end: iso(r.updated_at),
      userTurns: users,
      toolCalls: tools,
      opener: opener(first),
      text: `Zed agent thread "${j.title ?? r.summary}"${worktrees.length ? ` in ${worktrees.join(", ")}` : ""}\n\n${lines.join("\n\n")}`,
    });
  }
  return out;
}

/** Conductor: Claude Agent SDK messages in SQLite. */
export function conductorSessions(): Imported[] {
  const db = open(join(HOME, "Library", "Application Support", "com.conductor.app", "conductor.db"));
  if (!db) return [];
  const out: Imported[] = [];
  let sessions: any[] = [];
  try {
    sessions = db.query("select * from sessions").all() as any[];
  } catch {
    return [];
  }
  for (const s of sessions) {
    const rows = db.query("select created_at, role, content from session_messages where session_id = ? and cancelled_at is null order by created_at").all(s.id) as any[];
    const lines: string[] = [];
    let users = 0, tools = 0, first = "";
    for (const r of rows) {
      if (r.role === "user") {
        const t = String(r.content ?? "").split("</system_instruction>").pop()!.trim();
        if (!t) continue;
        users++;
        first ||= t;
        lines.push(`USER: ${t}`);
      } else {
        try {
          const items = JSON.parse(r.content)?.message?.content ?? [];
          const t = items.filter((i: any) => i?.type === "text").map((i: any) => i.text).join("\n").trim();
          const used = items.filter((i: any) => i?.type === "tool_use").map((i: any) => i.name);
          tools += used.length;
          if (t) lines.push(`AGENT: ${clip(t, 2000)}`);
          if (used.length) lines.push(`TOOLS: ${used.join(", ")}`);
        } catch {}
      }
    }
    if (!users) continue;
    const cwd = s.workspace_path ?? s.cwd ?? undefined;
    out.push({
      origin: "conductor",
      session: s.claude_session_id ?? `conductor-${s.id}`,
      cwd,
      project: cwd ? projectFor(cwd) : "unknown",
      start: iso(rows[0]?.created_at),
      end: iso(rows.at(-1)?.created_at),
      userTurns: users,
      toolCalls: tools,
      opener: opener(first),
      text: `Conductor session "${s.title ?? s.id}"\n\n${lines.join("\n\n")}`,
    });
  }
  return out;
}

/** OpenCode: sessions, messages and parts in SQLite. Subagent sessions are skipped. */
export function openCodeSessions(): Imported[] {
  const db = open(join(HOME, ".local", "share", "opencode", "opencode.db"));
  if (!db) return [];
  const out: Imported[] = [];
  let sessions: any[] = [];
  try {
    sessions = db.query("select id, title, directory, time_created, time_updated from session where parent_id is null").all() as any[];
  } catch {
    return [];
  }
  for (const s of sessions) {
    const parts = db
      .query(
        `select json_extract(m.data, '$.role') as role, json_extract(p.data, '$.type') as type,
                json_extract(p.data, '$.text') as text, json_extract(p.data, '$.tool') as tool
         from part p join message m on m.id = p.message_id where p.session_id = ? order by m.time_created, p.time_created`,
      )
      .all(s.id) as any[];
    const lines: string[] = [];
    let users = 0, tools = 0, first = "";
    for (const p of parts) {
      if (p.type === "text" && p.text) {
        if (p.role === "user") {
          if (p.text.startsWith("Called the ")) continue;
          users++;
          first ||= p.text;
          lines.push(`USER: ${p.text}`);
        } else lines.push(`AGENT: ${clip(p.text, 2000)}`);
      } else if (p.type === "tool" && p.tool) {
        tools++;
        lines.push(`TOOL ${p.tool}`);
      }
    }
    if (!users) continue;
    out.push({
      origin: "opencode",
      session: `opencode-${s.id}`,
      cwd: s.directory,
      project: s.directory ? projectFor(s.directory) : "unknown",
      start: iso(s.time_created),
      end: iso(s.time_updated),
      userTurns: users,
      toolCalls: tools,
      opener: opener(first),
      text: `OpenCode session "${s.title}"\n\n${lines.join("\n\n")}`,
    });
  }
  return out;
}

/**
 * Claude Code's prompt history outlives its transcripts (cleanupPeriodDays deletes those).
 * For sessions whose transcript is gone, the prompts alone still show what was asked.
 * Entries without a session id are split into sessions by project and a two-hour gap.
 */
export function promptHistory(have: Set<string>): Imported[] {
  const file = join(HOME, ".claude", "history.jsonl");
  if (!existsSync(file)) return [];
  const groups = new Map<string, { project: string; at: number[]; prompts: string[] }>();
  const last = new Map<string, { key: string; at: number }>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const text = String(e.display ?? "").trim();
    if (!text || text.startsWith("/") || !e.project) continue;
    let key = e.sessionId;
    if (!key) {
      const prev = last.get(e.project);
      key = prev && e.timestamp - prev.at < 2 * 3600_000 ? prev.key : `prompts-${basename(e.project)}-${e.timestamp}`;
      last.set(e.project, { key, at: e.timestamp });
    }
    if (have.has(key)) continue;
    const g = groups.get(key) ?? { project: e.project as string, at: [] as number[], prompts: [] as string[] };
    g.at.push(e.timestamp);
    g.prompts.push(text);
    groups.set(key, g);
  }
  // Orchestrators that drive Claude Code send the same few prompts over and over; a person doesn't.
  const human = (g: { prompts: string[] }) => new Set(g.prompts.map((p) => p.slice(0, 80))).size >= g.prompts.length * 0.6;
  return [...groups].filter(([, g]) => g.prompts.length >= 3 && human(g)).map(([key, g]) => ({
    origin: "prompts",
    session: key,
    cwd: g.project,
    project: projectFor(g.project),
    start: iso(g.at[0]),
    end: iso(g.at.at(-1)),
    userTurns: g.prompts.length,
    toolCalls: 0,
    opener: opener(g.prompts[0]),
    text: `Prompts only: the transcript of this Claude Code session is gone, so this is just what was asked.\n\n${g.prompts.map((p, i) => `USER (${iso(g.at[i]).slice(0, 16)}): ${p}`).join("\n\n")}`,
  }));
}

/**
 * Transcripts under extra directories: agents with their own HOME, copies from another
 * machine, or a thread-history backup (gzipped chunks in `<id>.jsonl.d/`, which are joined
 * back into one file under `work`).
 */
export function transcriptsIn(dirs: string[], work: string): Transcript[] {
  const out: Transcript[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name.endsWith(".jsonl.d")) {
        const chunks = readdirSync(p).filter((f) => f.endsWith(".jsonl.gz") || f.endsWith(".jsonl")).sort();
        const joined = join(work, "joined", p.replace(/[^\w.-]+/g, "_").slice(-150).replace(/\.d$/, ""));
        mkdirSync(join(work, "joined"), { recursive: true });
        writeFileSync(joined, chunks.map((c) => (c.endsWith(".gz") ? gunzipSync(readFileSync(join(p, c))) : readFileSync(join(p, c))).toString("utf8")).join(""));
        out.push({ path: joined, source: sourceOf(joined), mtimeMs: 0 });
      } else if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".git") walk(p);
      } else if (e.name.endsWith(".jsonl") && statSync(p).size > 0 && /subagents/.test(p) === false) {
        out.push({ path: p, source: sourceOf(p), mtimeMs: 0 });
      }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}
