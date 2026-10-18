# The autoblog bar

Shared by in-band reflection (the agent doing the work), manual writes, and the fallback reviewer.

## Who it's for

Nate, later. He might be starting something similar, hitting the same wall again, or looking for something to turn into a real post. Assume he has forgotten the project and the session.

The reference point is his own site, where posts look like "Spool", "Player", "Adding a Favicon in 2024", "Adding Extended Context in GPUI", and "Computer Use For All". They have topic titles, a plain first-person voice, and concrete code, and each one is about a thing he made or a way of doing something. The journal can be rougher than that, but never thinner.

The journal holds two kinds of entries. Both are titled by **topic**, and both are **living**: you revise them in place as we learn more.

## Notes

A note is a reference page on a topic that will come up again. It answers "what do I need to know about X?", and it stays current.

- Good titles: "Counting tokens: pitfalls", "Keeping long-running work alive when the screen locks", "macOS permissions for dev builds", "Signing and notarizing Mac apps in CI".
- The title is the topic, phrased the way Nate would search for it. It isn't an event, and it isn't a sentence-long lesson.
- The body is short: what to do, what goes wrong, and why. Bullets, code, and commands are welcome. Say where it came from in a line (`[[project]]`); don't tell the story of the session.
- **Revise, don't duplicate.** If a note already covers the topic, add to it: a new pitfall, a better fix, or a correction. Rewrite the whole note so it reads as one current page, not a log of updates.

## Posts

A post is something Nate could put on his site with light editing. It has one of two shapes:

- **A project.** What it is, why it exists, and what's interesting about how it works, like "Spool" or "Player". Write it once the project has a shape worth describing, and revise it as the project changes. The project already has a note under its own name, so give the post a title of its own that says what the project is, like Nate's drafts "Serial by Design" (Tasks) and "Computer Use For All" (Desktop Tools).
- **A way of working.** How we do something, refined across sessions and projects, like "How we sign Mac apps while prototyping" or "Designing by exploring several directions at once".

Guidelines:

- The title is short and topical: a name, "How we …", or a noun phrase. It is never a narrated event.
- The body is 400 to 1,500 words in a plain first-person voice ("I" and "we"), with code where it helps. Start with context for someone who has never heard of the project. Use headings that follow the topic, not a fixed template, and skip the moral at the end.
- Posts are rare. Most projects get one at most, and a single session almost never produces one. A post usually gathers material from many sessions.

## Default: nothing

Most checkpoints produce nothing. The most common useful outcome is a revision to an existing note. New notes are occasional, and new posts are rare. There are no quotas in either direction.

Ask these in order:

1. **Does an existing note or post cover this topic?** Revise it.
2. **Is this a topic Nate will hit again, on another project?** Write a new note.
3. **Is this a project, or a way of working, that's now worth describing whole?** Write a post.

Skip everything else:

- routine features, fixes, refactors, releases, and reviews
- one-off incidents that don't belong to a topic
- orchestrating agents
- anything the repo's own docs already say
- anything you can't name as a topic

## Name the topic first

Before writing, name the topic. The session hands you an incident, but the entry is about the topic that incident belongs to. Files, flags, and error messages are evidence for the body, never the title.

| What happened | The entry |
| --- | --- |
| A dev build kept asking for Accessibility permission. | Note: "macOS permissions for dev builds" |
| Summing token usage across requests came out ten times too high. | Note: "Counting tokens: pitfalls" |
| Overnight agents shipped sixty PRs while the screen was locked, so none were verified. | Note: "Keeping long-running work alive when the screen locks" |
| We built four site directions in parallel, then printed one as a zine. | Post: "Designing by exploring several directions at once" |
| Signing and keychain trouble came up across three Mac apps. | Post: "How we sign Mac apps while prototyping" |

The bad version of each is the incident used as the title, like "Sixty PRs shipped overnight against a locked screen were sixty unverified PRs."

## Writing

- Explain internal names the first time you use them, or don't use them.
- Never include secrets, tokens, keys, or passwords. Write `<redacted>` instead.
- The journal is an Obsidian vault. Link projects as `[[project]]` and related entries by their exact names, and don't invent links. Tags go in `--tags`. If a project has no description yet, add one with `--project-summary`.
- Give every decision, including a skip, a one-sentence reason. Reasons are logged and used to tune this bar.
