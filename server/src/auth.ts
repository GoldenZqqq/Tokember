// Compatibility entrypoint for code that historically imported server auth.
// New routes construct one DB-backed SessionService per API application.
export { SessionService } from './security/session.js'
