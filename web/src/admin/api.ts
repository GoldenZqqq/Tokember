import { requestJson, type Decoder, type Fetcher } from '../data/api-client'
import {
  decodeAuthenticated, decodeClassify, decodeDevices, decodeMaintenance,
  decodeDeviceCredentialCreated, decodeDeviceCredentials,
  decodeMaintenanceAction, decodeOk, decodeReprice, decodeRule, decodeRules,
  decodeSystemInfo,
  decodeProjectAttribution, decodeProjectAttributionMutation,
} from './decoders'
import type { PricingRuleInput } from './types'
import type { AuditFilters } from '../audit/query'
import { auditSearchParams } from '../audit/query'
import {
  decodeAuditCutovers,
  decodeAuditReconciliation,
  decodeAuditRecords,
  decodeAuditSummary,
} from '../audit/decoders'
import {
  decodeAlertCenter,
  decodeAlertEvaluation,
  decodeAlertRuleResponse,
} from './alert-decoders'
import type { AlertRuleInput } from '@tokember/contracts/alerts'
import type { DeviceCredentialInput } from '@tokember/contracts/security'

const API = import.meta.env?.VITE_API_URL || ''

function createRequester(api: string, fetcher?: Fetcher) {
  return function request<T>(path: string, decode: Decoder<T>, init?: RequestInit): Promise<T> {
    const { signal, ...requestInit } = init ?? {}
    const headers = new Headers(init?.headers)
    headers.set('Content-Type', 'application/json')
    return requestJson(`${api}/api/admin${path}`, {
      ...requestInit, decode, fetcher, signal: signal ?? undefined,
      credentials: 'include', headers,
    })
  }
}

type Requester = ReturnType<typeof createRequester>

function sessionMethods(request: Requester) {
  return {
    session: (signal?: AbortSignal) => request('/session', decodeAuthenticated, { signal }),
    login: (password: string) => request('/login', decodeAuthenticated, {
      method: 'POST', body: JSON.stringify({ password }),
    }),
    logout: () => request('/logout', decodeAuthenticated, { method: 'POST' }),
    devices: () => request('/devices', decodeDevices),
    systemInfo: () => request('/system', decodeSystemInfo),
  }
}

function deviceCredentialMethods(request: Requester) {
  return {
    deviceCredentials: () => request('/device-credentials', decodeDeviceCredentials),
    createDeviceCredential: (input: DeviceCredentialInput) => request(
      '/device-credentials', decodeDeviceCredentialCreated, {
        method: 'POST', body: JSON.stringify(input),
      },
    ),
    rotateDeviceCredential: (id: number) => request(
      `/device-credentials/${id}/rotate`, decodeDeviceCredentialCreated, { method: 'POST' },
    ),
    revokeDeviceCredential: (id: number) => request(
      `/device-credentials/${id}/revoke`, decodeOk, { method: 'POST' },
    ),
  }
}

function pricingMethods(request: Requester) {
  return {
    rules: () => request('/pricing/rules', decodeRules),
    createRule: (rule: PricingRuleInput) => request('/pricing/rules', decodeRule, {
      method: 'POST', body: JSON.stringify(rule),
    }),
    updateRule: (id: number, rule: PricingRuleInput) =>
      request(`/pricing/rules/${id}`, decodeRule, {
        method: 'PUT', body: JSON.stringify(rule),
      }),
    deleteRule: (id: number) =>
      request(`/pricing/rules/${id}`, decodeOk, { method: 'DELETE' }),
    addAlias: (ruleId: number, source: string, alias: string) =>
      request(`/pricing/rules/${ruleId}/aliases`, decodeClassify, {
        method: 'POST', body: JSON.stringify({ source, alias }),
      }),
    deleteAlias: (id: number) =>
      request(`/pricing/aliases/${id}`, decodeOk, { method: 'DELETE' }),
    reprice: (apply: boolean) => request('/pricing/reprice', decodeReprice, {
      method: 'POST', body: JSON.stringify({ apply }),
    }),
  }
}

function maintenanceMethods(request: Requester) {
  return {
    maintenanceSummary: (pattern?: string) => {
      const query = pattern ? `?pattern=${encodeURIComponent(pattern)}` : ''
      return request(`/maintenance/summary${query}`, decodeMaintenance)
    },
    ignoreUnpriced: (pattern?: string) => request('/maintenance/ignore', decodeMaintenanceAction, {
      method: 'POST', body: JSON.stringify(pattern ? { pattern } : {}),
    }),
    restoreIgnored: (opts?: { pattern?: string; all?: boolean }) =>
      request('/maintenance/restore', decodeMaintenanceAction, {
        method: 'POST', body: JSON.stringify(opts ?? {}),
      }),
    classifyModel: (source: string, alias: string, pricingRuleId: number) =>
      request('/maintenance/classify-model', decodeClassify, {
        method: 'POST', body: JSON.stringify({ source, alias, pricing_rule_id: pricingRuleId }),
      }),
  }
}

