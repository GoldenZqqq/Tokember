import type { ApiError } from './api-client'

export type ResourceStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'stale'
  | 'error'

export interface ResourceState<T> {
  key: string | null
  data: T | null
  status: ResourceStatus
  error: ApiError | null
  updatedAt: number | null
}

export function initialResource<T>(): ResourceState<T> {
  return { key: null, data: null, status: 'idle', error: null, updatedAt: null }
}

export function beginResource<T>(state: ResourceState<T>, key: string): ResourceState<T> {
  if (state.key === key && state.data != null) {
    return { ...state, status: 'refreshing', error: null }
  }
  return { key, data: null, status: 'loading', error: null, updatedAt: null }
}

export function succeedResource<T>(
  _state: ResourceState<T>,
  key: string,
  data: T,
  updatedAt = Date.now(),
): ResourceState<T> {
  return { key, data, status: 'ready', error: null, updatedAt }
}

export function failResource<T>(
  state: ResourceState<T>,
  key: string,
  error: ApiError,
): ResourceState<T> {
  if (state.key === key && state.data != null) {
    return { ...state, status: 'stale', error }
  }
  return { key, data: null, status: 'error', error, updatedAt: null }
}
