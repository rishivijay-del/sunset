/**
 * Integration test with a real temporary Git repo (Copado-style branches) and a
 * fake Agentia CLI. Covers: collision guard, tombstone guard, detach end to end
 * (--no-commit), quarantine edits, capsule originals, and restore of files.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agentia } from '../src/adapters/agentia.ts'
import { Git } from '../src/adapters/git.ts'
import { Salesforce } from '../src/adapters/salesforce.ts'
import { loadConfig } from '../src/core/config.ts'
import { loadPlan } from '../src/core/plan.ts'
import { setExecutor } from '../src/core/runner.ts'
import { addTombstone } from '../src/engine/capsule.ts'
import { findCollisions, inFlightStories } from '../src/engine/history.ts'
import { investigate } from '../src/engine/investigator.ts'
import { createPlan, runDetach, runRestore } from '../src/engine/phases.ts'

const here = dirname(fileURLToPath(import.meta.url))
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

// --- Build a repo that looks like a Copado pipeline repo
const root = mkdtempSync(join(tmpdir(), 'sunset-int-'))
cpSync(join(here, 'fixtures', 'repo'), root, { recursive: true })
writeFileSync(join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' }))
g(root, 'init', '-q', '-b', 'main')
g(root, 'config', 'user.email', 'dev@example.com')
g(root, 'config', 'user.name', 'Dev Example')
g(root, 'add', '-A')
g(root, 'commit', '-q', '-m', 'US-0000231: territory project adds Legacy_Region__c')
g(root, 'branch', 'dev')
// A teammate's in-flight story touches the TerritoryAssigner class
g(root, 'checkout', '-q', '-b', 'feature/US-0000456')
const cls = join(root, 'force-app/main/default/classes/TerritoryAssigner.cls')
writeFileSync(cls, readFileSync(cls, 'utf8').replace("'EMEA'", "'APAC'"))
g(root, 'commit', '-q', '-am', 'US-0000456: route APAC')
// Another story that does not touch the field
g(root, 'checkout', '-q', 'dev')
g(root, 'checkout', '-q', '-b', 'feature/US-0000457')
writeFileSync(join(root, 'force-app/main/default/classes/InvoiceService.cls'), 'public class InvoiceService { }\n')
g(root, 'commit', '-q', '-am', 'US-0000457: invoice tweak')
g(root, 'checkout', '-q', 'dev')

writeFileSync(join(root, '.sunset.json'), JSON.stringify({ pipelineId: 'a0W000', environments: [
  { name: 'DEV', sfAlias: 'dev', branch: 'dev', credentialId: 'c1', orgId: 'o1' },
  { name: 'PROD', sfAlias: 'prod', branch: 'main', isProduction: true },
] }))
const cfg = loadConfig(root)

// --- Fake agentia: stories + a Build agent that deletes lines mentioning the field
const calls: string[][] = []
setExecutor((bin, args, opts) => {
  if (bin === 'agentia') {
    calls.push(args)
    const key = args.slice(0, 3).join(' ')
    if (key === 'cicd work list') return { code: 0, stderr: '', stdout: JSON.stringify({ result: [
      { Name: 'US-0000456', copado__User_Story_Title__c: 'Route APAC accounts', copado__Status__c: 'In Progress' },
      { Name: 'US-0000457', copado__User_Story_Title__c: 'Invoice tweak', copado__Status__c: 'In Progress' },
      { Name: 'US-0000231', copado__User_Story_Title__c: 'Territory project', copado__Status__c: 'Completed' },
    ] }) }
    if (key === 'cicd work get') return { code: 0, stderr: '', stdout: JSON.stringify({ result: { Name: args[3], copado__User_Story_Title__c: 'Territory project 2021', copado__Status__c: 'Completed' } }) }
    if (key === 'ai agent ask') {
      const prompt = args[args.indexOf('-p') + 1]
      const m = /<<<SUNSET_FILE\n([\s\S]*)\nSUNSET_FILE>>>/.exec(prompt)
      if (!m) return { code: 0, stderr: '', stdout: JSON.stringify({ result: { answer: 'ok' } }) }
      const kept = m[1].split('\n').filter((l) => !/Legacy_Region__c/i.test(l)).join('\n')
      return { code: 0, stderr: '', stdout: JSON.stringify({ result: { answer: `<<<SUNSET_FILE\n${kept}\nSUNSET_FILE>>>\nRemoved lines using the field.` } }) }
    }
    return { code: 1, stderr: 'not faked', stdout: '' }
  }
  if (bin === 'git' || bin === 'which') {
    const r = spawnSync(bin, args, { cwd: opts.cwd, encoding: 'utf8', input: opts.input })
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { code: 1, stderr: `${bin} not available in test`, stdout: '' }
})

const agentia = new Agentia(cfg)
const git = new Git(root, 'origin')

// --- Collision guard: only US-0000456 touches a file that uses the field
const stories = inFlightStories(agentia.listStories(), cfg.inFlightExcludedStatuses)
assert.deepEqual(stories.map((s) => s.name), ['US-0000456', 'US-0000457'])
const collisions = findCollisions(git, stories, 'feature/', 'origin', 'dev', 'Legacy_Region__c', 'force-app')
assert.equal(collisions.length, 1)
assert.equal(collisions[0].story, 'US-0000456')
assert.ok(collisions[0].hits.every((h) => h.file.endsWith('TerritoryAssigner.cls')))

// --- Investigate offline: repo + history (origin story from commit message)
const inv = investigate(cfg, 'Account.Legacy_Region__c', { offline: true }, { agentia, sf: new Salesforce(), git })
assert.equal(inv.repo.summary.blocker, 6)
assert.ok(inv.origin?.summary.includes('US-0000231'), inv.origin?.summary)

// --- Plan + detach with --no-commit (local only), Build agent auto-approved
const plan = createPlan(cfg, undefined, [inv], { createStories: false })
await runDetach({ cfg, agentia, sf: new Salesforce(), git }, plan, { yes: true, noCommit: true })
const saved = loadPlan(cfg.stateDir, plan.id)
const detach = saved.phases.find((p) => p.name === 'detach')!
assert.ok(detach.changedFiles.some((f) => f.endsWith('Account-Account Layout.layout-meta.xml')))
assert.ok(detach.changedFiles.some((f) => f.endsWith('By_Region.listView-meta.xml')))
assert.ok(detach.changedFiles.some((f) => f.endsWith('TerritoryAssigner.cls')))
assert.ok(!/Legacy_Region__c/.test(readFileSync(join(root, 'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml'), 'utf8')))
assert.ok(!/Legacy_Region__c/.test(readFileSync(cls, 'utf8')))
// Permission sets are NOT touched in detach (quarantine handles them)
assert.match(readFileSync(join(root, 'force-app/main/default/permissionsets/Sales_Ops.permissionset-meta.xml'), 'utf8'), /Legacy_Region__c/)
const capsuleId = saved.capsules['Account.Legacy_Region__c']
assert.ok(capsuleId)

// --- Restore files from the capsule (local only)
await runRestore({ cfg, agentia, sf: new Salesforce(), git }, saved, { noCommit: true, yes: true })
assert.match(readFileSync(cls, 'utf8'), /Legacy_Region__c/)
assert.match(readFileSync(join(root, 'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml'), 'utf8'), /Legacy_Region__c/)

// --- Tombstone guard: a branch that re-adds a retired field is caught
addTombstone(cfg.stateDir, { qualified: 'Account.Legacy_Region__c', field: 'Legacy_Region__c', retiredAt: new Date().toISOString(), planId: plan.id })
const reintro = git.changedFiles('dev', 'feature/US-0000456', 'force-app').flatMap((f) => git.grepFileAtRef('feature/US-0000456', 'Legacy_Region__c', f))
assert.ok(reintro.length > 0)
const clean = git.changedFiles('dev', 'feature/US-0000457', 'force-app').flatMap((f) => git.grepFileAtRef('feature/US-0000457', 'Legacy_Region__c', f))
assert.equal(clean.length, 0)

console.log('integration: ok')
