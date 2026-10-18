import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import type { Config } from "./config";
import { listPosts, noteName, projectSummary, type PostMeta } from "./journal";

/*
 * Static site for the vault, with Obsidian semantics: [[wikilinks]] resolve by note name
 * (case-insensitive, with |alias and #heading), every note shows what links to it, and
 * projects and tags get their own pages.
 */

type Note = {
  name: string; // note name = filename without .md
  kind: "post" | "project";
  url: string;
  title: string;
  body: string; // markdown, frontmatter stripped
  meta?: PostMeta;
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
  for (const p of listPosts(cfg)) {
    const name = basename(p.path, ".md");
    const body = stripFront(readFileSync(join(cfg.journal, p.path), "utf8"));
    const links = outgoing(body);
    links.add(p.project.toLowerCase()); // the project property is a link too
    notes.set(name.toLowerCase(), { name, kind: "post", url: `/posts/${slug(name)}/`, title: p.title, body, meta: p, links });
  }
  const pdir = join(cfg.journal, "projects");
  for (const f of existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".md")) : []) {
    const name = basename(f, ".md");
    const raw = stripFront(readFileSync(join(pdir, f), "utf8"));
    const body = raw.split(/\n## Posts\n/)[0];
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

const stars = (n: number) => `<span class="stars" title="signal ${n}">${"★".repeat(n)}<span class="dim">${"★".repeat(3 - n)}</span></span>`;

function postRow(p: Note) {
  const m = p.meta!;
  return `<li><a href="${p.url}">${esc(p.title)}</a><span class="row-meta">${stars(m.signal)} · ${esc(m.project)} · ${m.kind} · ${m.date.slice(0, 10)}</span></li>`;
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
<header class="site"><a href="/" class="brand">${esc(opts.siteName)}</a><nav><a href="/">posts</a><a href="/projects/">projects</a><a href="/tags/">tags</a></nav></header>
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
  const posts = all.filter((n) => n.kind === "post").sort((a, b) => b.meta!.date.localeCompare(a.meta!.date));
  const projects = all.filter((n) => n.kind === "project").sort((a, b) => a.name.localeCompare(b.name));
  const backlinks = (n: Note) =>
    all.filter((o) => o !== n && o.links.has(n.name.toLowerCase())).sort((a, b) => (b.meta?.date ?? "").localeCompare(a.meta?.date ?? ""));

  rmSync(out, { recursive: true, force: true });
  const emit = (url: string, html: string) => {
    const dir = join(out, url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
  };
  writeFileSync(join((mkdirSync(out, { recursive: true }), out), "style.css"), CSS);

  for (const p of posts) {
    const m = p.meta!;
    const proj = notes.get(m.project.toLowerCase());
    const refs = backlinks(p);
    const siblings = posts.filter((o) => o !== p && o.meta!.project === m.project).slice(0, 8);
    emit(
      p.url,
      page(
        p.title,
        `<article>
<h1>${esc(p.title)}</h1>
<p class="meta">${m.date.slice(0, 10)} · ${proj ? `<a href="${proj.url}">${esc(m.project)}</a>` : esc(m.project)} · ${m.kind} · ${stars(m.signal)}${m.tags.length ? ` · ${m.tags.map((t) => `<a class="tag" href="/tags/${slug(t)}/">#${esc(t)}</a>`).join(" ")}` : ""}</p>
${render(p.body)}
</article>
<aside class="links">
<section><h2>Linked from</h2>${refs.length ? `<ul>${refs.map((r) => `<li><a href="${r.url}">${esc(r.title)}</a>${r.kind === "project" ? ' <span class="row-meta">project</span>' : ""}</li>`).join("")}</ul>` : `<p class="empty">Nothing links here yet.</p>`}</section>
${siblings.length ? `<section><h2>More from ${esc(m.project)}</h2><ul>${siblings.map(postRow).join("")}</ul></section>` : ""}
</aside>`,
        { siteName },
      ),
    );
  }

  for (const pr of projects) {
    const ps = posts.filter((p) => p.meta!.project.toLowerCase() === pr.name.toLowerCase());
    const refs = backlinks(pr).filter((r) => r.kind !== "post" || !ps.includes(r));
    emit(
      pr.url,
      page(
        pr.name,
        `<article><p class="eyebrow">project</p><h1>${esc(pr.name)}</h1>${render(pr.body)}</article>
<section class="list"><h2>Posts</h2><ul class="posts">${ps.map(postRow).join("")}</ul></section>
${refs.length ? `<aside class="links"><section><h2>Also linked from</h2><ul>${refs.map((r) => `<li><a href="${r.url}">${esc(r.title)}</a></li>`).join("")}</ul></section></aside>` : ""}`,
        { siteName },
      ),
    );
  }

  emit(
    "/projects/",
    page(
      "Projects",
      `<h1>Projects</h1><ul class="projects">${projects
        .map((pr) => {
          const n = posts.filter((p) => p.meta!.project.toLowerCase() === pr.name.toLowerCase()).length;
          const summary = projectSummary(cfg, pr.name);
          return `<li><a href="${pr.url}">${esc(pr.name)}</a> <span class="row-meta">${n} post${n === 1 ? "" : "s"}</span>${summary ? `<p>${esc(summary.split("\n")[0])}</p>` : ""}</li>`;
        })
        .join("")}</ul>`,
      { siteName },
    ),
  );

  const tags = new Map<string, Note[]>();
  for (const p of posts) for (const t of p.meta!.tags) tags.set(t, [...(tags.get(t) ?? []), p]);
  for (const [t, ps] of tags) emit(`/tags/${slug(t)}/`, page(`#${t}`, `<h1>#${esc(t)}</h1><ul class="posts">${ps.map(postRow).join("")}</ul>`, { siteName }));
  emit(
    "/tags/",
    page(
      "Tags",
      `<h1>Tags</h1><p class="tags">${[...tags.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([t, ps]) => `<a class="tag" href="/tags/${slug(t)}/">#${esc(t)} <span class="dim">${ps.length}</span></a>`)
        .join(" ")}</p>`,
      { siteName },
    ),
  );

  // Home: search, jewels, then everything by month.
  const jewels = posts.filter((p) => p.meta!.signal >= 3);
  let month = "";
  const byMonth = posts
    .map((p) => {
      const m = p.meta!.date.slice(0, 7);
      const head = m !== month ? `${month ? "</ul>" : ""}<h3>${m}</h3><ul class="posts">` : "";
      month = m;
      return head + postRow(p);
    })
    .join("");
  const searchIndex = posts.map((p) => ({ t: p.title, u: p.url, p: p.meta!.project, g: p.meta!.tags.join(" "), b: p.body.replace(/[#*`>\[\]_-]+/g, " ").replace(/\s+/g, " ").slice(0, 4000) }));
  writeFileSync(join(out, "search.json"), JSON.stringify(searchIndex));
  emit(
    "/",
    page(
      siteName,
      `<input id="q" type="search" placeholder="Search posts…" autocomplete="off">
<ul id="results" class="posts" hidden></ul>
<div id="home">
${jewels.length ? `<h2>Jewels</h2><ul class="posts">${jewels.map(postRow).join("")}</ul>` : ""}
<h2>All posts</h2>${byMonth}${posts.length ? "</ul>" : "<p class=empty>No posts yet.</p>"}
</div>
<script>${SEARCH_JS}</script>`,
      { siteName },
    ),
  );
  return { posts: posts.length, projects: projects.length, tags: tags.size };
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
.stars { color: var(--accent); letter-spacing: 0.05em; } .dim { opacity: 0.28; }
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
@media (max-width: 600px) { body { font-size: 17px; } h1 { font-size: 1.7rem; } }
`;
