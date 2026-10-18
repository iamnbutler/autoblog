# Backfilling a journal from your history

autoblog writes as you work, from now on. A backfill writes from what you've already done: months of agent sessions turned into notes, posts and a timeline. This is how we did it for a year of history, written down so anyone can repeat it.

It takes an afternoon of wall-clock time and a fair amount of `opus` usage, and the result is only as good as the bar it's held to. So start small, read what comes out, and widen from there.

## 0. Keep your history first

Two things delete history you'll want:

- **Claude Code deletes transcripts after 30 days** by default. Raise it before anything else, in `~/.claude/settings.json`:

  ```json
  { "cleanupPeriodDays": 3650 }
  ```

  Transcripts already deleted are gone, but `~/.claude/history.jsonl` keeps every prompt you typed much longer, and autoblog reads that too (see below).
- **Laptops get wiped.** If you want a copy that survives, back the transcripts up somewhere. [thread-history](https://github.com/iamnbutler/thread-history) does this for Claude Code and Codex, and autoblog reads its backups with `--from`.

## 1. Set up

```bash
autoblog init --owner <your first name>
```

`--owner` is whose journal this is. The prompts use it ("Luke's journal", "the way Luke would search for it"). Change it later in `~/.autoblog/config.json`.

Then read the bar: `autoblog bar`. Everything below is held to it. In short: notes are reference pages on a topic, posts are rare and are a project or a way of working, titles name a topic and never an incident, and nothing narrates what happened in a session.

## 2. See what's there

```bash
autoblog backfill --dry-run
```

This lists every session it would read, by where it came from and by project, without spending anything. It reads:

| Where | What |
| --- | --- |
| `~/.claude/projects/` | Claude Code transcripts |
| `~/.codex/sessions/`, `~/.codex/archived_sessions/` | Codex rollouts |
| `~/.claude/history.jsonl` | Prompts from Claude Code sessions whose transcripts are gone. Prompts alone still show what you asked for and how you steered. |
| Zed (`~/Library/Application Support/Zed/threads/threads.db`) | Zed's agent threads |
| Conductor (`com.conductor.app/conductor.db`) | Conductor sessions |
| OpenCode (`~/.local/share/opencode/opencode.db`) | OpenCode sessions |
| `--from <dir>` (repeatable) | Any other transcripts: agents that run with their own `HOME` or `CODEX_HOME`, copies from another machine, a thread-history backup (its `<id>.jsonl.d/` chunks are joined back up) |

It leaves out sessions in the journal or autoblog itself, small sessions (fewer than `minToolCalls` tool calls), automated ones that repeat the same prompts, sessions an entry already cites, and sessions an earlier backfill read (`~/.autoblog/backfill.json`). `--no-apps` skips Zed, Conductor, OpenCode and the prompt history.

Narrow it with `--since 2026-01-01`, `--until 2026-03-31` or `--project <name>`.

## 3. Make a plan, and read it

```bash
autoblog backfill --since 2026-01-01 --until 2026-03-31 --plan
```

This does the first two steps and stops:

1. **Harvest.** Sessions are grouped by project (about 1.2 MB of transcript per group), and one agent per group reads its sessions and proposes topics, read-only. Each proposal says whether it's a new topic, a correction to an existing entry, or one addition to an existing note, with the material a writer needs and the sessions it came from. Prompt: [`prompts/backfill-harvest.md`](../prompts/backfill-harvest.md).
2. **Curate.** One agent reads every harvest and the journal, merges duplicates, drops what's covered or thin, keeps posts rare, and writes a plan in sections. Prompt: [`prompts/backfill-curate.md`](../prompts/backfill-curate.md).

The plan is `~/.autoblog/backfill/<run>/curated.md`. **Read it.** This is the cheapest place to steer. Delete items you don't want, fix titles, move a post down to a note, and add a line to an item if you know something the transcripts don't. The harvests sit next to it in `harvest/` if you want the material behind an item.

## 4. Write

```bash
autoblog backfill --resume ~/.autoblog/backfill/<run>
```

One writer per section of the plan, in parallel (`--parallel 4` by default). Writers read the material and the transcripts behind it, check facts against repos where they can, and write with `--mode backfill --date <when the work happened>` and the sessions it came from. Prompt: [`prompts/backfill-write.md`](../prompts/backfill-write.md).

Then it records the sessions as done, logs them to the timeline (Claude Code and Codex transcripts only; the timeline splits transcripts by day), and links the journal.

To do all of it in one go, leave out `--plan`.

## 5. Read what it wrote

```bash
autoblog ls
autoblog show "<title>"
```

Fix what's wrong with `autoblog revise`. If something shouldn't exist, delete the file and run `autoblog reindex`. Check for:

- **Entries that narrate.** "How we fixed X on Tuesday" is an incident. The topic is X.
- **Near-duplicates.** Parallel writers, other machines and earlier runs can produce two notes on one topic. Merge them into the better title and delete the other.
- **Wrong links.** The linker links phrases that name another entry. When it gets one wrong, fix it by hand. It won't relink a phrase that's already linked.
- **Secrets.** Transcripts hold live tokens. Prompts tell every agent to write `<redacted>`, and the CLI redacts common token formats, but look anyway.

## Rules that made it work

These came from doing it badly first:

- **Topics, not sessions.** The first attempt wrote one entry per interesting session and every one read like a diary. Harvesting by group and curating across groups is what gets topic-shaped entries.
- **Revise only to correct, or for one aligned addition to a note.** Never extend a post. New work on a project with a post becomes a new note, a new post, or nothing.
- **Writers don't link.** autoblog links entries after each write, so writers name related topics plainly.
- **Date entries from the work.** `--date` is the last session an entry draws on, taken from timestamps inside the transcripts. File modification times are often days off.
- **Read the plan.** Curation is where a run goes right or wrong, and it's cheap to fix there.

## Several machines

Run the backfill on each machine for its own history. They share one vault: every commit runs `autoblog sync` in the background, which merges what the other machine pushed and then pushes. Each machine keeps its own `backfill.json`, and sessions cited in an entry's `sessions:` are skipped everywhere, so they don't redo each other's work. Topics can still overlap across machines, so look for near-duplicates after both finish.

## The timeline on its own

The timeline (one line per thing done, per day, across every project) is cheap, written by `haiku`. To log old sessions without writing entries:

```bash
autoblog timeline --from ~/.claude/projects/*/*.jsonl
```
