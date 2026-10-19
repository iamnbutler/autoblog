import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { commitLocked } from "./journal";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_PATH, DEFAULTS, REPO_ROOT, STATE_DIR, loadConfig } from "./config";

const HOME = homedir();
const BIN = join(REPO_ROOT, "bin", "autoblog");
const SKILL = join(REPO_ROOT, "skill", "autoblog");
const SKILL_TARGETS = [".claude/skills", ".agents/skills", ".codex/skills"].map((d) => join(HOME, d, "autoblog"));
const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
const PLIST_LABEL = "com.autoblog.sweep";
const PLIST = join(HOME, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const CODEX_HOOKS = join(HOME, ".codex", "hooks.json");
const HOOK_MARK = "autoblog hook";
const CLI = join(HOME, ".local", "bin", "autoblog");

/** Add (or with `remove`, strip) our Stop and UserPromptSubmit hooks in a Claude Code / Codex style hooks object. */
function wireHooks(file: string, command: string, remove = false) {
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  s.hooks ??= {};
  for (const event of ["Stop", "SessionEnd", "UserPromptSubmit"]) {
    const groups: any[] = (s.hooks[event] ?? []).filter((g: any) => !g.hooks?.some((h: any) => String(h.command).includes(HOOK_MARK)));
    if (!remove && event === "Stop") groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
    if (!remove && event === "UserPromptSubmit") groups.push({ hooks: [{ type: "command", command: `${command} --recall`, timeout: 5 }] });
    if (groups.length) s.hooks[event] = groups;
    else delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
}

function link(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (lstatSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {}
  symlinkSync(target, path);
}

const VAULT_GITIGNORE = `# Obsidian per-device state
.obsidian/workspace*.json
.obsidian/cache
.trash/
.DS_Store
`;

/**
 * Set up the private journal: <name>/<name>-autoblog on GitHub, cloned locally and
 * scaffolded as an Obsidian vault. Then wire every harness (unless noInstall).
 */
export function init(opts: { owner?: string; name?: string; repo?: string; dir?: string; noInstall?: boolean; noLaunchd?: boolean; noHooks?: boolean }) {
  const say = (m: string) => console.log(`  ${m}`);
  const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

  const name = opts.name ?? sh("gh", ["api", "user", "-q", ".login"]).stdout.trim();
  if (!name && !opts.repo) {
    console.error("autoblog init: couldn't detect your GitHub login (is `gh` authenticated?); pass --name or --repo owner/name");
    process.exit(1);
  }
  const repo = opts.repo ?? `${name}/${name}-autoblog`;
  const repoName = repo.split("/")[1];
  const dir = opts.dir ?? join(existsSync(join(HOME, "code")) ? join(HOME, "code") : HOME, repoName);

  if (sh("gh", ["repo", "view", repo]).status !== 0) {
    const r = spawnSync("gh", ["repo", "create", repo, "--private", "--description", "Private autoblog: stories agents write as we work"], { stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
    say(`created     github.com/${repo} (private)`);
  }
  if (!existsSync(join(dir, ".git"))) {
    const r = spawnSync("gh", ["repo", "clone", repo, dir], { stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const current = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : DEFAULTS;
  const owner = opts.owner ?? current.owner ?? DEFAULTS.owner;
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, owner, journal: dir }, null, 2) + "\n");
  const cfg = loadConfig();

  for (const d of ["posts", "projects"]) {
    mkdirSync(join(dir, d), { recursive: true });
    if (!readdirSync(join(dir, d)).length) writeFileSync(join(dir, d, ".gitkeep"), "");
  }
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), VAULT_GITIGNORE);
  commitLocked(cfg, "init vault");
  say(`journal     ${dir} (github.com/${repo})`);
  say(`owner       ${owner} (prompts say "${owner}'s journal"; change with --owner or in ${CONFIG_PATH})`);

  if (!opts.noInstall) install(opts);
}

export function install(opts: { noLaunchd?: boolean; noHooks?: boolean }) {
  const say = (m: string) => console.log(`  ${m}`);
  const cfg = loadConfig();
  if (!existsSync(join(cfg.journal, ".git"))) {
    console.error(`journal missing at ${cfg.journal}; run \`autoblog init\` first`);
    process.exit(1);
  }

  // 1. Dependencies (the site renderer)
  if (!existsSync(join(REPO_ROOT, "node_modules"))) spawnSync("bun", ["install"], { cwd: REPO_ROOT, stdio: "inherit" });

  // 2. CLI on PATH
  link(BIN, CLI);
  say(`cli         ~/.local/bin/autoblog -> ${BIN}`);

  // 3. Skill for every harness that reads SKILL.md
  for (const t of SKILL_TARGETS) link(SKILL, t);
  say(`skill       ${SKILL_TARGETS.map((t) => t.replace(HOME, "~")).join(", ")}`);

  // 4. In-band reflection: a Stop hook in each harness asks the working agent to reflect at checkpoints.
  if (!opts.noHooks) {
    wireHooks(CLAUDE_SETTINGS, `${CLI} hook`);
    say(`hooks       ${CLAUDE_SETTINGS.replace(HOME, "~")} (Stop, UserPromptSubmit)`);
    wireHooks(CODEX_HOOKS, `${CLI} hook --agent codex`);
    say(`hooks       ${CODEX_HOOKS.replace(HOME, "~")} (Stop, UserPromptSubmit; approve them once with /hooks in Codex)`);
  }

  // 5. launchd: fallback sweep for transcripts no in-band hook has claimed.
  if (!opts.noLaunchd && process.platform === "darwin") {
    const bun = process.execPath;
    const path = [dirname(bun), join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    writeFileSync(
      PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${bun}</string><string>${join(REPO_ROOT, "src", "cli.ts")}</string><string>sweep</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>StartInterval</key><integer>1200</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${join(STATE_DIR, "sweep.log")}</string>
  <key>StandardErrorPath</key><string>${join(STATE_DIR, "sweep.log")}</string>
</dict>
</plist>
`,
    );
    spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}`, PLIST], { stdio: "ignore" });
    spawnSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, PLIST], { stdio: "inherit" });
    say(`launchd     ${PLIST_LABEL} (sweep every 20m)`);
  }
}

export function uninstall() {
  for (const t of [...SKILL_TARGETS, CLI]) rmSync(t, { force: true, recursive: true });
  for (const f of [CLAUDE_SETTINGS, CODEX_HOOKS]) if (existsSync(f)) wireHooks(f, "", true);
  if (existsSync(PLIST)) {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}`, PLIST], { stdio: "ignore" });
    rmSync(PLIST);
  }
  console.log(`removed cli, skill, hooks, launchd agent (kept ${STATE_DIR} and the journal)`);
}
