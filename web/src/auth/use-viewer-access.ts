import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isAbortError, toApiError, type ApiError } from '../data/api-client'
import { LatestRequest } from '../data/latest-request'
import { createViewerApi } from './api'

export type ViewerAccessState =
  | { status: 'checking'; error: null }
  | { status: 'anonymous'; error: ApiError | null }
  | { status: 'authenticated'; error: null }
  | { status: 'error'; error: ApiError }

export function useViewerAccess(api: string, enabled: boolean) {
  const client = useMemo(() => createViewerApi(api), [api])
  const latest = useRef(new LatestRequest())
  const [state, setState] = useState<ViewerAccessState>({ status: 'checking', error: null })

  const refresh = useCallback(async () => {
    setState({ status: 'checking', error: null })
    try {
      const result = await latest.current.execute(signal => client.session(signal))
      if (result.current) setState(result.value!.authenticated
        ? { status: 'authenticated', error: null }
        : { status: 'anonymous', error: null })
    } catch (error) {
      if (!isAbortError(error)) setState({ status: 'error', error: toApiError(error) })
    }
  }, [client])

  useEffect(() => {
    if (!enabled) return
    refresh()
    return () => latest.current.cancel()
  }, [enabled, refresh])

  const login = useCallback(async (password: string) => {
    try {
      const result = await client.login(password)
      if (result.authenticated) setState({ status: 'authenticated', error: null })
    } catch (error) {
      setState({ status: 'anonymous', error: toApiError(error) })
    }
  }, [client])

  return { state, refresh, login }
}
