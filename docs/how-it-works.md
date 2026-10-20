# How it works

autoblog is the machinery. The journal lives in a separate private repo.

## Reflection checkpoints

The agent doing the work decides what's worth writing, because only it has the whole context, including the thing from day one of a multi-day session that turned out to matter on day three.

- A `Stop` hook (Claude Code and Codex) counts tool calls since the session's last checkpoint. It reads only the bytes appended since then, so it's cheap on a 40 MB transcript. After `reflectEvery` (40) calls, the hook asks the agent to reflect before it stops.
- The prompt is short: skip by default, or run `autoblog guide` if something might qualify. The agent then reads the bar (`autoblog bar`), searches the journal for its topic, and revises an entry, writes a new one, or skips. Most checkpoints end in a skip.
- The prompt includes the agent's own transcript path, so it can grep details that compaction dropped.
- Decisions and their reasons go to `~/.autoblog/decisions.jsonl`. `autoblog log` shows them. Tune `prompts/bar.md` on real misses.

You can also ask directly: `/autoblog`, `/autoblog <topic>`, or "write up an autoblog for this", in any agent that loads skills.

## Recall

Writing is half of it. A `UserPromptSubmit` hook (Claude Code and Codex) runs a ranked search on each prompt. When an entry clearly matches, because a rare word in the prompt names it in its title or tags, the hook tells the agent the entry exists and how to read it. "Set up TestFlight for this project" gets pointed at the TestFlight note. Each entry is mentioned once per session, and most prompts get nothing. `autoblog search <words>` runs the same ranking by hand.

## Pausing a conversation

Tell the agent "pause autoblog" (or run `autoblog pause` in the session) to keep a conversation out of the journal. The session id comes from the harness (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`), or pass `--session`. While a session is paused:

- the `Stop` hook stops checkpointing it;
- `write` and `revise` from it are refused, and `skip` does nothing;
- the sweep, timeline and backfill never read it, even if you name it explicitly. This lasts after `resume`, because the paused stretch can't be separated out of a transcript later;
- in Claude Code, a `SessionStart` hook reminds the agent after compaction or `--resume`.

`autoblog resume` turns checkpoints back on. Later reflections are told to leave out everything from before that point. State lives in `~/.autoblog/sessions.json`.

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

`timeline/YYYY-MM-DD.md` holds what moved that day, held to a high bar: at most three lines per project (the one or two contributions that mattered, plus a line summing up smaller things when they add up), and often none. On each sweep, a model (`timelineModel`, default `sonnet`; `haiku` was too lenient about the bar) reads each idle session's new activity, day by day, and rewrites the day's lines for the projects it touched, so later work folds into earlier lines. `autoblog timeline compact` rewrites days logged before the current bar. `autoblog timeline --from <transcripts…>` logs old sessions.

## Annotations

Every page on the site has an annotation box. Leave context or a correction there ("this was my design challenge for joining GitHub Next"), and the sweep has an agent fold it into the entry or the project description, in the page's own voice. Annotations from you override the rule against extending posts, but each change stays as small as the annotation. The page shows whether each one was folded in or skipped, and why.

Annotations live in a KV namespace bound to the site's Worker, created on the first deploy. The sweep waits until a page's newest annotation is 10 minutes old, so several in a row land together. `autoblog annotations` lists open ones, and `autoblog annotations apply` applies them now.

## Several machines

Every machine writes the same vault. Each commit runs `autoblog sync` in the background: fetch, merge (this machine's side wins on conflicting lines), rebuild generated files, push.

## Cost

Reflection is one extra step for the agent you're already running, usually a one-line skip. The sweep makes one `claude -p` call per orphaned idle transcript. The linker makes one small call per write, plus a daily pass.
