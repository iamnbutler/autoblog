// Serves the built vault, but only to someone signed in: through Cloudflare Access when
// ACCESS_TEAM and ACCESS_AUD are set, otherwise with the password (HTTP basic auth).
// Fails closed: with neither configured, nothing is served.
const enc = new TextEncoder();
const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// Access signs a JWT for every request it lets through. Check it here too, so the Worker
// stays closed if Access is ever turned off or the Worker is reached another way.
let certs; // { at, keys: Map<kid, CryptoKey> }, refreshed hourly and when a kid is unknown
async function accessKey(team, kid) {
  if (!certs || Date.now() - certs.at > 3600_000 || !certs.keys.has(kid)) {
    const { keys } = await (await fetch(`https://${team}/cdn-cgi/access/certs`)).json();
    const imported = await Promise.all(keys.map(async (k) => [k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])]));
    certs = { at: Date.now(), keys: new Map(imported) };
  }
  return certs.keys.get(kid);
}

async function accessAuthorized(req, env) {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  try {
    const [h, p, sig] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    const key = header.alg === "RS256" && (await accessKey(env.ACCESS_TEAM, header.kid));
    if (!key || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), enc.encode(`${h}.${p}`)))) return false;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return claims.iss === `https://${env.ACCESS_TEAM}` && aud.includes(env.ACCESS_AUD) && claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

async function authorized(req, env) {
  if (env.ACCESS_TEAM && env.ACCESS_AUD) return accessAuthorized(req, env);
  if (!env.AUTOBLOG_PASSWORD) return false;
  const got = await digest(req.headers.get("Authorization") ?? "");
  const want = await digest("Basic " + btoa(`${env.AUTOBLOG_USER}:${env.AUTOBLOG_PASSWORD}`));
  return crypto.subtle.timingSafeEqual(got, want);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Annotations: notes the owner leaves on a page, which an agent later folds into the entry.
// Stored in KV as `a:<id>`, with the page and status in metadata so listing needs no reads.
async function annotations(req, env, url) {
  const kv = env.ANNOTATIONS;
  if (!kv) return json({ error: "annotations are not set up; run `autoblog site deploy`" }, 501);
  const id = url.pathname.split("/")[2];
  // Browsers resend basic auth and Access's cookie to this origin from any site. Writes must be same-origin JSON,
  // which another site can't send without a CORS preflight this worker never answers.
  if (req.method !== "GET") {
    const origin = req.headers.get("Origin");
    if (!(req.headers.get("Content-Type") ?? "").startsWith("application/json") || (origin && origin !== url.origin)) return json({ error: "forbidden" }, 403);
  }

  if (req.method === "GET") {
    const page = url.searchParams.get("page"), status = url.searchParams.get("status");
    const keys = [];
    let cursor;
    do {
      const r = await kv.list({ prefix: "a:", cursor });
      keys.push(...r.keys);
      cursor = r.list_complete ? undefined : r.cursor;
    } while (cursor);
    const wanted = keys.filter((k) => (!page || k.metadata?.page === page) && (!status || k.metadata?.status === status));
    const items = (await Promise.all(wanted.map((k) => kv.get(k.name, "json")))).filter(Boolean);
    return json(items.sort((a, b) => a.at.localeCompare(b.at)));
  }

  if (req.method === "POST" && !id) {
    const body = await req.json().catch(() => null);
    const text = String(body?.text ?? "").trim();
    const page = String(body?.page ?? "");
    if (!text || !/^(note|post|project)\/.+/.test(page) || text.length > 10_000) return json({ error: "need page and text" }, 400);
    const item = { id: `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`, page, title: String(body.title ?? ""), text, at: new Date().toISOString(), status: "open" };
    await kv.put(`a:${item.id}`, JSON.stringify(item), { metadata: { page, status: item.status } });
    return json(item, 201);
  }

  if (id && (req.method === "PATCH" || req.method === "DELETE")) {
    const item = await kv.get(`a:${id}`, "json");
    if (!item) return json({ error: "not found" }, 404);
    if (req.method === "DELETE") {
      await kv.delete(`a:${id}`);
      return json({ deleted: id });
    }
    const patch = await req.json().catch(() => ({}));
    if (patch.status) item.status = String(patch.status);
    if (patch.reply !== undefined) item.reply = String(patch.reply);
    item.updated = new Date().toISOString();
    await kv.put(`a:${id}`, JSON.stringify(item), { metadata: { page: item.page, status: item.status } });
    return json(item);
  }
  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(req, env) {
    if (!(await authorized(req, env))) {
      if (env.ACCESS_AUD) return new Response("Sign in through Cloudflare Access", { status: 403, headers: { "Cache-Control": "no-store" } });
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="autoblog", charset="UTF-8"', "Cache-Control": "no-store" },
      });
    }
    const url = new URL(req.url);
    if (url.pathname === "/_annotations" || url.pathname.startsWith("/_annotations/")) return annotations(req, env, url);
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};
