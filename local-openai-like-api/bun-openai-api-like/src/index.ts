import {
  GITHUB_ENTERPRISE_URL,
  getCopilotApiBaseUrl,
  getAuthStorageKey,
  USER_AGENT,
  log,
} from "./config";
import { getAccessToken, hasToken } from "./auth/storage";
import { login } from "./auth/device-flow";
import { startServer } from "./server";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "login") {
    await runLogin();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // Default: start the server
  await runServer();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runLogin(): Promise<void> {
  log.info("Starting GitHub Copilot authentication...");
  try {
    await login(GITHUB_ENTERPRISE_URL);
    log.info("You can now start the proxy with: bun run src/index.ts");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Login failed:", message);
    process.exit(1);
  }
}

async function runServer(): Promise<void> {
  const storageKey = getAuthStorageKey(GITHUB_ENTERPRISE_URL);

  // 1. Check that a token exists
  if (!(await hasToken(storageKey))) {
    log.error("No authentication token found.");
    log.error("");
    log.error("  Run: bun run src/index.ts login");
    log.error("");
    log.error("to authenticate with GitHub Copilot.");
    process.exit(1);
  }

  // 2. Validate the token works by making a lightweight request
  log.info("Validating authentication token...");
  const valid = await validateToken(storageKey);
  if (!valid) {
    log.error("Authentication token is invalid or revoked.");
    log.error("");
    log.error("  Run: bun run src/index.ts login");
    log.error("");
    log.error("to re-authenticate.");
    process.exit(1);
  }

  log.info("Token is valid.");

  // 3. Start the HTTP server
  startServer();
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Make a small request to the Copilot API to verify the token works.
 * We send a minimal chat completions request with max_tokens=1 to the
 * cheapest model. If we get 200, 400 (bad request but authenticated), or
 * 429 (rate limited but authenticated), the token is valid. 401/403 means
 * the token is bad.
 *
 * We use a GET-like minimal approach: just checking that the API doesn't
 * reject us with an auth error.
 */
async function validateToken(storageKey: string): Promise<boolean> {
  const token = await getAccessToken(storageKey);
  if (!token) return false;

  const baseUrl = getCopilotApiBaseUrl(GITHUB_ENTERPRISE_URL);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Openai-Intent": "conversation-edits",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      log.debug(`Validation got ${response.status} — token invalid`);
      return false;
    }

    // Any other status (200, 400, 429, etc.) means we're authenticated
    // Consume the body to avoid resource leak
    await response.text();
    log.debug(`Validation got ${response.status} — token valid`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Token validation request failed:", message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
copilot-proxy — OpenAI-compatible proxy for GitHub Copilot

Usage:
  bun run src/index.ts            Start the proxy server
  bun run src/index.ts login      Authenticate with GitHub Copilot
  bun run src/index.ts help       Show this help message

Environment variables:
  PORT                   Server port (default: 3000)
  HOST                   Server bind address (default: 0.0.0.0)
  AUTH_FILE              Token file path (default: ~/.config/copilot-proxy/auth.json)
  GITHUB_ENTERPRISE_URL  GitHub Enterprise URL (optional)
  LOG_LEVEL              Logging level: debug, info, warn, error (default: info)
  USER_AGENT             User-Agent string (default: copilot-proxy/1.0.0)
`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  log.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
