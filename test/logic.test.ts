import assert from 'node:assert/strict'
import { parseOracle } from '../src/engine/oracle.ts'
import { decideVerdict, type UsageFacts } from '../src/engine/usage.ts'
import { canStart, newPhase, type Plan } from '../src/core/plan.ts'
import { extractPatchedFile, renameFieldInText } from '../src/engine/patcher.ts'
import { parseDeployResult, packageXml } from '../src/adapters/salesforce.ts'
import { storyIdsFrom } from '../src/adapters/git.ts'
import { fillTemplate } from '../src/core/config.ts'
import { parseCsv, toCsv } from '../src/util/csv.ts'
import { scoreCandidate } from '../src/engine/scanReport.ts'
import { metadataMemberOf } from '../src/core/referenceFinder.ts'
import { redact } from '../src/core/runner.ts'

// ---- Oracle parsing (shape of sf project deploy validate --json failures)
const deploy = parseDeployResult({
  status: 1,
  result: { success: false, details: { componentFailures: [
    { fullName: 'Account.Legacy_Region__c', componentType: 'CustomField', problem: 'This custom field is referenced elsewhere in salesforce.com. : Apex Class - TerritoryAssigner, Flow - Account_Region_Sync, Validation Rule - Account.Region_Required_For_Enterprise' },
  ] } },
})
const o = parseOracle('DEV', deploy, 'Account.Legacy_Region__c')
assert.equal(o.deletable, false)
assert.deepEqual(o.blockers.map((b) => `${b.type}|${b.name}`), ['Apex Class|TerritoryAssigner', 'Flow|Account_Region_Sync', 'Validation Rule|Account.Region_Required_For_Enterprise'])
assert.equal(parseOracle('DEV', parseDeployResult({ status: 0, result: { success: true, details: {} } }), 'Account.X__c').deletable, true)

// ---- Usage verdicts
const now = new Date('2026-10-01T00:00:00Z')
const base: UsageFacts = { env: 'PROD', fieldType: 'string', filterable: true, required: false, totalRecords: 1000, populated: 3, fillRatePct: 0.3, lastWritten: '2023-02-01T00:00:00Z', recentPopulatedWrites: 0, historyTracked: false, reports: [{ name: 'Accounts by Region', lastRunDate: '2022-05-01T00:00:00Z' }], sampled: false, notes: [] }
const opts = { recentDays: 30, cautionFillRatePct: 5, staleDays: 365, now }
assert.equal(decideVerdict(base, opts).verdict, 'SAFE')
assert.equal(decideVerdict({ ...base, lastWritten: '2026-09-30T10:00:00Z', recentPopulatedWrites: 40, lastWrittenBy: 'Integration User' }, opts).verdict, 'BLOCKED')
assert.equal(decideVerdict({ ...base, fillRatePct: 22 }, opts).verdict, 'CAUTION')
assert.equal(decideVerdict({ ...base, reports: [{ name: 'Pipeline', lastRunDate: '2026-08-01T00:00:00Z' }] }, opts).verdict, 'CAUTION')
assert.equal(decideVerdict({ ...base, required: true }, opts).verdict, 'BLOCKED')

// ---- Phase gates
const plan: Plan = { id: 'p', kind: 'retire', createdAt: '', targets: [{ object: 'Account', field: 'X__c', qualified: 'Account.X__c', verdict: 'SAFE' }], phases: ['detach', 'quarantine', 'archive', 'retire'].map((n) => newPhase(n as any, ['DEV', 'UAT', 'PROD'])), capsules: {}, history: [] }
assert.equal(canStart(plan, 'detach', { prodEnv: 'PROD' }).ok, true)
assert.equal(canStart(plan, 'quarantine', { prodEnv: 'PROD' }).ok, false)
plan.phases[0].status = 'done'
plan.phases[0].environments.forEach((e) => (e.status = 'verified'))
assert.equal(canStart(plan, 'quarantine', { prodEnv: 'PROD' }).ok, true)
plan.phases[1].status = 'done'
plan.phases[2].status = 'done'
plan.quarantine = { startedAt: '2026-09-20T00:00:00Z', endsAt: '2026-10-04T00:00:00Z', signals: [] }
plan.capsules['Account.X__c'] = 'cap'
assert.equal(canStart(plan, 'retire', { prodEnv: 'PROD', now }).ok, false, 'quarantine not over')
assert.equal(canStart(plan, 'retire', { prodEnv: 'PROD', now, overrideQuarantine: true }).ok, true)
plan.quarantine.signals.push({ at: '', kind: 'write', detail: 'x' })
assert.equal(canStart(plan, 'retire', { prodEnv: 'PROD', now, overrideQuarantine: true }).ok, false, 'signals block even with override')
plan.quarantine.signals = []
plan.targets[0].verdict = 'BLOCKED'
assert.equal(canStart(plan, 'retire', { prodEnv: 'PROD', now: new Date('2026-11-01') }).ok, false, 'BLOCKED verdict')

