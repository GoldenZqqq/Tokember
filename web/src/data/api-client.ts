export type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'server'
  | 'invalid-response'
  | 'aborted'

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type Decoder<T> = (value: unknown) => T
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface JsonRequestOptions<T> extends Omit<RequestInit, 'signal'> {
  decode: Decoder<T>
  signal?: AbortSignal
  timeoutMs?: number
  fetcher?: Fetcher
}

function safeErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value == null || !('error' in value)) return undefined
  return typeof value.error === 'string' && value.error.trim() ? value.error : undefined
}

async function parseErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function statusError(response: Response, body: unknown): ApiError {
  const kind = response.status === 401 || response.status === 403 ? 'auth' : 'server'
  const fallback = kind === 'auth'
    ? '登录状态无效，请重新登录'
    : `服务请求失败 (${response.status})`
  return new ApiError(kind, safeErrorMessage(body) ?? fallback, response.status)
}

function requestSignal(caller: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions<T>,
): Promise<T> {
  const { decode, fetcher = fetch, signal: caller, timeoutMs = 15_000, ...init } = options
  const timeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; timeout.abort() }, timeoutMs)
  try {
    const response = await fetcher(url, { ...init, signal: requestSignal(caller, timeout.signal) })
    if (!response.ok) throw statusError(response, await parseErrorBody(response))
    let body: unknown
    try {
      body = await response.json()
    } catch (cause) {
      throw new ApiError('invalid-response', '服务响应不是有效 JSON', response.status)
    }
    try {
      return decode(body)
    } catch (cause) {
      throw new ApiError('invalid-response', '服务响应格式异常', response.status)
    }
  } catch (cause) {
    if (cause instanceof ApiError) throw cause
    if (timedOut) throw new ApiError('timeout', '请求超时，请重试')
    if (caller?.aborted) throw new ApiError('aborted', '请求已取消')
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ApiError('aborted', '请求已取消')
    }
    throw new ApiError('network', '网络连接失败，请检查连接后重试')
  } finally {
    clearTimeout(timer)
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'aborted'
}

export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('network', error instanceof Error ? error.message : '请求失败')
}
