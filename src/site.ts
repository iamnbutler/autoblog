import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import type { Config } from "./config";
import { listEntries, noteName, projectSummary, type EntryMeta } from "./journal";
import { dayLines, timelineDir } from "./timeline";

/*
 * Static site for the vault, with Obsidian semantics: [[wikilinks]] resolve by note name
 * (case-insensitive, with |alias and #heading), every note shows what links to it, and
 * projects and tags get their own pages.
 */

type Note = {
  name: string; // note name = filename without .md
  kind: "note" | "post" | "project";
  url: string;
  title: string;
  body: string; // markdown, frontmatter stripped
  meta?: EntryMeta;
  links: Set<string>; // lowercased names this note links to
};

const slug = (s: string) =>
  s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

function stripFront(text: string) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Wikilinks outside code, so a [[link]] inside a code sample doesn't count as a link. */
function outgoing(md: string): Set<string> {
  const prose = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return new Set([...prose.matchAll(WIKILINK)].map((m) => noteName(m[1]).toLowerCase()));
}

function loadNotes(cfg: Config): Map<string, Note> {
  const notes = new Map<string, Note>();
  for (const e of listEntries(cfg)) {
    const name = basename(e.path, ".md");
    const body = stripFront(readFileSync(join(cfg.journal, e.path), "utf8"));
    const links = outgoing(body);
    for (const p of e.projects) links.add(p.toLowerCase()); // the projects property links too
    notes.set(name.toLowerCase(), { name, kind: e.type, url: `/${e.type}s/${slug(name)}/`, title: e.title, body, meta: e, links });
  }
  const pdir = join(cfg.journal, "projects");
  for (const f of existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".md")) : []) {
    const name = basename(f, ".md");
    const raw = stripFront(readFileSync(join(pdir, f), "utf8"));
    const body = raw.split(/\n## [^\n]*\n+<!-- autoblog:/)[0];
    notes.set(name.toLowerCase(), { name, kind: "project", url: `/projects/${slug(name)}/`, title: name, body, links: outgoing(body) });
  }
  return notes;
}

