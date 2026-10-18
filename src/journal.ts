import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isWithin, REPO_ROOT, type Config } from "./config";
import { redact } from "./redact";

/*
 * The journal is an Obsidian vault, whether or not Obsidian ever opens it:
 *   notes/<Topic>.md      short reference pages on a topic, revised in place as we learn more
 *   posts/<Topic>.md      pieces Nate could publish: a project, or a way of working
 *   projects/<name>.md    hub note per project: what it is, plus every entry that touches it
 *   timeline/<date>.md    the work log: one line per thing done that day, any project
 *   archive/<date>/       earlier entries, set aside; nothing reads them
 *   README.md             generated: what this vault is, nothing more
 * Note name = title, so [[Title]] resolves; names are unique across notes and posts.
 */

export const TYPES = ["note", "post"] as const;
export type EntryType = (typeof TYPES)[number];
const DIRS: Record<EntryType, string> = { note: "notes", post: "posts" };

export type EntryInput = {
  type: EntryType;
  title: string;
  body: string;
  tags?: string[];
  /** Projects this entry draws on; defaults to the one at cwd. */
  projects?: string[];
  /** One to three sentences on what the project is; fills the project note if it has none yet. */
  projectSummary?: string;
  cwd?: string;
  agent?: string;
  session?: string;
  mode: "auto" | "manual" | "backfill";
  /** When the work happened (any Date-parsable string); defaults to now. */
  date?: string;
};

export type EntryMeta = {
  path: string;
  type: EntryType;
  title: string;
  created: string;
  updated: string;
  projects: string[];
  tags: string[];
  mode: string;
};

const PLACEHOLDER = "_No description yet. The next agent to write about this project should add one to three sentences on what it is and why it exists._";
const LIST_START = "<!-- autoblog:entries (generated) -->";
const LIST_END = "<!-- /autoblog:entries -->";

export function tagify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-").replace(/^-|-$/g, "");
}

/** A title Obsidian and every filesystem accept as a note name. */
export function noteName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "Untitled";
}

/** Project name: the git toplevel's basename, ignoring lane/worktree subpaths. */
export function projectFor(cwd: string | undefined): string {
  if (!cwd) return "unknown";
  return repoProject(cwd) ?? basename(cwd);
}

