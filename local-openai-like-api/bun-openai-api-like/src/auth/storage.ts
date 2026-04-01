import { dirname } from "path";
import { AUTH_FILE, log } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface OAuthToken {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  enterpriseUrl?: string;
}

export type AuthInfo = OAuthToken;

export type AuthStore = Record<string, AuthInfo>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  const file = Bun.file(dir);
  if (!(await file.exists())) {
    await Bun.spawn(["mkdir", "-p", dir]).exited;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read the full auth store. Returns empty object if file missing. */
export async function readAuthStore(): Promise<AuthStore> {
  const file = Bun.file(AUTH_FILE);
  if (!(await file.exists())) return {};
  try {
    const text = await file.text();
    return JSON.parse(text) as AuthStore;
  } catch {
    log.warn("Failed to parse auth file, treating as empty");
    return {};
  }
}

/** Get a single auth entry by key. */
export async function getAuth(key: string): Promise<AuthInfo | null> {
  const store = await readAuthStore();
  return store[key] ?? null;
}

/** Set (upsert) a single auth entry. Atomic write with 0o600 permissions. */
export async function setAuth(key: string, info: AuthInfo): Promise<void> {
  await ensureDir(AUTH_FILE);
  const store = await readAuthStore();
  store[key] = info;
  const tmpPath = `${AUTH_FILE}.tmp.${Date.now()}`;
  await Bun.write(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Rename for atomicity
  const proc = Bun.spawn(["mv", tmpPath, AUTH_FILE]);
  await proc.exited;
  log.debug("Auth saved for key:", key);
}

/** Remove an auth entry. */
export async function removeAuth(key: string): Promise<void> {
  const store = await readAuthStore();
  delete store[key];
  await Bun.write(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Quick check: does a token exist for the given key? */
export async function hasToken(key: string): Promise<boolean> {
  const info = await getAuth(key);
  return info !== null && info.type === "oauth" && !!info.access;
}

/** Get the access token string for the given key, or null. */
export async function getAccessToken(key: string): Promise<string | null> {
  const info = await getAuth(key);
  if (!info || info.type !== "oauth") return null;
  // Both refresh and access are the same value for Copilot
  return info.access || info.refresh || null;
}