function markdown(notes: Map<string, Note>) {
  const wikilink: TokenizerAndRendererExtension = {
    name: "wikilink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenizer(src) {
      const m = /^\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m) return { type: "wikilink", raw: m[0], target: m[1].trim(), heading: m[2], alias: m[3] };
    },
    renderer(t: any) {
      const label = esc(t.alias ?? t.target + (t.heading ? ` › ${t.heading.slice(1)}` : ""));
      const note = notes.get(noteName(t.target).toLowerCase());
      if (!note) return `<span class="wikilink missing" title="No note named “${esc(t.target)}” yet">${label}</span>`;
      return `<a class="wikilink" href="${note.url}${t.heading ? `#${slug(t.heading.slice(1))}` : ""}">${label}</a>`;
    },
  };
  const m = new Marked({ gfm: true });
  m.use({
    extensions: [wikilink],
    renderer: {
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  return (md: string) =>
    (m.parse(md) as string)
      // Obsidian callouts: > [!note] Title
      .replace(/<blockquote>\s*<p>\[!(\w+)\][ \t]*([^\n<]*)/g, (_s, kind, title) => `<blockquote class="callout callout-${kind.toLowerCase()}"><p><strong class="callout-title">${title || kind}</strong><br>`);
}

function entryRow(e: Note) {
  const m = e.meta!;
  return `<li><a href="${e.url}">${esc(e.title)}</a><span class="row-meta">${m.type} · ${esc(m.projects.join(", "))} · ${m.created.slice(0, 10)}</span></li>`;
}

/** Where the owner leaves notes for agents to fold into this page (see site/worker.js). */
function annotate(n: Note) {
  return `<section class="annotations" data-page="${esc(`${n.kind}/${n.name}`)}" data-title="${esc(n.title)}">
<h2>Annotations</h2>
<ul></ul>
<form><textarea name="text" rows="3" placeholder="Add context or a correction. An agent will fold it into this page."></textarea><button type="submit">Annotate</button></form>
</section>
<script>${ANNOTATE_JS}</script>`;
}

function page(title: string, main: string, opts: { siteName: string; depth?: string } = { siteName: "autoblog" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site"><a href="/" class="brand">${esc(opts.siteName)}</a><nav><a href="/timeline/">timeline</a><a href="/projects/">projects</a><a href="/tags/">tags</a></nav></header>
<main>
${main}
</main>
</body>
</html>
`;
}

export function buildSite(cfg: Config, out: string, siteName: string) {
  const notes = loadNotes(cfg);
  const render = markdown(notes);
  const all = [...notes.values()];
  // Ordered by `created`: when the work happened. Revisions and backfills shouldn't reshuffle history.
  const entries = all.filter((n) => n.kind !== "project").sort((a, b) => b.meta!.created.localeCompare(a.meta!.created));
  const projects = all.filter((n) => n.kind === "project").sort((a, b) => a.name.localeCompare(b.name));
  const about = (pr: Note) => entries.filter((e) => e.meta!.projects.some((p) => p.toLowerCase() === pr.name.toLowerCase()));
  // The timeline: one file per day, one "- thing: what happened" line per piece of work.
  const tdir = timelineDir(cfg);
  const days = (existsSync(tdir) ? readdirSync(tdir) : []).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, -3)).sort().reverse();
  const logged = days.map((day) => ({ day, lines: dayLines(cfg, day) }));
  const linesAbout = (pr: Note) =>
    logged.flatMap(({ day, lines }) => lines.filter((l) => l.toLowerCase().startsWith(`- [[${pr.name.toLowerCase()}]]`)).map((l) => ({ day, line: l })));
  const backlinks = (n: Note) =>
    all.filter((o) => o !== n && o.links.has(n.name.toLowerCase())).sort((a, b) => (b.meta?.created ?? "").localeCompare(a.meta?.created ?? ""));

  rmSync(out, { recursive: true, force: true });
  const emit = (url: string, html: string) => {
    const dir = join(out, url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
  };
  writeFileSync(join((mkdirSync(out, { recursive: true }), out), "style.css"), CSS);
  const projectLink = (p: string) => {
    const n = notes.get(p.toLowerCase());
    return n ? `<a href="${n.url}">${esc(p)}</a>` : esc(p);
  };

  for (const e of entries) {
    const m = e.meta!;
    const refs = backlinks(e);
    const created = m.created.slice(0, 10), updated = m.updated.slice(0, 10);
    emit(
      e.url,
      page(
        e.title,
        `<article>
<p class="eyebrow">${m.type}</p>
<h1>${esc(e.title)}</h1>
<p class="meta">${m.projects.map(projectLink).join(", ")} · ${updated === created ? created : `updated ${updated}`}${m.tags.length ? ` · ${m.tags.map((t) => `<a class="tag" href="/tags/${slug(t)}/">#${esc(t)}</a>`).join(" ")}` : ""}</p>
${render(e.body)}
</article>
<aside class="links">
<section><h2>Linked from</h2>${refs.length ? `<ul>${refs.map((r) => `<li><a href="${r.url}">${esc(r.title)}</a> <span class="row-meta">${r.kind}</span></li>`).join("")}</ul>` : `<p class="empty">Nothing links here yet.</p>`}</section>
${annotate(e)}
</aside>`,
        { siteName },
      ),
    );
  }

  for (const pr of projects) {
    const es = about(pr);
    const refs = backlinks(pr).filter((r) => !es.includes(r));
    const group = (kind: string, label: string) => {
      const g = es.filter((e) => e.kind === kind);
      return g.length ? `<section class="list"><h2>${label}</h2><ul class="posts">${g.map(entryRow).join("")}</ul></section>` : "";
    };
    emit(
      pr.url,
      page(
        pr.name,
        `<article><p class="eyebrow">project</p><h1>${esc(pr.name)}</h1>${render(pr.body)}</article>
${group("post", "Posts")}${group("note", "Notes")}${es.length || linesAbout(pr).length ? "" : `<p class="empty">Nothing in the journal touches this project yet.</p>`}
${(() => {
  const ls = linesAbout(pr).slice(0, 30);
  return ls.length ? `<section class="list"><h2>Timeline</h2>${render(ls.map(({ day, line }) => `- ${day} · ${line.replace(/^- \[\[[^\]]+\]\]:\s*/, "")}`).join("\n"))}</section>` : "";
})()}
<aside class="links">${refs.length ? `<section><h2>Also linked from</h2><ul>${refs.map((r) => `<li><a href="${r.url}">${esc(r.title)}</a></li>`).join("")}</ul></section>` : ""}${annotate(pr)}</aside>`,
        { siteName },
      ),
    );
  }

  const active = projects.filter((pr) => about(pr).length || linesAbout(pr).length);
  emit(
    "/timeline/",
    page(
      "Timeline",
      `<h1>Timeline</h1>${logged.length ? logged.map(({ day, lines }) => `<section class="day"><h2>${day}</h2>${render(lines.join("\n"))}</section>`).join("\n") : `<p class="empty">Nothing logged yet.</p>`}`,
      { siteName },
    ),
  );
  emit(
    "/projects/",
    page(
      "Projects",
      `<h1>Projects</h1>${active.length ? `<ul class="projects">${active
        .map((pr) => {
          const n = about(pr).length;
          const summary = projectSummary(cfg, pr.name);
          return `<li><a href="${pr.url}">${esc(pr.name)}</a> <span class="row-meta">${n} ${n === 1 ? "entry" : "entries"}</span>${summary ? `<p>${esc(summary.split("\n")[0])}</p>` : ""}</li>`;
        })
        .join("")}</ul>` : `<p class="empty">No projects yet.</p>`}`,
      { siteName },
    ),
  );

  const tags = new Map<string, Note[]>();
  for (const e of entries) for (const t of e.meta!.tags) tags.set(t, [...(tags.get(t) ?? []), e]);
  for (const [t, es] of tags) emit(`/tags/${slug(t)}/`, page(`#${t}`, `<h1>#${esc(t)}</h1><ul class="posts">${es.map(entryRow).join("")}</ul>`, { siteName }));
  emit(
    "/tags/",
    page(
      "Tags",
      `<h1>Tags</h1><p class="tags">${[...tags.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([t, es]) => `<a class="tag" href="/tags/${slug(t)}/">#${esc(t)} <span class="dim">${es.length}</span></a>`)
        .join(" ")}</p>`,
      { siteName },
    ),
  );

  // Home: search, then posts, then notes, each newest first.
  const posts = entries.filter((e) => e.kind === "post");
  const noteEntries = entries.filter((e) => e.kind === "note");
  const searchIndex = entries.map((e) => ({ t: e.title, u: e.url, p: e.meta!.projects.join(" "), g: e.meta!.tags.join(" "), b: e.body.replace(/[#*`>\[\]_-]+/g, " ").replace(/\s+/g, " ").slice(0, 4000) }));
  writeFileSync(join(out, "search.json"), JSON.stringify(searchIndex));
  emit(
    "/",
    page(
      siteName,
      `<input id="q" type="search" placeholder="Search notes and posts…" autocomplete="off">
<ul id="results" class="posts" hidden></ul>
<div id="home">
<h2>Posts</h2>${posts.length ? `<ul class="posts">${posts.map(entryRow).join("")}</ul>` : "<p class=empty>No posts yet.</p>"}
<h2>Notes</h2>${noteEntries.length ? `<ul class="posts">${noteEntries.map(entryRow).join("")}</ul>` : "<p class=empty>No notes yet.</p>"}
</div>
<script>${SEARCH_JS}</script>`,
      { siteName },
    ),
  );
  return { notes: noteEntries.length, posts: posts.length, projects: active.length, tags: tags.size, days: days.length };
}

