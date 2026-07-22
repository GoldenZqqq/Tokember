export function canonicalAntigravityModel(raw: string, display?: string): string {
  const value = (display ?? raw).toLowerCase()
  if (value.includes('3.5 flash')) {
    if (value.includes('high')) return 'gemini-3.5-flash-high'
    if (value.includes('medium')) return 'gemini-3.5-flash-medium'
    if (value.includes('low')) return 'gemini-3.5-flash-low'
    return 'gemini-3.5-flash'
  }
  if (value.includes('3.1 pro')) {
    if (value.includes('high')) return 'gemini-3.1-pro-high'
    if (value.includes('low')) return 'gemini-3.1-pro-low'
    return 'gemini-3.1-pro'
  }
  if (value.includes('3.1 flash')) {
    if (value.includes('image')) return 'gemini-3.1-flash-image'
    if (value.includes('lite')) return 'gemini-3.1-flash-lite'
    return 'gemini-3.1-flash'
  }
  if (value.includes('3 flash')) return 'gemini-3-flash'
  if (value.includes('3 pro')) return 'gemini-3-pro'
  return raw
}
