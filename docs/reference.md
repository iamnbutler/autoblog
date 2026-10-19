# Reference

## CLI

```
autoblog write --type note|post --title <topic> [--tags a,b] [--project a,b] < body.md
autoblog revise <name> [--title new] < body.md
autoblog show <name>     autoblog ls [--notes|--posts]     autoblog search <words...>
autoblog project [name] [--summary "..."]
autoblog skip "<reason>" autoblog bar     autoblog guide   autoblog log
autoblog pause [--session id]    autoblog resume [--session id]
autoblog init [--owner name] [--repo owner/name] [--dir path]
autoblog install         autoblog uninstall
autoblog sweep [--dry-run -v]             autoblog review <transcript.jsonl> [--dry-run]
autoblog timeline [--from <transcripts...>]                autoblog link [--due]
autoblog annotations [apply] [--all] [--dry-run]
autoblog backfill [--since DATE] [--until DATE] [--project name] [--from dir] [--plan | --resume run] [--dry-run]
autoblog archive "<why>" autoblog reindex autoblog sync    autoblog transcript <path.jsonl>
autoblog site setup | deploy | build | open | password
```

`init` and `install` are idempotent. `install` links `~/.local/bin/autoblog`, links the skill into each harness, adds the `Stop` hooks (and a `SessionStart` hook in Claude Code, for paused sessions) and loads the launchd sweep. `uninstall` reverses all of that but leaves the vault and `~/.autoblog`.

## Config

`~/.autoblog/config.json`, with defaults:

```json
{
  "owner": "<first word of git user.name>",
  "journal": "~/code/<you>-autoblog",
  "model": "opus",
  "linkModel": "sonnet",
  "timelineModel": "haiku",
  "reflectEvery": 40,
  "reflectEveryTurns": 6,
  "idleMinutes": 20,
  "minToolCalls": 8,
  "lookbackHours": 24,
  "maxChars": 120000,
  "sources": ["claude", "codex"],
  "push": true
}
```

`AUTOBLOG_JOURNAL` overrides `journal`.

## Wiring

| Agent | Checkpoints | Manual |
| --- | --- | --- |
| Claude Code | `Stop` and `SessionStart` (compact, resume) hooks in `~/.claude/settings.json` | skill at `~/.claude/skills/autoblog` |
| Codex | `Stop` hook in `~/.codex/hooks.json` (approve once via `/hooks`) | skill at `~/.codex/skills/autoblog` and `~/.agents/skills/autoblog` |
| Anything else | a Stop hook calling `autoblog hook --agent <name>` (emits `{"decision":"block","reason":...}`), or the sweep with a reader in `src/transcripts.ts` | `skill/autoblog/SKILL.md`, or `autoblog write` |
