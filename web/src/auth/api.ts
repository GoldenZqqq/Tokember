import type { ViewerSessionResponse } from '@tokember/contracts/security'
import { requestJson, type Fetcher } from '../data/api-client'
import { booleanValue, objectValue } from '../data/decoders'

export function decodeViewerSession(value: unknown): ViewerSessionResponse {
  const row = objectValue(value, 'viewer session')
  return {
    required: booleanValue(row.required),
    authenticated: booleanValue(row.authenticated),
  }
}

export function createViewerApi(api: string, fetcher?: Fetcher) {
  const request = (path: string, init?: RequestInit) => {
    const { signal, ...requestInit } = init ?? {}
    return requestJson(`${api}/api/auth${path}`, {
      ...requestInit, decode: decodeViewerSession, fetcher, credentials: 'include',
      signal: signal ?? undefined,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  }
  return {
    session: (signal?: AbortSignal) => request('/session', { signal }),
    login: (password: string) => request('/login', {
      method: 'POST', body: JSON.stringify({ password }),
    }),
    logout: () => request('/logout', { method: 'POST' }),
  }
}
