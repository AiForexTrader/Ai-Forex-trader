import type { Session } from './types'

export const SESSION_CONFIG = {
  asian: { timeZone: 'Asia/Tokyo', startHour: 0, endHour: 8 },
  london: { timeZone: 'Europe/London', startHour: 8, endHour: 13 },
  newYork: { timeZone: 'America/New_York', startHour: 8, endHour: 17 },
} as const

const zonedHour = (date: Date, timeZone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date))
const zonedMinute = (date: Date, timeZone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone, minute: '2-digit' }).format(date))

export const getActiveSession = (date = new Date()): Session => {
  const londonHour = zonedHour(date, 'Europe/London')
  const newYorkHour = zonedHour(date, 'America/New_York')
  const newYorkMinute = zonedMinute(date, 'America/New_York')
  const newYorkDecimal = newYorkHour + newYorkMinute / 60

  if (londonHour >= 8 && londonHour < 13 && newYorkDecimal >= 3 && newYorkDecimal < 8) return 'LONDON / NY OVERLAP'
  if (londonHour >= 8 && londonHour < 13) return 'LONDON'
  if (newYorkDecimal >= 8 && newYorkDecimal < 17) return 'NEW YORK'
  if (newYorkDecimal >= 19 || newYorkDecimal < 4) return 'ASIA'
  return 'OFF HOURS'
}

export const formatSession = (session: Session) => session === 'LONDON / NY OVERLAP' ? 'LONDON / NY' : session
