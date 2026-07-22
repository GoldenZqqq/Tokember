import type { DB } from '../db.js'
import { runAlertEvaluation } from './reconcile.js'
import {
  deliverDueAlertWebhooks,
  readAlertWebhookConfig,
  type AlertWebhookFetcher,
} from './webhook.js'

interface AlertWorkerOptions {
  env?: NodeJS.ProcessEnv
  fetcher?: AlertWebhookFetcher
  intervalMs?: number
  now?: () => Date
  onError?: (message: string) => void
}

export interface AlertWorker {
  start: () => void
  stop: () => void
  runOnce: () => Promise<boolean>
}

export function createAlertWorker(db: DB, options: AlertWorkerOptions = {}): AlertWorker {
  let timer: NodeJS.Timeout | null = null
  let running = false
  const runOnce = async () => {
    if (running) return false
    running = true
    try {
      const config = readAlertWebhookConfig(options.env)
      const now = options.now?.() ?? new Date()
      runAlertEvaluation(db, { now, webhookConfigured: config != null })
      if (config) await deliverDueAlertWebhooks(db, {
        now, config, fetcher: options.fetcher,
      })
      return true
    } catch {
      options.onError?.('[alerts] background evaluation failed')
      return false
    } finally {
      running = false
    }
  }
  return {
    runOnce,
    start: () => {
      if (timer) return
      void runOnce()
      timer = setInterval(() => { void runOnce() }, options.intervalMs ?? 60_000)
      timer.unref()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
