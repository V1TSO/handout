# Handout

Share one HTML document through a link. No accounts.

- Public handouts are readable by anyone with the link.
- Private handouts are encrypted in the browser. Their Access Key stays in the link fragment and is never sent to the service.
- Every new handout lasts one year and gets a separate Delete Key. Save it to delete from any device.
- Both modes use a viewer with a title and **Download HTML**. Private downloads are decrypted locally. Downloads contain the original HTML, without the viewer.

One TypeScript Worker, one R2 bucket, and a React upload page built with Vite, Tailwind CSS, and shadcn/ui. Build tools run locally and in CI; the Worker has no runtime dependencies or document caches. The interface uses a risograph print look: paper surfaces, one dark ink for text and rules, a fluorescent-pink second ink for accents and offset blocks, and visible keyboard focus. The upload host sends a Content Security Policy with a per-response nonce. The zone keeps Cloudflare JavaScript Detections and Web Analytics on; Cloudflare copies that nonce onto the scripts it injects. The external script sources are the analytics beacon and Turnstile, which also gets a frame source.

## Use

**Upload HTML** is first and selected by default. Choose a file, drop it into the upload area, or switch to **Paste HTML**. Then select Public or Private, and click **Create share link**. Copy the share link and save the Delete Key from the result. The browser also keeps a local list of links and keys when local storage is available; it does not sync between devices.

The upload result has a primary **Copy link** action. Saved handouts also have a **Copy link** button. The input tabs support arrow-key navigation, and empty uploads focus the active input with an error message.

Deletion uses an accessible confirmation dialog. Cancel keeps the document; a failed request keeps the dialog open for retry.

To delete elsewhere, open **Delete a handout** on the upload page and enter the handout link and Delete Key. An Access Key cannot delete a handout.

Deleting removes the R2 object. Expired objects are refused on reads even before storage cleanup runs. Document responses use `Cache-Control: no-store`; new requests cannot retrieve deleted or expired content. Copies already downloaded or loaded into an open viewer cannot be withdrawn.

## Hostnames and routes

| Host / route | Purpose |
| --- | --- |
| `handout.v1tso.com/` | Upload page, local list, and deletion form |
| `POST handout.v1tso.com/api/handouts` | Create a handout |
| `DELETE handout.v1tso.com/api/handouts/:id` | Delete using its Delete Key |
| `h.v1tso.com/:id` | Generic viewer, with no document data embedded |
| `h.v1tso.com/:id/raw` | Document bytes and public metadata, read once from R2 |

The document fills the viewport and the viewer toolbar overlays it, hidden by default. It slides in when the reader scrolls up, wheels or swipes toward the top, moves the pointer to the top edge, or tabs into a toolbar control, and slides away after a few seconds or on the next scroll down. A small helper appended to the sandboxed render copy reports those gestures over a private channel; the parent accepts only messages from the current frame on that channel, and download bytes remain unchanged. A document whose own script policy blocks the helper keeps the toolbar pinned in view. **Hide toolbar** dismisses it at once.

The viewer requires JavaScript in both modes. A syntactically valid view URL returns the generic viewer even for a missing document; its `/raw` request returns 404 and the viewer shows the error. Raw responses use `application/octet-stream`, attachment disposition, and `nosniff`. Public documents are gzip-compressed in flight for clients that accept it; private bodies are ciphertext and travel as stored. The viewer page carries a preload hint for its `/raw` request, and the viewer shows download progress with the size from `x-handout-size`. The viewer displays the HTML in an iframe with an opaque sandbox origin. The upload host is separate from the view host.

## API

Every upload and deletion needs a Cloudflare Turnstile token in the `cf-turnstile-response` header. The widget on the upload page produces it, so the API only works from that page; plain `curl` calls receive 403 with `code: "turnstile_required"`. Agents can read `https://handout.v1tso.com/SKILL.md`, an Agent Skills file served from `frontend/public/` that explains how to drive the page.

```sh
curl https://handout.v1tso.com/api/handouts \
  -H 'content-type: text/html' \
  -H 'x-handout-title: My%20page' \
  --data-binary @index.html
```

