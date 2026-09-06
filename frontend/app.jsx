import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, Check, ArrowUpRight, FileUp, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  MAX_BYTES,
  enc,
  fmtBytes,
  fmtDate,
  titleFromHtml,
  encrypt,
  loadMine,
  saveMine,
} from "@/lib/handouts";

const SITEKEY = document.querySelector('meta[name="turnstile-sitekey"]')?.content ?? "";
const TURNSTILE_HEADER = "cf-turnstile-response";
const CHECK_FAILED = "The browser check failed. Reload the page and try again.";

function turnstileReady() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.turnstile) {
        clearInterval(timer);
        resolve(window.turnstile);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        reject(new Error("The browser check could not load. Check your connection and reload."));
      }
    }, 50);
  });
}

/**
 * One Turnstile widget per protected surface. `attach` goes on the widget's container, so a
 * container inside a dialog renders when the dialog opens and is removed when it closes.
 * `getToken` resolves with the single-use token; call `reset` after every request.
 */
function useTurnstile(action) {
  const widget = useRef(null);
  const pending = useRef({ token: null, waiters: [] });
  const [failed, setFailed] = useState("");
  const settle = (token, error) => {
    pending.current.token = token;
    for (const waiter of pending.current.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve(token);
  };
  const attach = useCallback(
    (node) => {
      if (!node) {
        if (widget.current) window.turnstile?.remove(widget.current);
        widget.current = null;
        pending.current.token = null;
        return;
      }
      turnstileReady()
        .then((turnstile) => {
          if (!node.isConnected || widget.current) return;
          widget.current = turnstile.render(node, {
            sitekey: SITEKEY,
            action,
            size: matchMedia("(max-width: 380px)").matches ? "compact" : "flexible",
            callback: (token) => {
              setFailed("");
              settle(token);
            },
            "expired-callback": () => (pending.current.token = null),
            "error-callback": () => {
              setFailed(CHECK_FAILED);
              settle(null, new Error(CHECK_FAILED));
              return true;
            },
          });
        })
        .catch((error) => {
          setFailed(error.message);
          settle(null, error);
        });
    },
    [action],
  );
  const getToken = () =>
    pending.current.token
      ? Promise.resolve(pending.current.token)
      : new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          pending.current.waiters.push(waiter);
          setTimeout(() => {
            const index = pending.current.waiters.indexOf(waiter);
            if (index >= 0) {
              pending.current.waiters.splice(index, 1);
              reject(new Error("The browser check is taking too long. Try again."));
            }
          }, 20000);
        });
  const reset = () => {
    pending.current.token = null;
    if (widget.current) window.turnstile?.reset(widget.current);
  };
  return { attach, getToken, reset, failed };
}

