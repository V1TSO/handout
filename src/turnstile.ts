const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_HEADER = "cf-turnstile-response";

export type TurnstileOutcome = { ok: true } | { ok: false; code: string; message: string };

interface SiteverifyResult {
  success?: boolean;
  action?: string;
  hostname?: string;
  metadata?: { result_with_testing_key?: boolean };
}

const fail = (code: string, message: string): TurnstileOutcome => ({ ok: false, code, message });

/**
 * Canonical server-side check of a Turnstile token. Fails closed: a missing secret, an empty
 * hostname allowlist, a network problem, or a mismatch all refuse the request. Cloudflare's
 * documented testing secret marks its answers with `result_with_testing_key` and returns a fixed
 * hostname and no action, so only those answers skip the action and hostname comparison.
 */
export async function verifyTurnstile(
  env: { TURNSTILE_SECRET: string; TURNSTILE_HOSTNAMES: string },
  token: string | null,
  remoteip: string,
  action: string,
  fetcher: typeof fetch = fetch,
): Promise<TurnstileOutcome> {
  const allowed = new Set(
    (env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  );
  if (!token || token.length > 2048) {
    return fail(
      "turnstile_required",
      `Complete the browser check first and send its token in the ${TURNSTILE_HEADER} header.`,
    );
  }
  if (!env.TURNSTILE_SECRET || allowed.size === 0) {
    return fail("turnstile_unavailable", "The browser check is not configured on this server.");
  }
  let result: SiteverifyResult;
  try {
    const response = await fetcher(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`siteverify ${response.status}`);
    result = (await response.json()) as SiteverifyResult;
  } catch {
    return fail("turnstile_unavailable", "The browser check could not be verified. Try again.");
  }
  const testing = result.metadata?.result_with_testing_key === true;
  const matches = testing || (result.action === action && allowed.has(result.hostname ?? ""));
  if (result.success !== true || !matches) {
    return fail("turnstile_failed", "The browser check did not pass. Reload the page and try again.");
  }
  return { ok: true };
}
