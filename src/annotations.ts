import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { personalize, REPO_ROOT, type Config } from "./config";
import { password } from "./deploy";

/*
 * Annotations are notes the owner leaves on a page of the site (site/worker.js keeps them in
 * KV). An agent folds each page's open annotations into the entry or project description,
 * then marks them applied or skipped, which shows on the page.
 */

export type Annotation = { id: string; page: string; title: string; text: string; at: string; status: string; reply?: string };

async function api(cfg: Config, path: string, init: RequestInit = {}): Promise<any> {
  const pw = password();
  if (!cfg.site?.url || !pw) throw new Error("the site isn't set up; run `autoblog site setup`");
  const res = await fetch(cfg.site.url + path, {
    ...init,
    headers: { Authorization: "Basic " + btoa(`${cfg.site.user}:${pw}`), "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export const listAnnotations = (cfg: Config, status?: string): Promise<Annotation[]> =>
  api(cfg, `/_annotations${status ? `?status=${status}` : ""}`);

const mark = (cfg: Config, id: string, status: string, reply: string) =>
  api(cfg, `/_annotations/${id}`, { method: "PATCH", body: JSON.stringify({ status, reply }) });

/**
 * Apply open annotations, one agent per page. Annotations younger than `settleMinutes` wait,
 * so a few left in a row land together.
 */
export async function applyAnnotations(cfg: Config, opts: { settleMinutes?: number; dryRun?: boolean; verbose?: boolean } = {}) {
  if (!cfg.site?.kv) return;
  const say = (m: string) => opts.verbose && console.error(m);
  const cutoff = Date.now() - (opts.settleMinutes ?? 10) * 60_000;
  let open: Annotation[];
  try {
    open = await listAnnotations(cfg, "open");
  } catch (e) {
    return say(`annotations: ${(e as Error).message}`);
  }
  const pages = new Map<string, Annotation[]>();
  for (const a of open) pages.set(a.page, [...(pages.get(a.page) ?? []), a]);
  for (const [page, as] of pages) {
    if (as.some((a) => Date.parse(a.at) > cutoff)) {
      say(`annotations: ${page} has a recent annotation; waiting`);
      continue;
    }
    say(`annotations: ${page} (${as.length})`);
    if (opts.dryRun) continue;
    const [kind, ...rest] = page.split("/");
    const name = rest.join("/");
    const prompt = personalize(cfg, readFileSync(join(REPO_ROOT, "prompts", "annotate.md"), "utf8"))
      .replace("{{PAGE}}", `${kind} "${name}"`)
      .replace("{{ANNOTATIONS}}", as.map((a) => `- id ${a.id} (${a.at.slice(0, 10)}):\n${a.text.replace(/^/gm, "  > ")}`).join("\n\n"))
      .replace("{{SESSIONS}}", as.map((a) => `annotation:${a.id}`).join(","));
    const r = spawnSync(
      "claude",
      ["-p", "--model", cfg.model, "--no-session-persistence", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(autoblog:*)"],
      { cwd: cfg.journal, input: prompt, encoding: "utf8", env: { ...process.env, AUTOBLOG_REVIEWER: "1" }, timeout: 20 * 60_000 },
    );
    if (r.status !== 0) {
      say(`annotations: agent failed on ${page}\n${(r.stderr || r.stdout || "").slice(0, 1000)}`);
      continue;
    }
    for (const a of as) {
      const m = new RegExp(`${a.id}\\W+(APPLIED|SKIPPED):?\\s*(.*)`).exec(r.stdout);
      if (!m) {
        say(`annotations: no verdict for ${a.id}; leaving it open`);
        continue;
      }
      await mark(cfg, a.id, m[1] === "APPLIED" ? "applied" : "skipped", m[2].trim()).catch((e) => say(String(e)));
      say(`  ${a.id} ${m[1].toLowerCase()}: ${m[2].trim()}`);
    }
  }
}
