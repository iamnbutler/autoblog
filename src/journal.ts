import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Config } from "./config";
import { redact } from "./redact";

/*
 * The journal is an Obsidian vault, whether or not Obsidian ever opens it:
 *   posts/<year>/<Title>.md   one note per story; filename = title so [[Title]] resolves
 *   projects/<name>.md        hub note per project: what it is, plus every post about it
 *   README.md                 generated home note
 * Properties are YAML frontmatter, and posts link with [[wikilinks]].
 */

export const KINDS = ["fix", "solution", "howto", "decision", "discovery", "kickoff", "note"] as const;

export type PostInput = {
  title: string;
  body: string;
  kind?: string;
  tags?: string[];
  signal?: number;
  project?: string;
  /** One to three sentences on what the project is; fills the project note if it has none yet. */
  projectSummary?: string;
  cwd?: string;
  agent?: string;
  session?: string;
  mode: "auto" | "manual";
};

export type PostMeta = {
  path: string;
  title: string;
  date: string;
  project: string;
  kind: string;
  signal: number;
  tags: string[];
  mode: string;
};

const PLACEHOLDER = "_No description yet. The next agent to write about this project should add one to three sentences on what it is and why it exists._";
const POSTS_START = "<!-- autoblog:posts (generated) -->";
const POSTS_END = "<!-- /autoblog:posts -->";

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
  const lane = cwd.match(/^(.*?)\/\.lane\/trees\//);
  if (lane) return basename(lane[1]);
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return basename(r.stdout.trim());
  return basename(cwd);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time in Obsidian's datetime property format. */
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const q = (s: string) => JSON.stringify(s);

export function writePost(cfg: Config, p: PostInput): string {
  ensureJournal(cfg);
  const now = new Date();
  const dir = join(cfg.journal, "posts", String(now.getFullYear()));
  mkdirSync(dir, { recursive: true });
  const name = noteName(p.title);
  let file = join(dir, `${name}.md`);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${name} ${i}.md`);

  const project = noteName(p.project ?? projectFor(p.cwd));
  ensureProjectNote(cfg, project, p.projectSummary);

  const tags = [...new Set((p.tags ?? []).map(tagify).filter(Boolean))];
  const front = [
    "---",
    `title: ${q(p.title)}`,
    `date: ${localStamp(now)}`,
    `project: ${q(`[[${project}]]`)}`,
    `kind: ${p.kind && (KINDS as readonly string[]).includes(p.kind) ? p.kind : "note"}`,
    `signal: ${Math.min(3, Math.max(1, p.signal ?? 2))}`,
    tags.length ? `tags:\n${tags.map((t) => `  - ${t}`).join("\n")}` : "tags: []",
    `mode: ${p.mode}`,
    p.agent ? `agent: ${p.agent}` : null,
    p.session ? `session: ${p.session}` : null,
    p.cwd ? `cwd: ${q(p.cwd)}` : null,
    "---",
    "",
  ].filter((l) => l !== null);

  // Obsidian shows the filename as the title, so drop a leading H1.
  const body = p.body.trim().replace(/^#\s+.*\n+/, "");
  writeFileSync(file, redact(`${front.join("\n")}${body}\n`));
  commit(cfg, `${p.mode}: ${p.title}`);
  return file;
}

/** Find a post by journal-relative path, title, or [[wikilink]]. */
export function findPost(cfg: Config, ref: string): string | null {
  const direct = resolve(cfg.journal, ref);
  if (direct.startsWith(resolve(cfg.journal, "posts") + "/") && existsSync(direct)) return direct;
  const want = noteName(ref.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/, "")).toLowerCase();
  const hit = listPosts(cfg).find((p) => noteName(p.title).toLowerCase() === want || basename(p.path, ".md").toLowerCase() === want);
  return hit ? join(cfg.journal, hit.path) : null;
}

export function appendUpdate(cfg: Config, ref: string, body: string, session?: string): string | null {
  const file = findPost(cfg, ref);
  if (!file) return null;
  appendFileSync(file, redact(`\n## Update ${localStamp(new Date()).slice(0, 10)}${session ? ` (${session.slice(0, 8)})` : ""}\n\n${body.trim()}\n`));
  commit(cfg, `update: ${basename(file, ".md")}`);
  return file;
}

function projectNotePath(cfg: Config, project: string) {
  return join(cfg.journal, "projects", `${noteName(project)}.md`);
}

/** Create the project hub note if missing; fill or replace its description when given one. */
export function ensureProjectNote(cfg: Config, project: string, summary?: string, replace = false) {
  const file = projectNotePath(cfg, project);
  mkdirSync(join(cfg.journal, "projects"), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, `---\ntype: project\n---\n${summary?.trim() || PLACEHOLDER}\n\n## Posts\n\n${POSTS_START}\n${POSTS_END}\n`);
    return;
  }
  if (!summary?.trim()) return;
  const text = readFileSync(file, "utf8");
  if (text.includes(PLACEHOLDER)) writeFileSync(file, text.replace(PLACEHOLDER, summary.trim()));
  else if (replace) {
    const m = text.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*?)(\n## Posts[\s\S]*)$/);
    if (m) writeFileSync(file, `${m[1]}${summary.trim()}\n${m[3]}`);
  }
}