const SEARCH_JS = `
const q = document.getElementById("q"), results = document.getElementById("results"), home = document.getElementById("home");
let index = null;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
q.addEventListener("input", async () => {
  const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  if (!terms.length) { results.hidden = true; home.hidden = false; return; }
  index ??= await (await fetch("/search.json")).json();
  const score = (d) => terms.every((t) => (d.t + " " + d.p + " " + d.g + " " + d.b).toLowerCase().includes(t)) ? terms.reduce((s, t) => s + (d.t.toLowerCase().includes(t) ? 3 : 0) + (d.g.includes(t) ? 2 : 0) + 1, 0) : 0;
  const hits = index.map((d) => [score(d), d]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  results.innerHTML = hits.length ? hits.map(([, d]) => '<li><a href="' + d.u + '">' + esc(d.t) + '</a><span class="row-meta">' + esc(d.p) + '</span></li>').join("") : '<li class="empty">No matches.</li>';
  results.hidden = false; home.hidden = true;
});
`;

const ANNOTATE_JS = `
(() => {
  const box = document.currentScript.previousElementSibling, list = box.querySelector("ul"), form = box.querySelector("form");
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const label = { open: "waiting for an agent", applied: "folded in", skipped: "not applied" };
  const show = (a) => {
    const li = document.createElement("li");
    li.innerHTML = '<p>' + esc(a.text).replace(/\\n/g, "<br>") + '</p><span class="row-meta">' + a.at.slice(0, 10) + ' · ' + (label[a.status] || a.status) + (a.reply ? ' · ' + esc(a.reply) : '') + (a.status === "open" ? ' · <a href="#" data-id="' + a.id + '">delete</a>' : '') + '</span>';
    list.append(li);
  };
  list.addEventListener("click", async (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    e.preventDefault();
    const r = await fetch("/_annotations/" + id, { method: "DELETE", headers: { "Content-Type": "application/json" } });
    if (r.ok) e.target.closest("li").remove();
  });
  fetch("/_annotations?page=" + encodeURIComponent(box.dataset.page)).then((r) => (r.ok ? r.json() : [])).then((as) => as.forEach(show)).catch(() => {});
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    const r = await fetch("/_annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: box.dataset.page, title: box.dataset.title, text }) });
    if (r.ok) { show(await r.json()); form.reset(); } else alert("Couldn't save the annotation: " + (await r.text()));
  });
})();
`;

