/**
 * The phase engine. Each function runs one phase for every target in a plan,
 * saving state after every step so any run can be resumed safely.
 *
 *   (merge only) migrate → detach → quarantine → archive → retire
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Agentia, Story } from '../adapters/agentia.js'
import { prodEnv, sourceEnv, type LoadedConfig } from '../core/config.js'
import { canStart, log, newPhase, phase, savePlan, type Phase, type PhaseName, type Plan, type Target } from '../core/plan.js'
import { findFieldFile, scanRepo, type Reference } from '../core/referenceFinder.js'
import { csvObjects, toCsv } from '../util/csv.js'
import { ApprovalError, color, confirm, ensureDir, icon, notifySlack, shortId, slug, typedConfirm, writeJson } from '../util/index.js'
import {
  addTombstone,
  capsuleDir,
  createCapsule,
  evaluateProof,
  fieldDefinitionXml,
  loadCapsule,
  preserveFieldDefinition,
  preserveOriginal,
  recordDataFile,
  removeTombstone,
  restoreOriginals,
  saveCapsule,
  verifyChecksums,
  type CapsuleManifest,
} from './capsule.js'
import type { Investigation } from './investigator.js'
import { askOracle } from './oracle.js'
import { inactiveFlowVersions, inactiveFlowVersionsByIds } from './orgReferences.js'
import { proposeAndApply } from './patcher.js'
import { commitToStory, promoteThroughPipeline, type ReleaseDeps } from './release.js'
import { detachEditorFor, isPermissionFile, removeFieldPermission, removeFromReport, setFieldPermission } from './xmlEditors.js'

export interface RunOptions {
  yes?: boolean
  confirm?: string
  untilEnv?: string
  overrideQuarantine?: boolean
  noCommit?: boolean // make local changes only (useful for review / dry runs)
}

// ------------------------------------------------------------------ plan
export interface StoryText {
  title: string
  description: string
}

export function defaultStoryText(name: PhaseName, targets: Target[], mergeInto?: string): StoryText {
  const list = targets.map((t) => t.qualified).join(', ')
  const texts: Record<PhaseName, StoryText> = {
    migrate: { title: `Sunset: migrate ${list} into ${mergeInto}`, description: `Copy data from ${list} into ${mergeInto} and repoint every reference.\n\nAcceptance criteria:\n- Every non-empty value exists in ${mergeInto}\n- No metadata references ${list}` },
    detach: { title: `Sunset: detach references to ${list}`, description: `Remove every reference that blocks deleting ${list} (code, Flows, formulas, validation rules, layouts, list views).\n\nAcceptance criteria:\n- Blocker Oracle reports no blockers outside obsolete Flow versions\n- Smoke tests pass in every environment` },
    quarantine: { title: `Sunset: quarantine ${list}`, description: `Hide ${list} from all users (explicit field-level security off) without deleting data, then watch for anyone who still needs it.\n\nAcceptance criteria:\n- Field is not visible or editable for any profile or permission set\n- Quarantine period passes with no signals` },
    archive: { title: `Sunset: archive and prove backup for ${list}`, description: `Export all values of ${list} and prove the backup is complete and restorable.\n\nAcceptance criteria:\n- Exported rows equal live populated count in every environment\n- Checksums recorded; field definition validates` },
    retire: { title: `Sunset: retire ${list}`, description: `Delete ${list} through the pipeline after all gates passed, clean remaining permission entries, and record a tombstone.\n\nAcceptance criteria:\n- Field deleted in every environment\n- Smoke tests pass\n- Restore capsule available` },
  }
  return texts[name]
}

export function createPlan(
  cfg: LoadedConfig,
  agentia: Agentia | undefined,
  investigations: Investigation[],
  opts: { kind?: Plan['kind']; mergeInto?: string; createStories?: boolean },
): Plan {
  const kind = opts.kind ?? (investigations.length > 1 ? 'campaign' : 'retire')
  const targets: Target[] = investigations.map((i) => ({ ...i.target, verdict: i.verdict.verdict }))
  const envs = cfg.environments.map((e) => e.name)
  const names: PhaseName[] = kind === 'merge' ? ['migrate', 'detach', 'quarantine', 'archive', 'retire'] : ['detach', 'quarantine', 'archive', 'retire']
  const id = `sunset-${slug(targets.length === 1 ? targets[0].qualified : `${targets[0].object}-campaign-${targets.length}`)}-${shortId()}`
  const plan: Plan = {
    id,
    kind,
    createdAt: new Date().toISOString(),
    targets,
    mergeInto: opts.mergeInto,
    phases: names.map((n) => newPhase(n, envs)),
    capsules: {},
    history: [],
  }

  // Story text from the Plan agent (falls back to solid templates)
  let aiTexts: Record<string, StoryText> | undefined
  if (agentia) {
    try {
      aiTexts = agentia.askJson<Record<string, StoryText>>(
        'plan',
        `Write Copado user stories for retiring Salesforce metadata in phases ${names.join(', ')}. Targets: ${targets.map((t) => t.qualified).join(', ')}.` +
          `${opts.mergeInto ? ` Data and references move into ${opts.mergeInto}.` : ''} Context: ${JSON.stringify(
            investigations.map((i) => ({ field: i.target.qualified, blockers: i.repo.summary.blocker, hazards: i.repo.summary.repoHazard, verdict: i.verdict, origin: i.origin?.summary })),
          ).slice(0, 4000)}` +
          ` Return an object keyed by phase name, each {"title": string (max 80 chars), "description": string with a short "Acceptance criteria" list}.`,
      )
    } catch {
      aiTexts = undefined
    }
  }
  for (const p of plan.phases) {
    const t = aiTexts?.[p.name]?.title ? aiTexts[p.name] : defaultStoryText(p.name, targets, opts.mergeInto)
    p.storyTitle = t.title.slice(0, 255)
    p.storyDescription = t.description
  }
  if (targets.some((t) => t.verdict === 'BLOCKED')) log(plan, 'Created with a BLOCKED target: phases after detach will refuse to start until resolved.')
  log(plan, `Plan created for ${targets.map((t) => t.qualified).join(', ')}`)

  if (opts.createStories && agentia) {
    for (const p of plan.phases) {
      try {
        const s = agentia.createStory(p.storyTitle!, p.storyDescription!)
        p.storyId = s.id
        p.storyName = s.name || s.id
        log(plan, `Created user story ${p.storyName} for ${p.name}`)
      } catch (err) {
        p.notes.push(`Story not created automatically: ${(err as Error).message.split('\n')[0]}. Create it and run: agentia sunset plan --attach ${plan.id} --phase ${p.name} --story <US-...>`)
      }
    }
  }
  savePlan(cfg.stateDir, plan)
  return plan
}

// ------------------------------------------------------------------ helpers
function ensureStory(p: Phase): Pick<Story, 'id' | 'name'> {
  if (!p.storyName && !p.storyId) throw new Error(`Phase "${p.name}" has no user story. Attach one: agentia sunset plan --attach <plan> --phase ${p.name} --story <US-...>`)
  return { id: p.storyId ?? p.storyName!, name: p.storyName ?? p.storyId! }
}

function capsuleFor(cfg: LoadedConfig, plan: Plan, t: Target): CapsuleManifest {
  const existing = plan.capsules[t.qualified]
  if (existing) return loadCapsule(cfg.stateDir, existing)
  const id = `${slug(t.qualified)}-${shortId()}`
  const m = createCapsule(cfg.stateDir, id, plan.id, { object: t.object, field: t.field, qualified: t.qualified })
  plan.capsules[t.qualified] = id
  return m
}

function walkRepo(root: string, test: (p: string) => boolean, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', '.sunset', '.sfdx', '.sf'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkRepo(root, test, full, out)
    else {
      const rel = relative(root, full).split(sep).join('/')
      if (test(rel)) out.push(rel)
    }
  }
  return out
}

const testClassesIn = (files: string[]) => files.filter((f) => /test\.cls$/i.test(f) || /_test\.cls$/i.test(f)).map((f) => f.split('/').pop()!.replace(/\.cls$/, ''))

function begin(plan: Plan, p: Phase) {
  if (p.status === 'pending') {
    p.status = 'in-progress'
    p.startedAt = new Date().toISOString()
  }
}

function finish(cfg: LoadedConfig, plan: Plan, p: Phase) {
  const allEnvs = p.environments.every((e) => e.status === 'verified' || e.status === 'deployed')
  if (allEnvs) {
    p.status = 'done'
    p.completedAt = new Date().toISOString()
    log(plan, `Phase ${p.name} complete in every environment`)
  }
  savePlan(cfg.stateDir, plan)
}

async function shipPhase(d: ReleaseDeps, plan: Plan, p: Phase, files: string[], message: string, opts: RunOptions, deletions: { type: string; name: string }[] = []) {
  if (opts.noCommit) {
    console.log(color.yellow(`--no-commit: ${files.length} file(s) changed locally only. Review with git diff.`))
    savePlan(d.cfg.stateDir, plan)
    return
  }
  const story = ensureStory(p)
  const srcProgress = p.environments.find((e) => e.env === sourceEnv(d.cfg).name)
  if (srcProgress?.status === 'pending') {
    const result = await commitToStory(d, story, message, files, deletions)
    console.log(`${icon.ok} ${result}`)
    log(plan, `Committed ${files.length} file(s)${deletions.length ? ` and ${deletions.length} deletion(s)` : ''} to ${story.name}`)
    savePlan(d.cfg.stateDir, plan)
  }
  await promoteThroughPipeline(d, story, p, { confirmPhrase: opts.confirm, yes: opts.yes, untilEnv: opts.untilEnv, testClasses: testClassesIn(files) })
  finish(d.cfg, plan, p)
}

function gate(cfg: LoadedConfig, plan: Plan, name: PhaseName, opts: RunOptions) {
  const g = canStart(plan, name, { prodEnv: prodEnv(cfg).name, overrideQuarantine: opts.overrideQuarantine })
  if (!g.ok) throw new ApprovalError(`Cannot start ${name}:\n${g.reasons.map((r) => `  ${icon.stop} ${r}`).join('\n')}`)
}

// ------------------------------------------------------------------ migrate (merge plans)
export async function runMigrate(d: ReleaseDeps, plan: Plan, opts: RunOptions) {
  const { cfg, agentia, sf } = d
  if (plan.kind !== 'merge' || !plan.mergeInto) throw new Error('Migrate is only for merge plans.')
  const p = phase(plan, 'migrate')
  gate(cfg, plan, 'migrate', opts)
  begin(plan, p)
  const t = plan.targets[0]
  const [, into] = plan.mergeInto.split('.')
  const capsule = capsuleFor(cfg, plan, t)

  // 1. Repoint references deterministically (From → Into)
  const refs = scanRepo(cfg.root, t.qualified).references.filter((r) => r.impact === 'blocker')
  for (const r of refs) preserveOriginal(cfg.stateDir, capsule, cfg.root, r.file)
  saveCapsule(cfg.stateDir, capsule)
  const outcomes = await proposeAndApply(agentia, cfg.root, refs, t.qualified, { yes: opts.yes, deterministicRename: { object: t.object, from: t.field, to: into } })
  p.changedFiles = outcomes.filter((o) => o.status === 'applied').map((o) => o.file)
  p.manualTasks.push(...outcomes.filter((o) => o.status !== 'applied' && o.status !== 'unchanged').map((o) => `${o.file}: ${o.note}`))

  // 2. Copy data where the surviving field is empty, in every environment (with approval)
  for (const env of cfg.environments) {
    if (!(await confirm(`Copy ${t.field} values into ${into} in ${env.name} where ${into} is empty?`, { yes: opts.yes && !env.isProduction, production: false }))) continue
    if (env.isProduction) await typedConfirm(`MIGRATE DATA IN ${env.name}`, opts.confirm)
    const file = join(capsuleDir(cfg.stateDir, capsule.id), 'data', `${env.name}-migrate-source.csv`)
    ensureDir(dirname(file))
    sf.exportCsv(env.sfAlias, `SELECT Id, ${t.field}, ${into} FROM ${t.object} WHERE ${t.field} != null`, file)
    const rows = csvObjects(readFileSync(file, 'utf8')).filter((r) => !r[into])
    const out = join(capsuleDir(cfg.stateDir, capsule.id), 'data', `${env.name}-migrate-upsert.csv`)
    writeFileSync(out, toCsv([['Id', into], ...rows.map((r) => [r.Id, r[t.field]])]))
    if (rows.length) sf.upsertCsv(env.sfAlias, t.object, out)
    p.notes.push(`${env.name}: copied ${rows.length} value(s) into ${into}.`)
  }
  saveCapsule(cfg.stateDir, capsule)
  await shipPhase(d, plan, p, p.changedFiles, `Sunset: repoint ${t.qualified} to ${plan.mergeInto}`, opts)
}

// ------------------------------------------------------------------ detach
export async function runDetach(d: ReleaseDeps, plan: Plan, opts: RunOptions) {
  const { cfg, agentia } = d
  const p = phase(plan, 'detach')
  gate(cfg, plan, 'detach', opts)
  begin(plan, p)
  const changed = new Set<string>(p.changedFiles)

  for (const t of plan.targets) {
    const capsule = capsuleFor(cfg, plan, t)
    const fieldFile = findFieldFile(cfg.root, t.object, t.field)
    if (fieldFile) preserveFieldDefinition(cfg.stateDir, capsule, cfg.root, fieldFile)
    const refs = scanRepo(cfg.root, t.qualified).references

    // Deterministic XML hazards (layouts, list views, compact layouts, record types, field sets, quick actions, Lightning pages)
    for (const r of refs.filter((x) => x.impact === 'repoHazard' && !isPermissionFile(x.file))) {
      const editor = detachEditorFor(r.file)
      if (!editor) {
        p.manualTasks.push(`${r.file}: no automatic editor for ${r.kind}; remove ${t.field} manually.`)
        continue
      }
      preserveOriginal(cfg.stateDir, capsule, cfg.root, r.file)
      const path = join(cfg.root, r.file)
      const res = editor(readFileSync(path, 'utf8'), t.object, t.field)
      if (res.removed > 0) {
        writeFileSync(path, res.xml)
        changed.add(r.file)
        console.log(`${icon.ok} ${r.kind}: removed ${res.removed} use(s) in ${r.file}`)
      }
    }

    // Blockers via the Build agent (human-approved)
    const blockers = refs.filter((x) => x.impact === 'blocker' && x.confidence !== 'possible')
    const possible = refs.filter((x) => x.impact === 'blocker' && x.confidence === 'possible')
    for (const r of possible) p.manualTasks.push(`${r.file}: mentions ${t.field} but may refer to another object. Check manually.`)
    for (const r of blockers) preserveOriginal(cfg.stateDir, capsule, cfg.root, r.file)
    saveCapsule(cfg.stateDir, capsule)
    const outcomes = await proposeAndApply(agentia, cfg.root, blockers, t.qualified, { yes: opts.yes })
    for (const o of outcomes) {
      if (o.status === 'applied') changed.add(o.file)
      else if (o.status !== 'unchanged') p.manualTasks.push(`${o.file}: ${o.note}`)
    }
    for (const r of refs.filter((x) => x.impact === 'unknown')) p.manualTasks.push(`${r.file}: unclassified mention of ${t.field}; review.`)
    saveCapsule(cfg.stateDir, capsule)
  }

  p.changedFiles = [...changed]
  savePlan(cfg.stateDir, plan)
  if (p.manualTasks.length) {
    console.log(color.yellow(`\n${icon.warn} Manual tasks (${p.manualTasks.length}):`))
    for (const m of p.manualTasks) console.log(`  ${icon.dot} ${m}`)
  }
  if (p.changedFiles.length === 0) {
    console.log(color.dim('No detach changes were needed in Git.'))
    for (const e of p.environments) e.status = 'verified'
    finish(cfg, plan, p)
    return
  }
  await shipPhase(d, plan, p, p.changedFiles, `Sunset: detach references to ${plan.targets.map((t) => t.qualified).join(', ')}`, opts)
}

// ------------------------------------------------------------------ quarantine
export async function runQuarantine(d: ReleaseDeps, plan: Plan, opts: RunOptions) {
  const { cfg } = d
  const p = phase(plan, 'quarantine')
  gate(cfg, plan, 'quarantine', opts)
  begin(plan, p)
  const permissionFiles = walkRepo(cfg.root, isPermissionFile)
  const changed = new Set<string>(p.changedFiles)
  for (const t of plan.targets) {
    const capsule = capsuleFor(cfg, plan, t)
    for (const f of permissionFiles) {
      preserveOriginal(cfg.stateDir, capsule, cfg.root, f)
      const path = join(cfg.root, f)
      const res = setFieldPermission(readFileSync(path, 'utf8'), t.object, t.field, false, false)
      if (res.changed) {
        writeFileSync(path, res.xml)
        changed.add(f)
      }
    }
    saveCapsule(cfg.stateDir, capsule)
  }
  p.changedFiles = [...changed]
  console.log(`${icon.ok} Field-level security set to hidden in ${p.changedFiles.length} permission set/profile file(s).`)
  await shipPhase(d, plan, p, p.changedFiles, `Sunset: quarantine ${plan.targets.map((t) => t.qualified).join(', ')}`, opts)
  if (p.status === 'done' && !plan.quarantine) {
    const start = new Date()
    const end = new Date(start.getTime() + cfg.quarantineDays * 86_400_000)
    plan.quarantine = { startedAt: start.toISOString(), endsAt: end.toISOString(), signals: [] }
    log(plan, `Quarantine started; ends ${end.toISOString().slice(0, 10)}`)
    savePlan(cfg.stateDir, plan)
    console.log(color.green(`${icon.ok} Quarantine running until ${end.toISOString().slice(0, 10)}. Check with: agentia sunset watch ${plan.id}`))
  }
}

/** Watch for anyone who still needs the field. Pure-ish: queries + signal recording. */
export async function watchQuarantine(d: ReleaseDeps, plan: Plan, opts: { signal?: string; clear?: boolean }) {
  const { cfg, sf } = d
  if (!plan.quarantine) throw new Error('Quarantine has not started for this plan.')
  const q = plan.quarantine
  if (opts.clear) {
    log(plan, `Cleared ${q.signals.length} quarantine signal(s)`)
    q.signals = []
  }
  if (opts.signal) q.signals.push({ at: new Date().toISOString(), kind: 'manual', detail: opts.signal })

  const prod = prodEnv(cfg)
  const since = q.startedAt.slice(0, 19) + 'Z'
  const newSignals: string[] = []
  for (const t of plan.targets) {
    try {
      const writes = sf.count(prod.sfAlias, `SELECT COUNT() FROM ${t.object} WHERE ${t.field} != null AND LastModifiedDate >= ${since}`)
      if (writes > 0) newSignals.push(`${writes} record(s) with ${t.qualified} set were modified since quarantine began.`)
    } catch (err) {
      console.log(color.dim(`Write check skipped for ${t.qualified}: ${(err as Error).message.split('\n')[0]}`))
    }
    const reports = scanRepo(cfg.root, t.qualified).references.filter((r) => r.kind === 'Report').map((r) => r.file.split('/').pop()!.replace('.report-meta.xml', ''))
    if (reports.length) {
      try {
        const list = reports.map((r) => `'${r}'`).join(',')
        const res = sf.query(prod.sfAlias, `SELECT Name, LastRunDate FROM Report WHERE DeveloperName IN (${list}) AND LastRunDate >= ${since}`)
        for (const r of res.records) newSignals.push(`Report "${r.Name}" (uses ${t.field}) was run on ${String(r.LastRunDate).slice(0, 10)}.`)
      } catch {
        /* optional */
      }
    }
  }
  for (const s of newSignals) if (!q.signals.some((x) => x.detail === s)) q.signals.push({ at: new Date().toISOString(), kind: s.startsWith('Report') ? 'report-run' : 'write', detail: s })
  savePlan(cfg.stateDir, plan)
  if (q.signals.length) {
    await notifySlack(cfg.slackWebhookEnvVar, `☀ Sunset quarantine signal for ${plan.targets.map((t) => t.qualified).join(', ')}:\n${q.signals.map((s) => `• ${s.detail}`).join('\n')}`)
  }
  return q
}

