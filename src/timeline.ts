import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { STATE_DIR, type Config } from "./config";
import { commit, ensureJournal, projectFor, withLock } from "./journal";
import { discover, readDays, sourceOf } from "./transcripts";
import { isOwnSession } from "./review";

/**
 * The timeline is a work log across every project: one file per day, one line per thing
 * done ("Next Cloud: added canvas posts…"). Unlike notes and posts there's no bar. A fast
 * model reads each session's new activity, day by day, and adds what got done.
 */

const STATE = join(STATE_DIR, "timeline.json");
type State = Record<string, number>; // transcript path → lines already logged

const loadState = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
function saveState(s: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

export const timelineDir = (cfg: Config) => join(cfg.journal, "timeline");
const dayFile = (cfg: Config, day: string) => join(timelineDir(cfg), `${day}.md`);

/** The day's lines, without frontmatter. */
export function dayLines(cfg: Config, day: string): string[] {
  const f = dayFile(cfg, day);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .filter((l) => l.startsWith("- "));
}

function appendLines(cfg: Config, day: string, lines: string[]) {
  mkdirSync(timelineDir(cfg), { recursive: true });
  const all = [...dayLines(cfg, day), ...lines];
  writeFileSync(dayFile(cfg, day), `---\ndate: ${day}\ntype: timeline\n---\n\n${all.join("\n")}\n`);
}

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          thing: { type: "string", description: 'The project or effort, as Nate would name it: "Next Cloud", "Next Cloud for Mac", "Ramble", "autoblog", "Taxes".' },
          isProject: { type: "boolean", description: "True when the thing is the session's own project." },
          text: { type: "string", description: "10 to 30 words, past tense: what changed, with the key detail." },
        },
        required: ["thing", "isProject", "text"],
      },
    },
  },
  required: ["lines"],
};

const SYSTEM = `You keep Nate's work log: one line per thing done, across all his projects, one file per day. You get a condensed slice of one coding-agent session from one day, and the lines already logged for that day.

Return a line for each thing this slice actually got done, up to 12 (a long session can do many things; a quiet one, none): something built, fixed, shipped, released, deployed, set up, decided, or found out. Each line names the thing and says what happened in 10 to 30 words: the headline, plus the one detail that makes it findable later ("Added canvas posts: paste images and arrange them, saved per post"; "Shipped 0.1.0 with Sparkle updates, signed and notarized"). Write it the way Nate would jot it down, not as a report. It should make sense to someone reading the log months later with no other context: say what the thing does for the person using it, not how the work was organized. Leave out test counts, file names, and where things are stored unless that's the point.

Good: "Added Post and Save as Draft to the editor: uploads local media, swaps in the URLs, then creates or updates the post with your gh token. ⌘↩ posts, ⇧⌘↩ saves a draft."
Bad: "Merged #57 so agents can pick folders in Open and Save panels, then #64 after a rebase; cut the 0.5.0 release PR #65." Better: "Agents can now pick folders in Open and Save panels; released 0.5.0, signed and notarized."
Bad: "Replaced the scattered live-check issue #42 with #129: 14 checks plus 2 unknowns. Closed #1, #2, #3 as shipped." That's issue bookkeeping; skip it, or say what was learned.

- One line per piece of work. Steps toward the same result are one line: a release script, its upload step and its hardening are "Built the release pipeline: …".
- \`thing\` is the project, not a feature; the text says what was done to it. Use the same thing for every line from one project.
- Never mention PR or issue numbers, merges, rebases or branch names. Say what changed, not how it landed.
- Skip housekeeping (saving credentials, reading docs, reviewing a plan, triaging or closing issues) unless it settled something.
- Skip anything already in the day's lines, even if worded differently.
- Skip chit-chat, questions that went nowhere, routine checks, and how the agent went about it.
- A slice where nothing landed gets no lines.
- Never include secrets, tokens or passwords.`;

