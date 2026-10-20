import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { STATE_DIR, type Config } from "./config";
import { commit, ensureJournal, projectFor, withLock } from "./journal";
import { discover, readDays, sourceOf } from "./transcripts";
import { isOwnSession } from "./review";
import { isPrivate, privateSessions } from "./inband";

/**
 * The timeline is a work log across every project: one file per day, a few lines per project
 * ("Next Cloud: added canvas posts…"). Unlike notes and posts there's no bar. A fast model reads
 * each session's new activity, day by day, and rewrites that day's lines for the projects it
 * touched, so later work folds into earlier lines instead of piling up under them.
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

/** "Next Cloud", "next-cloud" and "[[next-cloud]]" are the same thing. */
const key = (thing: string) => thing.toLowerCase().replace(/[^a-z0-9]/g, "");
const thingOf = (line: string) => line.match(/^- (?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\*\*(.+?)\*\*):/)?.slice(1).find(Boolean) ?? "";

/** Replace each given thing's lines for the day, keeping the day's order and every other thing's lines. */
function replaceLines(cfg: Config, day: string, things: Map<string, string[]>) {
  mkdirSync(timelineDir(cfg), { recursive: true });
  const out: string[] = [];
  const placed = new Set<string>();
  for (const l of dayLines(cfg, day)) {
    const k = key(thingOf(l));
    if (!things.has(k)) out.push(l);
    else if (!placed.has(k)) out.push(...things.get(k)!), placed.add(k);
  }
  for (const [k, ls] of things) if (!placed.has(k)) out.push(...ls);
  writeFileSync(dayFile(cfg, day), `---\ndate: ${day}\ntype: timeline\n---\n\n${[...new Set(out)].join("\n")}\n`);
}

const SCHEMA = {
  type: "object",
  properties: {
    things: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          thing: { type: "string", description: 'The project or effort, as the owner would name it: "Next Cloud", "Ramble", "autoblog", "Taxes". Use the name already in the day\'s lines when there is one.' },
          lines: { type: "array", maxItems: 3, items: { type: "string" }, description: "The thing's complete lines for the day, replacing any already logged: 1 to 3, past tense, 10 to 30 words each, without the thing's name." },
        },
        required: ["thing", "lines"],
      },
    },
  },
  required: ["things"],
};

const RULES = (owner: string) => `The log is for remembering what moved, read months later with no other context. Per thing per day, log the most important contributions: one line each for the one or two that mattered most (something shipped, built, fixed, decided, or found out), and at most one more line that sums up the smaller things together. Three lines is the ceiling, not the goal; one is often right.

Each line says what happened in 10 to 30 words: the headline, plus the one detail that makes it findable later. Write it the way ${owner} would jot it down, not as a report: what it does for the person using it, not how the work was organized.

Good: "Shipped Canary 0.0.50.80: project access and sharing, collaborator limits on agent runs, and moving channels straight to a cloud workspace."
Good: "Smaller: fixed the submit button spinner, tidied channel menus, and provider setup now offers to set one up instead of erroring."
Bad: six lines for one release (each test run, each fix, the deploy). Fold steps, test runs, and the findings that led to a fix into the line for what came of them.
Bad: "Freed 178Gi to 373Gi" followed later by "Corrected the total: 419Gi". Keep only the right number.

- Never mention PR or issue numbers, merges, rebases or branch names, test counts, or file names unless they're the point.
- Leave out edits to ${owner}'s journal itself (writing or revising notes and posts); the entries are their own record.
- Skip housekeeping, chit-chat, routine checks, and how the agent went about it.
- Never include secrets, tokens or passwords.`;

const system = (cfg: Config) => `You keep ${cfg.owner}'s work log: a few lines per project per day, one file per day. You get a condensed slice of one coding-agent session from one day, and the lines already logged for that day.

For each thing this slice actually moved forward, return its complete lines for the day: the lines already logged for it, merged with what this slice did, rewritten to fit the limit below. What you return replaces that thing's existing lines, so keep anything already logged that still matters, and correct anything this slice shows was wrong. Don't return things this slice didn't touch; their lines stay as they are. A slice where nothing landed returns no things.

\`thing\` is the project, not a feature; the session's own project unless the work was clearly for something else. Reuse the exact name the day's lines already use for it.

${RULES(cfg.owner)}`;

const compactSystem = (cfg: Config) => `You keep ${cfg.owner}'s work log: a few lines per project per day. You get one project's lines from one day, written too finely. Rewrite them as that project's complete lines for the day, keeping what mattered and dropping the rest. Use only what the lines say; don't invent detail.

${RULES(cfg.owner)}`;

