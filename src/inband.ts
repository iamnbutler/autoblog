import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, type Config } from "./config";
import { listPosts, projectFor } from "./journal";
import { logDecision } from "./review";

/**
 * In-band reflection: the agent running the session decides what is worth writing,
 * with its full context. A Stop hook fires at the end of every turn; once enough work
 * has piled up since the last checkpoint, it asks the agent to reflect before stopping.
 */

const SESSIONS = join(STATE_DIR, "sessions.json");

type Checkpoint = { transcript?: string; offset: number; turns: number; at: string; agent: string };
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
  const posts = listPosts(cfg).filter((p) => p.project === project).slice(0, 15);
  return reflectionPrompt({ project, toolCalls, transcript: ev.transcript_path, session: ev.session_id, agent, posts });
}

function reflectionPrompt(o: {
  project: string;
  toolCalls: number;
  transcript?: string;
  session: string;
  agent: string;
  posts: { path: string; title: string }[];
}): string {
  const existing = o.posts.length ? o.posts.map((p) => `  - ${p.path} | ${p.title}`).join("\n") : "  (none yet)";
  return `autoblog checkpoint (${o.toolCalls} tool calls since the last one). This is an automatic reflection; it is not from the user.

Look back over this whole session, not just the last turn, and decide whether there's a story here worth a post on Nate's private blog: something we figured out, built, decided, or learned that he'd want to read a year from now, having forgotten this project entirely. Most checkpoints produce nothing. The bar and the writing style are in \`autoblog bar\`. Read it if it isn't already in your context; it changed recently.${o.transcript ? `\nIf compaction dropped details you need, your full transcript is at ${o.transcript} (grep it; don't read it whole).` : ""}

Existing posts for ${o.project} (update one of these rather than duplicating it):
${existing}

Do exactly one of these, then stop. Don't resume other work or summarize this to the user:
- autoblog write --mode auto --agent ${o.agent} --session ${o.session} --title "..." --kind <fix|solution|howto|decision|discovery|kickoff> --tags a,b --signal <1-3> <<'EOF'
  <body>
  EOF
- autoblog update <post path> --session ${o.session} <<'EOF'
  <what's new>
  EOF
- autoblog skip --session ${o.session} "<one-sentence reason>"`;
}

export function logInband(entry: { session?: string; decision: string; reason?: string; titles?: string[]; written?: string[] }) {
  logDecision({ source: "inband", ...entry });
}