function CopyButton({ value, label = "Copy", description = label, primary = false, ...props }) {
  const [state, setState] = useState("");
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy(event) {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(value);
      setState("Copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState(""), 1500);
    } catch {
      setState("Select and copy");
      const code = button.parentElement.querySelector("code");
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      className={primary ? "" : "ghost"}
      aria-label={description}
      onClick={copy}
      {...props}
    >
      {state === "Copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {state || label}
    </Button>
  );
}
function Field({ label, value, note, primary = false }) {
  return (
    <div className={`field ${primary ? "result-link" : ""}`}>
      <div className="k">{label}</div>
      <div className="v">
        <code>{value}</code>
        <CopyButton
          value={value}
          primary={primary}
          label={primary ? "Copy link" : "Copy"}
          description={primary ? "Copy share link" : `Copy ${label}`}
        />
      </div>
      {note ? <p className="note">{note}</p> : null}
    </div>
  );
}
function UploadResult({ data }) {
  const heading = useRef(null);
  useEffect(() => {
    heading.current.focus({ preventScroll: true });
    // Instant: a smooth scroll here moves the Copy button under a tap that is already on its way.
    heading.current.closest("section").scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [data]);
  const isPrivate = data.visibility === "private";
  return (
    <section id="result" className="card" aria-live="polite" aria-label="Upload result">
      <div className="result-heading">
        <span className="success-mark" aria-hidden="true">
          ✓
        </span>
        <h2 ref={heading} tabIndex={-1}>
          Your link is ready.
        </h2>
      </div>
      <Field
        label={isPrivate ? "Protected link" : "Link"}
        value={data.link}
        primary
        note={isPrivate ? "Includes the key after #key=. Treat the whole link as a secret." : undefined}
      />
      <details>
        <summary>Save your Delete Key</summary>
        <Field
          label="Delete Key"
          value={data.deleteKey}
          note="Keep this key to delete from any device. It is separate from the private Access Key."
        />
      </details>
      {isPrivate ? (
        <details>
          <summary>Advanced: send link and key separately</summary>
          <Field label="Bare link" value={data.url} note="Requires the Access Key to open." />
          <Field
            label="Access key"
            value={data.accessKey}
            note="Never sent to the server. Nobody can recover it."
          />
        </details>
      ) : null}
      <p className="note">
        Expires {fmtDate(data.expiresAt)}. Save your Delete Key before leaving this page.
      </p>
      <div className="result-actions">
        <Button asChild variant="outline" className="ghost">
          <a href={data.link} target="_blank" rel="noopener">
            Open handout <ArrowUpRight aria-hidden="true" />
          </a>
        </Button>
      </div>
    </section>
  );
}
function App() {
  const [mode, setMode] = useState("file");
  const [html, setHtml] = useState("");
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [file, setFile] = useState(null);
  const [invalid, setInvalid] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: "", ok: false });
  const [result, setResult] = useState(null);
  const [mine, setMine] = useState(() => loadMine().filter((h) => Date.parse(h.expiresAt) > Date.now()));
  const [deleteOpen, setDeleteOpen] = useState(() => location.hash === "#delete-handout");
  const [deleteStatus, setDeleteStatus] = useState({ text: "", ok: false });
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteReturnFocus = useRef(null);
  const uploadCheck = useTurnstile("upload");
  const deleteCheck = useTurnstile("delete");
  const htmlRef = useRef(null),
    fileRef = useRef(null),
    deleteKeyRef = useRef(null),
    readVersion = useRef(0);
  const byteLength = enc.encode(html).byteLength;
  const notify = (text, ok = false) => setStatus({ text, ok });
  useEffect(() => {
    const onHash = () => {
      if (location.hash === "#delete-handout") setDeleteOpen(true);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  async function loadFile(next) {
    if (!next || busy) return;
    const version = ++readVersion.current;
    if (!/\.html?$/i.test(next.name) && next.type !== "text/html")
      return notify("Choose an .html or .htm file. Other file types are not supported.");
    if (next.size > MAX_BYTES) return notify(`"${next.name}" is ${fmtBytes(next.size)}. The limit is 25 MB.`);
    try {
      const text = await next.text();
      if (version !== readVersion.current) return;
      setHtml(text);
      setFile({ name: next.name, size: next.size });
      setMode("file");
      setInvalid(false);
      notify(`Loaded ${next.name}.`, true);
    } catch {
      notify("Could not read this file. Try choosing it again.");
    }
  }
  function drop(event) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length !== 1) return notify("Choose one HTML file at a time.");
    void loadFile(event.dataTransfer.files[0]);
  }
  const dropEvents = {
    onDragOver: (event) => {
      if (event.dataTransfer.types.includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: () => setDragging(false),
    onDrop: drop,
  };
  async function share(event) {
    event.preventDefault();
    if (busy) return;
    if (!html.trim()) {
      if (mode === "file") {
        fileRef.current.focus();
        return notify("Choose an HTML file or drop one in the upload area first.");
      }
      htmlRef.current.focus();
      setInvalid(true);
      return notify("Paste your HTML to create a link.");
    }
    if (byteLength > MAX_BYTES) return notify(`Too large: ${fmtBytes(byteLength)}. The limit is 25 MB.`);
    const documentTitle = (title.trim() || titleFromHtml(html) || "Untitled").slice(0, 120);
    setBusy(true);
    notify("Checking your browser…");
    try {
      const token = await uploadCheck.getToken();
      notify(visibility === "private" ? "Encrypting…" : "Uploading…");
      let body = enc.encode(html),
        accessKey = null;
      const headers = {
        "x-handout-visibility": visibility,
        "content-type": "text/html; charset=utf-8",
        [TURNSTILE_HEADER]: token,
      };
      if (visibility === "private") {
        ({ blob: body, accessKey } = await encrypt(documentTitle, html));
        headers["content-type"] = "application/octet-stream";
      } else headers["x-handout-title"] = encodeURIComponent(documentTitle);
      const response = await fetch("/api/handouts", { method: "POST", body, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`);
      const link = visibility === "private" ? `${data.url}#key=${accessKey}` : data.url;
      setResult({ ...data, link, accessKey });
      const items = [
        {
          id: data.id,
          url: link,
          title: documentTitle,
          visibility,
          deleteKey: data.deleteKey,
          createdAt: data.createdAt,
          expiresAt: data.expiresAt,
        },
        ...loadMine().filter((h) => Date.parse(h.expiresAt) > Date.now()),
      ].slice(0, 200);
      const saved = saveMine(items);
      setMine(items);
      notify(
        saved
          ? "Ready to pass along. Your link and keys are saved in this browser."
          : "Uploaded. Browser storage is unavailable: copy your link and Delete Key before leaving.",
        saved,
      );
    } catch (error) {
      notify(error.message || String(error));
    } finally {
      uploadCheck.reset();
      setBusy(false);
    }
  }
  function requestDelete(event) {
    event.preventDefault();
    deleteReturnFocus.current = event.currentTarget.querySelector("button");
    const values = new FormData(event.currentTarget);
    try {
      const url = new URL(values.get("link").trim());
      const id = url.pathname.replace(/^\/|\/$/g, "");
      if (!/^https?:$/.test(url.protocol) || !/^[A-Za-z0-9_-]{22}$/.test(id))
        throw new Error("Enter a complete handout link.");
      const key = values.get("key").trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(key))
        throw new Error("Enter the 43-character Delete Key from your upload.");
      setDeleteError("");
      setPendingDelete({ id, deleteKey: key, fromForm: true });
    } catch (error) {
      setDeleteStatus({
        text: error instanceof TypeError ? "Enter a complete handout link." : error.message,
        ok: false,
      });
    }
  }
  async function confirmDelete() {
    if (deleting || !pendingDelete) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const token = await deleteCheck.getToken();
      const response = await fetch(`/api/handouts/${pendingDelete.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${pendingDelete.deleteKey}`, [TURNSTILE_HEADER]: token },
      });
      if (response.status !== 204 && response.status !== 404) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Could not delete (${response.status}). Try again.`);
      }
      const items = loadMine().filter(
        (h) => h.id !== pendingDelete.id && Date.parse(h.expiresAt) > Date.now(),
      );
      saveMine(items);
      setMine((current) => current.filter((h) => h.id !== pendingDelete.id));
      const text =
        response.status === 204
          ? "Deleted. New requests can no longer load this handout. Downloaded copies remain."
          : "This handout is already gone.";
      if (pendingDelete.fromForm) {
        setDeleteStatus({ text, ok: true });
        deleteKeyRef.current.value = "";
      } else notify(text, true);
      setResult((current) => (current?.id === pendingDelete.id ? null : current));
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error.message || "Could not delete. Try again.");
    } finally {
      deleteCheck.reset();
      setDeleting(false);
    }
  }
  return (
    <>
      <main
        className="site"
        onPaste={(event) => {
          const next = event.clipboardData.files[0];
          if (next) {
            event.preventDefault();
            void loadFile(next);
          }
        }}
      >
        <header className="topbar flex items-center justify-between gap-5">
          <a className="brand" href="/" aria-label="Handout home">
            <img src="/logo.png" alt="" width="400" height="149" />
          </a>
          <nav aria-label="Main">
            <a href="#delete-handout">Delete a handout</a>
            <a href="/SKILL.md">For agents</a>
            <a href="https://github.com/V1TSO/handout">Source ↗</a>
          </nav>
        </header>
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">A simple home for your HTML</p>
          <h1 id="page-title">Made something? Pass it along.</h1>
          <p className="lede">Drop a file or paste your code. Get a link in seconds.</p>
        </section>
        <div className="workspace">
          <div className="content">
            <form id="form" className="panel" noValidate onSubmit={share} aria-busy={busy}>
              <div className="compose grid gap-7 md:grid-cols-[minmax(0,1fr)_330px]">
                <div className="editor-column">
                  <div className="form-heading mb-4 flex items-center justify-between gap-3">
                    <h2>Your document</h2>
                    <Badge variant="outline" className="pill">
                      HTML · up to 25 MB
                    </Badge>
                  </div>
                  <Tabs value={mode} onValueChange={setMode}>
                    <TabsList className="input-tabs" aria-label="Document input">
                      <TabsTrigger value="file" id="file-tab" aria-controls="file-panel">
                        Upload HTML
                      </TabsTrigger>
                      <TabsTrigger value="paste" id="paste-tab" aria-controls="paste-panel">
                        Paste HTML
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent
                      value="file"
                      id="file-panel"
                      aria-labelledby="file-tab"
                      forceMount
                      hidden={mode !== "file"}
                    >
                      <label
                        className={`drop-zone ${dragging ? "over" : ""}`}
                        data-loaded={!!file}
                        htmlFor="file"
                        {...dropEvents}
                      >
                        <span className="upload-symbol" aria-hidden="true">
                          <FileUp size={30} strokeWidth={1.5} />
                        </span>
                        <strong id="file-name">{file?.name || "Drop it here. Share it anywhere."}</strong>
                        <span id="file-description">
                          {file
                            ? `${fmtBytes(file.size)} · Ready to share`
                            : "A single .html file, with your styles and scripts included."}
                        </span>
                        <span className="file-pick">{file ? "Change file" : "Choose HTML file"}</span>
                        <input
                          ref={fileRef}
                          id="file"
                          type="file"
                          accept=".html,.htm,text/html"
                          disabled={busy}
                          onChange={(event) => void loadFile(event.target.files[0])}
                        />
                      </label>
                    </TabsContent>
                    <TabsContent
                      value="paste"
                      id="paste-panel"
                      aria-labelledby="paste-tab"
                      forceMount
                      hidden={mode !== "paste"}
                    >
                      <label htmlFor="html" className="sr-only">
                        HTML code
                      </label>
                      <Textarea
                        ref={htmlRef}
                        id="html"
                        aria-describedby="html-help size"
                        aria-invalid={invalid || undefined}
                        spellCheck={false}
                        value={html}
                        disabled={busy}
                        onChange={(event) => {
                          ++readVersion.current;
                          setHtml(event.target.value);
                          setInvalid(false);
                        }}
                        placeholder={
                          "<!doctype html>\n<html>\n  <head>\n    <title>Something worth sharing</title>\n  </head>\n  <body>…</body>\n</html>"
                        }
                        {...dropEvents}
                      />
                    </TabsContent>
                  </Tabs>
                  <div className="size-row">
                    <span id="html-help">Include styles and scripts in one HTML file.</span>
                    <span id="size" className={byteLength > MAX_BYTES ? "text-destructive" : ""}>
                      {fmtBytes(byteLength)} / 25 MB
                    </span>
                  </div>
                  <div className="title-row">
                    <label htmlFor="title">
                      Document title <span className="optional">optional</span>
                    </label>
                    <Input
                      id="title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      disabled={busy}
                      type="text"
                      maxLength="120"
                      autoComplete="off"
                      placeholder={titleFromHtml(html) || "We’ll use the title in your HTML"}
                    />
                  </div>
                </div>
                <div className="share-column">
                  <fieldset>
                    <legend>Sharing settings</legend>
                    <div className="choices">
                      <label className="choice">
                        <input
                          type="radio"
                          name="visibility"
                          value="public"
                          checked={visibility === "public"}
                          onChange={() => setVisibility("public")}
                          disabled={busy}
                        />
                        <strong>Public link</strong>
                        <span>Anyone with the link can view and download.</span>
                      </label>
                      <label className="choice">
                        <input
                          type="radio"
                          name="visibility"
                          value="private"
                          checked={visibility === "private"}
                          onChange={() => setVisibility("private")}
                          disabled={busy}
                        />
                        <strong>Private link</strong>
                        <span>Encrypted in your browser. The full link includes the key.</span>
                      </label>
                    </div>
                  </fieldset>
                  <div className="retention">
                    <span className="retention-icon" aria-hidden="true">
                      ◷
                    </span>
                    <div>
                      <strong>One year to share</strong>
                      <span>Delete anytime with your Delete Key.</span>
                    </div>
                  </div>
                  <div className="actions">
                    <div className="turnstile" ref={uploadCheck.attach} />
                    {uploadCheck.failed ? (
                      <p className="status" role="alert">
                        {uploadCheck.failed}
                      </p>
                    ) : null}
                    <Button id="share" type="submit" disabled={busy}>
                      {busy ? (
                        <>
                          <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
                          Creating link…
                        </>
                      ) : (
                        <>
                          Create share link <ArrowUpRight aria-hidden="true" />
                        </>
                      )}
                    </Button>
                    <p className="note">No account. No setup. Just a link.</p>
                  </div>
                  <p id="status" className={`status ${status.ok ? "ok" : ""}`} role="status">
                    {status.text}
                  </p>
                </div>
              </div>
            </form>
            {result ? <UploadResult data={result} /> : null}
            <section id="mine-section" className="library" aria-labelledby="mine-heading">
              <div className="library-heading mb-4 flex items-center justify-between gap-4">
                <h2 id="mine-heading" tabIndex={-1}>
                  Your handouts <span id="mine-count">{mine.length}</span>
                </h2>
                <span>Saved in this browser</span>
              </div>
              <div id="mine-empty" className="empty-state" hidden={mine.length !== 0}>
                <span className="empty-icon" aria-hidden="true">
                  ↗
                </span>
                <div>
                  <strong>Your next idea goes here.</strong>
                  <p>Links you create will appear here, ready to open, copy, or delete.</p>
                </div>
              </div>
              <ul id="mine" className="mine">
                {mine.map((item) => (
                  <li key={item.id}>
                    <a href={item.url} target="_blank" rel="noopener">
                      {item.title || "Untitled"}
                    </a>
                    <span className="meta">
                      {item.visibility === "private" ? "Private" : "Public"} · Expires{" "}
                      {fmtDate(item.expiresAt)}
                    </span>
                    <div className="item-actions">
                      <CopyButton
                        value={item.url}
                        label="Copy link"
                        description={`Copy link for ${item.title || "Untitled"}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="ghost danger del"
                        aria-label={`Delete ${item.title || "Untitled"}`}
                        onClick={(event) => {
                          deleteReturnFocus.current = event.currentTarget;
                          setDeleteError("");
                          setPendingDelete(item);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <details
              id="delete-handout"
              className="manage"
              open={deleteOpen}
              onToggle={(event) => setDeleteOpen(event.currentTarget.open)}
            >
              <summary>Delete a handout</summary>
              <form id="delete-form" onSubmit={requestDelete}>
                <h2>Have your Delete Key?</h2>
                <p>Use it here from any device. The Access Key for a private handout cannot delete it.</p>
                <label htmlFor="delete-link">Handout link</label>
                <Input
                  id="delete-link"
                  name="link"
                  type="url"
                  required
                  placeholder="https://h.v1tso.com/…"
                  autoComplete="off"
                />
                <label htmlFor="delete-key">Delete Key</label>
                <Input
                  id="delete-key"
                  name="key"
                  ref={deleteKeyRef}
                  type="password"
                  required
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="Paste the Delete Key from your upload"
                />
                <Button type="submit" variant="outline" className="ghost danger">
                  Delete handout
                </Button>
                <p id="delete-status" className={`status ${deleteStatus.ok ? "ok" : ""}`} role="status">
                  {deleteStatus.text}
                </p>
              </form>
            </details>
          </div>
        </div>
        <footer className="footer">
          <span>A little page, passed along.</span>
          <span>Public or private. Always yours to share.</span>
        </footer>
      </main>
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            // Keep the safe choice focused; the Turnstile frame would otherwise take it.
            event.preventDefault();
            document.querySelector('[data-slot="alert-dialog-cancel"]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = deleteReturnFocus.current;
            if (target?.isConnected) target.focus();
            else document.querySelector("#mine-heading")?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this handout?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.title
                ? `“${pendingDelete.title}” will no longer open from its link. `
                : "The link will no longer open this handout. "}
              This cannot be undone. Downloaded copies remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="turnstile" ref={deleteCheck.attach} />
          {deleteError || deleteCheck.failed ? (
            <p className="status" role="alert">
              {deleteError || deleteCheck.failed}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep handout</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting} onClick={confirmDelete}>
              {deleting ? "Deleting…" : "Delete permanently"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
