import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isWithin, personalize, LOCK_PATH, LOG_PATH, REPO_ROOT, STATE_DIR, STATE_PATH, type Config } from "./config";
import { discover, readDelta, sourceOf, type Delta } from "./transcripts";
import { projectFor, writeEntry } from "./journal";
import { inbandTranscripts, isPrivate, privateSessions } from "./inband";
import { vaultContext } from "./context";

type State = { transcripts: Record<string, { lines: number; reviewedAt: string }> };

type Judgment = {
  reason: string;
  entries: { type: "note" | "post"; title: string; tags: string[]; body: string }[];
  projectSummary?: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string" },
    projectSummary: { type: "string", description: "Only when the project note has no description: 1-3 sentences on what the project is." },
    entries: {
      type: "array",
      description: "New notes or posts, each on a topic no existing entry covers. Usually empty.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["note", "post"] },
          title: { type: "string", description: "The topic, as the journal's owner would search for it." },
          tags: { type: "array", items: { type: "string" } },
          body: { type: "string", description: "Markdown body, without the title heading. Link entries with [[wikilinks]]." },
        },
        required: ["type", "title", "tags", "body"],
      },
    },
  },
  required: ["reason", "entries"],
};

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return { transcripts: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function saveState(s: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

export function logDecision(entry: Record<string, unknown>) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function acquireLock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK_PATH)) {
    const { pid, at } = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && Date.now() - at < 60 * 60_000) return false;
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return true;
}

function releaseLock() {
  rmSync(LOCK_PATH, { force: true });
}

type SweepOpts = {
  dryRun?: boolean;
  verbose?: boolean;
  /** Restrict to these transcripts, skipping the idle wait (e.g. a session that just ended). */
  only?: string[];
  /** Also skip the size gate: an explicit `autoblog review`. */
  force?: boolean;
};

/**
 * The auto-mode loop: every transcript that has gone idle with enough new activity is
 * handed to the reviewer, which usually decides nothing is worth writing.
 */
export async function sweep(cfg: Config, opts: SweepOpts = {}) {
  if (!acquireLock()) {
    if (opts.verbose) console.error("autoblog: another sweep is running");
    return;
  }
  try {
    const state = loadState();
    const now = Date.now();
    const only = new Set((opts.only ?? []).map((p) => resolve(p)));
    const say = (m: string) => opts.verbose && console.error(m);

    // Sessions an agent reflects on in-band are its own business; only orphans get reviewed here.
    // Paused sessions are never reviewed, even when named explicitly.
    const inband = inbandTranscripts();
    const paused = privateSessions();
    const candidates = discover(cfg.sources).filter((t) => (only.size === 0 ? !inband.has(t.path) : only.has(t.path)));
    for (const f of only) if (!candidates.some((c) => c.path === f) && existsSync(f)) candidates.push({ path: f, source: sourceOf(f), mtimeMs: now });

    for (const t of candidates) {
      if (isPrivate(t.path, paused)) {
        if (only.has(t.path)) say(`skip (paused) ${t.path}`);
        continue;
      }
      const seen = state.transcripts[t.path];
      const explicit = only.has(t.path);
      if (!seen && !explicit && now - t.mtimeMs > cfg.lookbackHours * 3600_000) {
        // First run: don't backfill ancient history, just start watching from here.
        state.transcripts[t.path] = { lines: countLines(t.path), reviewedAt: new Date().toISOString() };
        continue;
      }
      if (!explicit && now - t.mtimeMs < cfg.idleMinutes * 60_000) continue;

      // An explicit review reads the whole transcript; the sweep resumes where it left off.
      const from = opts.force ? 0 : (seen?.lines ?? 0);
      const delta = readDelta(t.path, from, cfg.maxChars);
      if (delta.lines <= from) continue;
      const mark = () => (state.transcripts[t.path] = { lines: delta.lines, reviewedAt: new Date().toISOString() });

      if (isOwnSession(cfg, delta)) {
        mark();
        continue;
      }
      if (!opts.force && (delta.toolCalls < cfg.minToolCalls || delta.userTurns === 0)) {
        say(`skip (small: ${delta.toolCalls} tools) ${t.path}`);
        logDecision({ source: "sweep", transcript: t.path, decision: "skip-small", toolCalls: delta.toolCalls });
        mark();
        continue;
      }

      say(`review ${t.path} (${delta.toolCalls} tools, ${delta.text.length} chars)`);
      const written = await reviewDelta(cfg, delta, { transcript: t.path, dryRun: opts.dryRun, verbose: opts.verbose });
      if (written === null) continue; // reviewer failed; retry next sweep
      if (!opts.dryRun) {
        mark();
        saveState(state);
      }
    }
    if (!opts.dryRun) saveState(state);
  } finally {
    releaseLock();
  }
}