// ------------------------------------------------------------------ archive
export async function runArchive(d: ReleaseDeps, plan: Plan, opts: RunOptions & { envs?: string[] }) {
  const { cfg, sf } = d
  const p = phase(plan, 'archive')
  gate(cfg, plan, 'archive', opts)
  begin(plan, p)
  const envs = opts.envs?.length ? cfg.environments.filter((e) => opts.envs!.includes(e.name)) : cfg.environments
  for (const t of plan.targets) {
    const capsule = capsuleFor(cfg, plan, t)
    for (const env of envs) {
      const expected = sf.count(env.sfAlias, `SELECT COUNT() FROM ${t.object} WHERE ${t.field} != null`)
      const rel = `data/${env.name}.csv`
      const full = join(capsuleDir(cfg.stateDir, capsule.id), rel)
      ensureDir(dirname(full))
      if (expected > 0) sf.exportCsv(env.sfAlias, `SELECT Id, ${t.field} FROM ${t.object} WHERE ${t.field} != null`, full)
      else writeFileSync(full, `Id,${t.field}\n`)
      const entry = recordDataFile(cfg.stateDir, capsule, env.name, rel, expected)
      const ok = entry.rows === entry.expectedRows
      console.log(`${ok ? color.green(icon.ok) : color.red(icon.stop)} ${env.name}: backed up ${entry.rows} of ${entry.expectedRows} value(s) for ${t.qualified}`)
      p.environments.find((e) => e.env === env.name)!.status = ok ? 'verified' : 'failed'
    }
    capsule.proof.rowCountsMatch = capsule.data.every((x) => x.rows === x.expectedRows)
    capsule.proof.checksumsRecorded = capsule.data.every((x) => Boolean(x.sha256))
    if (capsule.fieldFile) {
      const res = sf.validateFieldDefinition(sourceEnv(cfg).sfAlias, t.object, t.field, fieldDefinitionXml(cfg.stateDir, capsule), cfg.apiVersion)
      capsule.proof.definitionValid = res.success
      if (!res.success) capsule.proof.notes.push(...res.failures.map((f) => f.problem))
    }
    capsule.proof.verifiedAt = new Date().toISOString()
    saveCapsule(cfg.stateDir, capsule)
    const proof = evaluateProof(capsule)
    if (!proof.proven) {
      p.status = 'blocked'
      savePlan(cfg.stateDir, plan)
      throw new Error(`Backup for ${t.qualified} is not proven:\n${proof.problems.map((x) => `  ${icon.stop} ${x}`).join('\n')}`)
    }
    console.log(color.green(`${icon.ok} Backup proven for ${t.qualified}: counts match, checksums recorded, definition ${capsule.proof.definitionValid === true ? 'validates' : 'saved'}.`))
  }
  p.status = 'done'
  p.completedAt = new Date().toISOString()
  log(plan, 'Archive proven')
  savePlan(cfg.stateDir, plan)
}

