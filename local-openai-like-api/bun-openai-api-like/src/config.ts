import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// OAuth constants
// ---------------------------------------------------------------------------
export const CLIENT_ID = "Ov23li8tweQw6odWQebz";
export const OAUTH_SCOPE = "read:user";
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// Polling safety margin (ms) added to the server-provided interval
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
// Extra seconds added on "slow_down" per RFC 8628 §3.5
export const OAUTH_SLOW_DOWN_EXTRA_S = 5;

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------
export const USER_AGENT =
  process.env.USER_AGENT ?? "copilot-proxy/1.0.0";

// ---------------------------------------------------------------------------
// Log level
// ---------------------------------------------------------------------------
export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? "info";

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const log = {
  debug: (...args: unknown[]) => {
    if (LOG_PRIORITY[LOG_LEVEL] <= 0) console.debug("[debug]", ...args);
  },
  info: (...args: unknown[]) => {
    if (LOG_PRIORITY[LOG_LEVEL] <= 1) console.log("[info]", ...args);
  },
  warn: (...args: unknown[]) => {
    if (LOG_PRIORITY[LOG_LEVEL] <= 2) console.warn("[warn]", ...args);
  },
  error: (...args: unknown[]) => {
    if (LOG_PRIORITY[LOG_LEVEL] <= 3) console.error("[error]", ...args);
  },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export const PORT = parseInt(process.env.PORT ?? "3000", 10);
export const HOST = process.env.HOST ?? "0.0.0.0";

// ---------------------------------------------------------------------------
// Auth file
// ---------------------------------------------------------------------------
function defaultAuthPath(): string {
  return join(homedir(), ".config", "copilot-proxy", "auth.json");
}
export const AUTH_FILE = process.env.AUTH_FILE ?? defaultAuthPath();

// ---------------------------------------------------------------------------
// Enterprise support
// ---------------------------------------------------------------------------
export const GITHUB_ENTERPRISE_URL = process.env.GITHUB_ENTERPRISE_URL;

export function normalizeEnterpriseUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function getGitHubBaseUrl(enterpriseUrl?: string): string {
  if (!enterpriseUrl) return "https://github.com";
  return enterpriseUrl.replace(/\/+$/, "");
}

export function getCopilotApiBaseUrl(enterpriseUrl?: string): string {
  if (!enterpriseUrl) return "https://api.githubcopilot.com";
  return `https://copilot-api.${normalizeEnterpriseUrl(enterpriseUrl)}`;
}

export function getDeviceCodeUrl(enterpriseUrl?: string): string {
  return `${getGitHubBaseUrl(enterpriseUrl)}/login/device/code`;
}

export function getAccessTokenUrl(enterpriseUrl?: string): string {
  return `${getGitHubBaseUrl(enterpriseUrl)}/login/oauth/access_token`;
}

/** Key used in auth.json */
export function getAuthStorageKey(enterpriseUrl?: string): string {
  return enterpriseUrl ? "github-copilot-enterprise" : "github-copilot";
}
