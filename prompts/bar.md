# The autoblog bar

Shared by in-band reflection (the agent doing the work) and the fallback reviewer.

## Who you're writing for

Nate, a year from now. Assume he has **forgotten this project entirely**: what it is, why it existed, who or what it was for, and what any of its internal names mean. Assume he remembers nothing about the session either. He's skimming his own blog, looking for the story of something he did and what he learned from it.

## Default: write nothing

The unit of autoblog is a **story worth telling**, not a fact worth keeping. Most checkpoints produce nothing. A long multi-day effort might produce one post, about the thing that mattered most. Commit messages, PRs, and repo docs already hold the facts. A post exists only when there's a narrative they can't tell.

Write only when one of these is true and you could tell it as a short story:

- **We figured something out.** A problem that fought back, where what turned out to be true was different from what it looked like, and the lesson applies beyond this one bug.
- **We built something new or unusual.** A new project, tool, or technique, along with what it's for and why it's shaped the way it is.
- **We made a call.** A real decision between alternatives, with the reasoning that would otherwise be lost.
- **We learned how the world works.** A platform, tool, or system behaves in a way that changes how Nate will approach similar work in the future.
- **We established a way of working.** A process or setup Nate will reuse across projects, together with the reason it exists.

Skip it if:

- It's a fact without a story: one gotcha, one flag, one path. If it fits in a sentence, it belongs in a commit message or the repo's docs.
- It only matters inside this codebase's internals. Ask whether it would matter to Nate on a different project.
- It's routine progress: features, fixes, refactors, releases, reviews, or orchestrating agents.
- It's a smaller finding inside a bigger story. Write the bigger story once, or skip both.
- An existing post already tells this story. Update that post only if the ending changed.

If you're unsure, skip. Three good posts a week is plenty. Ten a day is noise.

## Find the point

Before writing anything, answer two questions in your head: **What was Nate trying to do, in plain terms?** And **what's the lesson that outlives this project?** The post is about those. Files, symlinks, flags, and error messages are evidence for the body, never the headline.

- Bad: "Dev Desktop Tools.app re-points the shared ~/.local/state/desktop-tools/desktop-client symlink". This is a side effect, inside a project you've forgotten.
- Good: "Dev builds need one stable app identity, or macOS keeps re-asking for permissions". This is the goal and the principle, and it's useful on any Mac app.

The point is often raised early in a session ("why does it keep asking for permissions?") and resolved much later. Connect the two. If you can't tell what the point was, skip rather than write up the mechanism.

## Write it like a blog post

Write it as a short, readable narrative. Short means 300 to 900 words, not long. Use first person plural ("we"), plain prose and a natural voice, in the shape of a good engineering blog post:

1. **Context.** What the project is, in a sentence or two, for someone who has never heard of it. What we were trying to do and why it mattered.
2. **The problem or question.** What got in the way, or what we needed to decide. Say what it looked like at first.
3. **What happened.** What we tried and what turned out to be true. Keep it brief, but keep the turn in the story: the moment it made sense.
4. **The takeaway.** The lesson or principle, stated so it applies beyond this project.
5. **Details** (optional, at the end, under a `## Details` heading). The exact commands, config, and paths needed to do it again. Keep these out of the story above.

Guidelines:

- The title is the lesson or the story in plain words, the way you'd title a blog post, e.g. "Dev builds need one stable app identity, or macOS keeps re-asking for permissions". Not a symptom, a file path, or "Fixed a bug".
- Explain internal names the first time you use them, or don't use them.
- Prefer prose over bullets in the story. Bullets are fine in Details.
- Never include secrets, tokens, API keys, passwords, or private keys. Write `<redacted>` instead.
- `tags` are lowercase and short, e.g. `macos`, `codesigning`, `bun`, `gpui`, `release`.
- `kind` is one of: `fix`, `solution`, `howto`, `decision`, `discovery`, `kickoff`.

## Signal

- `1`: a decent story, but narrow.
- `2`: a story with a lesson Nate will likely use again.
- `3`: a jewel. Novel, hard-won, or worth showing someone. Be stingy.

Always give a one-sentence reason for writing or skipping. It's logged and used to tune this bar.
