import { execSync } from 'child_process';

/**
 * Cached OAuth token with expiry tracking.
 */
type CachedToken = {
  token: string;
  expiresAt: number;
};

let cachedToken: CachedToken | null = null;

/**
 * Get Databricks host from environment.
 * Returns the host with https:// prefix, no trailing slash.
 */
export const getDatabricksHost = (): string => {
  let host = process.env.DATABRICKS_HOST;
  if (!host) {
    throw new Error('DATABRICKS_HOST environment variable is not set');
  }
  // Ensure https:// prefix
  if (!host.startsWith('https://') && !host.startsWith('http://')) {
    host = `https://${host}`;
  }
  // Remove trailing slash
  return host.replace(/\/$/, '');
};

/**
 * Get OAuth token for Databricks M2M authentication.
 * Supports:
 * - Environment variables: DATABRICKS_TOKEN (direct token)
 * - OAuth M2M: DATABRICKS_CLIENT_ID + DATABRICKS_CLIENT_SECRET (via OIDC)
 * - Fallback: databricks auth token CLI (if DATABRICKS_CONFIG_PROFILE is set)
 */
export const getDatabricksToken = async (): Promise<string> => {
  // Check if we have a cached token that hasn't expired
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  // 1. Try direct token from env
  if (process.env.DATABRICKS_TOKEN) {
    return process.env.DATABRICKS_TOKEN;
  }

  // 2. Try OAuth M2M
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    const token = await getOAuthToken();
    cachedToken = {
      token,
      // Expire token 5 minutes before actual expiry for safety
      expiresAt: Date.now() + (3595 * 1000), // Assume 1 hour expiry, refresh at 59m55s
    };
    return token;
  }

  // 3. Try CLI fallback with config profile
  if (process.env.DATABRICKS_CONFIG_PROFILE) {
    if (cliTokenCache && cliTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cliTokenCache.token;
    }
    try {
      // `databricks auth token` は {"access_token": ..., "expiry": ...} の JSON を返す
      const out = JSON.parse(
        execSync(`databricks auth token --profile ${process.env.DATABRICKS_CONFIG_PROFILE}`, {
          encoding: 'utf-8',
        }),
      ) as { access_token: string; expiry?: string; expires_in?: number };
      if (out.access_token) {
        cliTokenCache = {
          token: out.access_token,
          expiresAt: out.expiry ? Date.parse(out.expiry) : Date.now() + (out.expires_in ?? 600) * 1000,
        };
        return out.access_token;
      }
    } catch (e) {
      console.warn('Failed to get token from CLI', e);
    }
  }

  throw new Error(
    'No Databricks authentication credentials found. Set DATABRICKS_TOKEN, ' +
    'DATABRICKS_CLIENT_ID+DATABRICKS_CLIENT_SECRET, or DATABRICKS_CONFIG_PROFILE'
  );
}

let cliTokenCache: { token: string; expiresAt: number } | undefined;

/**
 * Fetch helper that adds Databricks host and Authorization Bearer token.
 */
export const databricksFetch = async (
  path: string,
  init?: RequestInit
): Promise<Response> => {
  const host = getDatabricksHost();
  const token = await getDatabricksToken();

  const url = new URL(path, host);

  return fetch(url.toString(), {
    ...init,
    headers: {
      ...init?.headers,
      'Authorization': `Bearer ${token}`,
    },
  });
};

/**
 * Get OAuth token via OIDC client credentials flow.
 */
async function getOAuthToken(): Promise<string> {
  const host = getDatabricksHost();
  const clientId = process.env.DATABRICKS_CLIENT_ID!;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET!;

  const tokenUrl = new URL('/oidc/v1/token', host);
  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'all-apis',
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to get OAuth token: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  return data.access_token;
}
