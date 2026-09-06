const MAX_BYTES = 25 * 1024 * 1024;
const STORE_KEY = "handout.mine";
const enc = new TextEncoder();
const b64u = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 65536));
  return m
    ? m[1]
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
    : "";
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Blob layout: IV (12 bytes) || AES-256-GCM( gzip( JSON {t: title, h: html} ) ).
// Compressing first matters: ciphertext is random bytes and cannot be compressed in transit.
async function encrypt(title, html) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await gzip(enc.encode(JSON.stringify({ t: title, h: html })));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const blob = new Uint8Array(12 + ct.length);
  blob.set(iv, 0);
  blob.set(ct, 12);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return { blob, accessKey: b64u(raw) };
}

function loadMine() {
  try {
    const items = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(items)
      ? items.filter(
          (h) =>
            h &&
            typeof h.id === "string" &&
            typeof h.url === "string" &&
            /^https?:\/\//.test(h.url) &&
            typeof h.deleteKey === "string",
        )
      : [];
  } catch {
    return [];
  }
}
function saveMine(items) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export { MAX_BYTES, enc, fmtBytes, fmtDate, titleFromHtml, encrypt, loadMine, saveMine };
