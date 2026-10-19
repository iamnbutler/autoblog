---
name: autoblog
description: Write to the user's private autoblog journal of notes and posts. Use when the user says "pause autoblog" / "don't journal this" (run `autoblog pause`; `autoblog resume` undoes it); when the user says "/autoblog", "autoblog this", "write up an autoblog", "blog this", "make a note of this", or asks to record how something was done for later reference; when an autoblog checkpoint asks you to reflect; and to search the journal when asked "how did we do X again?".
---

# autoblog

autoblog is the user's private journal, written by their agents across every project. It's organized by topic, not by session, and it holds two kinds of entries:

- **Notes** are short reference pages on a topic that will come up again, like "Counting tokens: pitfalls" or "Keeping long-running work alive when the screen locks".
- **Posts** are pieces the user could publish with light editing: a project ("Spool"), or a way of working ("How we sign Mac apps while prototyping").

You get here two ways. A **checkpoint** (a Stop hook) asks you to look back over the session; pass the `--session`, `--agent` and `--mode auto` it gives you. Or the user asks: `/autoblog` means capture the most useful thing from the current work, and `/autoblog <topic>` means write about that topic. Don't write unprompted otherwise.

## Steps

1. Run `autoblog bar` and follow it. Most checkpoints end in a skip.
2. Name the topic. The incident is evidence; the topic is the title, phrased the way the user would search for it.
3. Run `autoblog search <a few words of the topic>` to see whether an entry already covers it. `autoblog ls` lists everything.
4. Then do one of these:

**Skip** (checkpoints only), with a one-sentence reason:

```bash
autoblog skip --session <id> "<why nothing here clears the bar>"
```

**Revise** an existing entry, only to fix something that's wrong, or to add to a note one thing that belongs on that exact page. Never to extend a post or bring a project post up to date. Print it, then send the whole body back with only that change:

```bash
autoblog show "Counting tokens: pitfalls"
autoblog revise "Counting tokens: pitfalls" [--session <id>] <<'EOF'
<the full body, with only the correction or addition changed>
EOF
```

**Write** a new entry. The body goes on stdin:

```bash
autoblog write --type note --title "macOS permissions for dev builds" \
  --tags macos,tcc,codesigning --agent claude-code [--session <id> --mode auto] <<'EOF'
What to do, what goes wrong, and why, with commands.
EOF
```

- `--type`: `note` (the usual) or `post` (rare: a project, or a way of working).
- `--project a,b`: the projects it draws on. The default is the current directory's project. If `autoblog project <name>` shows no description, add `--project-summary "<1-3 sentences>"`. With several projects, it goes to the first one with no description; set others with `autoblog project <name> --summary "..."`.
- `--session a,b`: every session the entry draws on, when there's more than one.
- Don't add `[[links]]` to other entries or projects. autoblog links entries after every write. Name related topics plainly in the text, and it will find them.
- Never include secrets. Write `<redacted>` instead. The CLI also redacts common token formats.

5. If the user asked, tell them the path the command printed, in one line. After a checkpoint, just stop: don't resume other work or summarize it.

## Pausing

When the user says "pause autoblog", "don't journal this conversation" or similar, run `autoblog pause`. Add `--session <id>` if it can't detect the session. From then on, write nothing from this conversation, including skips and timeline notes, and don't carry anything from it into entries written elsewhere. If a checkpoint still arrives, ignore it. `write` and `revise` refuse anyway. Only run `autoblog resume` when the user asks for it.

## Reading the journal

```bash
autoblog search <words>        # grep notes and posts
autoblog ls [--notes|--posts]  # most recently updated first
autoblog show "<name>"         # print one entry
autoblog path                  # where the journal lives
```

`timeline/` holds a day-by-day work log across every project, written automatically. Grep it for "when did we ship X?". Don't write to it yourself.

When the user asks "how did we do X?" or "did we solve this before?", search the journal before you start digging.
