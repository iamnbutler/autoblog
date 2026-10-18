import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { LOG_PATH, loadConfig } from "./config";
import { appendUpdate, commit, ensureJournal, ensureProjectNote, listPosts, projectFor, projectSummary, writePost } from "./journal";
import { logDecision, readBar, sweep } from "./review";
import { checkpoint, type HookInput } from "./inband";
import { init, install, uninstall } from "./install";
import { build, deploy, password, setup, siteUrl } from "./deploy";

const HELP = `autoblog: an effortless private journal written by your agents

Usage
  autoblog write --title <t> [--kind k] [--tags a,b] [--signal 1-3] [--agent a] [--mode manual|auto] < body.md
  autoblog update <title|path> < more.md   append a dated update to an existing post
  autoblog notes [--project p]      exact note names, for [[wikilinks]]
  autoblog project [name] [--summary "..."]
                                    show or set what a project is (its hub note)
  autoblog skip "<reason>"          record that a checkpoint found nothing worth writing
  autoblog bar                      print the bar for what is worth writing
  autoblog search <words...>        grep the journal, newest first
  autoblog ls [--jewels] [-n 20]    list recent posts
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
  autoblog reindex                  rebuild the journal index after hand edits, commit, push
  autoblog path                     print the journal directory
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Response(Bun.stdin.stream()).text();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case "write": {
      const { values } = parseArgs({
        args: rest,
        options: {
          title: { type: "string" },
          kind: { type: "string" },
          tags: { type: "string" },
          signal: { type: "string" },
          agent: { type: "string" },
          project: { type: "string" },
          session: { type: "string" },
          body: { type: "string" },
          mode: { type: "string" },
          "project-summary": { type: "string" },
        },
      });
      const body = values.body ?? (await readStdin());
      if (!values.title || !body.trim()) {
        console.error("autoblog write: --title and a body on stdin (or --body) are required");
        process.exit(2);
      }
      const file = writePost(cfg, {
        title: values.title,
        body,
        kind: values.kind,
        tags: values.tags?.split(",").map((t) => t.trim()),
        signal: values.signal ? Number(values.signal) : 2,
        agent: values.agent ?? (process.env.CLAUDECODE ? "claude-code" : process.env.CODEX_SANDBOX || process.env.CODEX_HOME ? "codex" : undefined),
        project: values.project,
        projectSummary: values["project-summary"],
        session: values.session,
        cwd: process.cwd(),
        mode: values.mode === "auto" ? "auto" : "manual",
      });
      logDecision({ source: values.mode === "auto" ? "inband" : "manual", session: values.session, decision: "write", titles: [`[${values.signal ?? 2}] ${values.title}`], written: [file] });
      console.log(file);
      return;
    }

    case "update": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { session: { type: "string" }, body: { type: "string" } } });
      const body = values.body ?? (await readStdin());
      if (!positionals[0] || !body.trim()) {
        console.error("autoblog update <title|path> < body.md");
        process.exit(2);
      }
      const file = appendUpdate(cfg, positionals[0], body, values.session);
      if (!file) {
        console.error(`autoblog update: no post matches ${positionals[0]} (see \`autoblog notes\`)`);
        process.exit(2);
      }
      logDecision({ source: "inband", session: values.session, decision: "update", written: [file] });
      console.log(file);
      return;
    }

    case "skip": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { session: { type: "string" } } });
      logDecision({ source: "inband", session: values.session, project: projectFor(process.cwd()), decision: "skip", reason: positionals.join(" ") });
      return;
    }

    case "notes": {
      const { values } = parseArgs({ args: rest, options: { project: { type: "string" } } });
      const posts = listPosts(cfg).filter((p) => !values.project || p.project === values.project);
      for (const p of posts) console.log(`[[${basename(p.path, ".md")}]]  (${p.project}, ${p.date.slice(0, 10)})`);
      const projects = existsSync(join(cfg.journal, "projects")) ? readdirSync(join(cfg.journal, "projects")).filter((f) => f.endsWith(".md")) : [];
      for (const f of projects) console.log(`[[${basename(f, ".md")}]]  (project)`);
      return;
    }

    case "project": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { summary: { type: "string" } } });
      const name = positionals[0] ?? projectFor(process.cwd());
      if (values.summary) {
        ensureJournal(cfg);
        ensureProjectNote(cfg, name, values.summary, true);
        commit(cfg, `project: ${name}`);
      }
      console.log(`[[${name}]]\n${projectSummary(cfg, name) ?? "(no description yet)"}`);
      return;
    }

    case "bar":
      return console.log(readBar());

    case "search": {
      if (!rest.length) return console.error("autoblog search <words...>");
      const r = spawnSync("grep", ["-rilE", rest.join(".*"), join(cfg.journal, "posts")], { encoding: "utf8" });
      const hits = new Set(r.stdout.split("\n").filter(Boolean).map((p) => p.slice(cfg.journal.length + 1)));
      for (const p of listPosts(cfg).filter((p) => hits.has(p.path))) {
        console.log(`${p.date.slice(0, 10)}  ${"★".repeat(p.signal).padEnd(3)}  ${p.title}  [${p.project}]\n            ${join(cfg.journal, p.path)}`);
      }
      return;
    }

    case "ls": {
      const { values } = parseArgs({ args: rest, options: { jewels: { type: "boolean" }, n: { type: "string", short: "n" } } });
      let posts = listPosts(cfg);
      if (values.jewels) posts = posts.filter((p) => p.signal >= 3);
      for (const p of posts.slice(0, Number(values.n ?? 20))) {
        console.log(`${p.date.slice(0, 10)}  ${"★".repeat(p.signal).padEnd(3)}  ${p.kind.padEnd(9)} ${p.title}  [${p.project}]`);
      }
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
          return console.log(`built ${s.posts} posts, ${s.projects} projects, ${s.tags} tags -> ~/.autoblog/site/dist`);
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

    case "reindex":
      // After hand edits: rebuild the index, commit, push.
      ensureJournal(cfg);
      commit(cfg, "reindex");
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
