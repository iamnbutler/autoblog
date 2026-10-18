import { basename } from "node:path";
import type { Config } from "./config";
import { listPosts, projectSummary } from "./journal";

/** What a writer needs to place a post in the vault: the project's description and linkable note names. */
export function vaultContext(cfg: Config, project: string): string {
  const posts = listPosts(cfg);
  const mine = posts.filter((p) => p.project === project).slice(0, 30);
  const others = posts.filter((p) => p.project !== project).slice(0, 30);
  const names = (ps: typeof posts) => (ps.length ? ps.map((p) => `  - [[${basename(p.path, ".md")}]]`).join("\n") : "  (none yet)");
  const summary = projectSummary(cfg, project);
  return [
    `Project note: [[${project}]]`,
    summary
      ? `  What it is: ${summary.replace(/\n+/g, " ")}`
      : `  It has no description yet. When you write, also pass --project-summary "<one to three sentences: what ${project} is and why it exists, for someone who has never heard of it>".`,
    "",
    `Existing posts about ${project} (link related ones; update one instead of retelling its story):`,
    names(mine),
    "",
    "Recent posts from other projects (link if genuinely related):",
    names(others),
  ].join("\n");
}