// ------------------------------------------------------------------ retire
export async function runRetire(d: ReleaseDeps, plan: Plan, opts: RunOptions & { purgeFlowVersions?: boolean }) {
  const { cfg, sf, git } = d
  const p = phase(plan, 'retire')
  if (opts.overrideQuarantine) await typedConfirm(`OVERRIDE QUARANTINE FOR ${plan.id}`, opts.confirm)
  gate(cfg, plan, 'retire', opts)
  begin(plan, p)

  // Capsules must still be intact
  for (const t of plan.targets) {
    const bad = verifyChecksums(cfg.stateDir, loadCapsule(cfg.stateDir, plan.capsules[t.qualified]))
    if (bad.length) throw new Error(`Capsule for ${t.qualified} was modified or is missing files: ${bad.join(', ')}`)
  }

  // Final oracle check per environment; purge obsolete Flow versions if they are the only blockers
  for (const env of cfg.environments) {
    for (const t of plan.targets) {
      const o = askOracle(sf, env, t.object, t.field, cfg.apiVersion)
      const flowBlockers = o.blockers.filter((b) => /flow/i.test(b.type))
      const others = o.blockers.filter((b) => !/flow/i.test(b.type))
      if (others.length) throw new Error(`${env.name} still has blockers for ${t.qualified}: ${others.map((b) => `${b.type} ${b.name}`).join(', ')}. Run detach again.`)
      if (flowBlockers.length) {
        const ids = flowBlockers.map((b) => b.name).filter((n) => /^301[A-Za-z0-9]{12,15}$/.test(n))
        const names = flowBlockers.map((b) => b.name).filter((n) => !/^301[A-Za-z0-9]{12,15}$/.test(n))
        const versions = [
          ...inactiveFlowVersionsByIds(sf, env.sfAlias, ids),
          ...inactiveFlowVersions(sf, env.sfAlias, [...new Set(names.map((n) => n.split('.')[0].replace(/-\d+$/, '')))]),
        ]
        const activeLeft = ids.length > versions.filter((v) => ids.includes(v.id)).length
        if (activeLeft) throw new Error(`${env.name}: the ACTIVE version of a flow still references ${t.field}. Run detach again so the flow is fixed first.`)
        console.log(color.yellow(`${icon.warn} ${env.name}: ${versions.length} obsolete Flow version(s) still reference ${t.field}: ${versions.map((v) => `${v.flow} v${v.version}`).join(', ')}`))
        if (!opts.purgeFlowVersions) throw new Error('Re-run with --purge-flow-versions to delete those obsolete (inactive) versions.')
        if (env.isProduction) await typedConfirm(`PURGE FLOW VERSIONS IN ${env.name}`, opts.confirm)
        else if (!(await confirm(`Delete ${versions.length} obsolete Flow version(s) in ${env.name}?`, { yes: opts.yes }))) throw new Error('Stopped by developer.')
        for (const v of versions) sf.deleteToolingRecord(env.sfAlias, 'Flow', v.id)
      }
    }
  }

  // Repo cleanup: permission entries, report columns, and the field definition itself
  const changed = new Set<string>()
  const deletions: { type: string; name: string }[] = []
  for (const t of plan.targets) {
    const capsule = loadCapsule(cfg.stateDir, plan.capsules[t.qualified])
    for (const f of walkRepo(cfg.root, isPermissionFile)) {
      const path = join(cfg.root, f)
      const res = removeFieldPermission(readFileSync(path, 'utf8'), t.object, t.field)
      if (res.removed) {
        preserveOriginal(cfg.stateDir, capsule, cfg.root, f)
        writeFileSync(path, res.xml)
        changed.add(f)
      }
    }
    for (const r of scanRepo(cfg.root, t.qualified).references.filter((x: Reference) => x.kind === 'Report')) {
      const path = join(cfg.root, r.file)
      const res = removeFromReport(readFileSync(path, 'utf8'), t.object, t.field)
      if (res.removed) {
        preserveOriginal(cfg.stateDir, capsule, cfg.root, r.file)
        writeFileSync(path, res.xml)
        changed.add(r.file)
      }
    }
    saveCapsule(cfg.stateDir, capsule)
    deletions.push({ type: 'CustomField', name: t.qualified })
  }

  const path = cfg.deletionPath === 'auto' ? 'A' : cfg.deletionPath
  plan.deletionPath = path
  const prod = prodEnv(cfg)
  const message = `Sunset: retire ${plan.targets.map((t) => t.qualified).join(', ')}`
  console.log(color.red(`\n${icon.warn} About to DELETE ${deletions.map((x) => x.name).join(', ')} through the pipeline (path ${path}).`))
  await typedConfirm(`RETIRE ${plan.targets.map((t) => t.qualified).join(' ')}`, opts.confirm)

  const removeFieldFiles = () => {
    for (const t of plan.targets) {
      const f = findFieldFile(cfg.root, t.object, t.field)
      if (f) {
        if (git.isRepo()) git.remove([f])
        if (existsSync(join(cfg.root, f))) unlinkSync(join(cfg.root, f))
        changed.add(f)
      }
    }
  }

  if (path === 'C') {
    // Destructive deploy per environment, in pipeline order, each verified
    for (const env of cfg.environments) {
      if (env.isProduction || env.name === prod.name) await typedConfirm(`DELETE IN ${env.name}`, opts.confirm)
      const res = sf.deployDestructive(env.sfAlias, deletions, cfg.apiVersion, env.isProduction ? cfg.testLevelProd : cfg.testLevelNonProd)
      if (!res.success) throw new Error(`Destructive deploy failed in ${env.name}: ${res.failures.map((f) => f.problem).join('; ')}`)
      const e = p.environments.find((x) => x.env === env.name)!
      e.status = 'deployed'
      e.at = new Date().toISOString()
      console.log(color.green(`${icon.ok} Deleted in ${env.name}`))
      savePlan(cfg.stateDir, plan)
    }
    removeFieldFiles()
    p.changedFiles = [...changed]
    p.manualTasks.push('Path C: make sure the field definition is also removed from every environment branch in Git (use Copado Destructive Changes or merge this commit), so it is not redeployed later.')
    if (!opts.noCommit && p.changedFiles.length) {
      try {
        await commitToStory(d, ensureStory(p), message, p.changedFiles.filter((f) => existsSync(join(cfg.root, f))))
      } catch (err) {
        p.manualTasks.push(`Commit repo cleanup manually: ${(err as Error).message.split('\n')[0]}`)
      }
    }
    finish(cfg, plan, p)
  } else {
    if (path === 'B') {
      removeFieldFiles()
      cfg.commitMode = 'git'
    }
    p.changedFiles = [...changed]
    await shipPhase(d, plan, p, p.changedFiles.filter((f) => existsSync(join(cfg.root, f)) || path === 'B'), message, opts, path === 'A' ? deletions : [])
    if (path === 'A') removeFieldFiles()
  }

  if (p.status === 'done') {
    for (const t of plan.targets) addTombstone(cfg.stateDir, { qualified: t.qualified, field: t.field, retiredAt: new Date().toISOString(), planId: plan.id, capsuleId: plan.capsules[t.qualified] })
    for (const ph of plan.phases) if (ph.storyId || ph.storyName) d.agentia.updateStoryStatus(ph.storyId ?? ph.storyName!, 'Completed')
    log(plan, 'Retired; tombstones recorded')
    savePlan(cfg.stateDir, plan)
    console.log(color.green(`\n${icon.sun} Retired ${plan.targets.map((t) => t.qualified).join(', ')}. Restore anytime: agentia sunset restore ${plan.id}`))
    console.log(color.dim('Note: Salesforce keeps deleted custom fields for 15 days and they count toward the field limit until erased (Setup → Object Manager → Fields → Deleted Fields).'))
  }
}

