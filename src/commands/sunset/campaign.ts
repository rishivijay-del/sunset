import { Args, Flags } from '@oclif/core'
import { Agentia } from '../../adapters/agentia.js'
import { investigate } from '../../engine/investigator.js'
import { createPlan } from '../../engine/phases.js'
import { scanObject } from '../../engine/scanReport.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Campaign extends SunsetCommand {
  static override description = 'Retire several fields as one campaign (one set of phased stories, one report)'
  static override examples = ['<%= config.bin %> sunset campaign Account --top 10 --min-score 90']
  static override args = { object: Args.string({ required: true }) }
  static override flags = {
    top: Flags.integer({ description: 'Take the N safest fields from a scan', default: 10 }),
    'min-score': Flags.integer({ description: 'Minimum safety score (0-100)', default: 90 }),
    fields: Flags.string({ description: 'Or give an explicit comma-separated list of Field__c names' }),
    'no-stories': Flags.boolean({ default: false }),
  }

  async run() {
    const { args, flags } = await this.parse(Campaign)
    const cfg = this.init0(flags)
    const names = flags.fields
      ? flags.fields.split(',').map((f) => f.trim())
      : scanObject(cfg, args.object, {}).candidates.filter((c) => c.score >= flags['min-score']).slice(0, flags.top).map((c) => c.field)
    if (!names.length) this.error('No fields matched. Lower --min-score or pass --fields.')
    const invs = names.map((n) => investigate(cfg, `${args.object}.${n}`))
    const kept = invs.filter((i) => i.verdict.verdict !== 'BLOCKED')
    for (const i of invs.filter((x) => x.verdict.verdict === 'BLOCKED')) this.log(color.red(`${icon.stop} Skipping ${i.target.qualified}: BLOCKED (${i.verdict.reasons[0]})`))
    if (!kept.length) this.error('Every candidate is BLOCKED.')
    const plan = createPlan(cfg, new Agentia(cfg), kept, { kind: 'campaign', createStories: !flags['no-stories'] })
    this.log(`${icon.sun} Campaign ${color.bold(plan.id)}: ${kept.length} field(s): ${kept.map((i) => i.target.field).join(', ')}`)
    this.log(`Next: ${color.cyan(`agentia sunset execute ${plan.id} --phase detach`)}`)
  }
}
