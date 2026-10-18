import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LOG_PATH, loadConfig, REPO_ROOT } from "./config";
import { archiveAll, commitLocked, ensureJournal, ensureProjectNote, findEntry, listEntries, projectFor, projectSummary, reviseEntry, TYPES, writeEntry, type EntryType } from "./journal";
import { logDecision, readBar, sweep } from "./review";
import { linkAfterWrite, linkDue, linkNamed } from "./link";
import { checkpoint, type HookInput } from "./inband";
import { readDelta } from "./transcripts";
import { init, install, uninstall } from "./install";
import { build, deploy, password, setup, siteUrl } from "./deploy";

const HELP = `autoblog: a private journal written by your agents, organized by topic

Usage
  autoblog write --type note|post --title <topic> [--tags a,b] [--project a,b] [--mode manual|auto] < body.md
  autoblog revise <name> [--title new] [--tags a,b] [--project a,b] < body.md
                                    replace an entry's body (rewrite it whole; it's a living page);
                                    --project sets the project list, otherwise the current repo is added
  autoblog show <name>              print an entry, to revise it
  autoblog ls [--notes|--posts] [-n N]
                                    entries, most recently updated first
  autoblog search <words...>        grep notes and posts (check before writing a new topic)
  autoblog link [name...] [--due] [--dry-run]
                                    add [[links]] between entries (runs after every write, and daily)
  autoblog project [name] [--summary "..."]
                                    show or set what a project is (its hub note)
  autoblog skip "<reason>"          record that a checkpoint found nothing worth writing
  autoblog bar                      print the bar for what is worth writing
  autoblog guide                    print the how-to (the autoblog skill), for checkpoints and manual writes
  autoblog transcript <path.jsonl>  condensed, readable view of a Claude Code or Codex transcript
  autoblog log [-n 20]              recent auto-mode decisions, in-band and sweep (for tuning)
  autoblog sweep [--dry-run] [-v]   fallback: review idle transcripts no agent claimed in-band
  autoblog review <transcript> [--dry-run]
                                    review one transcript, ignoring idle and size gates
  autoblog hook [--agent codex]     Stop hook entrypoint (reads hook JSON on stdin)
  autoblog init [--name n | --repo owner/name] [--dir path] [--no-install]
                                    create/clone the private {name}-autoblog vault, then install
  autoblog install [--no-launchd] [--no-hooks]
                                    (re)wire the CLI, skill, Stop hooks, and fallback sweep
  autoblog uninstall
  autoblog site setup [--worker name] [--user name] [--rotate]
                                    private site on Cloudflare (Worker + basic auth); redeploys after every write
  autoblog site deploy|build|open|password
  autoblog archive "<why>"          move every note and post to archive/<date>/ and start over
  autoblog reindex                  rebuild the journal index after hand edits, commit, push
  autoblog path                     print the journal directory
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Response(Bun.stdin.stream()).text();
}

const list = (v?: string) => v?.split(",").map((t) => t.trim()).filter(Boolean);
const detectAgent = () => (process.env.CLAUDECODE ? "claude-code" : process.env.CODEX_SANDBOX || process.env.CODEX_HOME ? "codex" : undefined);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case "write": {
      const { values } = parseArgs({
        args: rest,
        options: {
          type: { type: "string" },
          title: { type: "string" },
          tags: { type: "string" },
          agent: { type: "string" },
          project: { type: "string" },
          session: { type: "string" },
          body: { type: "string" },
          mode: { type: "string" },
          "project-summary": { type: "string" },
          date: { type: "string" },
        },
      });
      const body = values.body ?? (await readStdin());
      if (!values.title || !body.trim() || !TYPES.includes(values.type as EntryType)) {
        console.error("autoblog write: --type note|post, --title, and a body on stdin (or --body) are required");
        process.exit(2);
      }
      const file = writeEntry(cfg, {
        type: values.type as EntryType,
        title: values.title,
        body,
        tags: list(values.tags),
        agent: values.agent ?? detectAgent(),
        projects: list(values.project),
        projectSummary: values["project-summary"],
        session: values.session,
        cwd: process.cwd(),
        mode: values.mode === "auto" || values.mode === "backfill" ? values.mode : "manual",
        date: values.date,
      });
      logDecision({ source: values.mode === "auto" ? "inband" : (values.mode ?? "manual"), session: values.session, decision: "write", titles: [`${values.type}: ${values.title}`], written: [file] });
      console.log(file);
      return;
    }

    case "revise": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { title: { type: "string" }, tags: { type: "string" }, project: { type: "string" }, session: { type: "string" }, agent: { type: "string" }, body: { type: "string" } },
      });
      const body = values.body ?? (await readStdin());
      if (!positionals[0] || (!body.trim() && !values.title)) {
        console.error("autoblog revise <name> < body.md   (the whole new body; see `autoblog show <name>`)");
        process.exit(2);
      }
      const file = reviseEntry(cfg, positionals[0], {
        body,
        title: values.title,
        tags: list(values.tags),
        projects: list(values.project),
        cwd: process.cwd(),
        session: values.session,
        agent: values.agent ?? detectAgent(),
      });
      if (!file) {
        console.error(`autoblog revise: nothing named ${positionals[0]} (see \`autoblog ls\`)`);
        process.exit(2);
      }
      logDecision({ source: values.session ? "inband" : "manual", session: values.session, decision: "revise", written: [file] });
      console.log(file);
      return;
    }

    case "show": {
      const file = rest[0] && findEntry(cfg, rest.join(" "));
      if (!file) {
        console.error(`autoblog show: nothing named ${rest.join(" ")} (see \`autoblog ls\`)`);
        process.exit(2);
      }
      console.log(readFileSync(file, "utf8"));
      return;
    }

    case "skip": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { session: { type: "string" } } });
      logDecision({ source: "inband", session: values.session, project: projectFor(process.cwd()), decision: "skip", reason: positionals.join(" ") });
      return;
    }

    case "project": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { summary: { type: "string" } } });
      const name = positionals[0] ?? projectFor(process.cwd());
      if (values.summary) {
        ensureJournal(cfg);
        ensureProjectNote(cfg, name, values.summary, true);
        ensureJournal(cfg);
        commitLocked(cfg, `project: ${name}`);
      }
      console.log(`[[${name}]]\n${projectSummary(cfg, name) ?? "(no description yet)"}`);
      return;
    }

    case "transcript": {
      // Condensed, readable view of a Claude Code or Codex transcript: user, agent, tool calls, clipped results.
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { from: { type: "string" } } });
      if (!positionals[0]) return console.error("autoblog transcript <path.jsonl> [--from line]");
      const d = readDelta(positionals[0], Number(values.from ?? 0), Number.MAX_SAFE_INTEGER);
      const stamps = readFileSync(positionals[0], "utf8").match(/"timestamp":"([^"]+)"/g) ?? [];
      const when = (i: number) => stamps.at(i)?.slice(13, 29) ?? "?";
      console.log(`# ${d.source} session ${d.session ?? "?"} in ${d.cwd ?? "?"}, ${when(0)} to ${when(-1)} (${d.userTurns} user turns, ${d.toolCalls} tool calls)\n`);
      console.log(d.text);
      return;
    }

    case "bar":
      return console.log(readBar());

    case "search": {
      if (!rest.length) return console.error("autoblog search <words...>");
      const dirs = ["notes", "posts"].map((d) => join(cfg.journal, d)).filter(existsSync);
      const r = spawnSync("grep", ["-rilE", rest.join(".*"), ...dirs], { encoding: "utf8" });
      const hits = new Set(r.stdout.split("\n").filter(Boolean).map((p) => p.slice(cfg.journal.length + 1)));
      for (const e of listEntries(cfg).filter((e) => hits.has(e.path))) {
        console.log(`${e.type.padEnd(5)} ${e.title}  [${e.projects.join(", ")}]\n      ${join(cfg.journal, e.path)}`);
      }
      return;
    }

    case "ls": {
      const { values } = parseArgs({ args: rest, options: { notes: { type: "boolean" }, posts: { type: "boolean" }, n: { type: "string", short: "n" } } });
      const entries = listEntries(cfg, values.notes ? "note" : values.posts ? "post" : undefined);
      const shown = values.n ? entries.slice(0, Number(values.n)) : entries;
      for (const e of shown) {
        console.log(`${e.updated.slice(0, 10)}  ${e.type.padEnd(5)} ${e.title}  [${e.projects.join(", ")}]`);
      }
      if (shown.length < entries.length) console.log(`(${entries.length - shown.length} more; drop -n to see all)`);
      return;
    }

    case "log": {
      const { values } = parseArgs({ args: rest, options: { n: { type: "string", short: "n" } } });
      if (!existsSync(LOG_PATH)) return;
      const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").slice(-Number(values.n ?? 20));
      for (const l of lines) {
        const e = JSON.parse(l);
        const where = e.project ?? e.transcript?.split("/").slice(-2, -1)[0] ?? "";
        console.log(`${e.at.slice(0, 16)}  ${e.decision.padEnd(12)} ${where}${e.reason ? `\n    ${e.reason}` : ""}${e.titles?.length ? `\n    ${e.titles.join("; ")}` : ""}`);
      }
      return;
    }

    case "sweep": {
      const { values } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" }, verbose: { type: "boolean", short: "v" } } });
      await sweep(cfg, { dryRun: values["dry-run"], verbose: values.verbose || values["dry-run"] });
      // Once a day, older entries pick up links to whatever was written since.
      linkDue(cfg, { daily: true, dryRun: values["dry-run"] });
      return;
    }

    case "guide": {
      const skill = readFileSync(join(REPO_ROOT, "skill", "autoblog", "SKILL.md"), "utf8");
      console.log(skill.replace(/^---\n[\s\S]*?\n---\n+/, ""));
      return;
    }

    case "link": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { due: { type: "boolean" }, "after-write": { type: "boolean" }, "dry-run": { type: "boolean" } },
      });
      if (values["after-write"]) return linkAfterWrite(cfg, positionals[0]);
      const changed = values.due ? linkDue(cfg, { dryRun: values["dry-run"] }) : linkNamed(cfg, positionals, { dryRun: values["dry-run"] });
      if (!values["dry-run"]) console.log(changed.length ? `linked ${changed.join(", ")}` : "no new links");
      return;
    }

    case "review": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "dry-run": { type: "boolean" } } });
      if (!positionals.length) return console.error("autoblog review <transcript.jsonl>");
      await sweep(cfg, { only: positionals, force: true, dryRun: values["dry-run"], verbose: true });
      return;
    }

    case "hook": {
      // Stop hook. Returns instantly unless this turn is a reflection checkpoint.
      if (process.env.AUTOBLOG_REVIEWER) return;
      const { values } = parseArgs({ args: rest, options: { agent: { type: "string" } } });
      const agent = values.agent ?? "claude-code";
      let ev: HookInput = {};
      try {
        ev = JSON.parse(await readStdin());
      } catch {}
      const prompt = checkpoint(cfg, ev, agent);
      if (!prompt) return;
      if (agent === "claude-code") {
        // Non-error continuation: the agent sees this as hook feedback and takes one more step.
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: prompt } }));
      } else {
        console.log(JSON.stringify({ decision: "block", reason: prompt }));
      }
      return;
    }

    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: {
          name: { type: "string" },
          repo: { type: "string" },
          dir: { type: "string" },
          "no-install": { type: "boolean" },
          "no-launchd": { type: "boolean" },
          "no-hooks": { type: "boolean" },
        },
      });
      init({ name: values.name, repo: values.repo, dir: values.dir, noInstall: values["no-install"], noLaunchd: values["no-launchd"], noHooks: values["no-hooks"] });
      return;
    }

    case "install": {
      const { values } = parseArgs({ args: rest, options: { "no-launchd": { type: "boolean" }, "no-hooks": { type: "boolean" } } });
      install({ noLaunchd: values["no-launchd"], noHooks: values["no-hooks"] });
      return;
    }

    case "site": {
      const [sub, ...args] = rest;
      const { values } = parseArgs({
        args,
        options: { worker: { type: "string" }, user: { type: "string" }, url: { type: "string" }, rotate: { type: "boolean" }, quiet: { type: "boolean" } },
      });
      switch (sub) {
        case "setup":
          return setup({ worker: values.worker, user: values.user, url: values.url, rotate: values.rotate });
        case "deploy":
          if (!deploy(cfg, values.quiet)) process.exit(1);
          return;
        case "build": {
          const s = build(cfg);
          return console.log(`built ${s.notes} notes, ${s.posts} posts, ${s.projects} projects, ${s.tags} tags -> ~/.autoblog/site/dist`);
        }
        case "open":
          spawnSync("open", [cfg.site?.url ?? "https://dash.cloudflare.com"]);
          return console.log(siteUrl(cfg));
        case "password":
          return console.log(password() ?? "(none; run `autoblog site setup`)");
        default:
          return console.error("autoblog site setup|deploy|build|open|password");
      }
    }

    case "uninstall":
      return uninstall();

    case "archive": {
      if (!rest.length) return console.error('autoblog archive "<why these are being set aside>"');
      const n = archiveAll(cfg, rest.join(" "));
      return console.log(n ? `archived ${n} entries` : "nothing to archive");
    }

    case "reindex":
      // After hand edits: rebuild the index, commit, push.
      ensureJournal(cfg);
      commitLocked(cfg, "reindex");
      return;

    case "path":
      return console.log(cfg.journal);

    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`autoblog: ${e.message ?? e}`);
  process.exit(1);
});
