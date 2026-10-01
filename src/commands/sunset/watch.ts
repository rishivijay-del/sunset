import { Args, Flags } from '@oclif/core'
import { loadPlan } from '../../core/plan.js'
import { watchQuarantine } from '../../engine/phases.js'
import { color, daysBetween, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Watch extends SunsetCommand {
  static override description = 'Quarantine watch: has anyone written to the field or run its reports since it was hidden?'
  static override args = { plan: Args.string({ required: true }) }
  static override flags = {
    signal: Flags.string({ description: 'Record a manual signal (e.g. "Finance asked for this field")' }),
    clear: Flags.boolean({ description: 'Clear resolved signals', default: false }),
  }

  async run() {
    const { args, flags } = await this.parse(Watch)
    const cfg = this.init0(flags)
    const plan = loadPlan(cfg.stateDir, args.plan)
    const q = await watchQuarantine(this.deps(), plan, { signal: flags.signal, clear: flags.clear })
    const left = daysBetween(new Date(), new Date(q.endsAt))
    this.log(`\n${color.bold(`${icon.sun}  Quarantine ${plan.targets.map((t) => t.qualified).join(', ')}`)}`)
    this.log(`  Started ${q.startedAt.slice(0, 10)}, ends ${q.endsAt.slice(0, 10)} (${Math.max(0, left)} day(s) left)`)
    if (!q.signals.length) this.log(color.green(`  ${icon.ok} No signals. Nobody has used the field since it was hidden.`))
    for (const s of q.signals) this.log(color.red(`  ${icon.warn} ${s.at.slice(0, 10)} ${s.kind}: ${s.detail}`))
    if (q.signals.length) this.log(`\n  Retirement is paused. Resolve, then: ${color.cyan(`agentia sunset watch ${plan.id} --clear`)}  or undo: ${color.cyan(`agentia sunset restore ${plan.id}`)}`)
  }
}
