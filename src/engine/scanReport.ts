/** Scanner: rank an object's fields by how safe they are to retire. Reporter: before/after summary. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agentia } from '../adapters/agentia.js'
import type { Salesforce } from '../adapters/salesforce.js'
import type { LoadedConfig } from '../core/config.js'
import type { Plan } from '../core/plan.js'
import { listCustomFields, scanRepo } from '../core/referenceFinder.js'
import { ensureDir } from '../util/index.js'
import { loadCapsule } from './capsule.js'

export interface FieldCandidate {
  qualified: string
  field: string
  label?: string
  type?: string
  blockers: number
  hazards: number
  warnings: number
  fillRatePct?: number
  populated?: number
  score: number // 0-100, higher = safer to retire
  reason: string
}

export function scoreCandidate(c: Omit<FieldCandidate, 'score' | 'reason'>): { score: number; reason: string } {
  let score = 100
  score -= Math.min(45, c.blockers * 12)
  score -= Math.min(15, c.hazards * 2)
  score -= Math.min(15, c.warnings * 5)
  if (c.fillRatePct !== undefined) score -= Math.min(40, c.fillRatePct * 4)
  score = Math.max(0, Math.round(score))
  const parts: string[] = []
  parts.push(c.blockers ? `${c.blockers} blocker(s)` : 'no blockers')
  if (c.fillRatePct !== undefined) parts.push(`${c.fillRatePct.toFixed(1)}% filled`)
  if (c.warnings) parts.push(`${c.warnings} report(s)`)
  return { score, reason: parts.join(', ') }
}

export function scanObject(cfg: LoadedConfig, object: string, opts: { sf?: Salesforce; env?: { sfAlias: string }; limit?: number }): { candidates: FieldCandidate[]; totalCustomFields: number; headroom: number } {
  const fields = listCustomFields(cfg.root, object)
  let total: number | undefined
  if (opts.sf && opts.env) {
    try {
      total = opts.sf.count(opts.env.sfAlias, `SELECT COUNT() FROM ${object}`)
    } catch {
      total = undefined
    }
  }
  const candidates: FieldCandidate[] = []
  for (const f of fields) {
    const qualified = `${object}.${f.field}`
    const r = scanRepo(cfg.root, qualified)
    const label = /<label>([^<]*)<\/label>/.exec(f.xml)?.[1]
    const type = /<type>([^<]*)<\/type>/.exec(f.xml)?.[1]
    const isFormula = /<formula>/.test(f.xml)
    let fillRatePct: number | undefined
    let populated: number | undefined
    if (opts.sf && opts.env && total && !isFormula && !/LongTextArea|Html|EncryptedText|MultiselectPicklist/i.test(type ?? '')) {
      try {
        populated = opts.sf.count(opts.env.sfAlias, `SELECT COUNT() FROM ${object} WHERE ${f.field} ${type === 'Checkbox' ? '= true' : '!= null'}`)
        fillRatePct = (populated / total) * 100
      } catch {
        /* non-filterable or missing in org */
      }
    }
    const base = { qualified, field: f.field, label, type, blockers: r.summary.blocker, hazards: r.summary.repoHazard, warnings: r.summary.warning, fillRatePct, populated }
    candidates.push({ ...base, ...scoreCandidate(base) })
  }
  candidates.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field))
  return { candidates: opts.limit ? candidates.slice(0, opts.limit) : candidates, totalCustomFields: fields.length, headroom: cfg.fieldLimit - fields.length }
}

export function writeReport(cfg: LoadedConfig, plan: Plan, agentia?: Agentia, withAi = false): string {
  const lines: string[] = []
  lines.push(`# Sunset report: ${plan.targets.map((t) => t.qualified).join(', ')}`, '')
  lines.push(`Plan \`${plan.id}\` (${plan.kind}), created ${plan.createdAt.slice(0, 10)}.`, '')
  lines.push('## Phases', '', '| Phase | Status | Story | Environments | Files changed | Manual tasks |', '|---|---|---|---|---|---|')
  for (const p of plan.phases) {
    lines.push(`| ${p.name} | ${p.status} | ${p.storyName ?? '—'} | ${p.environments.map((e) => `${e.env}:${e.status}`).join(' ')} | ${p.changedFiles.length} | ${p.manualTasks.length} |`)
  }
  lines.push('', '## Backups', '')
  for (const t of plan.targets) {
    const id = plan.capsules[t.qualified]
    if (!id) {
      lines.push(`- ${t.qualified}: no capsule yet`)
      continue
    }
    const m = loadCapsule(cfg.stateDir, id)
    const counts = m.data.map((d) => `${d.env} ${d.rows}/${d.expectedRows}`).join(', ')
    lines.push(`- ${t.qualified}: capsule \`${id}\`; values ${counts || 'not exported yet'}; ${m.originals.length} original file(s) preserved; proof ${m.proof.rowCountsMatch && m.proof.checksumsRecorded ? 'verified' : 'pending'}.`)
  }
  if (plan.quarantine) {
    lines.push('', '## Quarantine', '', `From ${plan.quarantine.startedAt.slice(0, 10)} to ${plan.quarantine.endsAt.slice(0, 10)}; ${plan.quarantine.signals.length} signal(s).`)
    for (const s of plan.quarantine.signals) lines.push(`- ${s.at.slice(0, 10)} ${s.kind}: ${s.detail}`)
  }
  const manual = plan.phases.flatMap((p) => p.manualTasks.map((m) => `- [${p.name}] ${m}`))
  if (manual.length) lines.push('', '## Manual tasks', '', ...manual)
  const retired = plan.phases.find((p) => p.name === 'retire')?.status === 'done'
  lines.push('', '## Impact', '', retired ? `- ${plan.targets.length} field(s) retired; ${plan.targets.length} slot(s) will be reclaimed once the deleted fields are erased (Salesforce keeps them 15 days).` : '- Retirement not completed yet.')
  const filesTouched = new Set(plan.phases.flatMap((p) => p.changedFiles)).size
  lines.push(`- ${filesTouched} metadata file(s) changed automatically across all phases.`)

  if (withAi && agentia) {
    try {
      lines.push('', '## Release notes (Release agent)', '', agentia.ask('release', `Write short release notes (max 8 lines) for this Salesforce metadata retirement: ${JSON.stringify({ targets: plan.targets, phases: plan.phases.map((p) => ({ name: p.name, status: p.status, story: p.storyName, files: p.changedFiles.length })) })}`).trim())
      lines.push('', '## Stakeholder notice (Operate agent)', '', agentia.ask('operate', `Write a short, friendly notice (max 6 lines) for Salesforce users and report owners explaining that these fields were retired, why, and how to ask for them back: ${plan.targets.map((t) => t.qualified).join(', ')}`).trim())
    } catch (err) {
      lines.push('', `_AI notes unavailable: ${(err as Error).message.split('\n')[0]}_`)
    }
  }
  const dir = join(cfg.stateDir, 'reports')
  ensureDir(dir)
  const file = join(dir, `${plan.id}.md`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}
