import { Args } from '@oclif/core'
import { listPlans, loadPlan } from '../../core/plan.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

const paint = (s: string) => (s === 'done' || s === 'verified' ? color.green(s) : s === 'failed' || s === 'blocked' ? color.red(s) : s === 'in-progress' || s === 'deployed' ? color.yellow(s) : color.dim(s))

export default class Status extends SunsetCommand {
  static override description = 'Show where every phase of a plan is, per environment'
  static override args = { plan: Args.string({ description: 'Plan id (omit to list all)' }) }

  async run() {
    const { args, flags } = await this.parse(Status)
    const cfg = this.init0(flags)
    if (!args.plan) {
      const plans = listPlans(cfg.stateDir)
      if (!plans.length) return this.log('No plans yet. Start with: agentia sunset scan <Object>')
      for (const p of plans) this.log(`${p.id}  ${p.targets.map((t) => t.qualified).join(', ')}  ${p.phases.map((x) => `${x.name}:${paint(x.status)}`).join(' ')}`)
      return
    }
    const plan = loadPlan(cfg.stateDir, args.plan)
    this.log(`\n${color.bold(`${icon.sun}  ${plan.id}`)} (${plan.kind}) ${plan.targets.map((t) => `${t.qualified} [${t.verdict ?? '?'}]`).join(', ')}\n`)
    for (const p of plan.phases) {
      this.log(`${color.bold(p.name.padEnd(11))} ${paint(p.status).padEnd(12)} ${p.storyName ?? color.dim('no story')}`)
      this.log(`             ${p.environments.map((e) => `${e.env}:${paint(e.status)}`).join('  ')}`)
      if (p.manualTasks.length) this.log(color.yellow(`             ${p.manualTasks.length} manual task(s)`))
    }
    if (plan.quarantine) this.log(`\nQuarantine: ${plan.quarantine.startedAt.slice(0, 10)} → ${plan.quarantine.endsAt.slice(0, 10)}, ${plan.quarantine.signals.length} signal(s)`)
    this.log(`Capsules: ${Object.values(plan.capsules).join(', ') || 'none yet'}`)
    const next = plan.phases.find((p) => p.status !== 'done' && p.status !== 'skipped')
    if (next) this.log(`\nNext: ${color.cyan(next.name === 'retire' && plan.quarantine ? `agentia sunset watch ${plan.id}` : `agentia sunset execute ${plan.id} --phase ${next.name}`)}`)
    else this.log(color.green(`\n${icon.ok} All phases complete.`))
  }
}
