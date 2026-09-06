import { ID_PATTERN, readHandout } from "./handouts";
import { methodNotAllowed, notFoundPage, serveAsset, SHELL_PAGE_HEADERS, withHeaders } from "./http";

export async function handleViewHost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
  if (url.pathname === "/") return Response.redirect(`${url.protocol}//${env.UPLOAD_HOST}/`, 302);
  const match = /^\/([^/]+)(\/raw)?$/.exec(url.pathname);
  const id = match?.[1] ?? "";
  if (!ID_PATTERN.test(id)) return serveAsset(request, env, SHELL_PAGE_HEADERS);

  // The generic viewer contains no document data. It checks availability through /raw, and a
  // preload hint lets the browser start that download while the viewer script is still loading.
  if (!match?.[2]) {
    const shell = await env.ASSETS.fetch(new Request(new URL("/shell", url), { method: request.method }));
    const hinted = new HTMLRewriter()
      .on("head", {
        element(el) {
          el.append(`<link rel="preload" href="/${id}/raw" as="fetch" crossorigin="anonymous">`, { html: true });
        },
      })
      .transform(shell);
    return withHeaders(hinted, SHELL_PAGE_HEADERS);
  }
  const found = await readHandout(env, id);
  if (!found) return notFoundPage(request, env, SHELL_PAGE_HEADERS);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${id}.html"`,
    "content-length": String(found.meta.size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "x-handout-visibility": found.meta.visibility,
    "x-handout-title": encodeURIComponent(found.meta.title),
    "x-handout-size": String(found.meta.size),
  };
  if (request.method === "HEAD") {
    await found.body.cancel();
    return new Response(null, { headers });
  }
  // Public HTML compresses well and the octet-stream type keeps the edge from doing it, so the
  // Worker asks the runtime to gzip the stream. Private bodies are ciphertext and stay as they are.
  if (found.meta.visibility === "public" && /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) {
    delete headers["content-length"];
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
  }
  return new Response(found.body, { headers });
}
