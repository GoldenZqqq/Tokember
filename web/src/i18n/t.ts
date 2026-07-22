export type MessageTree = { [key: string]: string | MessageTree }

export type TranslateParams = Record<string, string | number>

function resolvePath(tree: MessageTree, path: string): string | undefined {
  const parts = path.split('.')
  let node: string | MessageTree | undefined = tree
  for (const part of parts) {
    if (node == null || typeof node === 'string') return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name]
    return value === undefined ? `{${name}}` : String(value)
  })
}

/**
 * Look up a dotted key in the active catalog.
 * Falls back to `fallback` catalog (typically English), then the key itself.
 * In tests / when `strict` is true, missing keys throw after fallback fails.
 */
export function translate(
  catalog: MessageTree,
  key: string,
  params?: TranslateParams,
  options?: { fallback?: MessageTree; strict?: boolean },
): string {
  const primary = resolvePath(catalog, key)
  if (primary !== undefined) return interpolate(primary, params)

  const secondary = options?.fallback ? resolvePath(options.fallback, key) : undefined
  if (secondary !== undefined) return interpolate(secondary, params)

  if (options?.strict) {
    throw new Error(`Missing i18n key: ${key}`)
  }
  return key
}

export type TranslateFn = (key: string, params?: TranslateParams) => string
