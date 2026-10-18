# autoblog

An effortless, private engineering journal written by your coding agents, organized by topic.

Agents notice when something we did belongs in the journal and write it to a **private** repo. The journal is organized by topic, not by session:

- **Notes** are short reference pages, like "Counting tokens: pitfalls".
- **Posts** are rarer pieces you could publish with light editing: a project, or a way of working ("How we sign Mac apps while prototyping").

This repo is the machinery. The journal lives in a separate private repo.

## Modes

**Auto (always on, in-band).** This mirrors the tail end of a `lane` lifecycle, where you reflect before landing. The agent doing the work decides what's worth writing, because only it has the whole context, including the thing from day one of a multi-day session that turned out to matter on day three.

- A `Stop` hook (Claude Code and Codex) counts tool calls since the session's last checkpoint. It reads only the bytes appended since then, so it costs nothing on a 40MB transcript. Once `reflectEvery` (40) calls pile up, the hook asks the agent to reflect before it stops.
- The prompt is a few lines: skip by default, or run `autoblog guide` (the skill) if something might qualify. Following it, the agent reads the bar (`autoblog bar`, i.e. [`prompts/bar.md`](prompts/bar.md)), searches the journal for its topic, and then revises an entry (`autoblog show` and `autoblog revise`), writes a new one (`autoblog write --type note|post`), or skips (`autoblog skip "<reason>"`). Most checkpoints end in a skip.
- Checkpoints come every chunk of work, so each chunk is reflected on while it's still in context. The prompt also gives the agent its own transcript path, so it can grep details that compaction dropped.
- The decision and its reason are logged to `~/.autoblog/decisions.jsonl`. `autoblog log` shows them; tune `prompts/bar.md` on real misses.

**Fallback sweep.** For transcripts no hook ever claimed (sessions from before install, or harnesses without hooks), a launchd job runs every 20 minutes. It hands idle transcripts to `claude -p` (`model`, default `opus`) with [`prompts/review.md`](prompts/review.md) plus the same bar. It sees only a condensed transcript, so it's second best.

**Links.** Writers don't add `[[links]]`. After every write or revise, a background `autoblog link` asks `claude -p` (`linkModel`, default `sonnet`) which phrases in the entry name another entry or a project, and code links the first mention of each, so prose is never rewritten. Links to names that don't exist are unlinked. Once a day the sweep relinks entries whose text changed, and offers every other entry only the names that appeared since, so older entries link forward to newer ones. Then the site redeploys.

**Timeline.** Alongside notes and posts there's a work log: `timeline/YYYY-MM-DD.md`, one line per thing done that day in any project (`- [[next-cloud]]: Added canvas posts: …`). It has no bar. On each sweep, a fast model (`timelineModel`, default `haiku`) reads each idle session's new activity day by day, and adds up to 12 lines per session-day, skipping what's already logged. `autoblog timeline --from <transcripts…>` backfills old sessions. The site has a `/timeline/` page, and each project page shows its recent lines.

**Backfill.** The sweep only watches new activity. For history, `autoblog backfill` reads old Claude Code and Codex transcripts, Claude Code's prompt history, Zed, Conductor and OpenCode, and any `--from` directories. Agents harvest topics from groups of sessions, one curator merges them into a plan, and writers write it; then it logs the timeline and links everything. `--plan` stops so you can read and edit the plan, and `--resume <run>` writes it. See [docs/backfill.md](docs/backfill.md) for the whole process, including how to keep your history first.

**Several machines.** Each machine writes the same vault. Every commit runs `autoblog sync` in the background: fetch, merge (this machine's side wins where both changed the same lines), rebuild generated files, push.

**Manual.** `/autoblog`, `/autoblog <topic>`, or "write up an autoblog for this", in any agent that loads skills.

## What goes in

The bar is the product, so read [`prompts/bar.md`](prompts/bar.md). In short:

- Most checkpoints write nothing.
- New notes are occasional, new posts are rare, and revisions are rarer still.
- A revision fixes something that's wrong, or adds to a note something that belongs on that exact page. It never extends a post. New work on a project becomes a new note or post, or nothing.
- Titles name a topic you'd search for, never an incident. "Keeping long-running work alive when the screen locks", not "Sixty PRs shipped overnight against a locked screen were sixty unverified PRs".

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
autoblog write --type note|post --title <topic> [--tags a,b] [--project a,b] < body.md
autoblog revise <name> [--title new] < body.md    autoblog show <name>
autoblog ls [--notes|--posts]    autoblog search <words...>   autoblog project [name] [--summary "..."]
autoblog skip "<reason>"         autoblog bar                 autoblog log
autoblog init                    autoblog install             autoblog uninstall
autoblog sweep [--dry-run -v]    autoblog review <transcript.jsonl> [--dry-run]
autoblog archive "<why>"         autoblog reindex             autoblog site setup|deploy|open|password
autoblog backfill [--since DATE] [--plan|--resume run] [--dry-run]   autoblog timeline [--from <transcripts...>]   autoblog link [--due]
autoblog sync                    autoblog transcript <path.jsonl>   autoblog guide
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
  "lookbackHours": 24,
  "maxChars": 120000,
  "sources": ["claude", "codex"],
  "push": true
}
```

## The vault

The journal is an Obsidian vault, whether or not you ever open it in Obsidian:

```
notes/macOS permissions for dev builds.md      # a topic
posts/How we sign Mac apps while prototyping.md
projects/desktop-tools.md     # what the project is, plus a generated list of what touches it
archive/<date>/               # entries set aside by `autoblog archive` (hidden from Obsidian search)
README.md                     # generated: what the vault is and where things live
```

- **Note names are titles,** so `[[wikilinks]]` resolve. Names are unique across notes and posts, so writing a topic that exists fails and points you at `revise`. Renaming with `revise --title` rewrites links across the vault.
- **Each entry** lists the projects it draws on (`projects: ["[[luau]]", "[[desktop-tools]]"]`), so a cross-project note shows up on every one of them.
- **Project notes** start with an agent-written description (`--project-summary`, or `autoblog project <name> --summary`), because a year from now you won't remember what the project was.
- **Properties:** `title, type, created, updated, projects, tags, sessions, agent, mode`.

Secrets are redacted on write: GitHub, Anthropic, OpenAI, Slack, AWS, and Google tokens, JWTs, private keys, and `*_TOKEN=` style assignments.

## Private site

GitHub Pages can't serve this: even from a private repo, a Pages site is public unless you're on Enterprise Cloud. So `autoblog site setup` deploys the vault to a **Cloudflare Worker behind HTTP basic auth** (`site/worker.js`). It fails closed: if no password is set, nothing is served. The password is generated into the Worker's secrets and your macOS Keychain (`autoblog site password`).

The site keeps Obsidian's semantics. `[[wikilinks]]` resolve by note name, including `|alias` and `#heading`. Every entry shows **Linked from** (its backlinks). There are project pages, tag pages, Obsidian callouts, and client-side search. After setup, every journal commit redeploys in the background.

```bash
autoblog site setup [--worker name] [--user name] [--rotate]   # once
autoblog site open | deploy | build | password
```

To put Cloudflare Access (SSO) in front instead, enable Zero Trust on the account and add an Access application for the worker's hostname.

## Cost

In-band reflection is one extra step for the agent you're already running, and most checkpoints end in a one-line skip. The fallback sweep makes one `claude -p` call per orphaned idle transcript, and the linker one small call per write, plus a daily pass over entries with something new to link.
