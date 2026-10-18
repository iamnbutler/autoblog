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

export default {
  async fetch(req, env) {
    if (!(await authorized(req, env))) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="autoblog", charset="UTF-8"', "Cache-Control": "no-store" },
      });
    }
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};
