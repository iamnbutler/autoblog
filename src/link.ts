import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { STATE_DIR, type Config } from "./config";
import { commit, listEntries, parseFile, projectSummary, serialize, withLock, type EntryMeta } from "./journal";

/**
 * Writers don't link other entries; this does. A model picks the phrases in an entry that
 * name another entry's topic or a project, and code turns the first mention of each into a
 * [[wikilink]]. The model never rewrites prose, and links that point nowhere are unlinked.
 * Runs after every write, and on a cadence so older entries pick up links to newer ones.
 */

const STATE = join(STATE_DIR, "links.json");
const DAY = 24 * 60 * 60_000;

type LinkState = { lastDue?: string; entries: Record<string, { hash: string; targets: string[] }> };

function loadState(): LinkState {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { entries: {} };
}

function saveState(s: LinkState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

const hash = (s: string) => createHash("sha1").update(s.trim()).digest("hex");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Target = { name: string; kind: "note" | "post" | "project"; about?: string };

function targets(cfg: Config): Target[] {
  const entries: Target[] = listEntries(cfg).map((e) => ({ name: basename(e.path, ".md"), kind: e.type }));
  const pdir = join(cfg.journal, "projects");
  const projects: Target[] = existsSync(pdir)
    ? readdirSync(pdir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => basename(f, ".md"))
        .map((name) => ({ name, kind: "project" as const, about: projectSummary(cfg, name)?.split(/(?<=\.)\s/)[0] }))
    : [];
  // "Next Cloud" the post and next-cloud the project are one name to a reader; link the entry.
  const norm = (n: string) => n.toLowerCase().replace(/[-_\s]+/g, " ");
  const taken = new Set(entries.map((t) => norm(t.name)));
  return [...entries, ...projects.filter((p) => !taken.has(norm(p.name)))];
}

// Code, links, URLs and headings are never linked into.
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|!?\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+|^#{1,6} .*$/gm;

/** Split a body into [text, protected] pieces, in order. */
function pieces(body: string): { text: string; open: boolean }[] {
  const out: { text: string; open: boolean }[] = [];
  let at = 0;
  for (const m of body.matchAll(PROTECTED)) {
    if (m.index! > at) out.push({ text: body.slice(at, m.index), open: true });
    out.push({ text: m[0], open: false });
    at = m.index! + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at), open: true });
  return out;
}

/** Unlink [[targets]] that don't exist, keeping their text. Code is left alone. */
export function dropDeadLinks(body: string, names: Set<string>): string {
  return pieces(body)
    .map((p) =>
      p.open || p.text.startsWith("`") || p.text.startsWith("!")
        ? p.text
        : p.text.replace(/^\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]$/, (all, t: string, _h, alias?: string) =>
            names.has(t.trim().toLowerCase()) ? all : (alias ?? t).trim(),
          ),
    )
    .join("");
}

/** Link the first unprotected, whole-word occurrence of `text` to `target`. */
export function applyMention(body: string, text: string, target: string): string {
  const re = new RegExp(`(?<![\\w\\[])${esc(text)}(?![\\w\\]])`);
  let done = false;
  return pieces(body)
    .map((p) => {
      if (done || !p.open || !re.test(p.text)) return p.text;
      done = true;
      return p.text.replace(re, text === target ? `[[${target}]]` : `[[${target}|${text}]]`);
    })
    .join("");
}

const linked = (body: string) =>
  new Set([...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim().toLowerCase()));

const SCHEMA = {
  type: "object",
  properties: {
    links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "A short phrase copied exactly from the entry, outside code and headings." },
          target: { type: "string", description: "The exact name of the entry or project it refers to, as listed." },
        },
        required: ["text", "target"],
      },
    },
  },
  required: ["links"],
};

const SYSTEM = `You add cross-links to one entry in a private Obsidian journal. You get the entry and a list of other entries and projects.

Return a link only where a short phrase in the entry names the target: the project's name ("Coolify", "Next Auth"), or the target's subject ("Sparkle", "macOS permissions", "the screen locking"). The phrase is the link text, so it has to read as a name for the target on its own.

- 1 to 5 words, copied exactly from the entry. No backticks, and nothing inside code, links or headings.
- Not a clause or sentence that merely touches the topic. "A static site is just FROM nginx" doesn't name a note about hosting static sites on Cloudflare.
- The target has to be what the phrase is about at that point, not just a related entry. A Coolify deploy isn't a Cloudflare Worker.
- If the phrase names something that isn't on the list, leave it unlinked. Never link it to the closest entry instead: "Calling the Claude API from your own client" isn't "LLM features in apps", and "Terminal-Bench 2.0" isn't a note about tracking benchmarks.
- One link per target, at its first good mention.
- Most entries need only a few links, and none is a fine answer.`;

