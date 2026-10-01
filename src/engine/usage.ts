/**
 * Usage Analyzer: is anyone actually using this field in production?
 * Produces a SAFE / CAUTION / BLOCKED verdict with plain-English reasons.
 */
import type { Salesforce } from '../adapters/salesforce.js'

export interface UsageFacts {
  env: string
  fieldType: string
  filterable: boolean
  required: boolean
  totalRecords: number
  populated: number
  fillRatePct: number
  lastWritten?: string // newest LastModifiedDate among populated records (approximation)
  lastWrittenBy?: string
  recentPopulatedWrites: number // populated records modified within recentDays
  historyTracked: boolean
  lastHistoryChange?: string
  reports: { name: string; lastRunDate?: string }[]
  sampled: boolean
  notes: string[]
}

export type Verdict = 'SAFE' | 'CAUTION' | 'BLOCKED'

export interface UsageVerdict {
  verdict: Verdict
  reasons: string[]
}

const isoDaysAgo = (days: number, now = new Date()) => new Date(now.getTime() - days * 86_400_000)

/** Pure decision logic, unit-tested. */
export function decideVerdict(f: UsageFacts, opts: { recentDays: number; cautionFillRatePct: number; staleDays: number; now?: Date }): UsageVerdict {
  const now = opts.now ?? new Date()
  const reasons: string[] = []
  let verdict: Verdict = 'SAFE'
  const recentCut = isoDaysAgo(opts.recentDays, now)
  const staleCut = isoDaysAgo(opts.staleDays, now)
  const bump = (v: Verdict) => {
    if (v === 'BLOCKED' || (v === 'CAUTION' && verdict === 'SAFE')) verdict = v
  }

  if (f.required) {
    bump('BLOCKED')
    reasons.push('Field is required; it cannot be hidden or safely retired without changing the requirement first.')
  }
  if (f.lastHistoryChange && new Date(f.lastHistoryChange) >= recentCut) {
    bump('BLOCKED')
    reasons.push(`Field history shows a change on ${f.lastHistoryChange.slice(0, 10)} (within ${opts.recentDays} days).`)
  }
  if (f.recentPopulatedWrites > 0 && f.lastWritten && new Date(f.lastWritten) >= recentCut) {
    bump('BLOCKED')
    reasons.push(`${f.recentPopulatedWrites} record(s) with a value were modified in the last ${opts.recentDays} days${f.lastWrittenBy ? `, most recently by ${f.lastWrittenBy}` : ''}.`)
  }
  if (f.fillRatePct >= opts.cautionFillRatePct) {
    bump('CAUTION')
    reasons.push(`${f.fillRatePct.toFixed(1)}% of records have a value (threshold ${opts.cautionFillRatePct}%).`)
  }
  if (f.lastWritten && new Date(f.lastWritten) >= staleCut && new Date(f.lastWritten) < recentCut) {
    bump('CAUTION')
    reasons.push(`Last written ${f.lastWritten.slice(0, 10)}, within the last ${opts.staleDays} days.`)
  }
  const recentReports = f.reports.filter((r) => r.lastRunDate && new Date(r.lastRunDate) >= staleCut)
  if (recentReports.length) {
    bump('CAUTION')
    reasons.push(`${recentReports.length} report(s) using it ran in the last ${opts.staleDays} days: ${recentReports.map((r) => r.name).join(', ')}.`)
  }
  if (verdict === 'SAFE') {
    reasons.push(
      f.populated === 0
        ? 'No records have a value.'
        : `Only ${f.fillRatePct.toFixed(1)}% of records have a value${f.lastWritten ? `, last written ${f.lastWritten.slice(0, 10)}` : ''}.`,
    )
    if (f.reports.length) reasons.push(`${f.reports.length} report(s) reference it; none ran in the last ${opts.staleDays} days.`)
  }
  return { verdict, reasons }
}

const historyObject = (object: string) => (object.endsWith('__c') ? object.replace(/__c$/, '__History') : `${object}History`)
const nonNull = (field: string, type: string) => (type === 'boolean' ? `${field} = true` : `${field} != null`)

