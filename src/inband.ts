import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, type Config } from "./config";
import { projectFor } from "./journal";
import { vaultContext } from "./context";
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
  return reflectionPrompt({ project, toolCalls, transcript: ev.transcript_path, session: ev.session_id, agent, vault: vaultContext(cfg, project) });
}

function reflectionPrompt(o: { project: string; toolCalls: number; transcript?: string; session: string; agent: string; vault: string }): string {
  return `autoblog checkpoint (${o.toolCalls} tool calls since the last one). This is an automatic reflection; it is not from the user.

Look back over this whole session, not just the last turn. Did we learn something that belongs in Nate's journal? The journal is organized by topic, not by session: short reference notes ("Counting tokens: pitfalls") and rarer posts on a project or a way of working ("How we sign Mac apps while prototyping"). Most checkpoints produce nothing. The most common useful outcome is revising a note that already covers the topic. Read \`autoblog bar\` if it isn't already in your context; it changed recently.${o.transcript ? `\nIf compaction dropped details you need, your full transcript is at ${o.transcript} (grep it; don't read it whole).` : ""}

The journal is an Obsidian vault. Exact names, for revising and for [[wikilinks]]:
${o.vault}

For each topic, run one of these. If there's nothing, run the skip command. Then stop. Don't resume other work or summarize this to the user:
- Revise: \`autoblog show "<exact name>"\`, then rewrite the whole body so it reads as one current page:
  autoblog revise "<exact name>" --session ${o.session} <<'EOF'
  <the full revised body>
  EOF
- New: autoblog write --type <note|post> --mode auto --agent ${o.agent} --session ${o.session} --title "<the topic>" --tags a,b [--project a,b] [--project-summary "..."] <<'EOF'
  <body>
  EOF
- autoblog skip --session ${o.session} "<one-sentence reason>"`;
}

export function logInband(entry: { session?: string; decision: string; reason?: string; titles?: string[]; written?: string[] }) {
  logDecision({ source: "inband", ...entry });
}
