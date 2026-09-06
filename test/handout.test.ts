import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { objectKey } from "../src/handouts";
import { sha256Hex } from "../src/encoding";
import { verifyTurnstile } from "../src/turnstile";

// The dev environment uses Cloudflare's testing secret, which accepts any token over the network.
const TOKEN = { upload: "token-upload", delete: "token-delete" };

const collection = `http://${env.UPLOAD_HOST}/api/handouts`;
const view = (id: string) => `http://${env.VIEW_HOST}/${id}`;
const raw = (id: string) => `${view(id)}/raw`;
let ip = 0;
const readText = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());
const nextIp = () => `10.0.${Math.floor(++ip / 250)}.${ip % 250}`;
const SAMPLE =
  '<!doctype html><title>Hello &amp; welcome</title><h1>Hi</h1><script>document.body.dataset.ran="yes"</script>';
interface Created {
  id: string;
  url: string;
  visibility: string;
  title: string;
  deleteKey: string;
  createdAt: string;
  expiresAt: string;
  size: number;
  expiry: string;
}
async function post(body: BodyInit, headers: Record<string, string> = {}) {
  return SELF.fetch(collection, {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp(), "cf-turnstile-response": TOKEN.upload, ...headers },
    body,
  });
}
async function create(body: BodyInit = SAMPLE, headers: Record<string, string> = {}): Promise<Created> {
  const res = await post(body, headers);
  expect(res.status).toBe(201);
  return res.json() as Promise<Created>;
}
function del(id: string, key?: string, token = TOKEN.delete) {
  return SELF.fetch(`${collection}/${id}`, {
    method: "DELETE",
    headers: {
      "cf-connecting-ip": nextIp(),
      "cf-turnstile-response": token,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
}
async function seed(id: string, expiresAt: string, visibility = "public") {
  await env.HANDOUTS.put(objectKey(id), SAMPLE, {
    customMetadata: {
      visibility,
      title: "Seeded",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt,
      deleteKeyHash: await sha256Hex("seed-delete-key"),
    },
  });
}

describe("application and viewer", () => {
  it("serves the React upload entry with a strict CSP and a per-response nonce", async () => {
    const res = await SELF.fetch(`http://${env.UPLOAD_HOST}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const nonce = /'nonce-([A-Za-z0-9_-]{22})'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain(`<meta name="turnstile-sitekey" content="${env.TURNSTILE_SITEKEY}"`);
    const tag = /<script[^>]*src="\/assets\/upload-[^" ]+\.js"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain(`nonce="${nonce}"`);
    const turnstileTag = /<script[^>]*challenges\.cloudflare\.com[^>]*>/.exec(html)?.[0] ?? "";
    expect(turnstileTag).toContain(`nonce="${nonce}"`);
    const again = await SELF.fetch(`http://${env.UPLOAD_HOST}/`, { headers: { "if-none-match": res.headers.get("etag") ?? "" } });
    expect(again.status).toBe(200);
    expect(again.headers.get("content-security-policy")).not.toContain(nonce);
    const missing = await SELF.fetch(`http://${env.UPLOAD_HOST}/nowhere`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toMatch(/'nonce-[A-Za-z0-9_-]{22}'/);
  });
  it("serves the agent skill file as markdown", async () => {
    const res = await SELF.fetch(`http://${env.UPLOAD_HOST}/SKILL.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text.startsWith("---\nname: handout\n")).toBe(true);
    expect(text).toContain("/api/handouts");
  });
  it("redirects the view root to upload", async () => {
    const res = await SELF.fetch(view(""), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://${env.UPLOAD_HOST}/`);
  });
  it("uses one generic viewer for both modes without embedding document data", async () => {
    for (const visibility of ["public", "private"]) {
      const created = await create(SAMPLE, { "x-handout-visibility": visibility });
      const res = await SELF.fetch(created.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).toContain("Download HTML");
      expect(body).toMatch(/src="\/assets\/viewer-[^"]+\.js"/);
      expect(body).toContain(`<link rel="preload" href="/${created.id}/raw" as="fetch" crossorigin="anonymous">`);
      expect(body).not.toContain(SAMPLE);
      expect(body).not.toContain(created.deleteKey);
    }
  });
  it("compresses public documents for clients that accept gzip and leaves private ones alone", async () => {
    const created = await create();
    const plain = await SELF.fetch(raw(created.id));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("x-handout-size")).toBe(String(created.size));
    expect(await readText(plain)).toBe(SAMPLE);
    const zipped = await SELF.fetch(raw(created.id), { headers: { "accept-encoding": "gzip, br" } });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toBe("accept-encoding");
    expect(zipped.headers.get("content-length")).not.toBe(String(created.size));
    expect(await readText(zipped)).toBe(SAMPLE);
    const secret = await create(crypto.getRandomValues(new Uint8Array(96)), { "x-handout-visibility": "private" });
    const opaque = await SELF.fetch(raw(secret.id), { headers: { "accept-encoding": "gzip" } });
    expect(opaque.headers.get("content-encoding")).toBeNull();
    expect(opaque.headers.get("content-length")).toBe("96");
  });
  it("returns an empty viewer body for HEAD", async () => {
    const res = await SELF.fetch(view("a".repeat(22)), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("upload and read", () => {
  it("creates a random ID with fixed one-year retention and an independent Delete Key", async () => {
    const created = await create(SAMPLE, { "x-handout-title": encodeURIComponent("My page") });
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.deleteKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.url).toBe(view(created.id));
    expect(created.expiry).toBe("1y");
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(365 * 86_400_000);
    expect(await env.HANDOUTS.head(`y/${created.id}`)).not.toBeNull();
    const res = await SELF.fetch(raw(created.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-handout-title")).toBe("My%20page");
    expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(SAMPLE).byteLength));
    expect(await readText(res)).toBe(SAMPLE);
    expect(res.headers.has("x-handout-meta")).toBe(false);
  });
  it("preserves public bytes, including Unicode and line endings", async () => {
    const bytes = new TextEncoder().encode("\ufeff<title>你好</title>\r\n<p>café 🌿</p>\r\n");
    const created = await create(bytes);
    expect(new Uint8Array(await (await SELF.fetch(raw(created.id))).arrayBuffer())).toEqual(bytes);
  });
  it("reads titles, decodes entities, and bounds optional titles", async () => {
    expect((await create()).title).toBe("Hello & welcome");
    expect((await create("<p>no title</p>")).title).toBe("Untitled");
    expect((await create(SAMPLE, { "x-handout-title": "a".repeat(200) })).title).toHaveLength(120);
  });
  it("keeps private data opaque and never exposes its title or Delete Key", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(212));
    const created = await create(bytes, { "x-handout-visibility": "private", "x-handout-title": "Secret" });
    expect(created.title).toBe("");
    const stored = await env.HANDOUTS.head(objectKey(created.id));
    expect(stored?.customMetadata?.deleteKeyHash).not.toBe(created.deleteKey);
    expect(stored?.customMetadata?.title).toBe("");
    const res = await SELF.fetch(raw(created.id));
    expect(res.headers.get("x-handout-visibility")).toBe("private");
    expect(res.headers.get("x-handout-title")).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
  it("supports HEAD on document bytes", async () => {
    const created = await create();
    const res = await SELF.fetch(raw(created.id), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(created.size));
    expect(await res.text()).toBe("");
  });
  it("does not serve previously read bytes after removal from R2", async () => {
    const created = await create();
    expect(await readText(await SELF.fetch(raw(created.id)))).toBe(SAMPLE);
    await env.HANDOUTS.delete(objectKey(created.id));
    expect((await SELF.fetch(raw(created.id))).status).toBe(404);
  });
  it("does not cache missing objects", async () => {
    const id = "N".repeat(22);
    expect((await SELF.fetch(raw(id))).status).toBe(404);
    await seed(id, new Date(Date.now() + 60000).toISOString());
    expect((await SELF.fetch(raw(id))).status).toBe(200);
  });
});

describe("expiration", () => {
  it("rejects expired public and private objects even before lifecycle cleanup", async () => {
    for (const visibility of ["public", "private"]) {
      const id = (visibility === "public" ? "P" : "Q").repeat(22);
      await seed(id, new Date(Date.now() - 1000).toISOString(), visibility);
      const res = await SELF.fetch(raw(id));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await env.HANDOUTS.head(objectKey(id))).not.toBeNull();
    }
  });
  it("fails closed for an invalid expiry date", async () => {
    const id = "Z".repeat(22);
    await seed(id, "invalid date");
    expect((await SELF.fetch(raw(id))).status).toBe(404);
  });
});

describe("validation", () => {
  it("rejects empty and oversized bodies", async () => {
    expect((await post("")).status).toBe(400);
    expect((await post(new Uint8Array(Number(env.MAX_BODY_BYTES) + 1))).status).toBe(413);
  });
  it("rejects unknown visibility", async () => {
    expect((await post(SAMPLE, { "x-handout-visibility": "secret" })).status).toBe(400);
  });
  it("refuses uploads and deletions without a Turnstile token", async () => {
    const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
    const missing = await post(SAMPLE, { "cf-turnstile-response": "" });
    expect(missing.status).toBe(403);
    expect(await code(missing)).toBe("turnstile_required");
    const created = await create();
    const unverified = await del(created.id, created.deleteKey, "");
    expect(unverified.status).toBe(403);
    expect(await code(unverified)).toBe("turnstile_required");
    expect((await SELF.fetch(raw(created.id))).status).toBe(200);
    expect((await del(created.id, created.deleteKey)).status).toBe(204);
  });
});

describe("Turnstile verification", () => {
  const strict = { TURNSTILE_SECRET: "real-secret", TURNSTILE_HOSTNAMES: "handout.v1tso.com, h.v1tso.com" };
  const answer =
    (body: unknown, status = 200) =>
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(sent.secret).toBe("real-secret");
      expect(sent.response).toBe("tok");
      return new Response(JSON.stringify(body), { status });
    };
  const outcome = (body: unknown, action = "upload", status = 200) =>
    verifyTurnstile(strict, "tok", "203.0.113.5", action, answer(body, status) as typeof fetch);
  it("accepts a passing token for the expected action and hostname", async () => {
    expect(await outcome({ success: true, action: "upload", hostname: "handout.v1tso.com" })).toEqual({ ok: true });
  });
  it("refuses failed, foreign, and misdirected tokens", async () => {
    for (const body of [
      { success: false, "error-codes": ["invalid-input-response"] },
      { success: true, action: "upload", hostname: "elsewhere.example" },
      { success: true, action: "delete", hostname: "handout.v1tso.com" },
      { success: true, hostname: "handout.v1tso.com" },
    ]) {
      const result = await outcome(body);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("turnstile_failed");
    }
  });
  it("fails closed when siteverify is unavailable or unconfigured", async () => {
    const down = await outcome({ success: true }, "upload", 502);
    expect(!down.ok && down.code).toBe("turnstile_unavailable");
    const thrown = await verifyTurnstile(strict, "tok", "203.0.113.5", "upload", (() => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(!thrown.ok && thrown.code).toBe("turnstile_unavailable");
    const unset = await verifyTurnstile({ ...strict, TURNSTILE_HOSTNAMES: "" }, "tok", "203.0.113.5", "upload");
    expect(!unset.ok && unset.code).toBe("turnstile_unavailable");
    const absent = await verifyTurnstile(strict, null, "203.0.113.5", "upload");
    expect(!absent.ok && absent.code).toBe("turnstile_required");
  });
  it("relaxes only action and hostname for Cloudflare's testing secret", async () => {
    const testing = { success: true, hostname: "example.com", metadata: { result_with_testing_key: true } };
    expect(await outcome(testing)).toEqual({ ok: true });
    const failing = { ...testing, success: false };
    expect((await outcome(failing)).ok).toBe(false);
  });
  it("limits uploads per IP", async () => {
    const address = nextIp();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post(SAMPLE, { "cf-connecting-ip": address })).status;
    expect(last).toBe(429);
  });
  it("rejects unsupported methods and malformed IDs", async () => {
    expect((await SELF.fetch(collection)).status).toBe(405);
    expect((await SELF.fetch(view("a".repeat(22)), { method: "POST" })).status).toBe(405);
    expect((await SELF.fetch(view("short"))).status).toBe(404);
    // Earlier 10- and 11-character ID shapes are no longer served.
    for (const id of ["abcdefghij", "dabcdefghij", "wabcdefghij", "yabcdefghij"]) {
      await seed(id, new Date(Date.now() + 60000).toISOString());
      expect((await SELF.fetch(raw(id))).status).toBe(404);
      expect((await del(id, "seed-delete-key")).status).toBe(404);
    }
    expect((await SELF.fetch(raw("way-too-long-id"))).status).toBe(404);
  });
});

describe("deletion", () => {
  it("requires the correct Delete Key and stops all later document reads", async () => {
    for (const visibility of ["public", "private"]) {
      const created = await create(SAMPLE, { "x-handout-visibility": visibility });
      expect((await SELF.fetch(raw(created.id))).status).toBe(200);
      expect((await del(created.id)).status).toBe(401);
      expect((await del(created.id, "x".repeat(43))).status).toBe(403);
      expect((await SELF.fetch(raw(created.id))).status).toBe(200);
      expect((await del(created.id, created.deleteKey)).status).toBe(204);
      expect((await SELF.fetch(raw(created.id))).status).toBe(404);
      expect((await SELF.fetch(raw(created.id), { method: "HEAD" })).status).toBe(404);
      expect((await del(created.id, created.deleteKey)).status).toBe(404);
    }
  });
  it("returns a useful no-store error page for missing document bytes", async () => {
    const res = await SELF.fetch(raw("M".repeat(22)));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain(`http://${env.UPLOAD_HOST}/`);
  });
});
