import { createHandout, deleteHandout, ID_PATTERN, type Visibility } from "./handouts";
import {
  allow,
  clientIp,
  error,
  json,
  methodNotAllowed,
  readBodyLimited,
  serveAsset,
  UPLOAD_PAGE_HEADERS,
} from "./http";
import { cleanTitle, titleFromHtml, UNTITLED } from "./title";
import { TURNSTILE_HEADER, verifyTurnstile } from "./turnstile";

const COLLECTION = "/api/handouts";
const ITEM = /^\/api\/handouts\/([A-Za-z0-9_-]+)$/;

/** The page reads the public Turnstile sitekey from this tag; the Worker fills it per environment. */
function withSitekey(response: Response, sitekey: string): Response {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  return new HTMLRewriter()
    .on('meta[name="turnstile-sitekey"]', {
      element(el) {
        el.setAttribute("content", sitekey);
      },
    })
    .transform(response);
}

export async function handleUploadHost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === COLLECTION) {
    if (request.method === "POST") return upload(request, env, url);
    return methodNotAllowed(["POST"]);
  }

  const item = ITEM.exec(url.pathname);
  if (item) {
    const id = item[1] ?? "";
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    if (!ID_PATTERN.test(id)) return error(404, "Handout not found");
    return remove(request, env, id);
  }

  if (url.pathname.startsWith("/api/")) return error(404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
  return withSitekey(await serveAsset(request, env, UPLOAD_PAGE_HEADERS), env.TURNSTILE_SITEKEY);
}

function parseVisibility(value: string | null): Visibility | null {
  if (value === null || value === "public") return "public";
  if (value === "private") return "private";
  return null;
}

function parseTitleHeader(value: string | null): string {
  if (!value) return "";
  try {
    return cleanTitle(decodeURIComponent(value));
  } catch {
    return "";
  }
}

async function upload(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await allow(env.UPLOAD_LIMITER, clientIp(request)))) {
    return error(429, "Too many uploads. Try again in a minute.", { "retry-after": "60" });
  }
  const check = await verifyTurnstile(env, request.headers.get(TURNSTILE_HEADER), clientIp(request), "upload");
  if (!check.ok) return error(403, check.message, {}, check.code);

  const visibility = parseVisibility(request.headers.get("x-handout-visibility"));
  if (!visibility) return error(400, "x-handout-visibility must be 'public' or 'private'");

  const read = await readBodyLimited(request, Number(env.MAX_BODY_BYTES));
  if (!read.ok) {
    if (read.reason === "too_large") return error(413, `Handout is larger than ${env.MAX_BODY_BYTES} bytes`);
    return error(400, "Handout body is empty");
  }

  let title = "";
  if (visibility === "public") {
    title = parseTitleHeader(request.headers.get("x-handout-title")) || titleFromHtml(read.bytes) || UNTITLED;
  }

  const { meta, deleteKey } = await createHandout(env, { body: read.bytes, visibility, title });
  const viewUrl = `${url.protocol}//${env.VIEW_HOST}/${meta.id}`;

  return json(
    {
      id: meta.id,
      url: viewUrl,
      visibility: meta.visibility,
      title: meta.title,
      deleteKey,
      expiry: "1y",
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      size: meta.size,
    },
    201,
    { location: viewUrl },
  );
}

async function remove(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await allow(env.DELETE_LIMITER, clientIp(request)))) {
    return error(429, "Too many requests. Try again in a minute.", { "retry-after": "60" });
  }
  const check = await verifyTurnstile(env, request.headers.get(TURNSTILE_HEADER), clientIp(request), "delete");
  if (!check.ok) return error(403, check.message, {}, check.code);

  const auth = request.headers.get("authorization") ?? "";
  const deleteKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!deleteKey) return error(401, "Delete Key required", { "www-authenticate": "Bearer" });

  const result = await deleteHandout(env, id, deleteKey);
  if (result === "not_found") return error(404, "Handout not found");
  if (result === "forbidden") return error(403, "Delete Key does not match");
  return new Response(null, { status: 204 });
}
