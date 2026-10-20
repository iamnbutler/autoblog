import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_PATH, REPO_ROOT, STATE_DIR, loadConfig, type Config } from "./config";
import { buildSite } from "./site";

/*
 * The site is a Cloudflare Worker serving the built vault as static assets, behind
 * HTTP basic auth or Cloudflare Access (site/worker.js). The password lives in a Worker
 * secret and the macOS Keychain (service "autoblog-site"), never in either repo; so does
 * the Access service token's secret (service "autoblog-site-access").
 */

const SITE_DIR = join(STATE_DIR, "site");
const DIST = join(SITE_DIR, "dist");
const LOCK = join(SITE_DIR, "deploy.lock");
const DIRTY = join(SITE_DIR, "deploy.dirty");
const KEYCHAIN_SERVICE = "autoblog-site";
const ACCESS_KEYCHAIN_SERVICE = "autoblog-site-access";
const WRANGLER = ["x", "wrangler@4"];

function wrangler(args: string[], input?: string) {
  return spawnSync("bun", [...WRANGLER, ...args, "--config", join(SITE_DIR, "wrangler.jsonc")], {
    cwd: SITE_DIR,
    input,
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
}

function writeWranglerConfig(cfg: Config) {
  const site = cfg.site!;
  mkdirSync(SITE_DIR, { recursive: true });
  writeFileSync(
    join(SITE_DIR, "wrangler.jsonc"),
    JSON.stringify(
      {
        name: site.worker,
        main: join(REPO_ROOT, "site", "worker.js"),
        compatibility_date: "2026-09-01",
        workers_dev: true,
        assets: { directory: DIST, binding: "ASSETS", run_worker_first: true, html_handling: "auto-trailing-slash", not_found_handling: "404-page" },
        vars: { AUTOBLOG_USER: site.user, ...(site.access ? { ACCESS_TEAM: site.access.team, ACCESS_AUD: site.access.aud } : {}) },
        ...(site.kv ? { kv_namespaces: [{ binding: "ANNOTATIONS", id: site.kv }] } : {}),
      },
      null,
      2,
    ),
  );
}

export function build(cfg: Config) {
  const name = cfg.site?.worker ?? "autoblog";
  const stats = buildSite(cfg, DIST, name);
  writeFileSync(join(DIST, "404.html"), `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/style.css><main><h1>Not found</h1><p><a href="/">Back to all posts</a></p></main>`);
  return stats;
}

export function deploy(cfg: Config, quiet = false): boolean {
  if (!cfg.site) {
    if (!quiet) console.error("autoblog site: not set up; run `autoblog site setup`");
    return false;
  }
  mkdirSync(SITE_DIR, { recursive: true });
  // Posts can land in bursts; one deploy at a time, and a deploy that started too early runs again.
  if (existsSync(LOCK) && Date.now() - Number(readFileSync(LOCK, "utf8") || 0) < 10 * 60_000) {
    writeFileSync(DIRTY, "");
    return true;
  }
  writeFileSync(LOCK, String(Date.now()));
  try {
    do {
      rmSync(DIRTY, { force: true });
      writeWranglerConfig(cfg);
      ensureAnnotationStore(cfg);
      const stats = build(cfg);
      const r = wrangler(["deploy"]);
      if (r.status !== 0) {
        console.error(`autoblog site: deploy failed\n${r.stderr || r.stdout}`.slice(0, 3000));
        return false;
      }
      rememberUrl(cfg, r.stdout);
      if (!quiet) console.log(`deployed ${stats.notes} notes, ${stats.posts} posts -> ${siteUrl(cfg)}`);
    } while (existsSync(DIRTY));
    return true;
  } finally {
    rmSync(LOCK, { force: true });
  }
}

/** The KV namespace annotations live in, created on the first deploy that lacks one. */
function ensureAnnotationStore(cfg: Config) {
  if (cfg.site!.kv) return;
  const r = wrangler(["kv", "namespace", "create", `${cfg.site!.worker}-annotations`]);
  const id = (r.stdout + r.stderr).match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1];
  if (!id) {
    console.error(`autoblog site: couldn't create the annotations store; deploying without it\n${r.stderr || r.stdout}`.slice(0, 2000));
    return;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, site: { ...raw.site, kv: id } }, null, 2) + "\n");
  cfg.site!.kv = id;
  writeWranglerConfig(cfg);
}

export function siteUrl(cfg: Config): string {
  return cfg.site?.url ?? `(run \`autoblog site deploy\` to learn the URL)`;
}

/** Remember the workers.dev URL wrangler reports, so `autoblog site open` knows where to go. */
function rememberUrl(cfg: Config, output: string) {
  const url = output.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  if (!url || cfg.site?.url) return;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, site: { ...raw.site, url } }, null, 2) + "\n");
  cfg.site!.url = url;
}

export function password(): string | null {
  const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The Access service token's secret, which the CLI sends with its client id to get past Access. */
export function accessSecret(): string | null {
  const r = spawnSync("security", ["find-generic-password", "-s", ACCESS_KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Put the site behind a Cloudflare Access app (created in the dashboard or API) instead of the
 * password. The service token's secret is read from stdin into the Keychain, then the site redeploys.
 */
export function access(opts: { team: string; aud: string; clientId?: string; secret?: string }) {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!raw.site) {
    console.error("autoblog site: not set up; run `autoblog site setup`");
    process.exit(1);
  }
  const prev = raw.site.access ?? {};
  raw.site.access = { team: opts.team, aud: opts.aud, ...(opts.clientId ?? prev.clientId ? { clientId: opts.clientId ?? prev.clientId } : {}) };
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
  if (opts.secret) {
    spawnSync("security", ["add-generic-password", "-U", "-a", raw.site.access.clientId ?? "autoblog", "-s", ACCESS_KEYCHAIN_SERVICE, "-l", "autoblog site access token", "-w", opts.secret]);
  }
  if (!deploy(loadConfig())) process.exit(1);
  console.log(`  access     ${opts.team} (aud ${opts.aud.slice(0, 12)}…${raw.site.access.clientId ? `; service token ${raw.site.access.clientId}` : "; no service token, so CLI annotation calls will fail"})`);
}

/** One-time: pick the Worker name and login, generate a password, deploy, and set the secret. */
export function setup(opts: { worker?: string; user?: string; url?: string; rotate?: boolean }) {
  const cfg = loadConfig();
  const repoName = cfg.journal.split("/").pop()!;
  const site = { worker: opts.worker ?? cfg.site?.worker ?? repoName, user: opts.user ?? cfg.site?.user ?? process.env.USER ?? "me", url: opts.url ?? cfg.site?.url };
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, site }, null, 2) + "\n");
  const next = loadConfig();

  if (!deploy(next)) process.exit(1);

  let pw = opts.rotate ? null : password();
  if (!pw) {
    pw = randomBytes(18).toString("base64url");
    spawnSync("security", ["add-generic-password", "-U", "-a", site.user, "-s", KEYCHAIN_SERVICE, "-l", "autoblog site", "-w", pw]);
  }
  const s = wrangler(["secret", "put", "AUTOBLOG_PASSWORD"], pw);
  if (s.status !== 0) {
    console.error(`autoblog site: setting the password secret failed\n${s.stderr || s.stdout}`);
    process.exit(1);
  }
  console.log(`  site       ${site.worker} (user "${site.user}"; password in Keychain: security find-generic-password -s ${KEYCHAIN_SERVICE} -w)`);
}
