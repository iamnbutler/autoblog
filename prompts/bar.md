# The autoblog bar

Shared by in-band reflection (the agent doing the work), manual writes, and the fallback reviewer.

## Who it's for

{{OWNER}}, later. They might be starting something similar, hitting the same wall again, or looking for something to turn into a real post. Assume they've forgotten the project and the session.

The reference point is a personal developer site, where posts look like "Spool", "Player", "Adding a Favicon in 2024", "Adding Extended Context in GPUI", and "Computer Use For All". They have topic titles, a plain first-person voice, and concrete code, and each one is about a thing the author made or a way of doing something. The journal can be rougher than that, but never thinner.

The journal holds two kinds of entries. Both are titled by **topic**. Once written, they change only under the narrow rules in "Revising" below.

## Notes

A note is a reference page on a topic that will come up again. It answers "what do I need to know about X?"

- Good titles: "Counting tokens: pitfalls", "Keeping long-running work alive when the screen locks", "macOS permissions for dev builds", "Signing and notarizing Mac apps in CI".
- The title is the topic, phrased the way {{OWNER}} would search for it. It isn't an event, and it isn't a sentence-long lesson.
- The body is short: what to do, what goes wrong, and why. Bullets, code, and commands are welcome. Say where it came from in a line (`[[project]]`); don't tell the story of the session.
- Don't write a second note on a topic a note already covers. Either it qualifies as a revision (below), or it's nothing.

## Posts

A post is something {{OWNER}} could put on their own site with light editing. It has one of two shapes:

- **A project.** What it is, why it exists, and what's interesting about how it works, like "Spool" or "Player". Write it once the project has a shape worth describing. It describes the project as it was then, and it isn't extended as the project changes. The project already has a note under its own name, so give the post a title of its own that says what the project is, like {{OWNER}}'s drafts "Serial by Design" (Tasks) and "Computer Use For All" (Desktop Tools).
- **A way of working.** How we do something, refined across sessions and projects, like "How we sign Mac apps while prototyping" or "Designing by exploring several directions at once".

Guidelines:

- The title is short and topical: a name, "How we …", or a noun phrase. It is never a narrated event.
- The body is 400 to 1,500 words in a plain first-person voice ("I" and "we"), with code where it helps. Start with context for someone who has never heard of the project. Use headings that follow the topic, not a fixed template, and skip the moral at the end.
- Posts are rare. Most projects get one at most, and a single session almost never produces one. A post usually gathers material from many sessions.

## Default: nothing

Most checkpoints produce nothing. New notes are occasional, new posts are rare, and revisions are rarer still. There are no quotas in either direction.

Ask these in order:

1. **Is something in an existing entry now wrong, or does an existing note's topic call for exactly this?** Revise it, within the rules below.
2. **Is this a topic {{OWNER}} will hit again, on another project?** Write a new note.
3. **Is this a project, a significant new piece of one, or a way of working that's now worth describing whole?** Write a post.

Skip everything else:

- routine features, fixes, refactors, releases, and reviews
- one-off incidents that don't belong to a topic
- orchestrating agents
- anything the repo's own docs already say
- anything you can't name as a topic

## Revising

Revising is for two things only:

- **A factual inaccuracy.** Something the entry says is wrong, or no longer true. Fix that, and change nothing else.
- **A very closely aligned addition to a note.** One new pitfall or fix that belongs on that exact page, where a reader looking up the topic would expect to find it. Keep the existing text. If the addition needs its own heading or more than a short paragraph, it's probably its own note.

Never revise to extend a post, to bring a project post up to date, or to fold in loosely related material. New work on a project becomes new notes, a new post, both, or nothing. When we ship revision history in Next Cloud, for example, that doesn't revise "Next Cloud". It might be a note on how the revision storage works, or a post of its own if it's substantial, or neither. The new entry mentions the old one by name, and the linker connects them.

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
- Don't add `[[links]]` to other entries or projects; autoblog links them after you write. Name related topics plainly in the text. Projects go in `--project`, tags in `--tags`, and if a project has no description yet, add one with `--project-summary`.
- Give every decision, including a skip, a one-sentence reason. Reasons are logged and used to tune this bar.