// ---- Patch extraction and deterministic rename
const ans = 'Sure.\n<<<SUNSET_FILE\npublic class A {}\nSUNSET_FILE>>>\nRemoved the field.'
assert.equal(extractPatchedFile(ans).content, 'public class A {}\n')
assert.equal(extractPatchedFile(ans).explanation, 'Removed the field.')
assert.equal(extractPatchedFile('no markers').content, undefined)
assert.equal(renameFieldInText('SELECT Region_New__c FROM Account WHERE region_new__c != null', 'Account', 'Region_New__c', 'Region__c'), 'SELECT Region__c FROM Account WHERE Region__c != null')

// ---- Misc helpers
assert.match(packageXml([{ type: 'CustomField', name: 'Account.X__c' }], '62.0'), /<members>Account\.X__c<\/members>\s*<name>CustomField<\/name>/)
assert.deepEqual(storyIdsFrom(['Merge branch feature/US-0000231 into dev', 'US-0000231: add region', 'feature/US-0009999']), ['US-0000231', 'US-0009999'])
assert.deepEqual(fillTemplate(['cicd', 'work', 'get', '{story}'], { story: 'US-1' }), ['cicd', 'work', 'get', 'US-1'])
assert.throws(() => fillTemplate(['x', '{pipelineId}'], {}), /Missing value/)
assert.deepEqual(parseCsv(toCsv([['Id', 'V'], ['001', 'a,"b"\nc']])), [['Id', 'V'], ['001', 'a,"b"\nc']])
assert.ok(scoreCandidate({ qualified: 'A.X__c', field: 'X__c', blockers: 0, hazards: 1, warnings: 0, fillRatePct: 0 }).score > scoreCandidate({ qualified: 'A.Y__c', field: 'Y__c', blockers: 3, hazards: 1, warnings: 1, fillRatePct: 12 }).score)
assert.deepEqual(metadataMemberOf('force-app/main/default/objects/Account/fields/X__c.field-meta.xml'), { type: 'CustomField', name: 'Account.X__c' })
assert.deepEqual(metadataMemberOf('force-app/main/default/lwc/regionBadge/regionBadge.js'), { type: 'LightningComponentBundle', name: 'regionBadge' })
assert.deepEqual(metadataMemberOf('force-app/main/default/classes/TerritoryAssigner.cls'), { type: 'ApexClass', name: 'TerritoryAssigner' })
assert.ok(!redact('{"accessToken":"00Dabc!AQ4AQ123456789012345678901234"}').includes('AQ4AQ'))
console.log('logic: ok')

// ---- Optional placeholders drop their flag when empty
{
  const { fillTemplate: ft, DEFAULT_COMMANDS: dc } = await import('../src/core/config.ts')
  assert.deepEqual(ft(dc.workCreate, { title: 'T', description: 'D', copadoProjectId: '', credentialId: 'a0C1' }), ['cicd', 'work', 'create', '--title', 'T', '--functional-requirements', 'D', '--source-credential', 'a0C1', '--json'])
  assert.deepEqual(ft(dc.workCreate, { title: 'T', description: 'D' }), ['cicd', 'work', 'create', '--title', 'T', '--functional-requirements', 'D', '--json'])
  assert.deepEqual(ft(dc.commitCreate, { story: 'a0S1' }), ['cicd', 'work', 'commit', 'a0S1', '--cloud', '--stdin', '--wait', '--json'])
  console.log('templates: ok')
}
