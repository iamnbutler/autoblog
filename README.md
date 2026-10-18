# autoblog

A private engineering journal, written by your coding agents and organized by topic.

While you work, agents notice when something belongs in the journal and write it to a private repo:

- **Notes**: short reference pages on a topic ("Counting tokens: pitfalls").
- **Posts**: rarer pieces about a project or a way of working ("How we sign Mac apps while prototyping").
- **Timeline**: one line per thing done, per day, across every project.

Most of the time they write nothing. The bar is in [`prompts/bar.md`](prompts/bar.md).

## Install

Requires [bun](https://bun.sh), an authenticated `gh`, and the `claude` CLI.

```bash
git clone https://github.com/iamnbutler/autoblog ~/code/autoblog
~/code/autoblog/bin/autoblog init --owner <your first name>
```

`init` creates a private `<you>-autoblog` repo, clones it as an Obsidian vault, and hooks Claude Code and Codex. `autoblog site setup` serves the vault as a password-protected site on Cloudflare.

## Docs

- [How it works](docs/how-it-works.md): reflection checkpoints, the fallback sweep, links, the timeline, several machines
- [Backfilling from your history](docs/backfill.md)
- [The vault and the site](docs/vault.md)
- [Reference](docs/reference.md): CLI, config, agent wiring
