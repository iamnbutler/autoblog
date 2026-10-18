import { basename } from "node:path";
import type { Config } from "./config";
import { listEntries, projectSummary, type EntryMeta } from "./journal";

/** For the fallback reviewer, which has no tools: the project's description, and every entry, so it doesn't duplicate one. */
export function vaultContext(cfg: Config, project: string): string {
  const entries = listEntries(cfg);
  const touches = (e: EntryMeta) => e.projects.some((p) => p.toLowerCase() === project.toLowerCase());
  const row = (e: EntryMeta) => `  - [[${basename(e.path, ".md")}]]${touches(e) ? `  (${project})` : ""}`;
  const section = (label: string, es: EntryMeta[]) => [label, ...(es.length ? es.map(row) : ["  (none yet)"])];
  const summary = projectSummary(cfg, project);
  return [
    `Project note: [[${project}]]`,
    summary
      ? `  What it is: ${summary.replace(/\n+/g, " ")}`
      : `  It has no description yet. When you write, also pass --project-summary "<one to three sentences: what ${project} is and why it exists, for someone who has never heard of it>".`,
    "",
    ...section("Notes:", entries.filter((e) => e.type === "note")),
    "",
    ...section("Posts:", entries.filter((e) => e.type === "post")),
  ].join("\n");
}
