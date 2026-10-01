/**
 * Blocker Oracle. Instead of guessing which references stop a deletion, run a
 * check-only destructive validation and let Salesforce itself answer.
 * Nothing is changed in the org.
 */
import type { Salesforce, DeployOutcome } from '../adapters/salesforce.js'

export interface OracleBlocker {
  type: string // e.g. "Apex Class"
  name: string // e.g. "TerritoryAssigner"
  message: string
}

export interface OracleResult {
  env: string
  deletable: boolean
  blockers: OracleBlocker[]
  otherErrors: string[]
}

const REFERENCE_RE = /referenced|in use|is used by|used in|dependent|depends on/i
const PAIR_RE = /([A-Z][A-Za-z ]{2,40}?)\s+-\s+([A-Za-z0-9_.:$-]+)/g

export function parseOracle(env: string, outcome: DeployOutcome, targetQualified: string): OracleResult {
  const blockers: OracleBlocker[] = []
  const otherErrors: string[] = []
  for (const f of outcome.failures) {
    const relevant = !f.fullName || f.fullName.toLowerCase() === targetQualified.toLowerCase() || f.problem.toLowerCase().includes(targetQualified.split('.')[1].toLowerCase())
    if (relevant && REFERENCE_RE.test(f.problem)) {
      const pairs = [...f.problem.matchAll(PAIR_RE)]
      if (pairs.length === 0) blockers.push({ type: 'Unknown', name: '', message: f.problem })
      for (const m of pairs) blockers.push({ type: m[1].trim(), name: m[2].trim().replace(/[.,;]$/, ''), message: f.problem })
    } else {
      otherErrors.push(`${f.componentType} ${f.fullName}: ${f.problem}`.trim())
    }
  }
  // Dedupe
  const seen = new Set<string>()
  const unique = blockers.filter((b) => {
    const k = `${b.type}|${b.name}`.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { env, deletable: outcome.success, blockers: unique, otherErrors }
}

export function askOracle(sf: Salesforce, env: { name: string; sfAlias: string }, object: string, field: string, apiVersion: string): OracleResult {
  const qualified = `${object}.${field}`
  const outcome = sf.validateDestructive(env.sfAlias, [{ type: 'CustomField', name: qualified }], apiVersion)
  return parseOracle(env.name, outcome, qualified)
}
