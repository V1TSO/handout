import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Field notes</title></head><body><main><h1>Field notes ✓</h1><p>A document worth sharing.</p><div style="height:2400px;background:linear-gradient(#fff,#dce9e4)"></div><p>End of the handout.</p></main><script>document.body.dataset.ran='yes';try { parent.document.body.dataset.escaped='yes'; } catch { document.body.dataset.isolated='yes'; }</script></body></html>`;

async function accessible(page) {
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((n) => n.target),
    })),
  ).toEqual([]);
}
async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

// Local per-test IPs isolate real rate-limit bindings without disabling them. Only the local
// Worker receives the header: Cloudflare's challenge servers refuse requests that carry it.
function testIp(testInfo) {
  const hash = createHash("sha256").update(testInfo.testId).digest();
  return `10.${hash[0]}.${hash[1]}.${hash[2]}`;
}
async function isolateIp(context, ip) {
  await context.route(/^https?:\/\/(localhost|127\.0\.0\.1):\d+\//, (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
}

test.beforeEach(async ({ context, page }, testInfo) => {
  await isolateIp(context, testIp(testInfo));
  await page.goto("/");
});

test("upload comes first; tabs, validation, mobile layout and accessibility", async ({ page }, testInfo) => {
  await expect(page.getByRole("tab").first()).toHaveText("Upload HTML");
  await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#file-panel")).toBeVisible();
  await expect(page.locator("#paste-panel")).toBeHidden();
  await capture(page, testInfo, "upload");
  await accessible(page);
  await page.locator("#share").click();
  await expect(page.locator("#status")).toContainText("Choose an HTML file");
  await page.locator("#file-tab").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#paste-tab")).toBeFocused();
  await page.locator("#share").click();
  await expect(page.locator("#html")).toBeFocused();
  await expect(page.locator("#html")).toHaveAttribute("aria-invalid", "true");
  await page.locator("#html").fill(HTML);
  await page.locator("#paste-tab").focus();
  await page.keyboard.press("Home");
  await expect(page.locator("#file-tab")).toBeFocused();
  await page.locator("#paste-tab").click();
  await expect(page.locator("#html")).toHaveValue(HTML);
  await accessible(page);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const mode of ["file", "paste"])
  for (const visibility of ["public", "private"]) {
    test(`${mode} ${visibility}: upload, copy, view, download, scroll and delete`, async ({
      page,
      context,
      browser,
    }, testInfo) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      if (mode === "file") {
        await page
          .locator("#file")
          .setInputFiles({ name: "field-notes.html", mimeType: "text/html", buffer: Buffer.from(HTML) });
        await expect(page.locator("#file-name")).toHaveText("field-notes.html");
        await expect(page.locator(".file-pick")).toHaveText("Change file");
        await capture(page, testInfo, "selected-file");
      } else {
        await page.locator("#paste-tab").click();
        await page.locator("#html").fill(HTML);
      }
      await page.locator(`input[value="${visibility}"]`).check();
      const createdPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/handouts") && r.request().method() === "POST",
      );
      await page.locator("#share").click();
      const response = await createdPromise;
      expect(response.status()).toBe(201);
      const created = await response.json();
      try {
        await expect(page.locator("#result h2")).toHaveText("Your link is ready.");
        await page.getByRole("button", { name: "Copy share link", exact: true }).click();
        const link = await page.evaluate(() => navigator.clipboard.readText());
        expect(link).toContain(created.url);
        if (visibility === "private") expect(link).toContain("#key=");
        await expect(page.locator("#mine-count")).toHaveText("1");
        await capture(page, testInfo, "upload-result");
        await accessible(page);
        const viewer = await context.newPage();
        viewer.on("pageerror", (e) => errors.push(e.message));
        await viewer.goto(link);
        const frame = viewer.frameLocator("iframe");
        await expect(frame.locator("h1")).toHaveText("Field notes ✓");
        await expect(frame.locator("body")).toHaveAttribute("data-ran", "yes");
        await expect(frame.locator("body")).toHaveAttribute("data-isolated", "yes");
        expect(await viewer.locator("body").getAttribute("data-escaped")).toBeNull();
        await capture(viewer, testInfo, "viewer");
        await accessible(viewer);
        // The toolbar is hidden by default; the pointer at the top edge of the document reveals it.
        await viewer.mouse.move(180, 300);
        await viewer.mouse.move(180, 4);
        await expect(viewer.locator(".viewer-bar")).toBeInViewport();
        const downloadPromise = viewer.waitForEvent("download");
        await viewer.locator("#download").click();
        const download = await downloadPromise;
        expect(await readFile(await download.path(), "utf8")).toBe(HTML);
        expect(download.suggestedFilename()).toBe("Field notes.html");
        await viewer.mouse.move(180, 300);
        await viewer.mouse.wheel(0, 500);
        await expect
          .poll(() => viewer.locator(".viewer-bar").evaluate((el) => el.getBoundingClientRect().bottom))
          .toBeLessThanOrEqual(1);
        await capture(viewer, testInfo, "scrolled-viewer");
        // Scrolling back up inside the document reveals the overlay toolbar.
        await viewer.frames()[1].evaluate(() => scrollTo(0, 0));
        await expect
          .poll(() => viewer.locator(".viewer-bar").evaluate((el) => el.getBoundingClientRect().bottom))
          .toBeGreaterThan(1);
        await expect.poll(() => viewer.evaluate(() => scrollY)).toBe(0);
        await viewer.reload();
        await expect(viewer.locator("iframe")).toBeVisible();
        if (visibility === "private") {
          await viewer.goto(created.url);
          await expect(viewer.locator("#ask")).toBeVisible();
          await expect(viewer.locator("#download")).toBeHidden();
          await viewer.locator("#key").fill("x".repeat(43));
          await viewer.locator("#unlock").click();
          await expect(viewer.locator("#msg")).toContainText("does not match");
          await capture(viewer, testInfo, "wrong-access-key");
          await viewer.locator("#key").fill(new URLSearchParams(new URL(link).hash.slice(1)).get("key"));
          await viewer.locator("#unlock").click();
          await expect(viewer.locator("iframe")).toBeVisible();
        }
        // Fresh context has no saved links or keys: exercise the portable deletion form.
        const other = await browser.newContext();
        try {
          await isolateIp(other, testIp(testInfo));
          const deletion = await other.newPage();
          await deletion.goto("http://localhost:8789/#delete-handout");
          await deletion.locator("#delete-link").fill(link);
          await deletion.locator("#delete-key").fill(created.deleteKey);
          await deletion.locator("#delete-form button").click();
          await expect(deletion.getByRole("alertdialog")).toBeVisible();
          await deletion.getByRole("button", { name: "Delete permanently" }).click();
          await expect(deletion.locator("#delete-status")).toContainText("Deleted.");
        } finally {
          await other.close();
        }
        await viewer.reload();
        await expect(viewer.locator("#msg")).toContainText("deleted");
        await expect(viewer.locator("iframe")).toHaveCount(0);
        await expect(viewer.locator("#download")).toBeHidden();
        expect(errors).toEqual([]);
        await viewer.close();
      } finally {
        await page.request.delete(`/api/handouts/${created.id}`, {
          headers: { authorization: `Bearer ${created.deleteKey}` },
        });
      }
    });
  }

test("bad files, oversized input, retry and invalid deletion do not lose the form", async ({
  page,
}, testInfo) => {
  await page
    .locator("#file")
    .setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("not HTML") });
  await expect(page.locator("#status")).toContainText(".html or .htm");
  await page
    .locator("#file")
    .setInputFiles({ name: "large.html", mimeType: "text/html", buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await expect(page.locator("#status")).toContainText("limit is 25 MB");
  await page.locator("#paste-tab").click();
  await page.locator("#html").fill(HTML);
  await page.route("**/api/handouts", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Upload unavailable. Try again." }),
    }),
  );
  await page.locator("#share").click();
  await expect(page.locator("#status")).toContainText("Try again");
  await expect(page.locator("#share")).toBeEnabled();
  await expect(page.locator("#html")).toHaveValue(HTML);
  await page.goto("/#delete-handout");
  await page.locator("#delete-link").fill("https://h.v1tso.com/" + "Z".repeat(22));
  await page.locator("#delete-key").fill("incorrect");
  await page.locator("#delete-form button").click();
  await expect(page.locator("#delete-status")).toContainText("43-character Delete Key");
  await capture(page, testInfo, "delete-validation");
});

test("delete dialog keeps focus, supports cancellation and retries failed requests", async ({
  page,
}, testInfo) => {
  await page.goto("/#delete-handout");
  await page.locator("#delete-link").fill("https://h.v1tso.com/" + "Z".repeat(22));
  await page.locator("#delete-key").fill("a".repeat(43));
  let requests = 0;
  await page.route("**/api/handouts/*", (route) => {
    requests++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Deletion unavailable. Try again." }),
    });
  });
  const trigger = page.locator("#delete-form button");
  const dialog = page.getByRole("alertdialog");
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep handout" })).toBeFocused();
  await accessible(page);
  await capture(page, testInfo, "delete-dialog");
  await dialog.getByRole("button", { name: "Keep handout" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(requests).toBe(0);
  await trigger.click();
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Try again");
  await expect(dialog.getByRole("button", { name: "Delete permanently" })).toBeEnabled();
  await expect(page.locator("#delete-key")).toHaveValue("a".repeat(43));
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect.poll(() => requests).toBe(2);
  await dialog.getByRole("button", { name: "Keep handout" }).click();
  await expect(trigger).toBeFocused();
});

test("blocked storage and clipboard still leave links and keys available", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: () => Promise.reject(new Error("Clipboard blocked")),
    });
  });
  await page.reload();
  await page.locator("#paste-tab").click();
  await page.locator("#html").fill(HTML);
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/handouts") && r.request().method() === "POST",
  );
  await page.locator("#share").click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const created = await response.json();
  try {
    await expect(page.locator("#status")).toContainText("Browser storage is unavailable");
    await page.getByRole("button", { name: "Copy share link", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy share link", exact: true })).toHaveText(
      "Select and copy",
    );
    expect(await page.evaluate(() => getSelection().toString())).toBe(created.url);
    await page.getByText("Save your Delete Key", { exact: true }).click();
    await expect(page.locator("#result code").filter({ hasText: created.deleteKey })).toBeVisible();
  } finally {
    await page.request.delete(`/api/handouts/${created.id}`, {
      headers: { authorization: `Bearer ${created.deleteKey}` },
    });
  }
});
