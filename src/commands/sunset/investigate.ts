import { Args, Flags } from '@oclif/core'
import { investigate } from '../../engine/investigator.js'
import { color, icon, table } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Investigate extends SunsetCommand {
  static override description = 'Everything about one field: references, blockers (asked of Salesforce), usage, history, collisions, verdict'
  static override examples = [
    '<%= config.bin %> sunset investigate Account.Legacy_Region__c',
    '<%= config.bin %> sunset investigate Account.Legacy_Region__c --offline',
  ]
  static override args = { field: Args.string({ description: 'Object.Field__c', required: true }) }
  static override flags = {
    offline: Flags.boolean({ description: 'Repo only: no org or Copado calls', default: false }),
    'skip-oracle': Flags.boolean({ description: 'Skip the check-only validation in the orgs', default: false }),
    env: Flags.string({ description: 'Environment for usage analysis (default: production)' }),
    json: Flags.boolean({ description: 'Machine-readable output', default: false }),
  }

  async run() {
    const { args, flags } = await this.parse(Investigate)
    const cfg = this.init0(flags)
    const inv = investigate(cfg, args.field, { offline: flags.offline, skipOracle: flags['skip-oracle'], usageEnv: flags.env })
    if (flags.json) return this.log(JSON.stringify(inv, null, 2))

    const v = inv.verdict.verdict
    const vColor = v === 'SAFE' ? color.green : v === 'CAUTION' ? color.yellow : color.red
    this.log(`\n${color.bold(`${icon.sun}  Sunset investigate ${inv.target.qualified}`)}\n`)
    this.log(`${color.bold('Verdict:')} ${vColor(v)}`)
    for (const r of inv.verdict.reasons) this.log(`  ${icon.dot} ${r}`)

    if (inv.origin) {
      this.log(`\n${color.bold('Why it exists')}`)
      this.log(`  ${inv.origin.aiSummary ?? inv.origin.summary}`)
      for (const s of inv.origin.stories.slice(0, 5)) this.log(color.dim(`  ${icon.dot} ${s.name}${s.title ? ` "${s.title}"` : ''}${s.status ? ` (${s.status})` : ''}`))
    }

    const groups: [string, string][] = [
      ['blocker', 'Blockers in Git (must change before delete)'],
      ['repoHazard', 'Repo hazards (would break future deploys)'],
      ['warning', 'Impact warnings'],
      ['unknown', 'Unclassified mentions'],
    ]
    for (const [key, label] of groups) {
      const refs = inv.repo.references.filter((r) => r.impact === key)
      if (!refs.length) continue
      this.log(`\n${color.bold(label)}: ${refs.length}`)
      this.log(table(refs.map((r) => [r.kind, `${r.file.replace(/^.*?\/default\//, '')}:${r.lines.join(',')}`, r.confidence])))
    }

    for (const o of inv.oracle) {
      this.log(`\n${color.bold(`Blocker Oracle (${o.env}, asked Salesforce directly)`)}: ${o.deletable ? color.green('deletable now') : `${o.blockers.length} blocker(s)`}`)
      for (const b of o.blockers) this.log(`  ${icon.stop} ${b.type} ${b.name}`)
      for (const e of o.otherErrors.slice(0, 3)) this.log(color.dim(`  ${e}`))
    }

    if (inv.org.length) {
      this.log(`\n${color.bold('Org-side references')} (Copado dependency API + Tooling API): ${inv.org.length}`)
      this.log(table(inv.org.map((o) => [o.type, o.name, o.source])))
    }

    if (inv.usage) {
      const u = inv.usage
      this.log(`\n${color.bold(`Usage in ${u.env}`)}`)
      this.log(`  ${u.populated} of ${u.totalRecords} records have a value (${u.fillRatePct.toFixed(1)}%)${u.sampled ? ' [estimated]' : ''}`)
      if (u.lastWritten) this.log(`  Last written ${u.lastWritten.slice(0, 10)}${u.lastWrittenBy ? ` by ${u.lastWrittenBy}` : ''}`)
      for (const r of u.reports) this.log(`  Report "${r.name}" last run ${r.lastRunDate?.slice(0, 10) ?? 'never'}`)
    }

    if (inv.collisions.length) {
      this.log(`\n${color.red(color.bold(`${icon.warn} In-flight collisions`))}`)
      for (const c of inv.collisions) this.log(`  ${c.story} "${c.title}"${c.owner ? ` (${c.owner})` : ''}: ${c.hits.length} reference(s) in ${c.branch}`)
    }
    for (const n of inv.notes) this.log(color.dim(`note: ${n}`))
    this.log(`\nNext: ${color.cyan(`agentia sunset plan ${inv.target.qualified}`)}`)
  }
}
