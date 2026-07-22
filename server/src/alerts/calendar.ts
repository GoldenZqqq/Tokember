import type { AlertPeriod } from '@tokember/contracts/alerts'

export interface UtcWindow {
  since: string
  until: string
}

interface CalendarParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let current = formatters.get(timeZone)
  if (current) return current
  current = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  formatters.set(timeZone, current)
  return current
}

function partsAt(value: Date, timeZone: string): CalendarParts {
  const values = Object.fromEntries(formatter(timeZone).formatToParts(value)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]))
  return {
    year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second,
  }
}

function epoch(parts: CalendarParts): number {
  return Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second,
  )
}

function localMidnightToUtc(parts: CalendarParts, timeZone: string): Date {
  const target = { ...parts, hour: 0, minute: 0, second: 0 }
  let guess = epoch(target)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const difference = epoch(target) - epoch(partsAt(new Date(guess), timeZone))
    if (difference === 0) return new Date(guess)
    guess += difference
  }
  return new Date(guess)
}

function shiftedDate(parts: CalendarParts, days: number): CalendarParts {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: value.getUTCFullYear(), month: value.getUTCMonth() + 1,
    day: value.getUTCDate(), hour: 0, minute: 0, second: 0,
  }
}

function nextMonth(parts: CalendarParts): CalendarParts {
  const value = new Date(Date.UTC(parts.year, parts.month, 1))
  return {
    year: value.getUTCFullYear(), month: value.getUTCMonth() + 1,
    day: 1, hour: 0, minute: 0, second: 0,
  }
}

export function localPeriodWindow(
  now: Date,
  period: AlertPeriod,
  timeZone: string,
): UtcWindow {
  const current = partsAt(now, timeZone)
  const start = period === 'month' ? { ...current, day: 1 } : current
  const end = period === 'month' ? nextMonth(start) : shiftedDate(start, 1)
  return {
    since: localMidnightToUtc(start, timeZone).toISOString(),
    until: localMidnightToUtc(end, timeZone).toISOString(),
  }
}

export function completeLocalDayWindows(
  now: Date,
  timeZone: string,
  count: number,
): UtcWindow[] {
  const current = partsAt(now, timeZone)
  return Array.from({ length: count }, (_, index) => {
    const start = shiftedDate(current, -(count - index))
    const end = shiftedDate(start, 1)
    return {
      since: localMidnightToUtc(start, timeZone).toISOString(),
      until: localMidnightToUtc(end, timeZone).toISOString(),
    }
  })
}
