# autoblog

An effortless, private engineering journal written by your coding agents.

Agents notice when something you did was worth remembering (a non-obvious fix, a novel solution, a procedure you keep repeating, a decision and its why) and write it up as a Markdown post in a **private** repo. Nobody has to read it front to back. It's a searchable firehose for "how did we do X again?", and you can pull the jewels out later.

This repo is the machinery. The journal lives in a separate private repo.

## Modes

**Auto (always on, in-band).** This mirrors the tail end of a `lane` lifecycle, where you reflect before landing. The agent doing the work decides what's worth writing, because only it has the whole context, including the thing from day one of a multi-day session that turned out to matter on day three.

- A `Stop` hook (Claude Code and Codex) counts tool calls since the session's last checkpoint. It reads only the bytes appended since then, so it costs nothing on a 40MB transcript. Once `reflectEvery` (40) calls pile up, the hook asks the agent to reflect before it stops.
- The agent reads the bar (`autoblog bar`, i.e. [`prompts/bar.md`](prompts/bar.md)), looks back over the whole session, and does exactly one thing: `autoblog write`, `autoblog update <post>`, or `autoblog skip "<reason>"`. Most checkpoints end in a skip.
- Checkpoints come every chunk of work, so each chunk is reflected on while it's still in context. The prompt also gives the agent its own transcript path, so it can grep details that compaction dropped.
- The decision and its reason are logged to `~/.autoblog/decisions.jsonl`. `autoblog log` shows them; tune `prompts/bar.md` on real misses.

**Fallback sweep.** For transcripts no hook ever claimed (sessions from before install, or harnesses without hooks), a launchd job runs every 20 minutes. It hands idle transcripts to `claude -p` (`model`, default `opus`) with [`prompts/review.md`](prompts/review.md) plus the same bar. It sees only a condensed transcript, so it's second best.

**Manual.** `/autoblog`, `/autoblog <topic>`, or "write up an autoblog for this", in any agent that loads skills.

## What a post is

The bar is the product, so read [`prompts/bar.md`](prompts/bar.md). In short, a post is a **story worth telling**, written for you a year from now, having forgotten the project entirely. It's a short blog post: what the project is, what we were after, what got in the way, what turned out to be true, and the takeaway that outlives the project, with an optional `## Details` section of commands at the end. One gotcha with no story isn't a post. Each post gets a **signal**: 1 is narrow, 2 is a reusable lesson, 3 is a jewel. `autoblog ls --jewels` lists the 3s.

## Wiring

| Agent | Auto | Manual |
| --- | --- | --- |
| Claude Code | `Stop` hook in `~/.claude/settings.json` | skill at `~/.claude/skills/autoblog` |
| Codex | `Stop` hook in `~/.codex/hooks.json` (approve once via `/hooks`) | skill at `~/.codex/skills/autoblog` and `~/.agents/skills/autoblog` |
| Anything else | a Stop hook calling `autoblog hook --agent <name>` (it emits `{"decision":"block","reason":...}`), or the fallback sweep with a reader in `src/transcripts.ts` | `skill/autoblog/SKILL.md`, or just `autoblog write` |

## Install

Requires [bun](https://bun.sh), an authenticated `gh`, and the `claude` CLI.

```bash
git clone https://github.com/iamnbutler/autoblog ~/code/autoblog
~/code/autoblog/bin/autoblog init
```

`init` creates your private `<you>/<you>-autoblog` repo if it doesn't exist, clones it to `~/code/<you>-autoblog`, and scaffolds it as an Obsidian vault. Then it runs `install`, which links `~/.local/bin/autoblog`, links the skill into each harness, adds the `Stop` hooks for Claude Code and Codex, and loads the launchd fallback. Both commands are idempotent. Override with `--name`, `--repo owner/name`, or `--dir`. The fallback only reviews transcripts from the last `lookbackHours` (24); it doesn't backfill everything. `autoblog uninstall` reverses everything except the vault and `~/.autoblog`.

## CLI

```
autoblog write --title <t> [--kind k] [--tags a,b] [--signal 1-3] [--mode auto] < body.md
autoblog update <title> < more.md  autoblog skip "<reason>"   autoblog bar
autoblog notes                   autoblog project [name] [--summary "..."]
autoblog init                    autoblog install            autoblog uninstall
autoblog search <words...>       autoblog ls [--jewels]       autoblog log
autoblog sweep [--dry-run -v]    autoblog review <transcript.jsonl> [--dry-run]
```

## Config

`~/.autoblog/config.json`:

```json
{
  "journal": "~/code/<you>-autoblog",
  "model": "opus",
  "reflectEvery": 40,
  "reflectEveryTurns": 6,
  "idleMinutes": 20,
  "minToolCalls": 8,
  "minSignal": 1,
  "lookbackHours": 24,
  "maxChars": 120000,
  "sources": ["claude", "codex"],
  "push": true
}
```

## The vault

The journal is an Obsidian vault, whether or not you ever open it in Obsidian:

```
posts/2026/Dev builds need one stable app identity, or macOS keeps re-asking for permissions.md
projects/desktop-tools.md     # what the project is, plus a generated list of its posts
README.md                     # generated: what the vault is and where things live
```

- **Note names are titles,** so `[[wikilinks]]` resolve.
- **Each post** links its project note (`project: "[[desktop-tools]]"` and in the prose) and links related posts. The writer gets the exact names of existing notes to link to.
- **Project notes** start with an agent-written description (`--project-summary`, or `autoblog project <name> --summary`), because a year from now you won't remember what the project was.
- **Properties:** `title, date, project, kind, signal, tags, mode, agent, session, cwd`.

Secrets are redacted on write: GitHub, Anthropic, OpenAI, Slack, AWS, and Google tokens, JWTs, private keys, and `*_TOKEN=` style assignments.

## Private site

GitHub Pages can't serve this: even from a private repo, a Pages site is public unless you're on Enterprise Cloud. So `autoblog site setup` deploys the vault to a **Cloudflare Worker behind HTTP basic auth** (`site/worker.js`). It fails closed: if no password is set, nothing is served. The password is generated into the Worker's secrets and your macOS Keychain (`autoblog site password`).

The site keeps Obsidian's semantics. `[[wikilinks]]` resolve by note name, including `|alias` and `#heading`. Every post shows **Linked from** (its backlinks) and more from its project. There are project pages, tag pages, Obsidian callouts, and client-side search. After setup, every journal commit redeploys in the background.

```bash
autoblog site setup [--worker name] [--user name] [--rotate]   # once
autoblog site open | deploy | build | password
```

To put Cloudflare Access (SSO) in front instead, enable Zero Trust on the account and add an Access application for the worker's hostname.

## Cost

In-band reflection is one extra step for the agent you're already running, and most checkpoints end in a one-line skip. The fallback sweep makes one `claude -p` call per orphaned idle transcript.
