---
name: autoblog
description: Write a post to Nate's private engineering journal. Use when the user says "/autoblog", "autoblog this", "write up an autoblog", "blog this", or asks to record how something was done for later reference. Also use to search the journal when asked "how did we do X again?".
---

# autoblog

autoblog is Nate's private engineering blog, written by his agents across every project: the stories of things we figured out, built, decided, or learned. It's written for Nate a year from now, who has forgotten the project entirely.

**Auto mode is driven by a hook.** At checkpoints, a Stop hook asks you to reflect, and the prompt says what to do. Don't write posts unprompted otherwise.

## Manual mode: the user asked for a post

`/autoblog` with no argument means: write up the most interesting thing from the current work. `/autoblog <topic>` means: write about that topic, using what you know from this session.

1. Run `autoblog bar` and follow its "Find the point" and "Write it like a blog post" sections. Find what Nate was trying to do and the lesson that outlives the project. Write it as a short narrative: context, problem, what happened, takeaway, and optional `## Details`.
2. Write the post with the CLI. The body goes on stdin:

```bash
autoblog write \
  --title "Codesigning a helper app so TCC permissions stick" \
  --kind fix \
  --tags macos,codesigning,tcc \
  --signal 2 \
  --agent claude-code <<'EOF'
A short narrative: what [[the-project]] is, what we were after, what got in the way, what turned out to be true, and the lesson. Link related posts as [[Exact Post Title]].

## Details

The exact commands, config, and paths needed to do it again.
EOF
```

- `--title`: the lesson or story in plain words, not a symptom or a file path.
- `--kind`: `fix` | `solution` | `howto` | `decision` | `discovery` | `kickoff` | `note`.
- `--signal`: `1` narrow, `2` reusable lesson, `3` jewel (rare).
- `--agent`: your harness, e.g. `claude-code` or `codex`.
- Project and cwd are detected from the current directory. If `autoblog project` shows no description, add `--project-summary "<1-3 sentences: what it is, why it exists>"`.
- The journal is an Obsidian vault. Run `autoblog notes` for exact note names to `[[link]]`. To extend an existing story, use `autoblog update "<exact title>" <<'EOF' … EOF` instead of writing a new post.

3. Never include secrets; write `<redacted>` instead. The CLI also redacts common token formats.
4. Tell the user the path the command printed, in one line.

## Reading the journal

```bash
autoblog search <words>   # grep titles and bodies, newest first
autoblog ls [--jewels]    # recent posts
autoblog path             # where the journal lives
```

When the user asks "how did we do X?" or "did we solve this before?", search the journal before you start digging.