function askModel(cfg: Config, input: string): { thing: string; isProject: boolean; text: string }[] | null {
  const r = spawnSync(
    "claude",
    ["-p", "--model", cfg.timelineModel, "--output-format", "json", "--no-session-persistence", "--tools", "", "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(SCHEMA)],
    { input, encoding: "utf8", cwd: STATE_DIR, env: { ...process.env, AUTOBLOG_REVIEWER: "1" }, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 },
  );
  if (r.status !== 0) {
    console.error(`autoblog: timeline model failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
    return null;
  }
  try {
    const out = JSON.parse(r.stdout);
    return (out.structured_output ?? JSON.parse(out.result)).lines ?? [];
  } catch (e) {
    console.error(`autoblog: could not parse timeline output: ${String(e)}`);
    return null;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Log new activity. The sweep calls this for idle transcripts; `only` logs the given
 * transcripts from the start (a backfill). Returns the number of lines added.
 */
export function timelinePass(cfg: Config, opts: { only?: string[]; dryRun?: boolean; verbose?: boolean } = {}): number {
  ensureJournal(cfg);
  const state = loadState();
  const start = { ...state };
  const now = Date.now();
  const only = new Set((opts.only ?? []).map((p) => resolve(p)));
  const say = (m: string) => opts.verbose && console.error(m);
  const candidates = only.size
    ? [...only].filter(existsSync).map((path) => ({ path, source: sourceOf(path), mtimeMs: now }))
    : discover(cfg.sources);
  let added = 0;
  const projectNotes = new Set(existsSync(join(cfg.journal, "projects")) ? readdirSync(join(cfg.journal, "projects")).map((f) => f.replace(/\.md$/, "")) : []);

  for (const t of candidates) {
    const explicit = only.has(t.path);
    if (!(t.path in state) && !explicit && now - t.mtimeMs > cfg.lookbackHours * 3600_000) {
      // First sight of an old transcript: start watching from here. Backfills pass it explicitly.
      state[t.path] = Number.MAX_SAFE_INTEGER;
      continue;
    }
    if (!explicit && now - t.mtimeMs < cfg.idleMinutes * 60_000) continue;
    // An explicit run picks up where the log left off, or from the start for a transcript the
    // sweep only marked as seen.
    const was = state[t.path];
    const from = was === undefined || (explicit && was === Number.MAX_SAFE_INTEGER) ? 0 : was;
    const days = readDays(t.path, from, 60_000);
    const total = days[0]?.lines ?? from;
    if (days.length && isOwnSession(cfg, days[0])) {
      state[t.path] = total;
      continue;
    }
    let ok = true;
    for (const d of days) {
      if (d.userTurns === 0 || d.toolCalls + d.userTurns < 3) continue;
      const project = projectFor(d.cwd);
      const input = [
        `Day: ${d.day}`,
        `Session project: ${project}${d.cwd ? ` (${d.cwd})` : ""}`,
        d.opener ? `The session began with: ${oneLine(d.opener).slice(0, 400)}` : "",
        `Already logged for ${d.day}:\n${dayLines(cfg, d.day).join("\n") || "(nothing yet)"}`,
        `---\n${d.text}`,
      ].filter(Boolean).join("\n\n");
      const picks = askModel(cfg, input);
      if (!picks) {
        ok = false;
        break;
      }
      const lines = picks
        .slice(0, 12)
        .filter((p) => p.text.trim())
        .map((p) => {
          const label = oneLine(p.thing) || project;
          const tag = p.isProject && projectNotes.has(project) ? `[[${project}]]` : `**${label}**`;
          return `- ${tag}: ${oneLine(p.text)}`;
        });
      say(`${d.day} ${project}: ${lines.length ? `\n  ${lines.join("\n  ")}` : "nothing"}`);
      if (!lines.length || opts.dryRun) continue;
      withLock(cfg, () => appendLines(cfg, d.day, lines));
      added += lines.length;
    }
    // A failed model call leaves the transcript where it was, to retry next sweep.
    if (ok && !opts.dryRun) state[t.path] = total;
  }
  // Merge into what's on disk now, so parallel backfills don't drop each other's progress.
  if (!opts.dryRun) withLock(cfg, () => saveState({ ...loadState(), ...Object.fromEntries(Object.entries(state).filter(([k, v]) => start[k] !== v)) }));
  if (added) withLock(cfg, () => commit(cfg, `timeline: ${added} line${added === 1 ? "" : "s"}`));
  return added;
}
