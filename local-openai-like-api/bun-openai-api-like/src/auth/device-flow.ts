import {
  CLIENT_ID,
  OAUTH_SCOPE,
  GRANT_TYPE,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  OAUTH_SLOW_DOWN_EXTRA_S,
  USER_AGENT,
  GITHUB_ENTERPRISE_URL,
  getDeviceCodeUrl,
  getAccessTokenUrl,
  getAuthStorageKey,
  log,
} from "../config";
import { setAuth } from "./storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full OAuth Device Flow.
 * Prints the verification URI and user code to stdout, polls until the user
 * authorises, and saves the token to auth.json.
 */
export async function login(enterpriseUrl?: string): Promise<void> {
  const deviceCodeUrl = getDeviceCodeUrl(enterpriseUrl);
  const accessTokenUrl = getAccessTokenUrl(enterpriseUrl);
  const storageKey = getAuthStorageKey(enterpriseUrl);

  // Step 1 — request device code
  log.info("Requesting device code...");
  const dcRes = await fetch(deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: OAUTH_SCOPE,
    }),
  });

  if (!dcRes.ok) {
    const text = await dcRes.text();
    throw new Error(
      `Failed to request device code (${dcRes.status}): ${text}`,
    );
  }

  const dc = (await dcRes.json()) as DeviceCodeResponse;

  // Step 2 — prompt user
  console.log();
  console.log("=".repeat(56));
  console.log("  GitHub Copilot — Device Authorization");
  console.log("=".repeat(56));
  console.log();
  console.log(`  1. Open:  ${dc.verification_uri}`);
  console.log(`  2. Enter: ${dc.user_code}`);
  console.log();
  console.log(`  Code expires in ${Math.round(dc.expires_in / 60)} minutes.`);
  console.log("=".repeat(56));
  console.log();
  console.log("Waiting for authorization...");

  // Step 3 — poll for access token
  let intervalMs = dc.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS;

  while (true) {
    await sleep(intervalMs);

    const pollRes = await fetch(accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: dc.device_code,
        grant_type: GRANT_TYPE,
      }),
    });

    const data = (await pollRes.json()) as PollResponse;

    if (data.access_token) {
      // Step 4 — save token
      await setAuth(storageKey, {
        type: "oauth",
        refresh: data.access_token,
        access: data.access_token,
        expires: 0,
        ...(enterpriseUrl ? { enterpriseUrl } : {}),
      });

      console.log();
      console.log("Authenticated successfully!");
      console.log();
      return;
    }

    if (data.error === "authorization_pending") {
      // Keep polling
      continue;
    }

    if (data.error === "slow_down") {
      // RFC 8628 §3.5: add 5 seconds (or use server interval if provided)
      if (data.interval) {
        intervalMs =
          data.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS;
      } else {
        intervalMs += OAUTH_SLOW_DOWN_EXTRA_S * 1000;
      }
      log.debug(`Slowing down, new interval: ${intervalMs}ms`);
      continue;
    }

    if (data.error === "expired_token") {
      throw new Error(
        "Device code expired. Please run the login command again.",
      );
    }

    // Any other error
    throw new Error(
      `OAuth error: ${data.error} — ${data.error_description ?? "unknown"}`,
    );
  }
}
