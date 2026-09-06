import { randomBase64Url } from "./encoding";

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function error(status: number, message: string, headers: HeadersInit = {}, code?: string): Response {
  return json(code ? { error: message, code } : { error: message }, status, headers);
}

export function methodNotAllowed(allowed: string[]): Response {
  return error(405, "Method not allowed", { allow: allowed.join(", ") });
}

const NONCE = "{nonce}";

/**
 * Applies response headers. A Content Security Policy containing the nonce placeholder gets a
 * fresh nonce per response; HTML bodies get that nonce on their script tags and are not cached,
 * so no two visitors share one. Cloudflare copies the nonce from the header onto the scripts it
 * injects for the zone's JavaScript Detections and Web Analytics.
 */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  const csp = headers["content-security-policy"];
  const nonce = csp?.includes(NONCE) ? randomBase64Url(16) : null;
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, nonce ? v.replaceAll(NONCE, nonce) : v);
  if (!nonce || !out.headers.get("content-type")?.includes("text/html")) return out;
  out.headers.set("cache-control", "no-store");
  return new HTMLRewriter()
    .on("script", {
      element(el) {
        el.setAttribute("nonce", nonce);
      },
    })
    .transform(out);
}

/**
 * Headers for the upload page and its assets. Scripts run from this origin or with the per-response
 * nonce; the external script sources are Cloudflare's analytics beacon and Turnstile, which also
 * renders its challenge in a frame. Inline styles are allowed.
 */
export const UPLOAD_PAGE_HEADERS: Record<string, string> = {
  "content-security-policy":
    `default-src 'none'; script-src 'self' 'nonce-${NONCE}' https://static.cloudflareinsights.com https://challenges.cloudflare.com; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' https://cloudflareinsights.com https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; " +
    "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** Headers for the private-view shell. No CSP: an iframe with a local URL would inherit it. */
export const SHELL_PAGE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
};

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "empty" };

/** Reads the body while counting bytes. Stops as soon as the limit is passed. */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, reason: "too_large" };
  if (!request.body) return { ok: false, reason: "empty" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  if (total === 0) return { ok: false, reason: "empty" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Serves a file from the assets binding. Unknown paths get the 404 page. Conditional headers are
 * dropped so HTML always arrives as a full response with its own nonce.
 */
export async function serveAsset(
  request: Request,
  env: Env,
  headers: Record<string, string>,
): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(request.url, { method: request.method }));
  if (response.status === 404) return notFoundPage(request, env, headers);
  return withHeaders(response, headers);
}

export async function notFoundPage(
  request: Request,
  env: Env,
  headers: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const page = await env.ASSETS.fetch(new Request(new URL("/404", url), { method: "GET" }));
  const html = (await page.text()).replaceAll("{{UPLOAD_URL}}", `${url.protocol}//${env.UPLOAD_HOST}/`);
  return withHeaders(
    new Response(request.method === "HEAD" ? null : html, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }),
    headers,
  );
}
