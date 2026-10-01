/**
 * Deterministic metadata editors (no AI). Each takes XML text and returns the
 * edited XML. Salesforce API names are case-insensitive, so matching is too.
 *
 * Important Salesforce behaviour these editors respect:
 *  - Deploying a permission set/profile WITHOUT a fieldPermissions entry does
 *    not revoke access. To hide a field you must deploy explicit false values.
 *    That is why quarantine uses setFieldPermission(false,false), and only the
 *    retire phase removes the entries.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches <tag>Field</tag> or <tag>Object.Field</tag> or <tag>Record.Field</tag>. */
function valueMatches(tag: string, object: string, field: string) {
  return new RegExp(`<${tag}>\\s*(?:(?:${esc(object)}|Record)\\.)?${esc(field)}\\s*</${tag}>`, 'i')
}

/** Remove every <block>...</block> (non-nested) whose body satisfies the test, with its indentation and newline. */
export function removeBlocks(xml: string, block: string, test: (body: string) => boolean): { xml: string; removed: number } {
  let removed = 0
  const re = new RegExp(`[ \\t]*<${block}>([\\s\\S]*?)</${block}>[ \\t]*\\r?\\n?`, 'g')
  const out = xml.replace(re, (whole, body: string) => {
    if (test(body)) {
      removed++
      return ''
    }
    return whole
  })
  return { xml: out, removed }
}

/** Remove single-line elements like <columns>Field</columns>. */
export function removeElements(xml: string, tag: string, object: string, field: string): { xml: string; removed: number } {
  let removed = 0
  const re = new RegExp(`[ \\t]*<${tag}>\\s*(?:(?:${esc(object)}|Record)\\.)?${esc(field)}\\s*</${tag}>[ \\t]*\\r?\\n?`, 'gi')
  const out = xml.replace(re, () => {
    removed++
    return ''
  })
  return { xml: out, removed }
}

export function removeFromLayout(xml: string, object: string, field: string) {
  const a = removeBlocks(xml, 'layoutItems', (b) => valueMatches('field', object, field).test(b))
  const b = removeElements(a.xml, 'fields', object, field) // related list columns
  return { xml: b.xml, removed: a.removed + b.removed }
}

export function removeFromListView(xml: string, object: string, field: string) {
  const a = removeElements(xml, 'columns', object, field)
  const b = removeBlocks(a.xml, 'filters', (body) => valueMatches('field', object, field).test(body))
  return { xml: b.xml, removed: a.removed + b.removed }
}

export const removeFromCompactLayout = (xml: string, object: string, field: string) => removeElements(xml, 'fields', object, field)

export const removeFromRecordType = (xml: string, object: string, field: string) =>
  removeBlocks(xml, 'picklistValues', (b) => valueMatches('picklist', object, field).test(b))

export function removeFromFieldSet(xml: string, object: string, field: string) {
  const a = removeBlocks(xml, 'displayedFields', (b) => valueMatches('field', object, field).test(b))
  const b = removeBlocks(a.xml, 'availableFields', (body) => valueMatches('field', object, field).test(body))
  return { xml: b.xml, removed: a.removed + b.removed }
}

export const removeFromQuickAction = (xml: string, object: string, field: string) =>
  removeBlocks(xml, 'quickActionLayoutItems', (b) => valueMatches('field', object, field).test(b))

export const removeFromFlexiPage = (xml: string, object: string, field: string) =>
  removeBlocks(xml, 'itemInstances', (b) => valueMatches('fieldItem', object, field).test(b))

export const removeFromReport = (xml: string, object: string, field: string) =>
  removeBlocks(xml, 'columns', (b) => valueMatches('field', object, field).test(b))

/** Remove the fieldPermissions entry entirely (retire phase only). */
export const removeFieldPermission = (xml: string, object: string, field: string) =>
  removeBlocks(xml, 'fieldPermissions', (b) => new RegExp(`<field>\\s*${esc(object)}\\.${esc(field)}\\s*</field>`, 'i').test(b))

/**
 * Set explicit field permissions (quarantine phase). Updates the existing entry
 * or inserts a new one so the deploy actively revokes access.
 */
export function setFieldPermission(xml: string, object: string, field: string, readable: boolean, editable: boolean): { xml: string; changed: boolean } {
  const qualified = `${object}.${field}`
  const entryRe = new RegExp(`(<fieldPermissions>)([\\s\\S]*?<field>\\s*${esc(object)}\\.${esc(field)}\\s*</field>[\\s\\S]*?)(</fieldPermissions>)`, 'i')
  const m = entryRe.exec(xml)
  if (m) {
    let body = m[2]
    body = body.replace(/<readable>\s*(true|false)\s*<\/readable>/i, `<readable>${readable}</readable>`)
    body = body.replace(/<editable>\s*(true|false)\s*<\/editable>/i, `<editable>${editable}</editable>`)
    if (!/<readable>/i.test(body)) body = body.replace(/(<\/field>)/i, `$1\n        <readable>${readable}</readable>`)
    if (!/<editable>/i.test(body)) body = body.replace(/(\s*)(<field>)/i, `$1<editable>${editable}</editable>$1$2`)
    const updated = xml.replace(entryRe, `$1${body}$3`)
    return { xml: updated, changed: updated !== xml }
  }
  const indent = /\n([ \t]+)<\w/.exec(xml)?.[1] ?? '    '
  const inner = `${indent}${indent}`
  const entry = `${indent}<fieldPermissions>\n${inner}<editable>${editable}</editable>\n${inner}<field>${qualified}</field>\n${inner}<readable>${readable}</readable>\n${indent}</fieldPermissions>\n`
  // Salesforce sorts elements alphabetically; inserting before the closing root tag is accepted on deploy.
  const updated = xml.replace(/(\s*)(<\/(?:PermissionSet|Profile)>\s*)$/, `\n${entry}$2`)
  return { xml: updated, changed: updated !== xml }
}

/** Pick the right detach editor for a file path. */
export function detachEditorFor(path: string): ((xml: string, object: string, field: string) => { xml: string; removed: number }) | undefined {
  if (path.endsWith('.layout-meta.xml')) return removeFromLayout
  if (path.endsWith('.listView-meta.xml')) return removeFromListView
  if (path.endsWith('.compactLayout-meta.xml')) return removeFromCompactLayout
  if (path.endsWith('.recordType-meta.xml')) return removeFromRecordType
  if (path.endsWith('.fieldSet-meta.xml')) return removeFromFieldSet
  if (path.endsWith('.quickAction-meta.xml')) return removeFromQuickAction
  if (path.endsWith('.flexipage-meta.xml')) return removeFromFlexiPage
  return undefined
}

export const isPermissionFile = (p: string) => p.endsWith('.permissionset-meta.xml') || p.endsWith('.profile-meta.xml')
