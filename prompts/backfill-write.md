# Backfill, step 3 of 3: write your section

You're writing a few entries in {{OWNER}}'s private journal from material that has already been harvested and curated. Take your time: the bar is high, and entries that narrate incidents get archived.

## Read first

1. `autoblog bar`: the bar and the style. Follow it.
2. For voice, read two or three existing posts (`autoblog ls --posts`, then `autoblog show`). Plain, first person, specific, with code where it helps. No corporate phrasing, aphorisms, or "takeaway" sections.
3. `{{CURATED}}`: the plan. Your section is **{{SECTION}}**. Write exactly those items, with exactly those titles and types. Other sections list every other planned title.

## For each item

- Read the harvest topics it cites (in `{{DIR}}`), and open the transcripts they point to wherever the material is thin or a fact needs checking. Don't state anything the sources don't support. Leave it out rather than guess. Write about what's current, and when something changed over time, say so.
- **Notes**: open with a sentence or two on what the topic is and when it matters. Organize the rest by subtopic: short sections, bullets, commands, config, numbers, and the reason behind each pitfall. As long as the material warrants and no longer.
- **Posts**: 400 to 1,500 words. A project post says what it is, why it exists, how it works, what's interesting, and where it stands. A way-of-working post says how and why, what it looks like across the projects it came from, and what goes wrong.
- Name internal things the first time they appear. Write for someone who has forgotten the project.
- Don't add `[[links]]`. autoblog links entries after each write. Name related topics plainly.
- **Never include secrets.** Use `<redacted>`.
- If `autoblog project <name>` shows no description, pass `--project-summary "<1-3 sentences>"` on your first write that names only that project.

## Writing

```
autoblog write --type <note|post> --mode backfill --agent claude-code \
  --title "<exact title>" --project a,b --tags x,y \
  --date <YYYY-MM-DD from the plan> --session <ids from the plan, comma-separated> <<'BODY'
<body, no H1>
BODY
```

- **Corrections and additions**: `autoblog show` the entry, then `autoblog revise "<title>" --session <ids>` with the full body on stdin, changing only the wrong sentence or adding the one item in its natural place. Leave everything else as it was. Never extend a post.
- If `write` says the title exists, someone else wrote it: show it, and revise only if your material corrects it or belongs on that exact note.
- When you're done, reread each entry with `autoblog show` and fix anything you'd be embarrassed for {{OWNER}} to read.

Reply with the titles you wrote, plus any fact you weren't sure of or left out.
