export type AuthRole = 'viewer' | 'admin'

export interface ViewerSessionResponse {
  required: boolean
  authenticated: boolean
}

export interface AdminSessionResponse {
  authenticated: boolean
}

export interface DeviceCredential {
  id: number
  token_id: string
  device_id: string
  device_name: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface DeviceCredentialListResponse {
  credentials: DeviceCredential[]
  legacy_api_key_allowed: boolean
}

export interface DeviceCredentialInput {
  device_id: string
  device_name?: string
  label: string
}

export interface DeviceCredentialCreatedResponse {
  credential: DeviceCredential
  token: string
}
