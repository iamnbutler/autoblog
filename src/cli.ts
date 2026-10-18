import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LOG_PATH, REPO_ROOT, STATE_DIR, loadConfig } from "./config";
import { listPosts, writePost } from "./journal";
import { sweep } from "./review";
import { install, uninstall } from "./install";

const HELP = `autoblog: an effortless private journal written by your agents

Usage
  autoblog write --title <t> [--kind k] [--tags a,b] [--signal 1-3] [--agent a] < body.md
  autoblog search <words...>        grep the journal, newest first
  autoblog ls [--jewels] [-n 20]    list recent posts
  autoblog log [-n 20]              recent auto-mode decisions (for tuning the reviewer)
  autoblog sweep [--dry-run] [-v]   review idle transcripts now (what launchd runs)
  autoblog review <transcript> [--dry-run]
                                    review one transcript, ignoring idle and size gates
  autoblog hook                     Claude Code hook entrypoint (reads hook JSON on stdin)
  autoblog install [--journal-repo owner/name] [--no-launchd] [--no-hooks]
  autoblog uninstall
  autoblog path                     print the journal directory
`;

const SELF = [process.execPath, join(REPO_ROOT, "src", "cli.ts")];

function detached(args: string[]) {
  spawn(SELF[0], [SELF[1], ...args], { detached: true, stdio: "ignore", cwd: STATE_DIR }).unref();
}

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
        session: values.session ?? process.env.CLAUDE_SESSION_ID,
        cwd: process.cwd(),
        mode: "manual",
      });
      console.log(file);
      return;
    }

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
      // Never block or slow the agent: hand off to a detached process and exit.
      if (process.env.AUTOBLOG_REVIEWER) return;
      let ev: any = {};
      try {
        ev = JSON.parse(await readStdin());
      } catch {}
      if (ev.hook_event_name === "SessionEnd" && ev.transcript_path) {
        detached(["__session-end", ev.transcript_path]);
      } else {
        // Stop fires every turn; sweep other idle sessions at most every 10 minutes.
        const stamp = join(STATE_DIR, "last-nudge");
        if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < 10 * 60_000) return;
        writeFileSync(stamp, "");
        detached(["sweep"]);
      }
      return;
    }

    case "__session-end": {
      await sweep(cfg, { only: rest });
      return;
    }

    case "install": {
      const { values } = parseArgs({
        args: rest,
        options: { "journal-repo": { type: "string" }, "no-launchd": { type: "boolean" }, "no-hooks": { type: "boolean" } },
      });
      install({ journalRepo: values["journal-repo"], noLaunchd: values["no-launchd"], noHooks: values["no-hooks"] });
      return;
    }

    case "uninstall":
      return uninstall();

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
