import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Add (or with `remove`, strip) our Stop hook in a Claude Code / Codex style hooks object. */
function wireHooks(file: string, command: string, remove = false) {
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  s.hooks ??= {};
  for (const event of ["Stop", "SessionEnd"]) {
    const groups: any[] = (s.hooks[event] ?? []).filter((g: any) => !g.hooks?.some((h: any) => String(h.command).includes(HOOK_MARK)));
    if (!remove && event === "Stop") groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
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

export function install(opts: { journalRepo?: string; noLaunchd?: boolean; noHooks?: boolean }) {
  const say = (m: string) => console.log(`  ${m}`);
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n");
  const cfg = loadConfig();

  // 1. Journal clone
  if (!existsSync(join(cfg.journal, ".git"))) {
    if (!opts.journalRepo) {
      console.error(`journal missing at ${cfg.journal}; pass --journal-repo <owner/name> to clone it`);
      process.exit(1);
    }
    const r = spawnSync("gh", ["repo", "clone", opts.journalRepo, cfg.journal], { stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
  }
  say(`journal     ${cfg.journal}`);

  // 2. CLI on PATH
  link(BIN, CLI);
  say(`cli         ~/.local/bin/autoblog -> ${BIN}`);

  // 3. Skill for every harness that reads SKILL.md
  for (const t of SKILL_TARGETS) link(SKILL, t);
  say(`skill       ${SKILL_TARGETS.map((t) => t.replace(HOME, "~")).join(", ")}`);

  // 4. In-band reflection: a Stop hook in each harness asks the working agent to reflect at checkpoints.
  if (!opts.noHooks) {
    wireHooks(CLAUDE_SETTINGS, `${CLI} hook`);
    say(`hooks       ${CLAUDE_SETTINGS.replace(HOME, "~")} (Stop)`);
    wireHooks(CODEX_HOOKS, `${CLI} hook --agent codex`);
    say(`hooks       ${CODEX_HOOKS.replace(HOME, "~")} (Stop; approve it once with /hooks in Codex)`);
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
