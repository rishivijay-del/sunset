import { Args, Flags } from '@oclif/core'
import { Salesforce } from '../../adapters/salesforce.js'
import { envByName, prodEnv } from '../../core/config.js'
import { scanObject } from '../../engine/scanReport.js'
import { color, icon, table } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Scan extends SunsetCommand {
  static override description = "Rank an object's custom fields by how safe they are to retire"
  static override examples = ['<%= config.bin %> sunset scan Account', '<%= config.bin %> sunset scan Account --org PROD --limit 20']
  static override args = { object: Args.string({ description: 'Object API name, e.g. Account', required: true }) }
  static override flags = {
    org: Flags.string({ description: 'Environment to measure fill rates in (default: none, repo only). Use "prod" for production.' }),
    limit: Flags.integer({ description: 'Show only the top N candidates' }),
    json: Flags.boolean({ default: false }),
  }

  async run() {
    const { args, flags } = await this.parse(Scan)
    const cfg = this.init0(flags)
    const env = flags.org ? (flags.org.toLowerCase() === 'prod' ? prodEnv(cfg) : envByName(cfg, flags.org)) : undefined
    const res = scanObject(cfg, args.object, { sf: env ? new Salesforce() : undefined, env, limit: flags.limit })
    if (flags.json) return this.log(JSON.stringify(res, null, 2))
    this.log(`\n${color.bold(`${icon.sun}  Sunset scan ${args.object}`)}: ${res.totalCustomFields} custom fields in repo, limit ${cfg.fieldLimit} (headroom ${res.headroom})\n`)
    const rows = res.candidates.map((c) => [String(c.score), c.field, c.type ?? '', c.fillRatePct === undefined ? '—' : `${c.fillRatePct.toFixed(1)}%`, c.reason])
    this.log(table(rows, ['Safety', 'Field', 'Type', 'Filled', 'Why']))
    const easy = res.candidates.filter((c) => c.score >= 80).length
    this.log(`\n${color.green(`${easy} field(s) look safe to retire first.`)} Investigate one: ${color.cyan(`agentia sunset investigate ${args.object}.<Field__c>`)}`)
  }
}
