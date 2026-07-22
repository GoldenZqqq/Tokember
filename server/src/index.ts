import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { assertRuntimeAuthConfig } from './api-auth.js'
import { initDB, resolveDbPath } from './db.js'
import { apiRoutes } from './routes.js'
import { BUILD_INFO } from './build-info.js'
import { SERVER_STARTED_AT } from './health.js'
import { createAlertWorker } from './alerts/worker.js'
import { createCorsMiddleware } from './security/cors.js'

const app = new Hono()
const dbPath = resolveDbPath(process.env.DB_PATH)
const db = initDB(dbPath)
assertRuntimeAuthConfig(db)
const alertWorker = createAlertWorker(db, {
  onError: message => console.error(message),
})

app.use('*', createCorsMiddleware())
app.route('/api', apiRoutes(db, dbPath, { buildInfo: BUILD_INFO }))

const port = Number(process.env.PORT) || 3147
serve({ fetch: app.fetch, port }, () => {
  console.log(`Tokember server running on :${port} (started ${SERVER_STARTED_AT})`)
})
alertWorker.start()
