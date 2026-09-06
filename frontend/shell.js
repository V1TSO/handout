"use strict";
(() => {
  const MAX_HTML_BYTES = 25 * 1024 * 1024;
  const id = location.pathname.slice(1).split("/")[0];
  const gate = document.getElementById("gate");
  const form = document.getElementById("unlock-form");
  const msg = document.getElementById("msg");
  const ask = document.getElementById("ask");
  const keyInput = document.getElementById("key");
  const button = document.getElementById("unlock");
  let documentUrl;
  let renderUrl;
  let encryptedBytes;
  let opened = false;

  const fromB64u = (s) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(s)) throw new Error("Enter a valid 43-character Access Key.");
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  };

  // Bound both network bytes and expanded JSON before allocating the complete buffer.
  async function readLimited(stream, limit, onProgress) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("This handout exceeds the size limit.");
        chunks.push(value);
        onProgress?.(size);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }

  function show(bytes, title) {
    if (opened) return;
    opened = true;
    const name = title || "Untitled";
    document.title = name;
    document.getElementById("viewer-title").textContent = name;
    documentUrl = URL.createObjectURL(new Blob([bytes], { type: "text/html;charset=utf-8" }));
    const frame = document.createElement("iframe");
    frame.className = "viewer-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");
    frame.setAttribute("title", name);
    // The document fills the viewport and the toolbar overlays it, hidden until the reader asks:
    // scrolling up, a wheel or swipe toward the top, the pointer at the top edge, or keyboard
    // focus on a toolbar control. A small helper appended to the render copy reports those
    // gestures over a private channel; the sandbox remains opaque and the download bytes are the
    // original. A document whose own script policy blocks the helper never reports, so the
    // toolbar stays pinned in view there.
    const channel = crypto.randomUUID();
    const helper = (origin, channel) => {
      const post = (type, top) => parent.postMessage({ type, channel, top }, origin);
      let pending = false;
      addEventListener(
        "scroll",
        (event) => {
          const top = event.target === document ? scrollY : event.target.scrollTop;
          if (!Number.isFinite(top) || pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            post("handout:scroll", top);
          });
        },
        { capture: true, passive: true },
      );
      addEventListener("wheel", (event) => event.deltaY < 0 && post("handout:reveal"), { passive: true });
      let touchY = 0;
      addEventListener("touchstart", (event) => (touchY = event.touches[0].clientY), { passive: true });
      addEventListener(
        "touchmove",
        (event) => {
          const y = event.touches[0].clientY;
          if (y - touchY > 12) post("handout:reveal");
          touchY = y;
        },
        { passive: true },
      );
      addEventListener("mousemove", (event) => event.clientY < 8 && post("handout:reveal"), { passive: true });
      post("handout:ready");
    };
    const bridge = `<script>(${helper.toString()})(${JSON.stringify(location.origin)},${JSON.stringify(channel)});<\/script>`;
    renderUrl = URL.createObjectURL(new Blob([bytes, bridge], { type: "text/html;charset=utf-8" }));
    const bar = document.querySelector(".viewer-bar");
    let hideTimer;
    let lastTop = 0;
    let helperReady = false;
    // Only visible keyboard focus keeps the toolbar open; a pointer click on Download leaves focus on the
    // link without a focus ring, and that must not block hiding on the next scroll.
    const keyboardFocusInside = () => bar.querySelector(":focus-visible") !== null;
    const barBusy = () => bar.matches(":hover") || keyboardFocusInside();
    const reveal = () => {
      bar.classList.add("shown");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => barBusy() || bar.classList.remove("shown"), 3000);
    };
    const conceal = () => {
      clearTimeout(hideTimer);
      if (!bar.classList.contains("pinned") && !keyboardFocusInside()) bar.classList.remove("shown");
    };
    addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.data?.channel !== channel) return;
      const { type, top } = event.data;
      if (type === "handout:ready") helperReady = true;
      else if (type === "handout:reveal") reveal();
      else if (type === "handout:scroll" && Number.isFinite(top)) {
        if (top < lastTop - 4) reveal();
        else if (top > lastTop + 4) conceal();
        lastTop = top;
      }
    });
    bar.addEventListener("focusin", reveal);
    bar.addEventListener("mouseleave", () => bar.classList.contains("shown") && reveal());
    conceal();
    setTimeout(() => helperReady || bar.classList.add("shown", "pinned"), 1500);
    frame.src = renderUrl;
    const focus = document.getElementById("focus-view");
    focus.classList.remove("hidden");
    focus.addEventListener("click", () => {
      bar.classList.remove("pinned");
      frame.focus({ preventScroll: true });
      conceal();
    });
    const download = document.getElementById("download");
    download.href = documentUrl;
    download.download =
      (name
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
        .replace(/^[. ]+|[. ]+$/g, "")
        .slice(0, 100) || "handout") + ".html";
    download.classList.remove("hidden");
    gate.remove();
    document.getElementById("viewer-content").append(frame);
  }

  async function unlock(text) {
    const key = await crypto.subtle.importKey("raw", fromB64u(text.trim()), "AES-GCM", false, ["decrypt"]);
    let plain;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: encryptedBytes.subarray(0, 12) },
          key,
          encryptedBytes.subarray(12),
        ),
      );
    } catch {
      throw new Error("That Access Key does not match. Check it and try again.");
    }
    let data;
    try {
      plain = await readLimited(
        new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip")),
        MAX_HTML_BYTES * 6 + 4096,
      );
      data = JSON.parse(new TextDecoder().decode(plain));
    } catch (err) {
      if (err.message?.includes("size limit")) throw err;
      throw new Error("This handout contains invalid document data.");
    }
    if (typeof data.h !== "string" || typeof data.t !== "string")
      throw new Error("This handout contains invalid document data.");
    const bytes = new TextEncoder().encode(data.h);
    if (bytes.byteLength > MAX_HTML_BYTES) throw new Error("This handout exceeds the 25 MB limit.");
    show(bytes, data.t.slice(0, 120));
    encryptedBytes = null;
    keyInput.value = "";
  }

  function fail(err) {
    msg.textContent = err.message || "Could not open this handout. Try again.";
    msg.classList.add("err");
    if (encryptedBytes) {
      ask.classList.remove("hidden");
      keyInput.focus();
    } else document.getElementById("retry").classList.remove("hidden");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled || opened) return;
    button.disabled = true;
    msg.textContent = "Opening…";
    msg.classList.remove("err");
    try {
      await unlock(keyInput.value);
    } catch (err) {
      fail(err);
    } finally {
      button.disabled = false;
    }
  });

  // Large documents take a moment to arrive; say how far along the download is, at most a few
  // times per second so the live region stays quiet.
  const fmtMb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  function progressReporter(total) {
    const bar = document.getElementById("progress");
    const fill = bar.firstElementChild;
    let lastUpdate = 0;
    return (loaded) => {
      const now = Date.now();
      if (now - lastUpdate < 250 || loaded < 262144) return;
      lastUpdate = now;
      if (total) {
        bar.classList.remove("hidden");
        fill.style.width = `${Math.min(100, Math.round((loaded / total) * 100))}%`;
        msg.textContent = `Loading… ${fmtMb(loaded)} of ${fmtMb(total)}`;
      } else msg.textContent = `Loading… ${fmtMb(loaded)}`;
    };
  }

  // Keep the fragment so reload and copying the view URL still work. It is never sent in HTTP requests.
  // The viewer page preloads /raw, so this fetch usually finds the download already in progress.
  async function load() {
    const response = await fetch(`/${id}/raw`);
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "This handout was deleted, has expired, or does not exist."
          : "Could not load this handout. Try again.",
      );
    const total = Number(response.headers.get("x-handout-size")) || 0;
    const bytes = await readLimited(response.body, MAX_HTML_BYTES, progressReporter(total));
    document.getElementById("progress").classList.add("hidden");
    if (response.headers.get("x-handout-visibility") === "public") {
      show(bytes, decodeURIComponent(response.headers.get("x-handout-title") || ""));
      return;
    }
    encryptedBytes = bytes;
    document.getElementById("viewer-title").textContent = "Private handout";
    document.getElementById("gate-title").textContent = "A handout, just for you.";
    const key = new URLSearchParams(location.hash.slice(1)).get("key");
    if (key) await unlock(key);
    else {
      msg.textContent = "Enter the Access Key shared with this link.";
      ask.classList.remove("hidden");
    }
  }
  load().catch(fail);
  addEventListener("pagehide", (event) => {
    if (!event.persisted) {
      if (documentUrl) URL.revokeObjectURL(documentUrl);
      if (renderUrl) URL.revokeObjectURL(renderUrl);
    }
  });
  // A history restore must check the server again after deletion or expiration.
  addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
})();
