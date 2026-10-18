# Backfill, step 1 of 3: harvest topics (read-only)

You're reading past coding-agent sessions to find **topics** for Nate's private journal. Don't write to the journal, and don't change any repo. Your only output is one harvest file, `{{OUT}}`. A curator reads every group's harvest next, and then writers write.

## The journal

Run `autoblog bar` first. It's short, and it's the most important input. In brief:

- **Notes** are short reference pages on a topic that will come up again: platform behaviors, pitfalls, recipes, tool quirks.
- **Posts** are rare. Either a **project** (what it is, why it exists, how it works, what's interesting) or a **way of working** (how Nate prototypes, designs, runs agents, releases, tests).
- Titles name a **topic** Nate would search for. They never narrate an incident.
- Existing entries change only to fix a factual inaccuracy, or for a very closely aligned addition to a note. Posts are never extended.

Run `autoblog ls` to see every entry, and `autoblog show "<name>"` to read any that touch your material. Your job is what those entries **don't** have. Other machines and earlier backfills write to this journal too, so it may already cover a lot.

For every candidate, say which kind it is:

- **new**: a topic no entry covers.
- **correction**: an existing entry says something your sources show is wrong. Quote the wrong sentence and give the evidence.
- **addition**: one pitfall or fix that belongs on an existing **note**'s exact page. Never additions to posts.

## Your group

{{GROUP}}

The index is `{{INDEX}}`, one line per session: file, session id, dates, project, user turns, tool calls, and how it opened. Each file is a readable transcript: what was said in full, tool calls as one line each, results clipped. Skim the index first, then read the substantive sessions. Where a repo is on disk, `git log` and the repo's docs can confirm facts.

Skip sessions about autoblog itself, anything personal (taxes, family admin), and automated sessions with no real human direction.

## What to look for

Work at the level of topics, not sessions:

1. **Project posts.** For a substantial project with no post yet, gather the purpose, architecture, key decisions and why, what was hard, and where it stands. Most small or abandoned projects don't qualify.
2. **Ways of working.** Practices that recur across sessions. Note every session where one shows up.
3. **Note topics.** Practical knowledge with several real facts in it, not a single gotcha.

Skip routine work, one-off incidents that belong to no topic, and agent orchestration chatter.

## Never copy secrets

Transcripts contain live tokens, keys and passwords. Never copy one. Write `<redacted>`.

## Output

Write `{{OUT}}` in this shape:

```
## <Topic title, as Nate would search for it>
- kind: new | correction to "<entry>" | addition to "<note>"
- type: note | post
- projects: <repo names>
- date: <YYYY-MM-DD of the latest session it draws on>
- sessions: <session ids, comma-separated>
- why: <one sentence: why this clears the bar>
- material:
  - <the substance: facts, pitfalls, commands, config, decisions with their reasons, numbers. Enough that a writer could draft most of the entry from this alone. Specific and accurate.>
- sources: <file paths with what to look at>

## Considered and rejected
- <candidate>: <why>
```

Accuracy matters more than coverage: don't state anything your sources don't show. If nothing clears the bar, write only the rejected list. Reply with one line per topic: title, kind, type.