const CSS = `:root {
  --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b675f; --line: #e6e2d9; --accent: #9a4a1c; --code-bg: #f1eee7; --missing: #a8a294;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Charter, Georgia, serif;
  --sans: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161513; --fg: #e9e5dc; --muted: #9a958a; --line: #2c2a26; --accent: #e09a62; --code-bg: #211f1c; --missing: #6d685e; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.65 var(--serif); }
main { max-width: 42rem; margin: 0 auto; padding: 1.5rem 16px 6rem; }
header.site { max-width: 42rem; margin: 0 auto; padding: 1.25rem 16px 0; display: flex; justify-content: space-between; align-items: baseline; font-family: var(--sans); font-size: 15px; }
header.site .brand { font-weight: 650; color: var(--fg); text-decoration: none; letter-spacing: -0.01em; }
header.site nav a { color: var(--muted); text-decoration: none; margin-left: 1.1rem; }
header.site nav a:hover { color: var(--fg); }
a { color: var(--accent); text-underline-offset: 0.18em; text-decoration-thickness: 1px; }
h1 { font-size: 2.1rem; line-height: 1.2; letter-spacing: -0.015em; margin: 1.5rem 0 0.5rem; text-wrap: balance; }
h2 { font-size: 1.35rem; line-height: 1.3; margin: 2.2rem 0 0.6rem; }
h3 { font-size: 1.1rem; margin: 1.8rem 0 0.4rem; }
.meta, .row-meta, .eyebrow, .empty, aside, .tags, #q { font-family: var(--sans); }
.meta { color: var(--muted); font-size: 14px; margin: 0 0 2rem; }
.eyebrow { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; margin: 2rem 0 -1rem; }
.dim { opacity: 0.4; }
.tag { text-decoration: none; font-family: var(--sans); font-size: 14px; }
code { font: 0.86em/1.5 var(--mono); background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 15px; }
pre code { background: none; padding: 0; font-size: inherit; }
blockquote { margin: 1.4rem 0; padding: 0.2rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
blockquote.callout { border-left-color: var(--accent); background: var(--code-bg); border-radius: 0 8px 8px 0; color: var(--fg); }
.callout-title { font-family: var(--sans); font-size: 14px; text-transform: capitalize; }
table { border-collapse: collapse; width: 100%; font-size: 16px; display: block; overflow-x: auto; }
th, td { border-bottom: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.5rem 0; }
a.wikilink { text-decoration-style: dotted; }
.wikilink.missing { color: var(--missing); border-bottom: 1px dotted var(--missing); cursor: help; }
ul.posts, ul.projects, aside ul { list-style: none; padding: 0; margin: 0; }
ul.posts li, ul.projects li, aside li { padding: 0.55rem 0; border-bottom: 1px solid var(--line); }
ul.posts li a, ul.projects li a { font-weight: 600; text-decoration: none; color: var(--fg); }
ul.posts li a:hover, ul.projects li a:hover { color: var(--accent); }
.row-meta { display: block; color: var(--muted); font-size: 13px; margin-top: 0.1rem; }
ul.projects p { margin: 0.2rem 0 0; color: var(--muted); font-size: 16px; }
aside.links { margin-top: 3.5rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: 15px; }
aside.links h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 1.5rem 0 0.4rem; }
aside a { text-decoration: none; }
.empty { color: var(--muted); font-size: 15px; }
#q { width: 100%; font-size: 16px; padding: 0.7rem 0.9rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); margin: 1rem 0 0.5rem; }
#q:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.annotations li p { margin: 0; white-space: pre-wrap; }
.annotations form { margin-top: 0.8rem; }
.annotations textarea { width: 100%; font: 15px/1.5 var(--sans); padding: 0.6rem 0.8rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); resize: vertical; }
.annotations textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.annotations button { margin-top: 0.4rem; font: 600 14px var(--sans); padding: 0.45rem 0.9rem; border: 0; border-radius: 6px; background: var(--accent); color: var(--bg); cursor: pointer; }
@media (max-width: 600px) { body { font-size: 17px; } h1 { font-size: 1.7rem; } }
`;