function auditMethods(request: Requester, api: string) {
  const query = (filters: AuditFilters) => auditSearchParams(filters).toString()
  return {
    auditRecords: (filters: AuditFilters, cursor?: string | null, signal?: AbortSignal) => {
      const params = auditSearchParams(filters, cursor)
      params.set('limit', '50')
      return request(`/audit/records?${params}`, decodeAuditRecords, { signal })
    },
    auditSummary: (filters: AuditFilters, signal?: AbortSignal) =>
      request(`/audit/summary?${query(filters)}`, decodeAuditSummary, { signal }),
    auditReconciliation: (filters: AuditFilters, signal?: AbortSignal) =>
      request(`/audit/reconciliation?${query(filters)}`, decodeAuditReconciliation, { signal }),
    auditCutovers: (filters: AuditFilters, signal?: AbortSignal) => {
      const params = new URLSearchParams()
      if (filters.device) params.set('device', filters.device)
      if (filters.provider) params.set('provider', filters.provider)
      return request(`/audit/cutover-events?${params}`, decodeAuditCutovers, { signal })
    },
    auditExportUrl: (filters: AuditFilters, format: 'csv' | 'json') => {
      const params = auditSearchParams(filters)
      params.set('format', format)
      return `${api}/api/admin/audit/export?${params}`
    },
  }
}

function alertMethods(request: Requester) {
  return {
    alerts: (signal?: AbortSignal) => request('/alerts', decodeAlertCenter, { signal }),
    createAlertRule: (rule: AlertRuleInput) => request('/alerts/rules', decodeAlertRuleResponse, {
      method: 'POST', body: JSON.stringify(rule),
    }),
    updateAlertRule: (id: number, rule: AlertRuleInput) =>
      request(`/alerts/rules/${id}`, decodeAlertRuleResponse, {
        method: 'PUT', body: JSON.stringify(rule),
      }),
    setAlertRuleEnabled: (id: number, enabled: boolean) =>
      request(`/alerts/rules/${id}/enabled`, decodeAlertRuleResponse, {
        method: 'POST', body: JSON.stringify({ enabled }),
      }),
    acknowledgeAlert: (id: number) => request(
      `/alerts/events/${id}/acknowledge`, decodeOk, { method: 'POST' },
    ),
    evaluateAlerts: () => request('/alerts/evaluate', decodeAlertEvaluation, {
      method: 'POST',
    }),
  }
}

function attributionMethods(request: Requester) {
  return {
    projectAttribution: (signal?: AbortSignal) => request(
      '/attribution/projects', decodeProjectAttribution, { signal },
    ),
    updateProjectGroupName: (groupId: number, displayName: string | null) => request(
      `/attribution/project-groups/${groupId}`, decodeProjectAttributionMutation, {
        method: 'PATCH', body: JSON.stringify({ display_name: displayName }),
      },
    ),
    mergeProject: (deviceId: string, projectId: string, targetGroupId: number) => request(
      '/attribution/projects/merge', decodeProjectAttributionMutation, {
        method: 'POST', body: JSON.stringify({
          device_id: deviceId, project_id: projectId, target_group_id: targetGroupId,
        }),
      },
    ),
  }
}

export function createAdminApi(api = API, fetcher?: Fetcher) {
  const request = createRequester(api, fetcher)
  return {
    ...sessionMethods(request),
    ...deviceCredentialMethods(request),
    ...pricingMethods(request),
    ...maintenanceMethods(request),
    ...auditMethods(request, api),
    ...alertMethods(request),
    ...attributionMethods(request),
  }
}

export const adminApi = createAdminApi()
export type {
  AuditAdminRecord, AuditCutoverPage, AuditReconciliationResponse,
  AuditRecordsPage, AuditSummaryResponse,
} from '@tokember/contracts/audit'
export type {
  ClassifyModelResult, DeviceSummary, MaintenanceActionResult,
  MaintenanceSummary, ModelAlias, PricingMode, PricingRule, PricingRuleInput,
  RepriceResult, SystemInfo,
} from './types'
export type {
  AlertCenterResponse, AlertEvaluationResponse, AlertEvent,
  AlertRule, AlertRuleInput, AlertRuleWithEvaluation,
} from '@tokember/contracts/alerts'
export type {
  DeviceCredential, DeviceCredentialCreatedResponse,
  DeviceCredentialInput, DeviceCredentialListResponse,
} from '@tokember/contracts/security'
export type {
  ProjectAttributionGroup, ProjectAttributionMember,
  ProjectAttributionMutationResponse, ProjectAttributionResponse,
} from '@tokember/contracts/attribution'
