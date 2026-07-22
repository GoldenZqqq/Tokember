export type MachinePlatform = 'windows' | 'macos' | 'linux' | 'other'

export interface MachineMetadata {
  platform: MachinePlatform
  architecture: string
  hostname: string
}
