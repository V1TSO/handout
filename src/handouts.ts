import { randomBase64Url, sha256Hex, timingSafeEqualHex } from "./encoding";

export type Visibility = "public" | "private";
export interface HandoutMeta {
  id: string;
  visibility: Visibility;
  title: string;
  createdAt: string;
  expiresAt: string;
  size: number;
}
export type DeleteResult = "deleted" | "forbidden" | "not_found";
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const TITLE_MAX_LENGTH = 120;

/** Objects live under the prefix that the one-year lifecycle rule selects. */
export function objectKey(id: string): string {
  return `y/${id}`;
}

function metaFromR2(id: string, object: R2Object): HandoutMeta | null {
  const m = object.customMetadata;
  if (!m || (m.visibility !== "public" && m.visibility !== "private")) return null;
  if (!m.createdAt || !m.expiresAt || !Number.isFinite(Date.parse(m.expiresAt))) return null;
  if (Date.parse(m.expiresAt) <= Date.now()) return null;
  return {
    id,
    visibility: m.visibility,
    title: decodeURIComponent(m.title ?? ""),
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    size: object.size,
  };
}

export async function createHandout(
  env: Env,
  input: { body: Uint8Array; visibility: Visibility; title: string },
): Promise<{ meta: HandoutMeta; deleteKey: string }> {
  const deleteKey = randomBase64Url(32);
  const deleteKeyHash = await sha256Hex(deleteKey);
  const now = new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomBase64Url(16);
    const meta: HandoutMeta = {
      id,
      visibility: input.visibility,
      title: input.visibility === "public" ? input.title : "",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      size: input.body.byteLength,
    };
    // Atomic create: even a collision cannot overwrite another handout.
    const object = await env.HANDOUTS.put(objectKey(id), input.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        v: "2",
        visibility: meta.visibility,
        title: encodeURIComponent(meta.title),
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        deleteKeyHash,
      },
    });
    if (object) return { meta, deleteKey };
  }
  throw new Error("Could not allocate a handout ID");
}

/** One R2 read supplies the bytes and metadata. No document caches. */
export async function readHandout(
  env: Env,
  id: string,
): Promise<{ meta: HandoutMeta; body: ReadableStream<Uint8Array> } | null> {
  const object = await env.HANDOUTS.get(objectKey(id));
  if (!object) return null;
  const meta = metaFromR2(id, object);
  if (!meta) {
    await object.body.cancel();
    return null;
  }
  return { meta, body: object.body };
}

export async function deleteHandout(env: Env, id: string, deleteKey: string): Promise<DeleteResult> {
  const head = await env.HANDOUTS.head(objectKey(id));
  if (!head) return "not_found";
  const storedHash = head.customMetadata?.deleteKeyHash ?? "";
  if (!timingSafeEqualHex(await sha256Hex(deleteKey), storedHash)) return "forbidden";
  await env.HANDOUTS.delete(objectKey(id));
  return "deleted";
}
