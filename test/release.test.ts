/** submitAndWait: work set + work submit --done, stash/unstash local edits, poll promotions. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agentia } from '../src/adapters/agentia.ts'
import { Git } from '../src/adapters/git.ts'
import { Salesforce } from '../src/adapters/salesforce.ts'
import { loadConfig } from '../src/core/config.ts'
import { setExecutor, resetExecutor } from '../src/core/runner.ts'
import { submitAndWait } from '../src/engine/release.ts'

const root = mkdtempSync(join(tmpdir(), 'sunset-rel-'))
const g = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' })
g('init', '-q', '-b', 'dev1-sfp'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T')
writeFileSync(join(root, 'f.txt'), 'one\n'); g('add', '-A'); g('commit', '-q', '-m', 'init')
writeFileSync(join(root, 'f.txt'), 'local edit\n') // uncommitted tracked change
writeFileSync(join(root, '.sunset.json'), JSON.stringify({ pipelineId: 'P', environments: [{ name: 'Dev1-SFP', sfAlias: 'd' }, { name: 'INT-SFP', sfAlias: 'i' }] }))
const cfg = loadConfig(root)

const calls: string[] = []
let polls = 0
setExecutor((bin, args, opts) => {
  if (bin === 'agentia') {
    const key = args.slice(0, 3).join(' ')
    calls.push(key)
    if (key === 'cicd work set') {
      // work set requires a clean tracked tree: prove Sunset stashed the edit
      assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), 'one\n')
      return { code: 0, stdout: '{"result":{}}', stderr: '' }
    }
    if (key === 'cicd work submit') return { code: 0, stdout: '{"result":{}}', stderr: '' }
    if (key === 'cicd promotion list') {
      polls++
      const status = polls < 2 ? 'In Progress' : 'Completed'
      return { code: 0, stderr: '', stdout: JSON.stringify({ result: [{ id: 'a17', name: 'P00001', status, sourceEnvironmentName: 'Dev1-SFP', destinationEnvironmentName: 'INT-SFP', lastPromotionExecutionStatus: 'Successful', lastDeploymentExecutionStatus: polls < 2 ? '' : 'Successful' }] }) }
    }
    return { code: 1, stdout: '', stderr: 'unexpected ' + key }
  }
  const r = spawnSync(bin, args, { cwd: opts.cwd, encoding: 'utf8', input: opts.input })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
})

await submitAndWait({ cfg, agentia: new Agentia(cfg), sf: new Salesforce(), git: new Git(root) }, { id: 'a1v', name: 'a1vhm0000009YLpAAM' }, 'INT-SFP', 1, 10)
assert.deepEqual(calls.slice(0, 2), ['cicd work set', 'cicd work submit'])
assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), 'local edit\n', 'local edit restored')
assert.ok(polls >= 2)

// A failed deployment is reported
polls = 0
setExecutor((bin, args, opts) => {
  if (bin === 'agentia') {
    const key = args.slice(0, 3).join(' ')
    if (key === 'cicd promotion list') return { code: 0, stderr: '', stdout: JSON.stringify({ result: [{ name: 'P00002', status: 'Completed', destinationEnvironmentName: 'UAT-SFP', lastDeploymentExecutionStatus: 'Failed' }] }) }
    return { code: 0, stdout: '{"result":{}}', stderr: '' }
  }
  const r = spawnSync(bin, args, { cwd: opts.cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
})
await assert.rejects(submitAndWait({ cfg, agentia: new Agentia(cfg), sf: new Salesforce(), git: new Git(root) }, { id: 'a1v', name: 'a1v' }, 'UAT-SFP', 1, 10), /Failed/)
resetExecutor()
console.log('release: ok')
