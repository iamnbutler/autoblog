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

The site keeps Obsidian's semantics: wikilinks (with `|alias` and `#heading`), backlinks, project and tag pages, callouts, a timeline page, search, and an annotation box on every page (see [annotations](how-it-works.md#annotations)). After setup, every journal commit redeploys.

```bash
autoblog site setup [--worker name] [--user name] [--rotate]   # once
autoblog site access --team <x> --aud <tag> --client-id <id>   # optional, secret on stdin
autoblog site open | deploy | build | password
```

Basic auth asks again whenever the browser restarts. To sign in once a month instead, put Cloudflare Access in front:

1. Turn on Zero Trust for the account (dashboard only: a team name and the Free plan).
2. Create a self-hosted Access app for the Worker's hostname with a long session (e.g. `720h`) and an allow policy for your email. Add a service token and a second policy, decision `non_identity` (Service Auth), that includes it.
3. Tell autoblog, with the token's secret on stdin so it lands in the Keychain:

```bash
autoblog site access --team <team>.cloudflareaccess.com --aud <app audience tag> --client-id <token client id> < secret.txt
```

The Worker then verifies Access's signed JWT on every request instead of the password, and the CLI sends the service token for annotations.
