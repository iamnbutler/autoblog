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
const HOOK_MARK = "autoblog hook";

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
  link(BIN, join(HOME, ".local", "bin", "autoblog"));
  say(`cli         ~/.local/bin/autoblog -> ${BIN}`);

  // 3. Skill for every harness that reads SKILL.md
  for (const t of SKILL_TARGETS) link(SKILL, t);
  say(`skill       ${SKILL_TARGETS.map((t) => t.replace(HOME, "~")).join(", ")}`);

  // 4. Claude Code hooks: SessionEnd reviews the finished session now; Stop nudges a sweep of other idle ones.
  if (!opts.noHooks) {
    const s = existsSync(CLAUDE_SETTINGS) ? JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) : {};
    s.hooks ??= {};
    for (const event of ["SessionEnd", "Stop"]) {
      const groups: any[] = (s.hooks[event] ??= []);
      const has = groups.some((g) => g.hooks?.some((h: any) => String(h.command).includes(HOOK_MARK)));
      if (!has) groups.push({ hooks: [{ type: "command", command: `${join(HOME, ".local", "bin", "autoblog")} hook`, timeout: 10 }] });
    }
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n");
    say(`hooks       ${CLAUDE_SETTINGS.replace(HOME, "~")} (SessionEnd, Stop)`);
  }

  // 5. launchd: periodic sweep catches every agent (Codex, Claude sessions that never "end").
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
  for (const t of [...SKILL_TARGETS, join(HOME, ".local", "bin", "autoblog")]) rmSync(t, { force: true, recursive: true });
  if (existsSync(CLAUDE_SETTINGS)) {
    const s = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    for (const event of ["SessionEnd", "Stop"]) {
      if (!s.hooks?.[event]) continue;
      s.hooks[event] = s.hooks[event].filter((g: any) => !g.hooks?.some((h: any) => String(h.command).includes(HOOK_MARK)));
      if (!s.hooks[event].length) delete s.hooks[event];
    }
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n");
  }
  if (existsSync(PLIST)) {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}`, PLIST], { stdio: "ignore" });
    rmSync(PLIST);
  }
  console.log(`removed cli, skill, hooks, launchd agent (kept ${STATE_DIR} and the journal)`);
}
