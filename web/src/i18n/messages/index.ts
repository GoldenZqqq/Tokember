import type { Locale } from '../locales'
import type { MessageTree } from '../t'
import { en } from './en'
import { zh } from './zh'

export const catalogs: Record<Locale, MessageTree> = {
  en: en as unknown as MessageTree,
  zh: zh as unknown as MessageTree,
}

export { en, zh }
