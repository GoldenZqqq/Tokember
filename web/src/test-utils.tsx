import { createElement, type ReactNode } from 'react'
import { LocaleProvider } from './i18n'

/** Wrap UI under test so useT() / LanguageSwitch work in node:test SSR. */
export function withLocale(children: ReactNode) {
  return createElement(LocaleProvider, null, children)
}
