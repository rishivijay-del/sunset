import { Args, Flags } from '@oclif/core'
import { Agentia } from '../../adapters/agentia.js'
import { investigate } from '../../engine/investigator.js'
import { createPlan } from '../../engine/phases.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Merge extends SunsetCommand {
  static override description = 'Consolidate a duplicate field into a surviving one, then retire the duplicate safely'
  static override examples = ['<%= config.bin %> sunset merge Account.Region_New__c Account.Region__c']
  static override args = {
    from: Args.string({ description: 'Field to retire (Object.Field__c)', required: true }),
    into: Args.string({ description: 'Field that survives (Object.Field__c)', required: true }),
  }
  static override flags = { 'no-stories': Flags.boolean({ default: false }) }

  async run() {
    const { args, flags } = await this.parse(Merge)
    const cfg = this.init0(flags)
    if (args.from.split('.')[0].toLowerCase() !== args.into.split('.')[0].toLowerCase()) this.error('Both fields must be on the same object')
    const inv = investigate(cfg, args.from)
    const plan = createPlan(cfg, new Agentia(cfg), [inv], { kind: 'merge', mergeInto: args.into, createStories: !flags['no-stories'] })
    this.log(`${icon.sun} Merge plan ${color.bold(plan.id)}: ${args.from} ${icon.arrow} ${args.into}`)
    this.log(`Next: ${color.cyan(`agentia sunset execute ${plan.id} --phase migrate`)}`)
  }
}