export function analyzeUsage(
  sf: Salesforce,
  env: { name: string; sfAlias: string },
  object: string,
  field: string,
  reportNames: string[],
  recentDays: number,
  ignoreWritesBefore?: string, // ISO datetime: ignore edits from a known bulk load/migration before this moment
): UsageFacts {
  const notes: string[] = []
  const describe = sf.describe(env.sfAlias, object)
  const meta = (describe?.fields ?? []).find((f: any) => String(f.name).toLowerCase() === field.toLowerCase())
  if (!meta) throw new Error(`${object}.${field} does not exist in ${env.name} (${env.sfAlias}).`)
  const fieldType = String(meta.type)
  const filterable = Boolean(meta.filterable)
  const required = meta.nillable === false && meta.defaultedOnCreate === false && fieldType !== 'boolean'
  const totalRecords = sf.count(env.sfAlias, `SELECT COUNT() FROM ${object}`)

  let populated = 0
  let sampled = false
  let lastWritten: string | undefined
  let lastWrittenBy: string | undefined
  let recentPopulatedWrites = 0

  const after = ignoreWritesBefore ? ` AND LastModifiedDate > ${new Date(ignoreWritesBefore).toISOString().slice(0, 19)}Z` : ''
  if (ignoreWritesBefore) notes.push(`Edits before ${ignoreWritesBefore} are ignored (usage.ignoreWritesBefore), e.g. a bulk data load.`)
  if (filterable) {
    populated = sf.count(env.sfAlias, `SELECT COUNT() FROM ${object} WHERE ${nonNull(field, fieldType)}`)
    if (populated > 0) {
      const latest = sf.query(env.sfAlias, `SELECT LastModifiedDate, LastModifiedBy.Name FROM ${object} WHERE ${nonNull(field, fieldType)}${after} ORDER BY LastModifiedDate DESC LIMIT 1`)
      lastWritten = latest.records[0]?.LastModifiedDate
      lastWrittenBy = latest.records[0]?.LastModifiedBy?.Name
      recentPopulatedWrites = sf.count(env.sfAlias, `SELECT COUNT() FROM ${object} WHERE ${nonNull(field, fieldType)} AND LastModifiedDate = LAST_N_DAYS:${recentDays}${after}`)
    }
    notes.push('Last-written dates use the record LastModifiedDate, which changes on any edit; field history (if tracked) is more precise.')
  } else {
    sampled = true
    const sample = sf.query(env.sfAlias, `SELECT ${field}, LastModifiedDate, LastModifiedBy.Name FROM ${object} ORDER BY LastModifiedDate DESC LIMIT 2000`)
    const withValue = sample.records.filter((r: any) => r[field] !== null && r[field] !== undefined && r[field] !== '')
    populated = Math.round((withValue.length / Math.max(1, sample.records.length)) * totalRecords)
    lastWritten = withValue[0]?.LastModifiedDate
    lastWrittenBy = withValue[0]?.LastModifiedBy?.Name
    recentPopulatedWrites = withValue.filter((r: any) => new Date(r.LastModifiedDate) >= isoDaysAgo(recentDays)).length
    notes.push(`${fieldType} fields cannot be filtered in SOQL, so usage was estimated from the 2,000 most recently modified records.`)
  }

  let historyTracked = false
  let lastHistoryChange: string | undefined
  try {
    const hAfter = ignoreWritesBefore ? ` AND CreatedDate > ${new Date(ignoreWritesBefore).toISOString().slice(0, 19)}Z` : ''
    const h = sf.query(env.sfAlias, `SELECT CreatedDate FROM ${historyObject(object)} WHERE Field = '${field}'${hAfter} ORDER BY CreatedDate DESC LIMIT 1`)
    historyTracked = true
    lastHistoryChange = h.records[0]?.CreatedDate
  } catch {
    /* history not tracked or object has no history */
  }

  const reports: { name: string; lastRunDate?: string }[] = []
  const devNames = reportNames.map((n) => n.split('/').pop() ?? n).filter(Boolean)
  if (devNames.length) {
    try {
      const inList = devNames.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(',')
      const r = sf.query(env.sfAlias, `SELECT DeveloperName, Name, LastRunDate FROM Report WHERE DeveloperName IN (${inList})`)
      for (const rec of r.records) reports.push({ name: rec.Name ?? rec.DeveloperName, lastRunDate: rec.LastRunDate ?? undefined })
    } catch {
      notes.push('Could not read Report.LastRunDate.')
    }
  }

  return {
    env: env.name,
    fieldType,
    filterable,
    required,
    totalRecords,
    populated,
    fillRatePct: totalRecords ? (populated / totalRecords) * 100 : 0,
    lastWritten,
    lastWrittenBy,
    recentPopulatedWrites,
    historyTracked,
    lastHistoryChange,
    reports,
    sampled,
    notes,
  }
}
