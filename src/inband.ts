import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, type Config } from "./config";
import { projectFor, projectSummary } from "./journal";
import { logDecision } from "./review";

/**
 * In-band reflection: the agent running the session decides what is worth writing,
 * with its full context. A Stop hook fires at the end of every turn; once enough work
 * has piled up since the last checkpoint, it asks the agent to reflect before stopping.
 */

const SESSIONS = join(STATE_DIR, "sessions.json");

type Checkpoint = {
  transcript?: string;
  offset: number;
  turns: number;
  at: string;
  agent: string;
  /** Set while the user has paused journaling for this conversation. */
  paused?: string;
  /** Once paused, a session stays out of the sweep, timeline and backfill for good. */
  private?: boolean;
  /** When journaling was last turned back on; reflection only looks after this. */
  resumed?: string;
};
type Sessions = Record<string, Checkpoint>;

export function loadSessions(): Sessions {
  return existsSync(SESSIONS) ? JSON.parse(readFileSync(SESSIONS, "utf8")) : {};
}

function saveSessions(s: Sessions) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSIONS, JSON.stringify(s, null, 2));
}

/** Transcripts some agent reflects on in-band; the fallback sweep leaves these alone. */
export function inbandTranscripts(): Set<string> {
  return new Set(Object.values(loadSessions()).map((c) => c.transcript).filter((t): t is string => !!t));
}

/** Sessions that were paused at some point; nothing reads them automatically. */
export function privateSessions(): string[] {
  return Object.entries(loadSessions()).filter(([, c]) => c.private).map(([id]) => id);
}

/** Whether a transcript path (or session id) belongs to a paused session. Paths embed the session id. */
export function isPrivate(pathOrSession: string, ids = privateSessions()): boolean {
  return ids.some((id) => pathOrSession.includes(id));
}

export function isPaused(session?: string): boolean {
  return !!session && !!loadSessions()[session]?.paused;
}

/** The session the calling agent is running in, from its harness's environment. */
export function currentSession(): string | undefined {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || undefined;
}

/** Pause (or with on=false, resume) checkpoints for a session. */
export function setPaused(session: string, on: boolean, agent: string, transcript?: string) {
  const sessions = loadSessions();
  const c: Checkpoint = sessions[session] ?? { offset: 0, turns: 0, at: "", agent };
  c.transcript ??= transcript;
  if (on) {
    c.paused = new Date().toISOString();
    c.private = true;
  } else if (c.paused) {
    delete c.paused;
    c.resumed = new Date().toISOString();
  }
  sessions[session] = c;
  saveSessions(sessions);
}

export const PAUSED_NOTE = `autoblog is paused for this conversation. Don't journal anything from it: no autoblog write, revise or skip, and nothing from it in later entries. Checkpoints won't fire, and the sweep, timeline and backfill leave it out. Only \`autoblog pause --off\`, run because the user asked, turns it back on.`;

// Tool calls are counted by marker rather than parsed, so a Stop on a days-long
// transcript only reads the bytes appended since the last checkpoint.
const TOOL_MARKERS = [/"type":"tool_use"/g, /"type":"(?:custom_tool_call|function_call|local_shell_call)"/g];

function countSince(path: string, offset: number): { toolCalls: number; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = offset <= size ? offset : 0;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    let toolCalls = 0;
    for (const re of TOOL_MARKERS) toolCalls += text.match(re)?.length ?? 0;
    return { toolCalls, size };
  } finally {
    closeSync(fd);
  }
}

export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
};

/** Returns the reflection prompt if this Stop should become a checkpoint, else null. */
export function checkpoint(cfg: Config, ev: HookInput, agent: string): string | null {
  if (ev.stop_hook_active || !ev.session_id) return null;
  const sessions = loadSessions();
  const prev: Checkpoint = sessions[ev.session_id] ?? { offset: 0, turns: 0, at: "", agent };
  prev.transcript ??= ev.transcript_path;
  prev.turns++;
  if (prev.paused) {
    // Paused: keep the checkpoint moving so resuming doesn't count the paused stretch.
    if (ev.transcript_path && existsSync(ev.transcript_path)) prev.offset = statSync(ev.transcript_path).size;
    sessions[ev.session_id] = { ...prev, turns: 0 };
    saveSessions(sessions);
    return null;
  }

  let due: boolean;
  let toolCalls = 0;
  let size = prev.offset;
  if (ev.transcript_path && existsSync(ev.transcript_path)) {
    ({ toolCalls, size } = countSince(ev.transcript_path, prev.offset));
    due = toolCalls >= cfg.reflectEvery;
  } else {
    // No transcript to measure: fall back to counting turns.
    due = prev.turns >= cfg.reflectEveryTurns;
  }

  if (due) sessions[ev.session_id] = { ...prev, offset: size, turns: 0, at: new Date().toISOString() };
  else sessions[ev.session_id] = prev;
  saveSessions(sessions);
  if (!due) return null;

  const project = projectFor(ev.cwd);
  return reflectionPrompt({ owner: cfg.owner, project, toolCalls, transcript: ev.transcript_path, session: ev.session_id, agent, summary: projectSummary(cfg, project), since: prev.resumed });
}

function reflectionPrompt(o: { owner: string; project: string; toolCalls: number; transcript?: string; session: string; agent: string; summary: string | null; since?: string }): string {
  return `autoblog checkpoint (${o.toolCalls} tool calls since the last one). This is an automatic reflection; it is not from the user.

Look back over this whole session, not just the last turn.${o.since ? ` The user paused journaling earlier in it, so leave out everything from before it was turned back on at ${o.since}.` : ""} Did we learn something that belongs in ${o.owner}'s journal? Most checkpoints produce nothing. If not, run:
  autoblog skip --session ${o.session} "<one-sentence reason>"
If something might qualify, run \`autoblog guide\` (the autoblog skill) and follow it, passing --session ${o.session} --agent ${o.agent} --mode auto.${o.summary ? "" : ` The ${o.project} project has no description yet, so add --project-summary when you write.`}${o.transcript ? ` If compaction dropped details you need, your full transcript is at ${o.transcript} (grep it; don't read it whole).` : ""}

Then stop. Don't resume other work or summarize this to the user.`;
}
