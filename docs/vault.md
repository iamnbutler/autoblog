# The vault and the site

## The vault

The journal is an Obsidian vault, whether or not you open it in Obsidian:

```
notes/macOS permissions for dev builds.md      # a topic
posts/How we sign Mac apps while prototyping.md
projects/desktop-tools.md     # what the project is, plus a generated list of what touches it
timeline/2026-10-17.md        # the day's work log
archive/<date>/               # entries set aside by `autoblog archive`
README.md                     # generated
```

- **Names are titles,** so `[[wikilinks]]` resolve. They're unique across notes and posts. Writing a topic that exists fails and points you at `revise`. Renaming with `revise --title` rewrites links across the vault.
- **Each entry lists its projects** (`projects: ["[[luau]]", "[[desktop-tools]]"]`), so a cross-project note shows up on each project's page.
- **Project pages** start with a short description (`autoblog project <name> --summary "…"`), because a year from now you won't remember what the project was.
- **Properties:** `title, type, created, updated, projects, tags, sessions, agent, mode`.

Secrets are redacted on write: GitHub, Anthropic, OpenAI, Slack, AWS and Google tokens, JWTs, private keys, and `*_TOKEN=` style assignments.

## The private site

GitHub Pages sites are public unless you're on Enterprise Cloud, so `autoblog site setup` deploys the vault to a **Cloudflare Worker behind HTTP basic auth** (`site/worker.js`). It fails closed: with no password set, nothing is served. The password goes into the Worker's secrets and your macOS Keychain (`autoblog site password`).

The site keeps Obsidian's semantics: wikilinks (with `|alias` and `#heading`), backlinks, project and tag pages, callouts, a timeline page, and search. After setup, every journal commit redeploys.

```bash
autoblog site setup [--worker name] [--user name] [--rotate]   # once
autoblog site open | deploy | build | password
```

For SSO instead, put a Cloudflare Access application in front of the worker's hostname.
