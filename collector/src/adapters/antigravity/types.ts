import type { UsageRecord } from '../types.js'

export type AntigravityApp = 'antigravity' | 'antigravity-cli' | 'antigravity-ide'

export interface ConversationRoot {
  dir: string
  app: AntigravityApp
  extensions: readonly string[]
}

export interface ConversationSource {
  path: string
  app: AntigravityApp
}

export interface ServerInfo {
  port: number
  csrfToken: string
}

export interface GeneratorMetadata {
  chatModel?: {
    usage?: {
      model?: string
      inputTokens?: string
      outputTokens?: string
      thinkingOutputTokens?: string
      responseOutputTokens?: string
      responseId?: string
    }
    chatStartMetadata?: { createdAt?: string }
  }
}

export interface CachedCascade {
  mtimeMs: number
  sizeBytes: number
  records: UsageRecord[]
}

export interface AntigravityCache {
  version: 1
  cascades: Record<string, CachedCascade>
}
