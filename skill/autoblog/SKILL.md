---
name: autoblog
description: Write a post to Nate's private engineering journal. Use when the user says "/autoblog", "autoblog this", "write up an autoblog", "blog this", or asks to record how something was done for later reference. Also use to search the journal when asked "how did we do X again?".
---

# autoblog

autoblog is a private, searchable journal of things worth remembering across every project and agent: novel solutions, non-obvious fixes, recurring how-tos, and decisions with their rationale. Nobody reads it front to back. Future Nate (and future agents) search it.

**Auto mode is handled for you.** A background sweep reviews idle sessions and writes posts on its own. Don't write auto posts unprompted. Only write when the user asks.

## Manual mode: the user asked for a post

`/autoblog` with no argument means: write up the most interesting thing from the current work. `/autoblog <topic>` means: write about that topic, using what you know from this session.

1. Pick the angle. Write about the non-obvious part: the root cause, the trick, the exact steps, the why. Don't summarize the diff.
2. Write the post with the CLI. The body goes on stdin:

```bash
autoblog write \
  --title "Codesigning a helper app so TCC permissions stick" \
  --kind fix \
  --tags macos,codesigning,tcc \
  --signal 2 \
  --agent claude-code <<'EOF'
Lead with the answer. Then the context: the symptom, the cause, and the fix.

Include exact commands, config, file paths, and code so it's reproducible.
EOF
```

- `--title`: what someone would type into search, not "Fixed a bug".
- `--kind`: `fix` | `solution` | `howto` | `decision` | `discovery` | `kickoff` | `note`.
- `--signal`: `1` firehose, `2` solid reference, `3` jewel (rare).
- `--agent`: your harness, e.g. `claude-code` or `codex`.
- Project and cwd are detected from the current directory.

3. Style: a terse note to self. Use "we". No preamble. Usually 80 to 400 words. Never include secrets; write `<redacted>` instead. The CLI also redacts common token formats.
4. Tell the user the path the command printed, in one line.

## Reading the journal

```bash
autoblog search <words>   # grep titles and bodies, newest first
autoblog ls [--jewels]    # recent posts
autoblog path             # where the journal lives
```

When the user asks "how did we do X?" or "did we solve this before?", search the journal before you start digging.
