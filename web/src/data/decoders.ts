export type JsonObject = Record<string, unknown>

export function objectValue(value: unknown, label = 'object'): JsonObject {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

export function arrayValue(value: unknown, label = 'array'): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

export function stringValue(value: unknown, label = 'string'): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

export function nullableString(value: unknown, label = 'string'): string | null {
  return value == null ? null : stringValue(value, label)
}

export function numberValue(value: unknown, label = 'number'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

export function booleanValue(value: unknown, label = 'boolean'): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

export function optionalString(value: unknown, label = 'string'): string | undefined {
  return value == null ? undefined : stringValue(value, label)
}

export function literalValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label = 'value',
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`)
  }
  return value as T
}
