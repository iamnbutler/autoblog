// Serves the built vault, but only to someone with the password (HTTP basic auth).
// Fails closed: with no AUTOBLOG_PASSWORD secret set, nothing is served.
const enc = new TextEncoder();
const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function authorized(req, env) {
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
  // Browsers resend basic auth to this origin from any site. Writes must be same-origin JSON,
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
