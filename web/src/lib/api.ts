import { useAuth } from '../store/auth';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function authHeaders(): Record<string, string> {
  const token = useAuth.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...authHeaders(),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the PeerBeats server. Is it still running?');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) useAuth.getState().logout();
    throw new ApiError(res.status, data?.error ?? `The server returned an error (${res.status}).`);
  }
  return data as T;
}