// ------------------------------------------------------------------ restore
export async function runRestore(d: ReleaseDeps, plan: Plan, opts: RunOptions & { dataOnly?: boolean; storyName?: string }) {
  const { cfg, agentia, sf } = d
  const restored: string[] = []
  for (const t of plan.targets) {
    const capsuleId = plan.capsules[t.qualified]
    if (!capsuleId) throw new Error(`No capsule for ${t.qualified}; nothing to restore from.`)
    const m = loadCapsule(cfg.stateDir, capsuleId)
    const bad = verifyChecksums(cfg.stateDir, m)
    if (bad.length) throw new Error(`Capsule ${capsuleId} is damaged: ${bad.join(', ')}`)
    if (!opts.dataOnly) restored.push(...restoreOriginals(cfg.stateDir, m, cfg.root))
  }
  console.log(`${icon.ok} Restored ${restored.length} file(s) in the repo from the capsule(s).`)

  const retired = phase(plan, 'retire').status === 'done'
  if (retired) {
    console.log(color.yellow(`${icon.warn} The field was deleted. Salesforce keeps deleted fields for 15 days:`))
    console.log(color.yellow('  • Fastest (keeps all data): Setup → Object Manager → <Object> → Fields & Relationships → Deleted Fields → Undelete, in each environment.'))
    console.log(color.yellow('  • Or erase the deleted field there first, then continue here to redeploy the definition and reload data from the capsule.'))
  }

  if (!opts.dataOnly && !opts.noCommit) {
    let story: Pick<Story, 'id' | 'name'>
    if (opts.storyName) story = { id: opts.storyName, name: opts.storyName }
    else {
      const s = agentia.createStory(`Sunset: restore ${plan.targets.map((t) => t.qualified).join(', ')}`, `Restore from capsule(s) ${Object.values(plan.capsules).join(', ')}.`)
      story = { id: s.id, name: s.name || s.id }
    }
    const restorePhase = newPhase('detach', cfg.environments.map((e) => e.name))
    restorePhase.title = 'Restore'
    await commitToStory(d, story, `Sunset: restore ${plan.targets.map((t) => t.qualified).join(', ')}`, restored.filter((f) => existsSync(join(cfg.root, f))))
    await promoteThroughPipeline(d, story, restorePhase, { confirmPhrase: opts.confirm, yes: opts.yes })
  }

  // Reload data per environment
  for (const t of plan.targets) {
    const m = loadCapsule(cfg.stateDir, plan.capsules[t.qualified])
    for (const dfile of m.data) {
      const env = cfg.environments.find((e) => e.name === dfile.env)
      if (!env || dfile.rows === 0) continue
      if (env.isProduction) await typedConfirm(`RELOAD DATA IN ${env.name}`, opts.confirm)
      else if (!(await confirm(`Reload ${dfile.rows} value(s) of ${t.qualified} into ${env.name}?`, { yes: opts.yes }))) continue
      sf.upsertCsv(env.sfAlias, t.object, join(capsuleDir(cfg.stateDir, m.id), dfile.file))
      console.log(color.green(`${icon.ok} ${env.name}: reloaded ${dfile.rows} value(s)`))
    }
    removeTombstone(cfg.stateDir, t.qualified)
  }
  log(plan, 'Restored from capsule')
  savePlan(cfg.stateDir, plan)
  writeJson(join(cfg.stateDir, 'last-restore.json'), { planId: plan.id, at: new Date().toISOString(), files: restored })
}
