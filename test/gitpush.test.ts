/** pushFilesToFeatureBranch: commits exact working-tree files to feature/<story> on the remote, leaving the checkout untouched. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agentia } from '../src/adapters/agentia.ts'
import { Git } from '../src/adapters/git.ts'
import { Salesforce } from '../src/adapters/salesforce.ts'
import { loadConfig } from '../src/core/config.ts'
import { resetExecutor } from '../src/core/runner.ts'
import { featureBranchExists, pushFilesToFeatureBranch } from '../src/engine/release.ts'

resetExecutor()
const bare = mkdtempSync(join(tmpdir(), 'sunset-bare-'))
spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
const root = mkdtempSync(join(tmpdir(), 'sunset-wc-'))
const g = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' })
g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T')
mkdirSync(join(root, 'force-app/ps'), { recursive: true })
writeFileSync(join(root, 'force-app/ps/Zone.permissionset-meta.xml'), '<readable>true</readable>\n')
writeFileSync(join(root, '.sunset.json'), JSON.stringify({ pipelineId: 'P', environments: [{ name: 'Dev1', sfAlias: 'd', branch: 'dev1' }, { name: 'Prod', sfAlias: 'p', branch: 'main', isProduction: true }] }))
g('add', '-A'); g('commit', '-q', '-m', 'base'); g('remote', 'add', 'origin', bare); g('push', '-q', 'origin', 'main')
g('checkout', '-q', '-b', 'dev1'); g('push', '-q', 'origin', 'dev1')
writeFileSync(join(root, 'force-app/ps/Zone.permissionset-meta.xml'), '<readable>false</readable>\n') // local, uncommitted edit
const cfg = loadConfig(root)
const d = { cfg, agentia: new Agentia(cfg), sf: new Salesforce(), git: new Git(root) }
assert.equal(featureBranchExists(d, 'US-1'), false)
pushFilesToFeatureBranch(d, 'US-1', ['force-app/ps/Zone.permissionset-meta.xml'], 'quarantine')
assert.equal(featureBranchExists(d, 'US-1'), true)
const onBranch = spawnSync('git', ['show', 'origin/feature/US-1:force-app/ps/Zone.permissionset-meta.xml'], { cwd: root, encoding: 'utf8' }).stdout
assert.equal(onBranch, '<readable>false</readable>\n')
assert.equal(g('branch', '--show-current').stdout.trim(), 'dev1', 'checkout untouched')
assert.equal(readFileSync(join(root, 'force-app/ps/Zone.permissionset-meta.xml'), 'utf8'), '<readable>false</readable>\n', 'local edit kept')
assert.equal(g('branch', '--list', 'feature/US-1').stdout.trim(), '', 'local feature branch removed for work set')
console.log('git push fallback: ok')
