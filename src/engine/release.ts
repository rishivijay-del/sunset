/**
 * Release Driver + Verifier.
 *
 * Copado's commit model: a commit RETRIEVES the selected components from the
 * user story's development org into the story's feature branch. So Sunset
 *   1. deploys the local edits to the source (DEV) org,
 *   2. asks Copado to commit those components to the story,
 *   3. promotes the story environment by environment (merge_and_deploy),
 *   4. verifies each environment (CRT smoke job, or Apex tests as fallback),
 *   5. stops for typed human confirmation before production.
 */
import type { Agentia, Story } from '../adapters/agentia.js'
import type { Git } from '../adapters/git.js'
import { testLevelArgs, type Salesforce } from '../adapters/salesforce.js'
import { prodEnv, sourceEnv, type LoadedConfig } from '../core/config.js'
import type { EnvProgress, Phase } from '../core/plan.js'
import { metadataMemberOf } from '../core/referenceFinder.js'
import { run } from '../core/runner.js'
import { color, confirm, icon, pick, typedConfirm } from '../util/index.js'

export interface ReleaseDeps {
  cfg: LoadedConfig
  agentia: Agentia
  sf: Salesforce
  git: Git
}

export function membersForFiles(files: string[]): { type: string; name: string }[] {
  const seen = new Set<string>()
  const out: { type: string; name: string }[] = []
  for (const f of files) {
    const m = metadataMemberOf(f)
    if (!m) continue
    const k = `${m.type}:${m.name}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push(m)
    }
  }
  return out
}

/** Step 1+2: put the changes on the user story. */
export async function commitToStory(
  d: ReleaseDeps,
  story: Pick<Story, 'id' | 'name'>,
  message: string,
  files: string[],
  deletions: { type: string; name: string }[] = [],
): Promise<string> {
  const { cfg, agentia, sf, git } = d
  const src = sourceEnv(cfg)
  const members = membersForFiles(files)

  if (cfg.commitMode === 'git') {
    const branch = `${cfg.featureBranchPrefix}${story.name}`
    const base = src.branch ?? 'main'
    git.fetch()
    git.checkoutNew(branch, git.refExists(`${cfg.gitRemote}/${branch}`) ? `${cfg.gitRemote}/${branch}` : `${cfg.gitRemote}/${base}`)
    git.addAll(files)
    const sha = git.commit(`${story.name}: ${message}`)
    git.push(branch)
    return `git ${sha.slice(0, 8)} on ${branch}`
  }

  if (files.length) {
    console.log(`${icon.arrow} Deploying ${files.length} changed file(s) to ${src.name} (${src.sfAlias}) so Copado can commit them`)
    const outcome = sf.validateSource(cfg.root, src.sfAlias, files, cfg.testLevelNonProd)
    if (!outcome.success) throw new Error(`Validation in ${src.name} failed:\n${outcome.failures.map((f) => ` - ${f.componentType} ${f.fullName}: ${f.problem}`).join('\n')}`)
    // Real deploy (validation passed)
    // --ignore-conflicts: scratch/source-tracked dev orgs otherwise refuse when the org changed since the last local sync
    const args = ['project', 'deploy', 'start', '-o', src.sfAlias, ...testLevelArgs(cfg.testLevelNonProd), '--ignore-conflicts', '--wait', '60', '--json']
    for (const f of files) args.push('--source-dir', f)
    run('sf', args, { cwd: cfg.root, timeoutMs: 70 * 60_000 })
  }

  const changes = [...members.map((m) => ({ ...m, action: 'add' as const })), ...deletions.map((m) => ({ ...m, action: 'delete' as const }))]
  if (changes.length === 0) return 'nothing to commit'

  if (cfg.commitMode === 'agent') {
    const list = changes.map((c) => `${c.action === 'delete' ? 'DELETE (destructive change)' : 'commit'} ${c.type} ${c.name}`).join('; ')
    const answer = agentia.ask('release', `Commit these components from the ${src.name} environment to user story ${story.name}: ${list}. Commit message: "${message}". Reply with the commit result.`)
    return `release agent: ${answer.slice(0, 200)}`
  }

  const res = agentia.commit(story.id || story.name, message, changes)
  return `copado commit ${String(pick(res?.result ?? res, ['id', 'commitId', 'jobExecutionId']) ?? 'submitted')}`
}

/** Step 3-5: move the story through every environment after the source one. */
export async function promoteThroughPipeline(
  d: ReleaseDeps,
  story: Pick<Story, 'id' | 'name'>,
  phaseState: Phase,
  opts: { confirmPhrase?: string; yes?: boolean; untilEnv?: string; testClasses?: string[] },
): Promise<void> {
  const { cfg, agentia } = d
  const envs = cfg.environments
  const src = sourceEnv(cfg)
  const prod = prodEnv(cfg)
  mark(phaseState, src.name, 'deployed', 'committed from source environment')

  for (const env of envs.slice(1)) {
    const progress = phaseState.environments.find((e) => e.env === env.name)
    if (progress && (progress.status === 'deployed' || progress.status === 'verified')) continue

    if (env.isProduction || env.name === prod.name) {
      console.log(color.red(`\n${icon.warn} Next step deploys to PRODUCTION (${env.name}).`))
      await typedConfirm(`PROMOTE ${story.name} TO ${env.name}`, opts.confirmPhrase)
    } else if (!(await confirm(`Promote ${story.name} to ${env.name}?`, { yes: opts.yes }))) {
      console.log(color.yellow('Stopped by developer. Run the same command again to continue.'))
      return
    }

    try {
      console.log(`${icon.arrow} Submitting ${story.name} to ${env.name} (Copado creates the promotion, merges and deploys)...`)
      await submitAndWait(d, story, env.name)
    } catch (err) {
      mark(phaseState, env.name, 'failed', (err as Error).message.slice(0, 200))
      let analysis = ''
      try {
        analysis = agentia.ask('release', `Promotion of user story ${story.name} to ${env.name} failed: ${(err as Error).message.slice(0, 2500)}. Explain the likely cause and the fix in 3 short bullet points.`)
      } catch {
        /* optional */
      }
      throw new Error(`Promotion to ${env.name} failed: ${(err as Error).message.split('\n')[0]}${analysis ? `\nRelease agent: ${analysis}` : ''}`)
    }
    mark(phaseState, env.name, 'deployed')
    const verified = await verifyEnvironment(d, env.name, env.sfAlias, opts.testClasses ?? [])
    mark(phaseState, env.name, verified ? 'verified' : 'failed', verified ? 'smoke tests passed' : 'smoke tests failed')
    if (!verified) throw new Error(`Verification failed in ${env.name}. Stopping. Consider: agentia sunset restore`)
    if (opts.untilEnv && opts.untilEnv.toLowerCase() === env.name.toLowerCase()) return
  }
}

/**
 * One pipeline hop, exactly as verified on the Playground:
 *   agentia cicd work set <story>; agentia cicd work submit --done
 * then poll the story's promotions until the one into `envName` has completed its deployment.
 * `work set` needs a clean tracked tree and checks out feature/<story>, so Sunset stashes local
 * edits (already committed to the story by Copado) and returns to the original branch afterwards.
 */
export async function submitAndWait(d: ReleaseDeps, story: Pick<Story, 'id' | 'name'>, envName: string, timeoutMinutes = 45, pollMs = 20_000): Promise<void> {
  const { agentia, git } = d
  const startBranch = git.currentBranch()
  const stashed = git.hasTrackedChanges() ? git.stashPush('sunset-autostash before work submit') : false
  try {
    agentia.setActiveStory(story.name || story.id)
    agentia.submitDone()
  } finally {
    try {
      git.checkout(startBranch)
    } catch {
      /* stay where we are */
    }
    if (stashed && !git.stashPop()) console.log(color.yellow(`${icon.warn} Could not re-apply your local edits automatically. Run: git stash pop`))
  }
  const deadline = Date.now() + timeoutMinutes * 60_000
  let last = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    const p = agentia.storyPromotions(story.id || story.name).find((x) => x.to.toLowerCase() === envName.toLowerCase())
    if (!p) continue
    const state = `${p.name} ${p.status} (merge: ${p.promotionStatus || '-'}, deploy: ${p.deployStatus || '-'})`
    if (state !== last) console.log(color.dim(`   ${state}`))
    last = state
    if (/fail|error|conflict|cancel/i.test(`${p.status} ${p.promotionStatus} ${p.deployStatus}`)) throw new Error(`${p.name} to ${envName}: ${state}`)
    if (/complete/i.test(p.status) && (!p.deployStatus || /success/i.test(p.deployStatus))) return
  }
  throw new Error(`Timed out after ${timeoutMinutes} minutes waiting for the promotion to ${envName} (last: ${last || 'no promotion found'})`)
}

function savePlanHint(_p: Phase) {
  /* state is saved by the caller after each step */
}

function mark(phaseState: Phase, env: string, status: EnvProgress['status'], detail?: string) {
  const e = phaseState.environments.find((x) => x.env === env)
  if (e) {
    e.status = status
    e.at = new Date().toISOString()
    e.detail = detail
  }
}

/** Verifier: CRT smoke job if configured, else Apex tests, else skip with a note. */
export async function verifyEnvironment(d: ReleaseDeps, envName: string, alias: string, testClasses: string[]): Promise<boolean> {
  const { cfg, agentia, sf } = d
  if (cfg.crt.enabled && cfg.crt.projectId && cfg.crt.jobId) {
    console.log(`${icon.arrow} Running Copado Robotic Testing smoke job for ${envName}...`)
    const run = agentia.runTests()
    let passed = run.passed
    const deadline = Date.now() + 30 * 60_000
    while (passed === undefined && run.buildId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000))
      passed = agentia.testStatus(run.buildId).passed
    }
    if (passed === true) {
      console.log(color.green(`${icon.ok} CRT smoke passed${run.buildId ? ` (${run.buildId})` : ''}`))
      return true
    }
    if (passed === false) {
      console.log(color.red(`${icon.stop} CRT smoke failed (${run.status})`))
      if (run.buildId) agentia.saveTestLogs(run.buildId, `${cfg.stateDir}/test-logs/${run.buildId}`)
      return false
    }
    console.log(color.red('CRT smoke did not finish in 30 minutes.'))
    return false
  }
  if (testClasses.length) {
    console.log(`${icon.arrow} Running Apex tests in ${envName}: ${testClasses.join(', ')}`)
    const r = sf.runApexTests(alias, testClasses)
    console.log(r.passed ? color.green(`${icon.ok} Apex tests passed`) : color.red(`${icon.stop} Apex tests failed`))
    return r.passed
  }
  console.log(color.dim(`No CRT job or test classes configured; ${envName} marked deployed without smoke verification.`))
  return true
}