/** The project at cwd, or null when cwd isn't inside a repo (a scratch dir isn't a project). */
function repoProject(cwd: string): string | null {
  const lane = cwd.match(/^(.*?)\/\.lane\/trees\//);
  if (lane) return basename(lane[1]);
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? basename(r.stdout.trim()) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time in Obsidian's datetime property format. */
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const q = (s: string) => JSON.stringify(s);

/**
 * Point [[wikilinks]] at real note names. Titles can contain characters a filename can't
 * (`:` `/` `?`), so [[Drop: a Mac app]] becomes [[Drop a Mac app|Drop: a Mac app]].
 */
export function normalizeLinks(md: string): string {
  return md.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (all, target: string, heading = "", alias?: string) => {
    const name = noteName(target);
    if (name === target.trim()) return all;
    return `[[${name}${heading}|${alias ?? target.trim()}]]`;
  });
}

/**
 * Several agents can write at once (a backfill fans out), so every write, regenerate, and
 * commit runs under one lock. mkdir is atomic, which makes it the lock.
 */
export function withLock<T>(cfg: Config, fn: () => T): T {
  const lock = join(cfg.journal, ".git", "autoblog.lock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("journal is locked by another writer");
      Bun.sleepSync(100);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function writeEntry(cfg: Config, e: EntryInput): string {
  ensureJournal(cfg);
  return withLock(cfg, () => writeEntryLocked(cfg, e));
}

function writeEntryLocked(cfg: Config, e: EntryInput): string {
  const name = noteName(e.title);
  const existing = findEntry(cfg, name);
  if (existing) throw new Error(`"${name}" already exists (${relative(cfg.journal, existing)}); revise it instead: autoblog revise "${name}"`);
  if (existsSync(projectNotePath(cfg, name))) throw new Error(`"${name}" is a project note; give the post a title of its own (the project is linked through --project)`);
  // A bare YYYY-MM-DD means that local day, not UTC midnight (which is the day before here).
  const parsed = e.date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(e.date) ? `${e.date}T12:00` : e.date) : null;
  const when = localStamp(parsed && !isNaN(+parsed) ? parsed : new Date());
  const dir = join(cfg.journal, DIRS[e.type]);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.md`);

  const projects = projectsFor(e);
  for (const p of projects) ensureProjectNote(cfg, p, projects.length === 1 ? e.projectSummary : undefined);
  const front: Front = {
    title: e.title,
    type: e.type,
    created: when,
    updated: when,
    projects: projects.map((p) => `[[${p}]]`),
    tags: [...new Set((e.tags ?? []).map(tagify).filter(Boolean))],
    sessions: e.session ? [e.session] : [],
    agent: e.agent ?? "",
    mode: e.mode,
  };
  writeFileSync(file, redact(serialize(front, e.body)));
  commit(cfg, `${e.mode}: ${e.type} ${name}`, { link: name });
  return file;
}

export type Revision = {
  /** The whole new body: the old one with only a correction or a closely aligned addition. */
  body?: string;
  title?: string;
  tags?: string[];
  projects?: string[];
  cwd?: string;
  session?: string;
  agent?: string;
};

/** Revise an entry in place: new body, merged projects, tags and sessions, a new `updated`. */
export function reviseEntry(cfg: Config, ref: string, r: Revision): string | null {
  ensureJournal(cfg);
  return withLock(cfg, () => {
    let file = findEntry(cfg, ref);
    if (!file) return null;
    const { front, body } = parseFile(readFileSync(file, "utf8"));
    // --project sets the list outright. Otherwise revising from inside another repo adds that
    // project. A scratch dir, the journal, and autoblog's own repo (where backfills run) add nothing.
    const inRepo = r.cwd && !isWithin(r.cwd, cfg.journal) && !isWithin(r.cwd, REPO_ROOT) ? repoProject(r.cwd) : null;
    const projects = r.projects?.length
      ? projectsFor({ projects: r.projects }).map((p) => `[[${p}]]`)
      : [...new Set([...listOf(front.projects), ...(inRepo ? [`[[${noteName(inRepo)}]]`] : [])])];
    for (const p of projects) ensureProjectNote(cfg, unlink(p));
    const next: Front = {
      ...front,
      updated: localStamp(new Date()),
      projects,
      tags: [...new Set([...listOf(front.tags), ...(r.tags ?? []).map(tagify).filter(Boolean)])],
      sessions: [...new Set([...listOf(front.sessions), ...(r.session ? [r.session] : [])])],
    };
    if (r.agent) next.agent = r.agent;
    let text = r.body?.trim() ? r.body : body;
    const oldName = basename(file, ".md");
    if (r.title && noteName(r.title) !== oldName) {
      const name = noteName(r.title);
      if (findEntry(cfg, name)) throw new Error(`"${name}" already exists`);
      if (existsSync(projectNotePath(cfg, name))) throw new Error(`"${name}" is a project note`);
      next.title = r.title;
      const moved = join(dirname(file), `${name}.md`);
      rmSync(file);
      file = moved;
      relink(cfg, oldName, name);
    }
    writeFileSync(file, redact(serialize(next, text)));
    commit(cfg, `revise: ${basename(file, ".md")}`, { link: basename(file, ".md") });
    return file;
  });
}

/** Point every [[Old name]] in the vault at the new name. */
function relink(cfg: Config, from: string, to: string) {
  const re = new RegExp(`\\[\\[${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\]|#])`, "g");
  for (const f of vaultFiles(cfg)) {
    const t = readFileSync(f, "utf8");
    const n = t.replace(re, `[[${to}`);
    if (n !== t) writeFileSync(f, n);
  }
}

/** Set aside every note and post under archive/<date>/, so the journal starts over. */
export function archiveAll(cfg: Config, reason: string): number {
  ensureJournal(cfg);
  return withLock(cfg, () => {
    const dest = join(cfg.journal, "archive", localStamp(new Date()).slice(0, 10));
    let n = 0;
    for (const d of ["notes", "posts"]) {
      const src = join(cfg.journal, d);
      if (!existsSync(src)) continue;
      n += walk(src).filter((f) => f.endsWith(".md")).length;
      mkdirSync(dest, { recursive: true });
      renameSync(src, join(dest, d));
    }
    if (n) {
      hideArchiveInObsidian(cfg);
      writeFileSync(join(dest, "README.md"), `Archived ${n} entries on ${localStamp(new Date()).slice(0, 10)}.\n\n${reason.trim()}\n`);
      commit(cfg, `archive ${n} entries`);
    }
    return n;
  });
}

/** Keep archived entries out of Obsidian's search, graph and backlinks ("Excluded files"). */
function hideArchiveInObsidian(cfg: Config) {
  const file = join(cfg.journal, ".obsidian", "app.json");
  let app: { userIgnoreFilters?: string[] } = {};
  try {
    app = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  if (app.userIgnoreFilters?.includes("archive/")) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...app, userIgnoreFilters: [...(app.userIgnoreFilters ?? []), "archive/"] }, null, 2) + "\n");
}

/** Find a note or post by journal-relative path, title, or [[wikilink]]. */
export function findEntry(cfg: Config, ref: string): string | null {
  const direct = resolve(cfg.journal, ref);
  if (TYPES.some((t) => direct.startsWith(resolve(cfg.journal, DIRS[t]) + "/")) && existsSync(direct)) return direct;
  const want = noteName(ref.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/, "")).toLowerCase();
  const hit = listEntries(cfg).find((e) => basename(e.path, ".md").toLowerCase() === want || noteName(e.title).toLowerCase() === want);
  return hit ? join(cfg.journal, hit.path) : null;
}

function projectsFor(e: { projects?: string[]; cwd?: string }): string[] {
  const named = (e.projects ?? []).map((p) => noteName(unlink(p.trim()))).filter((p) => p && p !== "Untitled");
  return named.length ? [...new Set(named)] : e.cwd ? [noteName(projectFor(e.cwd))] : [];
}

const unlink = (s: string) => s.replace(/^\[\[|\]\]$/g, "");
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);