function askModel(cfg: Config, prompt: string, input: string): { thing: string; lines: string[] }[] | null {
  const r = spawnSync(
    "claude",
    ["-p", "--model", cfg.timelineModel, "--output-format", "json", "--no-session-persistence", "--tools", "", "--system-prompt", prompt, "--json-schema", JSON.stringify(SCHEMA)],
    { input, encoding: "utf8", cwd: STATE_DIR, env: { ...process.env, AUTOBLOG_REVIEWER: "1" }, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 },
  );
  if (r.status !== 0) {
    console.error(`autoblog: timeline model failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
    return null;
  }
  try {
    const out = JSON.parse(r.stdout);
    return (out.structured_output ?? JSON.parse(out.result)).things ?? [];
  } catch (e) {
    console.error(`autoblog: could not parse timeline output: ${String(e)}`);
    return null;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The name each thing already goes by in the day's lines, so a rewrite keeps its tag. */
function existingNames(cfg: Config, day: string) {
  return new Map(dayLines(cfg, day).map((l) => [key(thingOf(l)), thingOf(l)] as const));
}

/** Model output as finished lines, keyed by thing. A thing with a project note links to it. */
function formatThings(picks: { thing: string; lines: string[] }[], names: Map<string, string>, projectNotes: Set<string>, fallback: string) {
  const notes = new Map([...projectNotes].map((n) => [key(n), n] as const));
  const things = new Map<string, string[]>();
  for (const p of picks) {
    const label = oneLine(p.thing) || fallback;
    const k = key(label);
    const note = notes.get(k);
    const tag = note ? `[[${note}]]` : `**${names.get(k) ?? label}**`;
    const lines = p.lines.map(oneLine).filter(Boolean).slice(0, 3).map((t) => `- ${tag}: ${t}`);
    if (lines.length) things.set(k, [...(things.get(k) ?? []), ...lines].slice(0, 3));
  }
  return things;
}

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
  const paused = privateSessions();
  const projectNotes = new Set(existsSync(join(cfg.journal, "projects")) ? readdirSync(join(cfg.journal, "projects")).map((f) => f.replace(/\.md$/, "")) : []);

  for (const t of candidates) {
    const explicit = only.has(t.path);
    if (isPrivate(t.path, paused)) {
      if (explicit) say(`skip (paused) ${t.path}`);
      continue;
    }
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
      const picks = askModel(cfg, system(cfg), input);
      if (!picks) {
        ok = false;
        break;
      }
      const things = formatThings(picks, existingNames(cfg, d.day), projectNotes, project);
      const shown = [...things.values()].flat();
      say(`${d.day} ${project}: ${shown.length ? `\n  ${shown.join("\n  ")}` : "nothing"}`);
      if (!things.size || opts.dryRun) continue;
      withLock(cfg, () => replaceLines(cfg, d.day, things));
      added += shown.length;
    }
    // A failed model call leaves the transcript where it was, to retry next sweep.
    if (ok && !opts.dryRun) state[t.path] = total;
  }
  // Merge into what's on disk now, so parallel backfills don't drop each other's progress.
  if (!opts.dryRun) withLock(cfg, () => saveState({ ...loadState(), ...Object.fromEntries(Object.entries(state).filter(([k, v]) => start[k] !== v)) }));
  if (added) withLock(cfg, () => commit(cfg, `timeline: ${added} line${added === 1 ? "" : "s"}`));
  return added;
}

/**
 * Rewrite days logged before the per-project limit: each project with more than `over` lines on
 * a day is condensed to at most three. Returns the number of lines removed.
 */
export function compactPass(cfg: Config, opts: { days?: string[]; over?: number; dryRun?: boolean; verbose?: boolean } = {}): number {
  const say = (m: string) => opts.verbose && console.error(m);
  const dir = timelineDir(cfg);
  const days = opts.days?.length ? opts.days : existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, -3)).sort() : [];
  const projectNotes = new Set(existsSync(join(cfg.journal, "projects")) ? readdirSync(join(cfg.journal, "projects")).map((f) => f.replace(/\.md$/, "")) : []);
  let removed = 0;
  for (const day of days) {
    const groups = new Map<string, string[]>();
    for (const l of dayLines(cfg, day)) groups.set(key(thingOf(l)), [...(groups.get(key(thingOf(l))) ?? []), l]);
    const names = existingNames(cfg, day);
    const things = new Map<string, string[]>();
    for (const [k, ls] of groups) {
      if (!k || ls.length <= (opts.over ?? 3)) continue;
      const name = names.get(k)!;
      const picks = askModel(cfg, compactSystem(cfg), `Day: ${day}\nProject: ${name}\n\n${ls.map((l) => l.replace(/^- .+?: /, "- ")).join("\n")}`);
      if (!picks) continue;
      // However the model names it, these lines belong to this thing.
      const out = formatThings(picks.map((p) => ({ ...p, thing: name })), names, projectNotes, name).get(k) ?? [];
      if (!out.length) continue;
      say(`${day} ${name}: ${ls.length} -> ${out.length}\n  ${out.join("\n  ")}`);
      things.set(k, out);
      removed += ls.length - out.length;
    }
    if (things.size && !opts.dryRun) withLock(cfg, () => replaceLines(cfg, day, things));
  }
  if (removed && !opts.dryRun) withLock(cfg, () => commit(cfg, `timeline: compact, ${removed} lines fewer`));
  return removed;
}
