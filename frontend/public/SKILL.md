---
name: handout
description: Share one self-contained HTML document as a link through handout.v1tso.com, public or end-to-end encrypted, with no account. Use when asked to share, publish, or hand out an HTML page, demo, report, or prototype as a link, or to delete a handout created earlier. Needs a browser: every upload and deletion passes a Cloudflare Turnstile check.
---

# Handout

One HTML document per handout. Every link lasts one year. No account. Two operations: create and delete.

Upload page: `https://handout.v1tso.com`. Links open on `https://h.v1tso.com/ID` in a viewer with a title bar and a **Download HTML** button. The document runs in a sandboxed frame: its scripts execute, but it cannot reach the viewer page or other origins' cookies.

## Browser required

Every upload and deletion needs a Cloudflare Turnstile token, a single-use value the widget on the upload page produces after checking the browser. Plain HTTP clients cannot obtain one. Use one of these routes:

1. **Drive the page.** With browser automation, open the upload page, choose Upload HTML or Paste HTML, provide the document, pick Public or Private, and click **Create share link**. The page waits for the check and then shows the link and the Delete Key. Read both from the result card.
2. **Hand the task to the user.** Give the user the complete HTML file and the upload page address, and ask for the link and Delete Key back.

Before uploading, make sure the file is complete on its own: styles and scripts inline or loaded from absolute URLs. The viewer serves exactly the bytes you send.

## Page flow

- **Upload HTML** accepts one `.html` file by picker or drop. **Paste HTML** accepts the source text. Either way the size limit is 25 MiB.
- **Document title** is optional. Without it the page uses the document's `<title>`, then `Untitled`.
- **Public link** is readable by anyone who has it. **Private link** encrypts in the browser; the whole link, including `#key=`, is the secret, and the bare link without the fragment opens a key prompt.
- The result card shows the link, and under **Save your Delete Key**, the 43-character Delete Key. It is shown once and is the only way to delete from another device.
- **Delete a handout** at the bottom of the page takes a link and a Delete Key. Deleting from the saved list or the form opens a confirmation dialog that runs its own browser check.

## HTTP API, for completeness

The page talks to this API. Every call must carry a fresh Turnstile token in the `cf-turnstile-response` header, produced by a widget on `handout.v1tso.com` for the matching action, so the calls only work from that page.

```sh
POST https://handout.v1tso.com/api/handouts        # body: raw HTML; action "upload"
  content-type: text/html; charset=utf-8
  x-handout-title: My%20page                        # optional, percent-encoded, 120 chars max
  x-handout-visibility: public | private            # private bodies are the encrypted format below
  cf-turnstile-response: TOKEN

DELETE https://handout.v1tso.com/api/handouts/ID    # action "delete"
  authorization: Bearer DELETE_KEY
  cf-turnstile-response: TOKEN
```

Create returns `201` with `id`, `url`, `visibility`, `title`, `deleteKey`, `expiry`, `createdAt`, `expiresAt`, and `size`. Delete returns `204`. Errors are JSON `{ "error": "message", "code": "..." }`; the Turnstile codes are `turnstile_required`, `turnstile_failed`, and `turnstile_unavailable`. Other statuses: `401` no Delete Key, `403` wrong key, `404` gone or expired, `413` too large, `429` rate limited with `retry-after`.

Private bodies are `IV (12 bytes) || AES-256-GCM( gzip( UTF-8 JSON {"t": title, "h": html} ) )` with a random 32-byte key, shared as `#key=` in base64url without padding. The page does this itself; you only need it to read a private handout's format.

## Report to the user

After a successful upload, report three things: the link (complete with fragment for a private handout), the Delete Key, and the expiry date. Say that the Delete Key cannot be recovered later.
