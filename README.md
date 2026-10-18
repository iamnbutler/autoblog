# autoblog

An effortless, private engineering journal written by your coding agents.

Agents notice when something you did was worth remembering (a non-obvious fix, a novel solution, a procedure you keep repeating, a decision and its why) and write it up as a Markdown post in a **private** repo. Nobody has to read it front to back. It's a searchable firehose for "how did we do X again?", and you can pull the jewels out later.

This repo is the machinery. The journal lives in a separate private repo.

## Modes

**Auto (always on).** This mirrors the tail end of a `lane` lifecycle (reflect before landing): when a session goes idle, a reviewer reads what happened and decides whether anything is worth keeping. The default answer is *nothing*. The bar and its tuning live in [`prompts/review.md`](prompts/review.md).

- A transcript counts as "done" after `idleMinutes` (20) without activity, or when Claude Code fires `SessionEnd`.
- Deltas under `minToolCalls` (8) are skipped without calling the model.
- The reviewer (`claude -p`, default `sonnet`) sees the condensed transcript, plus the journal's existing posts for that project so it can append an update instead of duplicating.
- Each post gets a **signal**: 1 is firehose, 2 is solid, 3 is a jewel. `minSignal` filters what gets written. `autoblog ls --jewels` and the journal README surface the 3s.
- Every decision, including each skip and its one-line reason, goes to `~/.autoblog/decisions.jsonl`. `autoblog log` shows them, so you can tune the prompt on real misses.

**Manual.** `/autoblog`, `/autoblog <topic>`, or "write up an autoblog for this" in any agent that loads skills. The agent writes the post itself with full context, via `autoblog write`.

## Wiring

| Agent | Auto | Manual |
| --- | --- | --- |
| Claude Code | `SessionEnd` hook reviews the finished session. `Stop` hook nudges a sweep, throttled to every 10m. | skill at `~/.claude/skills/autoblog` |
| Codex | launchd sweep reads `~/.codex/sessions/**.jsonl` | skill at `~/.codex/skills/autoblog`, `~/.agents/skills/autoblog` |
| Anything else | add a reader in `src/transcripts.ts` | point it at `skill/autoblog/SKILL.md`, or just call `autoblog write` |

A launchd agent runs `autoblog sweep` every 20 minutes, so sessions that never "end" still get reviewed. Hooks never block: they hand off to a detached process and exit.

## Install

Requires [bun](https://bun.sh), `gh`, and the `claude` CLI.

```bash
gh repo create <you>/autoblog-journal --private   # once
git clone https://github.com/iamnbutler/autoblog ~/code/autoblog
~/code/autoblog/bin/autoblog install --journal-repo <you>/autoblog-journal
```

`install` clones the journal and links `~/.local/bin/autoblog`. It also links the skill into each harness, adds the Claude Code hooks to `~/.claude/settings.json`, and loads the launchd agent. On first run it only watches transcripts from the last `lookbackHours` (24) and doesn't backfill everything. `autoblog uninstall` reverses all of it except the journal and `~/.autoblog`.

## CLI

```
autoblog write --title <t> [--kind k] [--tags a,b] [--signal 1-3] < body.md
autoblog search <words...>       autoblog ls [--jewels]       autoblog log
autoblog sweep [--dry-run -v]    autoblog review <transcript.jsonl> [--dry-run]
```

## Config

`~/.autoblog/config.json`:

```json
{
  "journal": "~/code/autoblog-journal",
  "model": "sonnet",
  "idleMinutes": 20,
  "minToolCalls": 8,
  "minSignal": 1,
  "lookbackHours": 24,
  "maxChars": 120000,
  "sources": ["claude", "codex"],
  "push": true
}
```

## Journal layout

```
posts/2026/10/2026-10-17-transparent-nspanel-clicks-fall-through.md
README.md   # generated index: jewels first, then every post by month
```

Each post has frontmatter: `title, date, project, kind, signal, tags, mode, agent, cwd, session`. Secrets are redacted on write: GitHub, Anthropic, OpenAI, Slack, AWS, and Google tokens, JWTs, private keys, and `*_TOKEN=` style assignments. The reviewer is also told never to include them.

## Cost

Auto mode spends model tokens. Each review sends one condensed transcript of at most `maxChars`, about 30k tokens, to `model`. The size and idle gates keep this to roughly one review per real chunk of work. Set `"model": "haiku"` or raise `minToolCalls` to spend less.
