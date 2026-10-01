import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapsule, csvRowCount, evaluateProof, preserveFieldDefinition, preserveOriginal, recordDataFile, restoreOriginals, saveCapsule, verifyChecksums, capsuleDir, addTombstone, loadTombstones, removeTombstone } from '../src/engine/capsule.ts'

assert.equal(csvRowCount('Id,V\n001,a\n002,"multi\nline"\n'), 2)
assert.equal(csvRowCount('Id,V\n'), 0)

const repo = mkdtempSync(join(tmpdir(), 'sunset-repo-'))
const state = join(repo, '.sunset')
mkdirSync(join(repo, 'force-app/main/default/objects/Account/fields'), { recursive: true })
mkdirSync(join(repo, 'force-app/main/default/layouts'), { recursive: true })
writeFileSync(join(repo, 'force-app/main/default/objects/Account/fields/X__c.field-meta.xml'), '<CustomField><fullName>X__c</fullName></CustomField>\n')
writeFileSync(join(repo, 'force-app/main/default/layouts/Account-Layout.layout-meta.xml'), '<Layout>original</Layout>\n')

const m = createCapsule(state, 'cap1', 'plan1', { object: 'Account', field: 'X__c', qualified: 'Account.X__c' })
preserveFieldDefinition(state, m, repo, 'force-app/main/default/objects/Account/fields/X__c.field-meta.xml')
preserveOriginal(state, m, repo, 'force-app/main/default/layouts/Account-Layout.layout-meta.xml')
preserveOriginal(state, m, repo, 'force-app/main/default/layouts/Account-Layout.layout-meta.xml') // idempotent
assert.equal(m.originals.length, 1)

mkdirSync(join(capsuleDir(state, 'cap1'), 'data'), { recursive: true })
writeFileSync(join(capsuleDir(state, 'cap1'), 'data/PROD.csv'), 'Id,X__c\n001,a\n002,b\n003,c\n')
recordDataFile(state, m, 'PROD', 'data/PROD.csv', 3)
m.proof.definitionValid = true
saveCapsule(state, m)
assert.equal(evaluateProof(m).proven, true)
assert.deepEqual(verifyChecksums(state, m), [])

recordDataFile(state, m, 'PROD', 'data/PROD.csv', 4) // org has one more value than the export
assert.equal(evaluateProof(m).proven, false)

// Tamper detection
writeFileSync(join(capsuleDir(state, 'cap1'), 'data/PROD.csv'), 'Id,X__c\n001,changed\n')
assert.deepEqual(verifyChecksums(state, m), ['data/PROD.csv'])

// Restore puts originals and the definition back
writeFileSync(join(repo, 'force-app/main/default/layouts/Account-Layout.layout-meta.xml'), '<Layout>edited</Layout>\n')
writeFileSync(join(repo, 'force-app/main/default/objects/Account/fields/X__c.field-meta.xml'), '')
const restored = restoreOriginals(state, m, repo)
assert.equal(restored.length, 2)
assert.equal(readFileSync(join(repo, 'force-app/main/default/layouts/Account-Layout.layout-meta.xml'), 'utf8'), '<Layout>original</Layout>\n')
assert.match(readFileSync(join(repo, 'force-app/main/default/objects/Account/fields/X__c.field-meta.xml'), 'utf8'), /X__c/)

addTombstone(state, { qualified: 'Account.X__c', field: 'X__c', retiredAt: 'now', planId: 'plan1' })
assert.equal(loadTombstones(state).length, 1)
removeTombstone(state, 'account.x__c')
assert.equal(loadTombstones(state).length, 0)
console.log('capsule: ok')