export function projectSummary(cfg: Config, project: string): string | null {
  const file = projectNotePath(cfg, project);
  if (!existsSync(file)) return null;
  const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n## Posts")[0].trim();
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

export function commit(cfg: Config, message: string) {
  regenerate(cfg);
  git(cfg, "add", "-A");
  git(cfg, "commit", "-q", "-m", message);
  if (cfg.push) {
    // Detached so agents never wait on the network; the next push catches up after a failure.
    spawn("git", ["-C", cfg.journal, "push", "-q", "-u", "origin", "HEAD"], { detached: true, stdio: "ignore" }).unref();
  }
}

export function listPosts(cfg: Config): PostMeta[] {
  const root = join(cfg.journal, "posts");
  if (!existsSync(root)) return [];
  const out: PostMeta[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) {
        const m = parseFront(readFileSync(p, "utf8"));
        const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : "");
        out.push({
          path: relative(cfg.journal, p),
          title: str("title") || basename(e, ".md"),
          date: str("date"),
          project: str("project").replace(/^\[\[|\]\]$/g, ""),
          kind: str("kind") || "note",
          signal: Number(str("signal") || 1),
          tags: Array.isArray(m.tags) ? m.tags : [],
          mode: str("mode"),
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Just enough YAML for our own frontmatter: scalars, quoted strings, and block or flow lists. */
function parseFront(text: string): Record<string, string | string[]> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string | string[]> = {};
  if (!m) return out;
  let last = "";
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && last) {
      (out[last] = Array.isArray(out[last]) ? out[last] : []) as string[];
      (out[last] as string[]).push(item[1].trim());
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    last = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      out[last] = v.slice(1, -1).split(",").map((t) => t.trim()).filter(Boolean);
      continue;
    }
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {}
    }
    out[last] = v;
  }
  return out;
}

/** Markdown link that works on GitHub and in Obsidian. */
const mdLink = (title: string, path: string) => `[${title}](${path.split("/").map(encodeURIComponent).join("/")})`;

/** Rebuild generated parts: each project note's post list and the README home note. */
function regenerate(cfg: Config) {
  const posts = listPosts(cfg);
  const byProject = new Map<string, PostMeta[]>();
  for (const p of posts) byProject.set(p.project, [...(byProject.get(p.project) ?? []), p]);

  for (const [project, ps] of byProject) {
    ensureProjectNote(cfg, project);
    const file = projectNotePath(cfg, project);
    const text = readFileSync(file, "utf8");
    const list = ps.map((p) => `- [[${basename(p.path, ".md")}]] · ${p.date.slice(0, 10)} · ${p.kind}`).join("\n");
    const block = `${POSTS_START}\n${list}\n${POSTS_END}`;
    const next = text.includes(POSTS_START) ? text.slice(0, text.indexOf(POSTS_START)) + block + text.slice(text.indexOf(POSTS_END) + POSTS_END.length) : `${text.trimEnd()}\n\n## Posts\n\n${block}\n`;
    if (next !== text) writeFileSync(file, next);
  }

  const stars = (n: number) => "★".repeat(n) + "☆".repeat(3 - n);
  const line = (p: PostMeta) => `- ${stars(p.signal)} ${mdLink(p.title, p.path)} · ${mdLink(p.project, `projects/${noteName(p.project)}.md`)} · ${p.kind}`;
  const lines = [
    "# autoblog",
    "",
    "A private blog written by agents as we work, via [autoblog](https://github.com/iamnbutler/autoblog). It's an Obsidian vault: open this folder in Obsidian for backlinks and the graph. This file is generated; don't edit it.",
    "",
    "## Jewels",
    "",
    ...posts.filter((p) => p.signal >= 3).map(line),
    "",
    "## Projects",
    "",
    ...[...byProject.keys()].sort().map((p) => `- ${mdLink(p, `projects/${noteName(p)}.md`)} (${byProject.get(p)!.length})`),
    "",
    "## Posts",
  ];
  let month = "";
  for (const p of posts) {
    if (p.date.slice(0, 7) !== month) {
      month = p.date.slice(0, 7);
      lines.push("", `### ${month}`, "");
    }
    lines.push(line(p));
  }
  writeFileSync(join(cfg.journal, "README.md"), lines.join("\n") + "\n");
}
