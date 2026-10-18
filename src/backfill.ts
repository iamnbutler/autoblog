import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { REPO_ROOT, STATE_DIR, type Config } from "./config";
import { listEntries, parseFile, projectFor } from "./journal";
import { discover, readDelta, sourceOf, type Transcript } from "./transcripts";
import { isOwnSession } from "./review";
import { linkDue } from "./link";
import { timelinePass } from "./timeline";

/**
 * Backfill the journal from old sessions. The sweep only watches new activity, so history
 * goes through the same three steps that work by hand: agents harvest topics from groups of
 * sessions (read-only), one curator merges them into a plan, and writers write each section
 * of it. Sessions already cited by an entry, or done by an earlier backfill, are left out,
 * so a second machine doesn't redo the first one's work.
 */

const STATE = join(STATE_DIR, "backfill.json");
const GROUP_CHARS = 1_200_000; // condensed transcript per harvester
const TOOLS = ["Bash(autoblog:*)", "Bash(git log:*)", "Bash(git show:*)", "Read", "Grep", "Glob", "Write", "Edit"];

type Session = {
  path: string;
  session: string;
  project: string;
  start: string;
  end: string;
  userTurns: number;
  toolCalls: number;
  opener: string;
};

const loadDone = (): Set<string> => new Set(existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")).sessions : []);
function saveDone(done: Set<string>) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ sessions: [...done].sort() }, null, 2));
}

/** Session ids cited by any entry. */
function citedSessions(cfg: Config): Set<string> {
  const out = new Set<string>();
  for (const e of listEntries(cfg)) {
    const s = parseFile(readFileSync(join(cfg.journal, e.path), "utf8")).front.sessions;
    for (const id of Array.isArray(s) ? s : s ? [s] : []) out.add(String(id));
  }
  return out;
}

function stamps(path: string): [string, string] {
  const all = readFileSync(path, "utf8").match(/"timestamp":"([^"]+)"/g) ?? [];
  const at = (s?: string) => s?.slice(13, -1) ?? "";
  return [at(all[0]), at(all.at(-1))];
}

export type BackfillOpts = { since?: string; until?: string; project?: string; paths?: string[]; dryRun?: boolean; parallel?: number; timeline?: boolean };

