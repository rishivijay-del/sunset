import { Args, Flags } from '@oclif/core'
import { readFileSync } from 'node:fs'
import { Agentia } from '../../adapters/agentia.js'
import { loadPlan } from '../../core/plan.js'
import { writeReport } from '../../engine/scanReport.js'
import { icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Report extends SunsetCommand {
  static override description = 'Write a before/after report for a plan (optionally with AI release notes and a stakeholder notice)'
  static override args = { plan: Args.string({ required: true }) }
  static override flags = {
    ai: Flags.boolean({ description: 'Add release notes (Release agent) and a stakeholder notice (Operate agent)', default: false }),
    print: Flags.boolean({ description: 'Print the report to the terminal', default: true, allowNo: true }),
  }

  async run() {
    const { args, flags } = await this.parse(Report)
    const cfg = this.init0(flags)
    const plan = loadPlan(cfg.stateDir, args.plan)
    const file = writeReport(cfg, plan, new Agentia(cfg), flags.ai)
    if (flags.print) this.log(readFileSync(file, 'utf8'))
    this.log(`${icon.ok} Report written to ${file}`)
  }
}
