/**
 * Investigator: runs every analysis for one field and combines them.
 * Each layer degrades gracefully: if the org or Copado is unreachable, the
 * repo layer still works and the notes explain what was skipped.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agentia } from '../adapters/agentia.js'
import { Git } from '../adapters/git.js'
import { Salesforce } from '../adapters/salesforce.js'
import { prodEnv, sourceEnv, type LoadedConfig } from '../core/config.js'
import { findFieldFile, scanRepo, type ScanResult } from '../core/referenceFinder.js'
import { findCollisions, inFlightStories, investigateOrigin, type Collision, type Origin } from './history.js'
import { askOracle, type OracleResult } from './oracle.js'
import { copadoReferences, mergeOrgReferences, toolingReferences, type OrgReference } from './orgReferences.js'
import { analyzeUsage, decideVerdict, type UsageFacts, type UsageVerdict } from './usage.js'

export interface Investigation {
  target: { object: string; field: string; qualified: string }
  at: string
  fieldFile?: string
  repo: ScanResult
  org: OrgReference[]
  oracle: OracleResult[]
  usage?: UsageFacts
  verdict: UsageVerdict
  origin?: Origin
  collisions: Collision[]
  notes: string[]
}

export interface InvestigateOptions {
  offline?: boolean // repo only, no org/Copado calls
  skipOracle?: boolean
  skipHistory?: boolean
  skipCollisions?: boolean
  usageEnv?: string
}

export function investigate(cfg: LoadedConfig, qualified: string, opts: InvestigateOptions = {}, deps?: { agentia?: Agentia; sf?: Salesforce; git?: Git }): Investigation {
  const [object, field] = qualified.split('.')
  if (!object || !field || !/__c$/i.test(field)) throw new Error(`Expected a custom field as Object.Field__c, got "${qualified}"`)
  const notes: string[] = []
  const agentia = deps?.agentia ?? new Agentia(cfg)
  const sf = deps?.sf ?? new Salesforce()
  const git = deps?.git ?? new Git(cfg.root, cfg.gitRemote)

  const repo = scanRepo(cfg.root, qualified)
  const fieldFile = findFieldFile(cfg.root, object, field)
  if (!fieldFile) notes.push(`${qualified} is not defined in this repo. Org checks will still run.`)

  let org: OrgReference[] = []
  const oracle: OracleResult[] = []
  let usage: UsageFacts | undefined
  let verdict: UsageVerdict = { verdict: 'CAUTION', reasons: ['Usage not checked (offline).'] }
  let origin: Origin | undefined
  let collisions: Collision[] = []

  const src = sourceEnv(cfg)
  const prod = prodEnv(cfg)

  if (!opts.offline) {
    org = mergeOrgReferences(copadoReferences(agentia, src, object, field, notes), toolingReferences(sf, src, object, field, notes))

    if (!opts.skipOracle) {
      for (const env of dedupeEnvs([src, prod])) {
        try {
          oracle.push(askOracle(sf, env, object, field, cfg.apiVersion))
        } catch (err) {
          notes.push(`Blocker Oracle failed in ${env.name}: ${(err as Error).message.split('\n')[0]}`)
        }
      }
    }

    const usageEnv = opts.usageEnv ? cfg.environments.find((e) => e.name === opts.usageEnv) ?? prod : prod
    try {
      const reportNames = [
        ...repo.references.filter((r) => r.kind === 'Report').map((r) => r.file.replace(/^.*\/reports\//, '').replace(/\.report-meta\.xml$/, '')),
        ...org.filter((o) => o.type.toLowerCase() === 'report').map((o) => o.name),
      ]
      usage = analyzeUsage(sf, usageEnv, object, field, [...new Set(reportNames)], cfg.usage.recentDays, cfg.usage.ignoreWritesBefore)
      verdict = decideVerdict(usage, cfg.usage)
    } catch (err) {
      notes.push(`Usage analysis failed in ${usageEnv.name}: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  if (!opts.skipHistory && git.isRepo()) {
    let fieldInfo: { label?: string; description?: string } | undefined
    if (fieldFile) {
      try {
        const xml = readFileSync(join(cfg.root, fieldFile), 'utf8')
        fieldInfo = { label: /<label>([^<]*)<\/label>/.exec(xml)?.[1], description: /<description>([^<]*)<\/description>/.exec(xml)?.[1] }
      } catch {
        /* optional */
      }
    }
    origin = investigateOrigin(git, opts.offline ? undefined : agentia, fieldFile, field, cfg.packageDir, notes, fieldInfo)
  }

  if (!opts.offline && !opts.skipCollisions && git.isRepo()) {
    try {
      const stories = inFlightStories(agentia.listStories(), cfg.inFlightExcludedStatuses)
      collisions = findCollisions(git, stories, cfg.featureBranchPrefix, cfg.gitRemote, src.branch ?? 'main', field, cfg.packageDir)
    } catch (err) {
      notes.push(`Collision check skipped: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  if (collisions.length && verdict.verdict === 'SAFE') {
    verdict = { verdict: 'CAUTION', reasons: [...verdict.reasons, `${collisions.length} in-flight story(ies) still reference the field.`] }
  }

  return { target: { object, field, qualified: `${object}.${field}` }, at: new Date().toISOString(), fieldFile, repo, org, oracle, usage, verdict, origin, collisions, notes }
}

function dedupeEnvs<T extends { name: string }>(envs: T[]): T[] {
  const seen = new Set<string>()
  return envs.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
}
