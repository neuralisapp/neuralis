export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ProjectIdProvider = () => string | null;

let _getProjectId: ProjectIdProvider = () => null;

export function setProjectIdProvider(fn: ProjectIdProvider): void {
  _getProjectId = fn;
}

export function getProjectIdProvider(): ProjectIdProvider {
  return _getProjectId;
}

function buildHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const projectId = _getProjectId();
  if (projectId) {
    headers.set('X-Project-Id', projectId);
  }
  return headers;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: buildHeaders(init?.headers) });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let body: unknown;
    try {
      body = await res.json();
      if (body && typeof body === 'object' && 'error' in body) {
        message = String((body as Record<string, unknown>).error);
      }
    } catch { /* ignore */ }
    throw new ApiError(message, res.status, body);
  }
  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}
