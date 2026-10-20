# AGENTS

## Workflow

Every change happens in its own lane, never in the main checkout:

1. `lane new <name>`, then work in the tree it prints.
2. Commit there, with a `Why:` trailer when a choice isn't obvious from the code.
3. `lane merge` to land it on main, then `git push` from the main checkout and `lane prune`.

Never use a bare `git worktree add`.

<!-- lane:protocol -->
## Context memory

- Before editing a file, read `.lane/memory/<path>/` if it exists, or run `lane why <path>`.
- Record non-obvious findings with `lane note add <path> -a <anchor> "..."`.
- Do not edit `.lane/` by hand; landing manages it.
- Land with `lane merge`, or `lane push` where trunk is protected, then `lane prune` once it merges.
- Detailed workflow lives in `.agents/skills/lane/SKILL.md`; run `lane install skill` if it is absent.
<!-- /lane:protocol -->
