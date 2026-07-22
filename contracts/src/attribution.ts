import type { StatsAggregateRow } from './stats.js'

export interface ProjectAttributionMember extends StatsAggregateRow {
  device_id: string
  device_name: string
  project_id: string
  first_seen_at: string
  last_seen_at: string
}

export interface ProjectAttributionGroup extends StatsAggregateRow {
  id: number
  display_name: string | null
  members: ProjectAttributionMember[]
}

export interface ProjectAttributionResponse {
  groups: ProjectAttributionGroup[]
}

export interface ProjectAttributionMutationResponse {
  ok: true
  group_id: number
}
