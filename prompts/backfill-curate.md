# Backfill, step 2 of 3: curate

Harvesters read past coding-agent sessions in groups and proposed topics for Nate's private journal. Your job is to turn their proposals into one plan that writers will follow exactly. Don't write to the journal or change any repo. Your only output is `{{OUT}}`.

## Read

1. `autoblog bar`: the bar. Follow it.
2. `autoblog ls`, and `autoblog show "<name>"` for any entry a candidate touches. Other machines and earlier backfills write to this journal too.
3. The harvest files: {{HARVESTS}}

## Decide

- **Merge duplicates** across harvests into one topic, combining their sources and sessions.
- **Drop** anything an existing entry already covers, single gotchas that aren't a topic, routine work, anything personal, and anything that would mostly restate another entry.
- **Corrections**: keep only ones you confirm against the entry's text. Quote the wrong sentence.
- **Additions**: keep only one pitfall or fix that belongs on that exact note. Never additions to posts. Drop marginal ones.
- **Posts are rare.** Keep only the strongest project and way-of-working candidates. Fold weaker ones into notes, or reject them.
- A new note needs several real facts.

## Output

Write `{{OUT}}` with sections of at most 8 items each. Each section is handed to one writer, so group related topics together (corrections and additions in their own sections):

```
## A. <section name>

- **note: <exact title>** [projects] (date YYYY-MM-DD; sessions id1,id2). One line of scope. Sources: <harvest file> § <topic>; …
- **post: <exact title>** [projects] (…). …
- **correction: <existing entry>** (…). The wrong sentence, the fix, the evidence. Sources: …
- **addition: <existing note>** (…). The one item to add. Sources: …

## B. …

## Rejected
- <candidate>: <why>
```

Titles are final: writers use them exactly. Reply with counts of posts, notes, corrections and additions, and the post titles.