function countLines(path: string) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

/** Sessions that run inside the journal or this repo's reviewer are never reviewed. */
export function isOwnSession(cfg: Config, d: { cwd?: string }) {
  if (!d.cwd) return false;
  return isWithin(d.cwd, cfg.journal) || isWithin(d.cwd, STATE_DIR);
}

async function reviewDelta(
  cfg: Config,
  delta: Delta,
  ctx: { transcript: string; dryRun?: boolean; verbose?: boolean },
): Promise<string[] | null> {
  const project = projectFor(delta.cwd);
  const input = [
    `Project: ${project}`,
    `Agent: ${delta.source}`,
    delta.cwd ? `Directory: ${delta.cwd}` : "",
    "",
    "## The vault (an Obsidian vault; link with [[wikilinks]] using exact names)",
    vaultContext(cfg, project),
    "",
    delta.opener ? `## Session opener (earlier context)\n${delta.opener.slice(0, 2000)}\n` : "",
    "## Transcript (condensed; this is the part to judge)",
    delta.text,
  ].join("\n");

  const judgment = runJudge(cfg, input);
  if (!judgment) {
    logDecision({ source: "sweep", transcript: ctx.transcript, decision: "error" });
    return null;
  }

  const written: string[] = [];
  const agent = delta.source === "claude" ? "claude-code" : "codex";
  const entries = judgment.entries ?? [];
  for (const e of entries) {
    if (ctx.dryRun) {
      console.log(`\n=== ${e.type}: ${e.title} (${e.tags.join(", ")})\n\n${e.body}\n`);
      continue;
    }
    try {
      written.push(writeEntry(cfg, { ...e, projects: [project], projectSummary: judgment.projectSummary, cwd: delta.cwd, agent, session: delta.session, mode: "auto" }));
    } catch (err) {
      console.error(`autoblog: ${String(err)}`);
    }
  }
  if (ctx.verbose || ctx.dryRun) console.error(`reason: ${judgment.reason}`);
  logDecision({
    source: "sweep",
    transcript: ctx.transcript,
    project,
    decision: entries.length ? "write" : "skip",
    reason: judgment.reason,
    titles: entries.map((e) => `${e.type}: ${e.title}`),
    written,
    dryRun: !!ctx.dryRun,
  });
  return written;
}

export function readBar(cfg: Config): string {
  return personalize(cfg, readFileSync(join(REPO_ROOT, "prompts", "bar.md"), "utf8"));
}

function runJudge(cfg: Config, input: string): Judgment | null {
  const system = personalize(cfg, readFileSync(join(REPO_ROOT, "prompts", "review.md"), "utf8")).replace("{{BAR}}", readBar(cfg));
  const r = spawnSync(
    "claude",
    [
      "-p",
      "--model", cfg.model,
      "--output-format", "json",
      "--no-session-persistence",
      "--tools", "",
      "--system-prompt", system,
      "--json-schema", JSON.stringify(SCHEMA),
    ],
    {
      input,
      encoding: "utf8",
      cwd: STATE_DIR,
      env: { ...process.env, AUTOBLOG_REVIEWER: "1" },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60_000,
    },
  );
  if (r.status !== 0) {
    console.error(`autoblog: reviewer failed: ${r.stderr || r.stdout}`.slice(0, 2000));
    return null;
  }
  try {
    const out = JSON.parse(r.stdout);
    return out.structured_output ?? JSON.parse(out.result);
  } catch (e) {
    console.error(`autoblog: could not parse reviewer output: ${String(e)}`);
    return null;
  }
}
