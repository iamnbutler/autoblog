# How it works

autoblog is the machinery. The journal lives in a separate private repo.

## Reflection checkpoints

The agent doing the work decides what's worth writing, because only it has the whole context, including the thing from day one of a multi-day session that turned out to matter on day three.

- A `Stop` hook (Claude Code and Codex) counts tool calls since the session's last checkpoint. It reads only the bytes appended since then, so it's cheap on a 40 MB transcript. After `reflectEvery` (40) calls, the hook asks the agent to reflect before it stops.
- The prompt is short: skip by default, or run `autoblog guide` if something might qualify. The agent then reads the bar (`autoblog bar`), searches the journal for its topic, and revises an entry, writes a new one, or skips. Most checkpoints end in a skip.
- The prompt includes the agent's own transcript path, so it can grep details that compaction dropped.
- Decisions and their reasons go to `~/.autoblog/decisions.jsonl`. `autoblog log` shows them. Tune `prompts/bar.md` on real misses.

You can also ask directly: `/autoblog`, `/autoblog <topic>`, or "write up an autoblog for this", in any agent that loads skills.

## Fallback sweep

For transcripts no hook claimed (sessions from before install, or harnesses without hooks), a launchd job runs every 20 minutes. It hands idle transcripts from the last `lookbackHours` to `claude -p` with [`prompts/review.md`](../prompts/review.md) and the bar. It sees only a condensed transcript, so it's second best.

## What goes in

Read [`prompts/bar.md`](../prompts/bar.md). In short:

- New notes are occasional, new posts are rare, revisions rarer still.
- A revision fixes something wrong, or adds to a note something that belongs on that exact page. It never extends a post.
- Titles name a topic you'd search for, never an incident.

## Links

Writers don't add `[[links]]`. After every write, a background `autoblog link` asks a model (`linkModel`, default `sonnet`) which phrases name another entry or project, and code links the first mention of each, so prose is never rewritten. Once a day the sweep relinks changed entries and offers older entries the names that appeared since.

## Timeline

`timeline/YYYY-MM-DD.md` holds one line per thing done that day, in any project. On each sweep, a fast model (`timelineModel`, default `haiku`) reads each idle session's new activity, day by day, and adds what isn't logged yet. `autoblog timeline --from <transcripts…>` logs old sessions.

## Several machines

Every machine writes the same vault. Each commit runs `autoblog sync` in the background: fetch, merge (this machine's side wins on conflicting lines), rebuild generated files, push.

## Cost

Reflection is one extra step for the agent you're already running, usually a one-line skip. The sweep makes one `claude -p` call per orphaned idle transcript. The linker makes one small call per write, plus a daily pass.
