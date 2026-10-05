/**
 * A retirement plan: one or more target fields moving through four phases.
 * Stored as JSON in .sunset/plans/<id>.json so every step is resumable and auditable.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '../util/index.js'

export type PhaseName = 'migrate' | 'detach' | 'quarantine' | 'archive' | 'retire'
export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'blocked' | 'skipped'

export interface EnvProgress {
  env: string
  status: 'pending' | 'deployed' | 'verified' | 'failed'
  at?: string
  detail?: string
}

export interface Phase {
  name: PhaseName
  title: string
  status: PhaseStatus
  storyId?: string
  storyName?: string
  storyTitle?: string
  storyDescription?: string
  changedFiles: string[]
  manualTasks: string[]
  environments: EnvProgress[]
  startedAt?: string
  completedAt?: string
  notes: string[]
}

export interface Target {
  object: string
  field: string
  qualified: string
  verdict?: 'SAFE' | 'CAUTION' | 'BLOCKED'
}

export interface Plan {
  id: string
  kind: 'retire' | 'merge' | 'campaign'
  createdAt: string
  targets: Target[]
  mergeInto?: string // for merge plans: Object.Field__c that survives
  phases: Phase[]
  capsules: Record<string, string> // qualified field -> capsule id
  quarantine?: { startedAt: string; endsAt: string; signals: QuarantineSignal[]; watchFrom?: string } // watchFrom: only look for use after this moment (set by --clear)
  deletionPath?: 'A' | 'B' | 'C'
  history: { at: string; event: string }[]
}

export interface QuarantineSignal {
  at: string
  kind: 'write' | 'report-run' | 'error' | 'manual'
  detail: string
}

export const PHASE_TITLES: Record<PhaseName, string> = {
  migrate: 'Migrate data and references into the surviving field',
  detach: 'Detach: remove every reference that blocks deletion',
  quarantine: 'Quarantine: hide the field and watch for anyone who still needs it',
  archive: 'Archive: back up the data and prove it can be restored',
  retire: 'Retire: delete the field through the pipeline',
}

export function newPhase(name: PhaseName, envs: string[]): Phase {
  return {
    name,
    title: PHASE_TITLES[name],
    status: 'pending',
    changedFiles: [],
    manualTasks: [],
    environments: envs.map((env) => ({ env, status: 'pending' })),
    notes: [],
  }
}

export const planPath = (stateDir: string, id: string) => join(stateDir, 'plans', `${id}.json`)

export function savePlan(stateDir: string, plan: Plan) {
  writeJson(planPath(stateDir, plan.id), plan)
}

export function loadPlan(stateDir: string, id: string): Plan {
  const p = planPath(stateDir, id)
  if (!existsSync(p)) {
    const matches = listPlans(stateDir).filter((x) => x.id.toLowerCase().includes(id.toLowerCase()))
    if (matches.length === 1) return matches[0]
    throw new Error(`Plan "${id}" not found in ${join(stateDir, 'plans')}${matches.length > 1 ? ' (ambiguous)' : ''}`)
  }
  return readJson<Plan>(p, undefined as unknown as Plan)
}

export function listPlans(stateDir: string): Plan[] {
  const dir = join(stateDir, 'plans')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<Plan>(join(dir, f), undefined as unknown as Plan))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const phase = (plan: Plan, name: PhaseName) => {
  const p = plan.phases.find((x) => x.name === name)
  if (!p) throw new Error(`Plan ${plan.id} has no ${name} phase`)
  return p
}

export function log(plan: Plan, event: string) {
  plan.history.push({ at: new Date().toISOString(), event })
}

export interface GateResult {
  ok: boolean
  reasons: string[]
}

/**
 * The safety rules. A phase may start only when everything before it is
 * finished everywhere it needs to be. These are enforced in code, not docs.
 */
export function canStart(plan: Plan, name: PhaseName, opts: { prodEnv: string; now?: Date; overrideQuarantine?: boolean } ): GateResult {
  const reasons: string[] = []
  const order = plan.phases.map((p) => p.name)
  const idx = order.indexOf(name)
  if (idx < 0) return { ok: false, reasons: [`Plan has no ${name} phase`] }
  for (const prev of plan.phases.slice(0, idx)) {
    if (prev.status !== 'done' && prev.status !== 'skipped') reasons.push(`Phase "${prev.name}" is ${prev.status}; finish it first.`)
  }
  if (plan.targets.some((t) => t.verdict === 'BLOCKED')) reasons.push('A target has a BLOCKED usage verdict (someone is actively using it).')

  if (name === 'quarantine' || name === 'archive' || name === 'retire') {
    const detach = plan.phases.find((p) => p.name === 'detach')
    const prod = detach?.environments.find((e) => e.env === opts.prodEnv)
    if (detach && prod && prod.status !== 'verified' && prod.status !== 'deployed') reasons.push(`Detach changes have not reached ${opts.prodEnv} yet.`)
  }
  if (name === 'retire') {
    const now = opts.now ?? new Date()
    const q = plan.quarantine
    if (!q) reasons.push('Quarantine has not started.')
    else {
      if (q.signals.length > 0) reasons.push(`Quarantine recorded ${q.signals.length} signal(s) that someone still uses the field. Resolve them first.`)
      if (new Date(q.endsAt) > now && !opts.overrideQuarantine) reasons.push(`Quarantine period ends ${q.endsAt.slice(0, 10)}. Wait, or pass --override-quarantine with typed confirmation.`)
    }
    for (const t of plan.targets) if (!plan.capsules[t.qualified]) reasons.push(`No restore capsule for ${t.qualified}. Run the archive phase first.`)
  }
  return { ok: reasons.length === 0, reasons }
}
