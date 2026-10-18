import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Config } from "./config";
import { redact } from "./redact";

export const KINDS = ["fix", "solution", "howto", "decision", "discovery", "kickoff", "note"] as const;
export type Kind = (typeof KINDS)[number];

export type PostInput = {
  title: string;
  body: string;
  kind?: string;
  tags?: string[];
  signal?: number;
  project?: string;
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

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "post";
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

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

export function writePost(cfg: Config, p: PostInput): string {
  ensureJournal(cfg);
  const now = new Date();
  const day = localDay(now);
  const dir = join(cfg.journal, "posts", day.slice(0, 4), day.slice(5, 7));
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${day}-${slugify(p.title)}.md`);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${day}-${slugify(p.title)}-${i}.md`);

  const project = p.project ?? projectFor(p.cwd);
  const front = [
    "---",
    `title: ${yamlString(p.title)}`,
    `date: ${now.toISOString()}`,
    `project: ${yamlString(project)}`,
    `kind: ${p.kind && (KINDS as readonly string[]).includes(p.kind) ? p.kind : "note"}`,
    `signal: ${Math.min(3, Math.max(1, p.signal ?? 2))}`,
    `tags: [${(p.tags ?? []).map((t) => slugify(t)).filter(Boolean).join(", ")}]`,
    `mode: ${p.mode}`,
    p.agent ? `agent: ${p.agent}` : null,
    p.cwd ? `cwd: ${yamlString(p.cwd)}` : null,
    p.session ? `session: ${p.session}` : null,
    "---",
    "",
  ].filter((l) => l !== null);

  const body = p.body.trim().replace(/^#\s+.*\n+/, ""); // title lives in frontmatter
  writeFileSync(file, redact(`${front.join("\n")}# ${p.title}\n\n${body}\n`));
  commit(cfg, `${p.mode}: ${p.title}`);
  return file;
}

export function appendUpdate(cfg: Config, relPath: string, body: string, session?: string): string | null {
  const file = resolve(cfg.journal, relPath);
  if (!file.startsWith(resolve(cfg.journal, "posts") + "/") || !existsSync(file)) return null;
  const day = localDay(new Date());
  appendFileSync(file, redact(`\n## Update ${day}${session ? ` (${session.slice(0, 8)})` : ""}\n\n${body.trim()}\n`));
  commit(cfg, `update: ${relative(cfg.journal, file)}`);
  return file;
}

export function ensureJournal(cfg: Config) {
  if (!existsSync(join(cfg.journal, ".git"))) {
    throw new Error(`journal not found at ${cfg.journal} (run \`autoblog install\` or set "journal" in ~/.autoblog/config.json)`);
  }
}

function git(cfg: Config, ...args: string[]) {
  return spawnSync("git", ["-C", cfg.journal, ...args], { encoding: "utf8" });
}

export function commit(cfg: Config, message: string) {
  writeIndex(cfg);
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
        out.push({
          path: relative(cfg.journal, p),
          title: m.title ?? e,
          date: m.date ?? "",
          project: m.project ?? "",
          kind: m.kind ?? "note",
          signal: Number(m.signal ?? 1),
          tags: (m.tags ?? "").replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean),
          mode: m.mode ?? "",
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function parseFront(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch {}
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

function writeIndex(cfg: Config) {
  const posts = listPosts(cfg);
  const stars = (n: number) => "★".repeat(n) + "☆".repeat(3 - n);
  const lines = [
    "# autoblog journal",
    "",
    "Private firehose written by agents via [autoblog](https://github.com/iamnbutler/autoblog). Generated; do not edit.",
    "",
    "## Jewels",
    "",
    ...posts.filter((p) => p.signal >= 3).map((p) => `- [${p.title}](${p.path}) · ${p.project} · ${p.date.slice(0, 10)}`),
    "",
    "## All posts",
    "",
  ];
  let month = "";
  for (const p of posts) {
    const m = p.date.slice(0, 7);
    if (m !== month) {
      lines.push("", `### ${m}`, "");
      month = m;
    }
    lines.push(`- ${stars(p.signal)} [${p.title}](${p.path}) · \`${p.project}\` · ${p.kind}${p.tags.length ? ` · ${p.tags.join(", ")}` : ""}`);
  }
  writeFileSync(join(cfg.journal, "README.md"), lines.join("\n") + "\n");
}