/** Every old session worth reading: not autoblog's own, not too small, not done before. */
export function inventory(cfg: Config, opts: BackfillOpts): Session[] {
  const archived = (): Transcript[] => {
    const out: Transcript[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) out.push({ path: p, source: "codex", mtimeMs: 0 });
      }
    };
    if (cfg.sources.includes("codex")) walk(join(homedir(), ".codex", "archived_sessions"));
    return out;
  };
  const transcripts = opts.paths?.length ? opts.paths.map((path) => ({ path, source: sourceOf(path), mtimeMs: 0 })) : [...discover(cfg.sources), ...archived()];
  const skip = new Set([...citedSessions(cfg), ...loadDone()]);
  const out: Session[] = [];
  const seen = new Set<string>();
  for (const t of transcripts) {
    let d;
    try {
      d = readDelta(t.path, 0, 1);
    } catch {
      continue;
    }
    const session = d.session ?? basename(t.path, ".jsonl");
    if (seen.has(session) || skip.has(session) || isOwnSession(cfg, d)) continue;
    seen.add(session);
    if (d.userTurns === 0 || d.toolCalls < cfg.minToolCalls) continue;
    const [start, end] = stamps(t.path);
    if (opts.since && end && end < opts.since) continue;
    if (opts.until && start && start.slice(0, 10) > opts.until) continue;
    const project = projectFor(d.cwd);
    if (opts.project && project !== opts.project) continue;
    out.push({ path: t.path, session, project, start, end, userTurns: d.userTurns, toolCalls: d.toolCalls, opener: (d.opener ?? "").replace(/\s+/g, " ").slice(0, 160) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Pack sessions into harvest groups: one project per group where it's big enough, oldest first. */
function groups(sessions: (Session & { file: string; chars: number })[]) {
  const byProject = new Map<string, typeof sessions>();
  for (const s of sessions) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
  const out: { name: string; sessions: typeof sessions }[] = [];
  let misc: typeof sessions = [];
  const flush = (name: string, list: typeof sessions) => {
    let cur: typeof sessions = [];
    let size = 0;
    for (const s of list) {
      if (cur.length && size + s.chars > GROUP_CHARS) {
        out.push({ name, sessions: cur });
        (cur = []), (size = 0);
      }
      cur.push(s);
      size += s.chars;
    }
    if (cur.length) out.push({ name, sessions: cur });
  };
  for (const [project, list] of byProject) {
    const size = list.reduce((n, s) => n + s.chars, 0);
    if (size < GROUP_CHARS / 4) misc.push(...list);
    else flush(project, list);
  }
  misc.sort((a, b) => a.start.localeCompare(b.start));
  flush("misc", misc);
  return out.map((g, i) => ({ ...g, name: `${String(i + 1).padStart(2, "0")}-${g.name.replace(/[^\w.-]+/g, "-")}` }));
}

function template(name: string, vars: Record<string, string>): string {
  let s = readFileSync(join(REPO_ROOT, "prompts", name), "utf8");
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{{${k}}}`, v);
  return s;
}

/** One agent with tools to read the journal and transcripts, and to run autoblog. */
function runAgent(cfg: Config, prompt: string, cwd: string, log: string): Promise<boolean> {
  return new Promise((done) => {
    const out = createWriteStream(log);
    const p = spawn("claude", ["-p", "--model", cfg.model, "--no-session-persistence", "--permission-mode", "acceptEdits", "--allowedTools", ...TOOLS], {
      cwd,
      env: { ...process.env, AUTOBLOG_REVIEWER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    p.stdout.pipe(out);
    p.stderr.pipe(out);
    p.stdin.end(prompt);
    p.on("close", (code) => done(code === 0));
    p.on("error", () => done(false));
  });
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

export async function backfill(cfg: Config, opts: BackfillOpts) {
  const sessions = inventory(cfg, opts);
  const say = (m: string) => console.error(m);
  if (!sessions.length) return say("autoblog: nothing to backfill");
  const projects = new Map<string, number>();
  for (const s of sessions) projects.set(s.project, (projects.get(s.project) ?? 0) + 1);
  say(`${sessions.length} sessions from ${sessions[0].start.slice(0, 10)} to ${sessions.at(-1)!.end.slice(0, 10)}, across ${projects.size} projects:`);
  say([...projects].sort((a, b) => b[1] - a[1]).map(([p, n]) => `  ${p}: ${n}`).join("\n"));
  if (opts.dryRun) return;

  const dir = join(STATE_DIR, "backfill", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  for (const d of ["sessions", "harvest", "logs"]) mkdirSync(join(dir, d), { recursive: true });

  // Readable transcripts, one file per session.
  const files = sessions.map((s, i) => {
    const d = readDelta(s.path, 0, Number.MAX_SAFE_INTEGER, { full: true });
    const file = join(dir, "sessions", `${String(i + 1).padStart(4, "0")}.md`);
    const text = `# ${s.project}, session ${s.session}, ${s.start} to ${s.end} (${s.userTurns} user turns, ${s.toolCalls} tool calls)\nTranscript: ${s.path}\nWorking directory: ${d.cwd ?? "?"}\n\n${d.text}\n`;
    writeFileSync(file, text);
    return { ...s, file, chars: text.length };
  });
  const plan = groups(files);
  say(`${plan.length} harvest groups in ${dir}`);

  // 1. Harvest, in parallel.
  const parallel = opts.parallel ?? 4;
  await pool(plan, parallel, async (g) => {
    const index = join(dir, "harvest", `${g.name}.index.txt`);
    writeFileSync(index, g.sessions.map((s) => [s.file, s.session, `${s.start.slice(0, 10)}..${s.end.slice(0, 10)}`, s.project, `${s.userTurns} turns`, `${s.toolCalls} tools`, s.opener].join("\t")).join("\n") + "\n");
    const projects = [...new Set(g.sessions.map((s) => s.project))];
    const group = `${g.sessions.length} sessions, ${g.sessions[0].start.slice(0, 10)} to ${g.sessions.at(-1)!.end.slice(0, 10)}, from ${projects.join(", ")}.`;
    const out = join(dir, "harvest", `${g.name}.md`);
    say(`harvest ${g.name} (${g.sessions.length} sessions)`);
    const ok = await runAgent(cfg, template("backfill-harvest.md", { GROUP: group, INDEX: index, OUT: out }), dir, join(dir, "logs", `harvest-${g.name}.log`));
    if (!ok || !existsSync(out)) say(`  harvest ${g.name} failed; see logs/harvest-${g.name}.log`);
  });
  const harvests = plan.map((g) => join(dir, "harvest", `${g.name}.md`)).filter(existsSync);
  if (!harvests.length) return say("autoblog: every harvest failed; nothing written");

  // 2. Curate into one plan, split into sections.
  const curated = join(dir, "curated.md");
  say("curate");
  await runAgent(cfg, template("backfill-curate.md", { HARVESTS: harvests.map((h) => `\`${h}\``).join(", "), OUT: curated }), dir, join(dir, "logs", "curate.log"));
  if (!existsSync(curated)) return say(`autoblog: curation failed; see ${join(dir, "logs", "curate.log")}`);
  const sections = [...readFileSync(curated, "utf8").matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).filter((s) => !/^rejected/i.test(s));

  // 3. Write each section, in parallel.
  await pool(sections, parallel, async (section) => {
    say(`write ${section}`);
    const slug = section.replace(/[^\w]+/g, "-").slice(0, 40);
    const ok = await runAgent(cfg, template("backfill-write.md", { CURATED: curated, SECTION: section, DIR: join(dir, "harvest") }), dir, join(dir, "logs", `write-${slug}.log`));
    if (!ok) say(`  write ${section} failed; see logs/write-${slug}.log`);
  });

  // Done: remember the sessions, log their work, and link everything.
  const done = loadDone();
  for (const s of sessions) done.add(s.session);
  saveDone(done);
  if (opts.timeline !== false) {
    say("timeline");
    timelinePass(cfg, { only: sessions.map((s) => s.path) });
  }
  say("link");
  linkDue(cfg);
  say(`done. Plan and logs: ${dir}`);
}
