import type { TranslateFn } from './t'

/** Map stable English (and legacy Chinese) server error bodies to message keys. */
const SERVER_ERROR_KEYS: Record<string, string> = {
  // English / stable
  'Invalid pricing rule input': 'server.pricingInvalid',
  'A rule for this model already exists in this scope': 'server.pricingExists',
  'Pricing rule not found': 'server.pricingMissing',
  'Invalid rule id': 'server.pricingIdInvalid',
  'Remove aliases incompatible with the new source first': 'server.aliasIncompatible',
  'Invalid model alias input': 'server.aliasInvalid',
  'This source alias is already mapped to another model': 'server.aliasConflict',
  'Cannot map into a disabled pricing rule': 'server.aliasDisabled',
  'Alias source is incompatible with the pricing rule source': 'server.aliasSourceMismatch',
  'Alias matches the canonical model; no mapping needed': 'server.aliasSameAsModel',
  'Invalid alias id': 'server.aliasIdInvalid',
  'Model alias not found': 'server.aliasMissing',
  'Invalid ignore pattern': 'server.ignoreInvalid',
  'Invalid classify input': 'server.classifyInvalid',
  'This source model is already mapped to another rule': 'server.classifyConflict',
  'Target pricing rule is disabled': 'server.classifyDisabled',
  'Target rule does not apply to this source': 'server.classifySourceMismatch',
  'Model is already the target canonical name': 'server.classifySame',
  'Incorrect password': 'server.passwordWrong',
  // Legacy Chinese (admin-routes)
  '价格规则参数无效': 'server.pricingInvalid',
  '该模型在此规则范围内已存在': 'server.pricingExists',
  '价格规则不存在': 'server.pricingMissing',
  '规则 ID 无效': 'server.pricingIdInvalid',
  '请先移除与新来源不兼容的模型别名': 'server.aliasIncompatible',
  '模型别名参数无效': 'server.aliasInvalid',
  '计价规则不存在': 'server.aliasMissingRule',
  '该来源的别名已归入其他模型': 'server.aliasConflict',
  '不能归入已停用的计价规则': 'server.aliasDisabled',
  '别名来源与计价规则来源不兼容': 'server.aliasSourceMismatch',
  '别名与标准模型相同，无需归类': 'server.aliasSameAsModel',
  '别名 ID 无效': 'server.aliasIdInvalid',
  '模型别名不存在': 'server.aliasMissing',
  '忽略模式无效': 'server.ignoreInvalid',
  '归类参数无效': 'server.classifyInvalid',
  '该来源的模型已归入其他规则': 'server.classifyConflict',
  '目标计价规则已停用': 'server.classifyDisabled',
  '目标规则不适用于该来源': 'server.classifySourceMismatch',
  '该模型已经是目标标准模型': 'server.classifySame',
  '密码错误': 'server.passwordWrong',
}

export function formatServerError(raw: string, t: TranslateFn): string {
  const key = SERVER_ERROR_KEYS[raw]
  if (key) return t(key)
  return raw
}
