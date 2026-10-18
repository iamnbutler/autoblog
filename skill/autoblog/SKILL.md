---
name: autoblog
description: Write to Nate's private journal of notes and posts. Use when the user says "/autoblog", "autoblog this", "write up an autoblog", "blog this", "make a note of this", or asks to record how something was done for later reference. Also use to search the journal when asked "how did we do X again?".
---

# autoblog

autoblog is Nate's private journal, written by his agents across every project. It's organized by topic, not by session, and it holds two kinds of entries:

- **Notes** are short reference pages on a topic that will come up again, like "Counting tokens: pitfalls" or "Keeping long-running work alive when the screen locks".
- **Posts** are pieces Nate could publish with light editing: a project ("Spool"), or a way of working ("How we sign Mac apps while prototyping").

**Auto mode is driven by a hook.** At checkpoints, a Stop hook asks you to reflect, and its prompt says what to do. Don't write unprompted otherwise.

## Manual mode: the user asked for an entry

`/autoblog` with no argument means: capture the most useful thing from the current work. `/autoblog <topic>` means: write about that topic, using what you know from this session.

1. Run `autoblog bar` and follow it. Name the topic first. The incident is evidence, and the topic is the title.
2. Run `autoblog ls` (or `autoblog search <words>`). If an entry already covers the topic, revise it only to fix something that's wrong, or to add to a note something that belongs on that exact page. Run `autoblog show "<name>"`, then send the whole body back with only that change. Never revise to extend a post or bring a project post up to date: new work on a project is a new note or post, or nothing.

```bash
autoblog revise "Counting tokens: pitfalls" <<'EOF'
<the full body, with only the correction or addition changed>
EOF
```

3. Otherwise, write a new entry. The body goes on stdin:

```bash
autoblog write --type note \
  --title "macOS permissions for dev builds" \
  --tags macos,tcc,codesigning \
  --agent claude-code <<'EOF'
What to do, what goes wrong, and why, with commands. Mention where it came from: [[the-project]].
EOF
```

- `--type`: `note` (the usual) or `post` (rare: a project, or a way of working).
- `--title`: the topic, as Nate would search for it. Never an event.
- `--project a,b`: the projects it draws on. The default is the current directory's project. If `autoblog project` shows no description, add `--project-summary "<1-3 sentences>"`.
- Link related entries by exact name (`[[Name]]`), using the names `autoblog ls` prints.

4. Never include secrets. Write `<redacted>` instead. The CLI also redacts common token formats.
5. Tell the user the path the command printed, in one line.

## Reading the journal

```bash
autoblog search <words>        # grep notes and posts
autoblog ls [--notes|--posts]  # most recently updated first
autoblog show "<name>"         # print one entry
autoblog path                  # where the journal lives
```

When the user asks "how did we do X?" or "did we solve this before?", search the journal before you start digging.
