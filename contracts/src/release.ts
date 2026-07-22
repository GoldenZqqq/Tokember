export interface BuildInfo {
  schema_version: 2
  release_id: string
  version: string
  commit: string
  built_at: string
  node_version: string
  architecture: string
  lockfile_sha256: string
  runtime_dependencies: Record<string, string>
}
