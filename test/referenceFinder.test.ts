import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanRepo } from '../src/core/referenceFinder.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repo')
const result = scanRepo(repo, 'Account.Legacy_Region__c')
const byFile = (name: string) => result.references.find((r) => r.file.endsWith(name))

// The field's own definition is found and marked as such
assert.equal(byFile('objects/Account/fields/Legacy_Region__c.field-meta.xml')?.impact, 'definition')

// Blockers: things Salesforce refuses to delete around
for (const [file, kind] of [
  ['TerritoryAssigner.cls', 'Apex class'],
  ['Account_Region_Sync.flow-meta.xml', 'Flow'],
  ['Region_Label__c.field-meta.xml', 'Formula field'],
  ['Region_Required_For_Enterprise.validationRule-meta.xml', 'Validation rule'],
  ['regionBadge.js', 'Lightning web component'],
  ['objects/Contact/fields/Account_Region__c.field-meta.xml', 'Formula field'], // cross-object formula
] as const) {
  const ref = byFile(file)
  assert.ok(ref, `expected a reference in ${file}`)
  assert.equal(ref.impact, 'blocker', `${file} should be a blocker`)
  assert.equal(ref.kind, kind)
}

// Repo hazards: the org allows the delete, but these break future deploys
for (const file of ['Account Layout.layout-meta.xml', 'Sales_Ops.permissionset-meta.xml', 'By_Region.listView-meta.xml']) {
  assert.equal(byFile(file)?.impact, 'repoHazard', `${file} should be a repo hazard`)
}

// Warnings
assert.equal(byFile('Accounts_By_Region.report-meta.xml')?.impact, 'warning')

// Traps: same API name on another object, and unrelated files, are ignored
assert.equal(byFile('objects/Contact/fields/Legacy_Region__c.field-meta.xml'), undefined)
assert.equal(byFile('InvoiceService.cls'), undefined)
assert.equal(byFile('Industry_Notes__c.field-meta.xml'), undefined)

// Confidence: qualified references and same-object files are exact
assert.equal(byFile('Sales_Ops.permissionset-meta.xml')?.confidence, 'exact')
assert.equal(byFile('regionBadge.js')?.confidence, 'exact')
assert.equal(byFile('Account Layout.layout-meta.xml')?.confidence, 'exact')

console.log(JSON.stringify(result.summary))
for (const r of result.references) {
  console.log(`${r.impact.padEnd(10)} ${r.confidence.padEnd(8)} ${r.kind.padEnd(24)} ${r.file}  (lines ${r.lines.join(',')})`)
}
console.log('\nAll Reference Finder tests passed.')
