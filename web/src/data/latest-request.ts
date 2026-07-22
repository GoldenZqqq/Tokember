export interface LatestResult<T> {
  current: boolean
  value?: T
}

export class LatestRequest {
  private sequence = 0
  private controller?: AbortController

  async execute<T>(loader: (signal: AbortSignal) => Promise<T>): Promise<LatestResult<T>> {
    const sequence = ++this.sequence
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    try {
      const value = await loader(controller.signal)
      return this.isCurrent(sequence, controller)
        ? { current: true, value }
        : { current: false }
    } catch (error) {
      if (!this.isCurrent(sequence, controller)) return { current: false }
      throw error
    }
  }

  cancel(): void {
    this.sequence += 1
    this.controller?.abort()
    this.controller = undefined
  }

  private isCurrent(sequence: number, controller: AbortController): boolean {
    return sequence === this.sequence && controller === this.controller
  }
}
