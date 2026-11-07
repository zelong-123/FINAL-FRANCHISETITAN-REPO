import { SUPABASE_URL, clearPersistSession, setPersistSession, supabase } from './supabase';

// The `api` Edge Function serves the same /api/v1 routes the Laravel backend did.
export const API_BASE_URL = `${SUPABASE_URL}/functions/v1/api/v1`;

const DEFAULT_TIMEOUT = 30000;

export class ApiError extends Error {
  constructor(message, status = 0, errors = {}, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
    this.payload = payload;
  }
}

let cachedToken = null;
supabase.auth.onAuthStateChange((_event, session) => {
  cachedToken = session?.access_token ?? null;
});

export const authToken = {
  /** A valid access token; supabase-js refreshes an expiring one first. */
  get: async () => {
    const { data } = await supabase.auth.getSession();
    cachedToken = data.session?.access_token ?? null;
    return cachedToken;
  },
  /** Last known token, for page-unload requests that cannot wait for a promise. */
  latest: () => cachedToken,
  set: async ({ token, refresh_token: refreshToken }, persist = false) => {
    setPersistSession(persist);
    const { error } = await supabase.auth.setSession({ access_token: token, refresh_token: refreshToken });
    if (error) throw new ApiError('Your session could not be started. Please sign in again.', 401);
    cachedToken = token;
  },
  clear: async () => {
    cachedToken = null;
    clearPersistSession();
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  },
};

function makeQuery(query = {}) {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : '';
}

function parsePayload(response) {
  if (response.status === 204) return Promise.resolve({});
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json().catch(() => ({}));
  return response.text().then((text) => (text ? { message: text } : {})).catch(() => ({}));
}

export async function apiRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    query,
    headers = {},
    signal,
    skipAuth = false,
    timeout = DEFAULT_TIMEOUT,
  } = options;

  const token = skipAuth ? null : await authToken.get();
  const isFormData = body instanceof FormData;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort('timeout'), timeout);
  const abortFromCaller = () => controller.abort('caller');
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(`${API_BASE_URL}${path}${makeQuery(query)}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(isFormData || body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(!skipAuth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
    });

    const payload = await parsePayload(response);
    if (!response.ok) {
      if (response.status === 401) {
        await authToken.clear();
        window.dispatchEvent(new CustomEvent('herald:unauthorized'));
      }
      throw new ApiError(
        payload.message || `Request failed with status ${response.status}.`,
        response.status,
        payload.errors || {},
        payload,
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new ApiError('The request was cancelled.', 0);
      throw new ApiError('The server took too long to respond. Check your connection and try again.', 0);
    }
    throw new ApiError('Herald could not reach the server. Check your connection and try again.', 0);
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export const api = {
  get: (path, query, options = {}) => apiRequest(path, { ...options, query }),
  post: (path, body, options = {}) => apiRequest(path, { ...options, method: 'POST', body }),
  put: (path, body, options = {}) => apiRequest(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options = {}) => apiRequest(path, { ...options, method: 'PATCH', body }),
  delete: (path, options = {}) => apiRequest(path, { ...options, method: 'DELETE' }),
};

/** Download a server-generated file (CSV template/export) with the auth header. */
export async function downloadFile(path, query, fallbackName = 'download.csv') {
  const token = await authToken.get();
  const response = await fetch(`${API_BASE_URL}${path}${makeQuery(query)}`, {
    headers: {
      Accept: 'text/csv, application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const payload = await parsePayload(response);
    throw new ApiError(
      payload.message || `Download failed with status ${response.status}.`,
      response.status,
      payload.errors || {},
      payload,
    );
  }

  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1]?.trim() || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  // Callers may read response headers (e.g. X-Template-Rows); existing callers ignore it.
  return { filename: link.download, headers: response.headers };
}

export function firstValidationMessage(error) {
  if (!(error instanceof ApiError)) return error?.message || 'Something went wrong.';
  const first = Object.values(error.errors || {}).flat()[0];
  return first || error.message;
}