Optional headers: `x-handout-visibility` (`public` or `private`) and `x-handout-title` (percent-encoded, public only). Public titles fall back to the document's `<title>`, then `Untitled`.

A 201 response contains `id`, `url`, `visibility`, `title`, `deleteKey`, `expiry` (`1y`), `createdAt`, `expiresAt`, and `size`. IDs contain 22 random base64url characters. Delete Keys contain 43 base64url characters; only their SHA-256 hashes are stored in R2.

```sh
curl -X DELETE https://handout.v1tso.com/api/handouts/ID \
  -H 'authorization: Bearer DELETE_KEY'
```

Delete responses: 204 deleted, 401 missing key, 403 wrong key, 404 missing object, 429 rate limited. Limits: 25 MiB per uploaded body; 10 uploads and 10 deletes per minute per IP. The browser also limits cleartext HTML to 25 MiB. For private uploads, compression and encryption overhead can affect the uploaded body size.

### Private uploads from a script

Use `x-handout-visibility: private`, `content-type: application/octet-stream`, and this binary format:

```
IV (12 bytes) || AES-256-GCM( gzip( UTF-8 JSON {"t": "title", "h": "html"} ) )
```

The Access Key is 32 random bytes, base64url without padding. Share `https://h.v1tso.com/ID#key=ACCESS_KEY`. The viewer retains the fragment so reload and copying the address work. The whole link is a secret. Decompression is bounded, and the viewer rejects decoded HTML over 25 MiB.

## Development and validation

```sh
pnpm install
pnpm dev       # Upload: http://localhost:8787; view: http://127.0.0.1:8787/ID
pnpm build     # Compile frontend/ into dist/
pnpm check     # Generate types, typecheck, build, integration tests
pnpm exec playwright install chromium
pnpm test:browser # Desktop and mobile browser tests
pnpm exec wrangler deploy --env="" --dry-run
```

Wrangler runs the Vite build and watches the frontend during development. The build creates assets with content-based filenames. Edit `frontend/`; `dist/` is generated and ignored by Git. The upload page uses local shadcn/ui components in `frontend/components/ui/`, with Handout's print styling. React owns the form, upload result, local list, and deletion dialog. Encryption and storage helpers live in `frontend/lib/handouts.js`. The viewer keeps its separate JavaScript entry and does not load React.

To add a component, run `npx shadcn@latest add COMPONENT`. Configuration is in `components.json`; check generated imports against the local `@/lib/utils` helper. Review generated styles so they keep the existing contrast and mobile layout.

Browser tests start their own Worker on port 8789 with separate local R2 state. To use an installed Chrome browser, run `PLAYWRIGHT_CHANNEL=chrome pnpm test:browser`. CI runs both integration and browser tests.

The dev environment omits custom-domain routes so Wrangler passes through the two local hostnames. Keep one dev process for the shared local R2 state.

## Deployment and existing data

Pushes to `main` deploy through Workers Builds, which runs `npx wrangler deploy` from the connected GitHub repository; the local check command never deploys. For a new installation, create the bucket and its lifecycle rule before deploying:

```sh
pnpm exec wrangler r2 bucket create handout --location enam
pnpm exec wrangler r2 bucket lifecycle add handout expire-1y y/ --expire-days 365
pnpm exec wrangler deploy --env=""
```

Then create a Turnstile widget for the upload hostname, put its sitekey in `TURNSTILE_SITEKEY` in `wrangler.jsonc`, keep `TURNSTILE_HOSTNAMES` at the upload hostname, and store the secret with `pnpm exec wrangler secret put TURNSTILE_SECRET`. The `dev` environment uses Cloudflare's public testing keys, so local development and both test suites pass the check without a real widget.

For this account, the bucket and the `y/` one-year rule already exist (checked 2026-09-04). Reuse them. Objects are stored as `y/<id>`; the public ID does not encode expiration. Only this format is served. There is no compatibility path for earlier ID shapes, object keys, or the original unzipped private format.