function projectNotePath(cfg: Config, project: string) {
  return join(cfg.journal, "projects", `${noteName(project)}.md`);
}

/** Create the project hub note if missing; fill or replace its description when given one. */
export function ensureProjectNote(cfg: Config, project: string, summary?: string, replace = false) {
  const file = projectNotePath(cfg, project);
  mkdirSync(join(cfg.journal, "projects"), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, `---\ntype: project\n---\n${summary?.trim() || PLACEHOLDER}\n\n## In the journal\n\n${LIST_START}\n${LIST_END}\n`);
    return;
  }
  if (!summary?.trim()) return;
  const text = readFileSync(file, "utf8");
  if (text.includes(PLACEHOLDER)) writeFileSync(file, text.replace(PLACEHOLDER, summary.trim()));
  else if (replace) {
    const m = text.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*?)(\n## [^\n]*\n+<!-- autoblog:[\s\S]*)$/);
    if (m) writeFileSync(file, `${m[1]}${summary.trim()}\n${m[3]}`);
  }
}

export function projectSummary(cfg: Config, project: string): string | null {
  const file = projectNotePath(cfg, project);
  if (!existsSync(file)) return null;
  const body = readFileSync(file, "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split(/\n## [^\n]*\n+<!-- autoblog:/)[0]
    .trim();
  return body === PLACEHOLDER ? null : body;
}

export function ensureJournal(cfg: Config) {
  if (!existsSync(join(cfg.journal, ".git"))) {
    throw new Error(`journal not found at ${cfg.journal} (run \`autoblog init\`)`);
  }
}

function git(cfg: Config, ...args: string[]) {
  return spawnSync("git", ["-C", cfg.journal, ...args], { encoding: "utf8" });
}

/** Regenerate, commit and push under the journal lock (for callers outside a write). */
export function commitLocked(cfg: Config, message: string) {
  withLock(cfg, () => commit(cfg, message));
}

/**
 * Commit, then push and redeploy in the background. After a write, `link` names the entry:
 * the background job links it to the rest of the journal first, and deploys after that.
 */
export function commit(cfg: Config, message: string, opts: { link?: string } = {}) {
  regenerate(cfg);
  git(cfg, "add", "-A");
  git(cfg, "commit", "-q", "-m", message);
  if (cfg.push) {
    // Detached so agents never wait on the network; the next sync catches up after a failure.
    spawn(process.execPath, [join(import.meta.dir, "cli.ts"), "sync"], { detached: true, stdio: "ignore" }).unref();
  }
  const job = opts.link ? ["link", opts.link, "--after-write"] : cfg.site ? ["site", "deploy", "--quiet"] : null;
  if (job) spawn(process.execPath, [join(import.meta.dir, "cli.ts"), ...job], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Merge what other machines pushed, then push. Several machines write to one vault, so a
 * plain push gets rejected as soon as they diverge. Generated files are rebuilt after the
 * merge; where both sides changed the same lines of an entry, this machine's side wins.
 */
export function sync(cfg: Config): { merged: number; pushed: boolean } {
  return withLock(cfg, () => {
    if (git(cfg, "fetch", "-q", "origin").status !== 0) return { merged: 0, pushed: false };
    const upstream = git(cfg, "rev-parse", "--abbrev-ref", "@{u}").stdout.trim() || "origin/main";
    const merged = Number(git(cfg, "rev-list", "--count", `HEAD..${upstream}`).stdout.trim()) || 0;
    if (merged) {
      const m = git(cfg, "merge", "-q", "--no-edit", "-X", "ours", upstream);
      if (m.status !== 0) {
        git(cfg, "merge", "--abort");
        console.error(`autoblog: sync: merge failed: ${(m.stderr || m.stdout).slice(0, 500)}`);
        return { merged: 0, pushed: false };
      }
      regenerate(cfg);
      git(cfg, "add", "-A");
      git(cfg, "commit", "-q", "-m", "reindex after merge");
    }
    const pushed = git(cfg, "push", "-q", "-u", "origin", "HEAD").status === 0;
    return { merged, pushed };
  });
}

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every Markdown file in the vault outside .git and the archive. */
function vaultFiles(cfg: Config): string[] {
  return ["notes", "posts", "projects"].flatMap((d) => (existsSync(join(cfg.journal, d)) ? walk(join(cfg.journal, d)) : [])).filter((f) => f.endsWith(".md"));
}

export function listEntries(cfg: Config, type?: EntryType): EntryMeta[] {
  const out: EntryMeta[] = [];
  for (const t of type ? [type] : TYPES) {
    const root = join(cfg.journal, DIRS[t]);
    if (!existsSync(root)) continue;
    for (const p of walk(root).filter((f) => f.endsWith(".md"))) {
      const { front } = parseFile(readFileSync(p, "utf8"));
      const str = (k: string) => (typeof front[k] === "string" ? (front[k] as string) : "");
      out.push({
        path: relative(cfg.journal, p),
        type: t,
        title: str("title") || basename(p, ".md"),
        created: str("created"),
        updated: str("updated") || str("created"),
        projects: listOf(front.projects).map(unlink),
        tags: listOf(front.tags),
        mode: str("mode"),
      });
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export type Front = Record<string, string | string[]>;

export function serialize(front: Front, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(front)) {
    if (Array.isArray(v)) lines.push(v.length ? `${k}:\n${v.map((x) => `  - ${/^[\w./-]+$/.test(x) ? x : q(x)}`).join("\n")}` : `${k}: []`);
    else if (v !== "") lines.push(`${k}: ${k === "title" || /: |#|^[\[\]"{}&*!>|%@`]/.test(v) ? q(v) : v}`);
  }
  // Obsidian shows the filename as the title, so drop a leading H1.
  const text = body.trim().replace(/^#\s+.*\n+/, "");
  return `${lines.join("\n")}\n---\n\n${normalizeLinks(text)}\n`;
}

export function parseFile(text: string): { front: Front; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return { front: m ? parseFront(m[1]) : {}, body: m ? text.slice(m[0].length).replace(/^\n+/, "") : text };
}

/** Just enough YAML for our own frontmatter: scalars, quoted strings, and block or flow lists. */
function parseFront(yaml: string): Front {
  const out: Front = {};
  let last = "";
  const unq = (v: string) => {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v);
      } catch {}
    }
    return v;
  };
  for (const line of yaml.split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && last) {
      (out[last] = Array.isArray(out[last]) ? out[last] : []) as string[];
      (out[last] as string[]).push(unq(item[1].trim()));
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    last = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      out[last] = v.slice(1, -1).split(",").map((t) => unq(t.trim())).filter(Boolean);
      continue;
    }
    out[last] = unq(v);
  }
  return out;
}

/** Rebuild generated parts: each project note's entry list, and the short README. */
function regenerate(cfg: Config) {
  const entries = listEntries(cfg);
  const pdir = join(cfg.journal, "projects");
  const projects = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")) : [];
  for (const project of projects) {
    const file = projectNotePath(cfg, project);
    const text = readFileSync(file, "utf8");
    const mine = entries.filter((e) => e.projects.some((p) => p.toLowerCase() === project.toLowerCase()));
    const list = (t: EntryType, label: string) => {
      const es = mine.filter((e) => e.type === t).sort((a, b) => a.title.localeCompare(b.title));
      return es.length ? [`${label}:`, ...es.map((e) => `- [[${basename(e.path, ".md")}]]`), ""] : [];
    };
    const block = [LIST_START, ...list("post", "Posts"), ...list("note", "Notes"), LIST_END].join("\n");
    const at = text.search(/<!-- autoblog:(entries|posts) \(generated\) -->/);
    const endMatch = text.match(/<!-- \/autoblog:(entries|posts) -->/);
    let next: string;
    if (at >= 0 && endMatch) {
      const before = text.slice(0, at).replace(/## Posts\n+$/, "## In the journal\n\n");
      next = before + block + text.slice(text.indexOf(endMatch[0]) + endMatch[0].length);
    } else next = `${text.trimEnd()}\n\n## In the journal\n\n${block}\n`;
    if (next !== text) writeFileSync(file, next);
  }

  const lines = [
    "# autoblog",
    "",
    "A private journal written by agents as we work, via [autoblog](https://github.com/iamnbutler/autoblog). It's an Obsidian vault: open this folder in Obsidian for backlinks and the graph.",
    "",
    "- `notes/`: short reference pages on a topic, kept current",
    "- `posts/`: longer pieces on a project or a way of working",
    "- `projects/`: what each project is, and what touches it",
    "- `timeline/`: a work log across every project, one file per day",
    "- `archive/`: earlier entries, set aside",
    ...(cfg.site?.url ? [`- ${cfg.site.url}: the private site`] : []),
  ];
  writeFileSync(join(cfg.journal, "README.md"), lines.join("\n") + "\n");
}
