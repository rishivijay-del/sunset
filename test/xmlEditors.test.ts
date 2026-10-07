import assert from 'node:assert/strict'
import { removeFieldPermission, removeFromFlexiPage, removeFromLayout, removeFromListView, removeFromRecordType, setFieldPermission } from '../src/engine/xmlEditors.ts'

const layout = `<Layout>
    <layoutSections>
        <layoutColumns>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>Name</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>Legacy_Region__c</field>
            </layoutItems>
        </layoutColumns>
    </layoutSections>
    <relatedLists>
        <fields>Account.Legacy_Region__c</fields>
        <fields>NAME</fields>
    </relatedLists>
</Layout>
`
const l = removeFromLayout(layout, 'Account', 'Legacy_Region__c')
assert.equal(l.removed, 2)
assert.ok(!/Legacy_Region__c/.test(l.xml))
assert.ok(/<field>Name<\/field>/.test(l.xml))
assert.ok(/<fields>NAME<\/fields>/.test(l.xml))

const lv = removeFromListView(`<ListView>\n    <columns>NAME</columns>\n    <columns>Legacy_Region__c</columns>\n    <filters>\n        <field>Legacy_Region__c</field>\n        <operation>equals</operation>\n    </filters>\n</ListView>\n`, 'Account', 'Legacy_Region__c')
assert.equal(lv.removed, 2)
assert.ok(!/Legacy_Region__c/.test(lv.xml) && /NAME/.test(lv.xml))

const rt = removeFromRecordType(`<RecordType>\n    <picklistValues>\n        <picklist>Legacy_Region__c</picklist>\n        <values><fullName>EMEA</fullName></values>\n    </picklistValues>\n    <picklistValues>\n        <picklist>Type</picklist>\n    </picklistValues>\n</RecordType>\n`, 'Account', 'Legacy_Region__c')
assert.equal(rt.removed, 1)
assert.ok(/<picklist>Type<\/picklist>/.test(rt.xml))

const fp = removeFromFlexiPage(`<FlexiPage>\n    <itemInstances>\n        <fieldInstance>\n            <fieldItem>Record.Legacy_Region__c</fieldItem>\n        </fieldInstance>\n    </itemInstances>\n    <itemInstances>\n        <fieldInstance><fieldItem>Record.Name</fieldItem></fieldInstance>\n    </itemInstances>\n</FlexiPage>\n`, 'Account', 'Legacy_Region__c')
assert.equal(fp.removed, 1)
assert.ok(/Record\.Name/.test(fp.xml))

const ps = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldPermissions>
        <editable>true</editable>
        <field>Account.Legacy_Region__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <label>Sales Ops</label>
</PermissionSet>
`
const hidden = setFieldPermission(ps, 'Account', 'Legacy_Region__c', false, false)
assert.ok(hidden.changed)
assert.ok(/<editable>false<\/editable>\s*<field>Account\.Legacy_Region__c<\/field>\s*<readable>false<\/readable>/.test(hidden.xml))

// Inserting an explicit entry where none exists (so the deploy actively revokes access)
const noEntry = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <custom>false</custom>\n</Profile>\n`
const inserted = setFieldPermission(noEntry, 'Account', 'Legacy_Region__c', false, false)
assert.ok(inserted.changed)
assert.ok(/<fieldPermissions>[\s\S]*<field>Account\.Legacy_Region__c<\/field>[\s\S]*<readable>false<\/readable>[\s\S]*<\/fieldPermissions>\s*<\/Profile>/.test(inserted.xml))

const removed = removeFieldPermission(hidden.xml, 'Account', 'Legacy_Region__c')
assert.equal(removed.removed, 1)
assert.ok(!/Legacy_Region__c/.test(removed.xml) && /<label>Sales Ops<\/label>/.test(removed.xml))

// Same field name on another object is untouched
const other = setFieldPermission(ps.replace('Account.', 'Contact.'), 'Account', 'Legacy_Region__c', false, false)
assert.ok(/<field>Contact\.Legacy_Region__c<\/field>\s*<readable>true<\/readable>/.test(other.xml))
console.log('xmlEditors: ok')

// Inserting into a permission set that has no fieldPermissions yet must keep element order (before <label>)
{
  const ps2 = `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>x</description>\n    <hasActivationRequired>false</hasActivationRequired>\n    <label>L</label>\n</PermissionSet>\n`
  const r2 = setFieldPermission(ps2, 'Account', 'Market_Zone__c', false, false)
  assert.ok(r2.xml.indexOf('<fieldPermissions>') > r2.xml.indexOf('<description>'))
  assert.ok(r2.xml.indexOf('<fieldPermissions>') < r2.xml.indexOf('<hasActivationRequired>'))
  // With existing entries, the new one goes right after the last one (still grouped)
  const ps3 = `<PermissionSet>\n    <fieldPermissions>\n        <editable>true</editable>\n        <field>Account.A__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n    <label>L</label>\n</PermissionSet>\n`
  const r3 = setFieldPermission(ps3, 'Account', 'B__c', false, false)
  assert.ok(/<\/fieldPermissions>\n    <fieldPermissions>[\s\S]*Account\.B__c[\s\S]*<\/fieldPermissions>\n    <label>/.test(r3.xml), r3.xml)
  console.log('xmlEditors ordering: ok')
}
