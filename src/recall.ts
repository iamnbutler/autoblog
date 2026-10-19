import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR, type Config } from "./config";
import { listEntries } from "./journal";

/*
 * Finding what the journal already knows. `search` ranks entries for a query; `recall` runs
 * on every prompt (a UserPromptSubmit hook) and, when an entry clearly matches, tells the
 * agent it exists, so "set up TestFlight" starts from the TestFlight note.
 */

const STOP = new Set(
  "a an and are as at be but by can could do does for from get got have how i if in into is it its just let lets like make me my need no not of on or our please set should so some that the their them then there these this those to up us use using want was we what when where which while who why will with would you your yeah ok okay also now new add fix help work thing things push pull update test build run commit change check try look good bad better faster slower file code again still last first next same other more less very really sure think know see show go going done".split(" "),
);

const stem = (w: string) => (w.length < 5 ? w : w.replace(/(ization|isation|ation|ized|ised|izing|ising|ize|ise|ings|ing|ed|es|s|e)$/, "")) || w;
const terms = (s: string) => [...new Set(s.toLowerCase().split(/[^a-z0-9+#.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w.length >= 2 && !STOP.has(w)).map(stem))];

type Doc = { type: string; title: string; projects: string[]; path: string; title_: Set<string>; tags: Set<string>; heads: Set<string>; body: Map<string, number>; text: string };

function load(cfg: Config): Doc[] {
  return listEntries(cfg).map((e) => {
    const raw = readFileSync(join(cfg.journal, e.path), "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "");
    const body = new Map<string, number>();
    for (const t of raw.toLowerCase().split(/[^a-z0-9+#.]+/).map(stem)) body.set(t, (body.get(t) ?? 0) + 1);
    return {
      type: e.type,
      title: e.title,
      projects: e.projects,
      path: join(cfg.journal, e.path),
      title_: new Set(terms(e.title)),
      tags: new Set([...e.tags, ...e.projects].flatMap(terms)),
      heads: new Set(terms((raw.match(/^#+ .*$/gm) ?? []).join(" "))),
      body,
      text: raw,
    };
  });
}

export type Hit = { type: string; title: string; projects: string[]; path: string; score: number; strong: boolean; snippet: string };

/** Entries ranked for a query. Rare words count for more, and a title or tag match most. */
export function rank(cfg: Config, query: string, limit = 10): Hit[] {
  const docs = load(cfg);
  const q = terms(query);
  if (!q.length || !docs.length) return [];
  const idf = new Map(q.map((t) => [t, Math.log((docs.length + 1) / (docs.filter((d) => d.body.has(t) || d.title_.has(t) || d.tags.has(t)).length + 0.5))]));
  // A distinctive word names only a few entries (in their title or tags), however often
  // others mention it: "sparkle" is, "mac" isn't.
  const naming = new Map(q.map((t) => [t, docs.filter((d) => d.title_.has(t) || d.tags.has(t)).length]));
  const few = Math.max(3, docs.length / 30);
  return docs
    .map((d) => {
      let score = 0, strong = false;
      for (const t of q) {
        const w = idf.get(t)!;
        const named = d.title_.has(t) || d.tags.has(t);
        score += w * ((d.title_.has(t) ? 5 : 0) + (d.tags.has(t) ? 3 : 0) + (d.heads.has(t) ? 2 : 0) + Math.min(d.body.get(t) ?? 0, 4) * 0.5);
        if (named && naming.get(t)! <= few) strong = true;
      }
      const line = d.text.split("\n").find((l) => l.trim() && !l.startsWith("#") && q.some((t) => l.toLowerCase().includes(t))) ?? "";
      return { type: d.type, title: d.title, projects: d.projects, path: d.path, score, strong, snippet: line.trim().slice(0, 160) };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const SEEN = join(STATE_DIR, "recall.json");

/**
 * For a UserPromptSubmit hook: what to tell the agent about entries this prompt clearly
 * touches, or null. Each entry is mentioned once per session.
 */
export function recall(cfg: Config, prompt: string, session?: string): string | null {
  if (!prompt || prompt.startsWith("/") || prompt.split(/\s+/).length < 3) return null;
  let seen: Record<string, string[]> = {};
  try {
    seen = JSON.parse(readFileSync(SEEN, "utf8"));
  } catch {}
  const already = new Set(session ? seen[session] ?? [] : []);
  const hits = rank(cfg, prompt, 6).filter((h) => h.strong && !already.has(h.title));
  if (!hits.length) return null;
  const top = hits.filter((h) => h.score >= hits[0].score * 0.5).slice(0, 3);
  if (session) {
    seen[session] = [...already, ...top.map((h) => h.title)];
    const keep = Object.keys(seen).slice(-200);
    mkdirSync(dirname(SEEN), { recursive: true });
    writeFileSync(SEEN, JSON.stringify(Object.fromEntries(keep.map((k) => [k, seen[k]]))));
  }
  return [
    `${cfg.owner}'s journal (autoblog) has entries that may cover this:`,
    ...top.map((h) => `- ${h.type} "${h.title}"${h.projects.length ? ` [${h.projects.join(", ")}]` : ""}`),
    `If one applies, read it before starting: autoblog show "<title>". It records what worked before and the pitfalls. autoblog search <words> finds more.`,
  ].join("\n");
}