function pickLinks(cfg: Config, entry: { name: string; body: string }, cands: Target[]): { text: string; target: string }[] {
  if (!cands.length) return [];
  const list = cands.map((t) => `- ${t.name} (${t.kind}${t.about ? `: ${t.about}` : ""})`).join("\n");
  const input = `Entry: ${entry.name}\n\n${entry.body}\n\n---\nEntries and projects you may link:\n${list}\n`;
  const r = spawnSync(
    "claude",
    ["-p", "--model", cfg.linkModel, "--output-format", "json", "--no-session-persistence", "--tools", "", "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(SCHEMA)],
    { input, encoding: "utf8", cwd: STATE_DIR, env: { ...process.env, AUTOBLOG_REVIEWER: "1" }, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 },
  );
  if (r.status !== 0) throw new Error(`linker failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  const out = JSON.parse(r.stdout);
  return (out.structured_output ?? JSON.parse(out.result)).links ?? [];
}

/**
 * Link one entry. With `only`, consider just those targets (new names since its last link).
 * Returns true when the file changed.
 */
export function linkEntry(cfg: Config, e: EntryMeta, all: Target[], state: LinkState, only?: Set<string>, dryRun = false): boolean {
  const file = join(cfg.journal, e.path);
  const name = basename(e.path, ".md");
  const names = new Set(all.map((t) => t.name.toLowerCase()));
  const { body } = parseFile(readFileSync(file, "utf8"));
  const have = linked(body);
  const cands = all.filter((t) => t.name !== name && !have.has(t.name.toLowerCase()) && (!only || only.has(t.name)));
  // A project link's text has to contain the project's name: "Spade" isn't ace2, and "Parley"
  // isn't gpui-ce, however related they are.
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const fits = (l: { text: string; target: string }) => {
    const t = cands.find((c) => c.name === l.target);
    return !!t && !!l.text.trim() && (t.kind !== "project" || squash(l.text).includes(squash(t.name)));
  };
  const picks = pickLinks(cfg, { name, body }, cands).filter(fits);

  const changed = withLock(cfg, () => {
    // Re-read under the lock: the entry may have been revised while the model was thinking.
    const { front, body: now } = parseFile(readFileSync(file, "utf8"));
    let next = dropDeadLinks(now, names);
    const done = linked(next);
    for (const l of picks) {
      if (done.has(l.target.toLowerCase())) continue;
      const after = applyMention(next, l.text, l.target);
      if (after !== next) done.add(l.target.toLowerCase());
      next = after;
    }
    state.entries[e.path] = { hash: hash(next), targets: all.map((t) => t.name).sort() };
    if (next === now) return false;
    if (dryRun) {
      console.log(`${name}: ${picks.map((l) => `"${l.text}" → ${l.target}`).join(", ")}`);
      return false;
    }
    writeFileSync(file, serialize(front, next));
    return true;
  });
  return changed;
}

/** Link the named entries against everything. */
export function linkNamed(cfg: Config, refs: string[], opts: { dryRun?: boolean } = {}): string[] {
  const all = targets(cfg);
  const state = loadState();
  const entries = listEntries(cfg);
  const pick = refs.length ? entries.filter((e) => refs.some((r) => r.toLowerCase() === basename(e.path, ".md").toLowerCase() || r.toLowerCase() === e.title.toLowerCase())) : entries;
  const changed: string[] = [];
  for (const e of pick) {
    try {
      if (linkEntry(cfg, e, all, state, undefined, opts.dryRun)) changed.push(basename(e.path, ".md"));
    } catch (err) {
      console.error(`autoblog: ${basename(e.path, ".md")}: ${String(err)}`);
    }
  }
  if (!opts.dryRun) saveState(state);
  if (changed.length) withLock(cfg, () => commit(cfg, `link: ${changed.length === 1 ? changed[0] : `${changed.length} entries`}`));
  return changed;
}

/**
 * The cadence pass: relink entries whose text changed since their last link, and offer the
 * rest only the names that appeared since. With `daily`, it runs at most once a day.
 */
export function linkDue(cfg: Config, opts: { daily?: boolean; dryRun?: boolean } = {}): string[] {
  const state = loadState();
  if (opts.daily && state.lastDue && Date.now() - Date.parse(state.lastDue) < DAY) return [];
  const all = targets(cfg);
  const changed: string[] = [];
  for (const e of listEntries(cfg)) {
    const { body } = parseFile(readFileSync(join(cfg.journal, e.path), "utf8"));
    const seen = state.entries[e.path];
    const fresh = seen ? new Set(all.map((t) => t.name).filter((n) => !seen.targets.includes(n))) : undefined;
    if (seen && seen.hash === hash(body) && !fresh!.size) continue;
    try {
      if (linkEntry(cfg, e, all, state, seen && seen.hash === hash(body) ? fresh : undefined, opts.dryRun)) changed.push(basename(e.path, ".md"));
    } catch (err) {
      console.error(`autoblog: ${basename(e.path, ".md")}: ${String(err)}`);
    }
  }
  if (opts.dryRun) return changed;
  state.lastDue = new Date().toISOString();
  saveState(state);
  if (changed.length) withLock(cfg, () => commit(cfg, `link: ${changed.length} entries`));
  return changed;
}

/** After a write: link that entry, and make sure the site redeploys either way. */
export function linkAfterWrite(cfg: Config, ref: string) {
  const changed = linkNamed(cfg, [ref]);
  if (!changed.length && cfg.site) {
    spawn(process.execPath, [join(import.meta.dir, "cli.ts"), "site", "deploy", "--quiet"], { detached: true, stdio: "ignore" }).unref();
  }
}
