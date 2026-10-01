import { existsSync } from 'node:fs'
import { Agentia } from '../../adapters/agentia.js'
import { Git } from '../../adapters/git.js'
import { run, which } from '../../core/runner.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Doctor extends SunsetCommand {
  static override description = 'Check that everything Sunset needs is installed, configured and authenticated'

  async run() {
    const { flags } = await this.parse(Doctor)
    const cfg = this.init0(flags)
    const checks: { name: string; ok: boolean; fix?: string; detail?: string }[] = []
    const major = Number(process.versions.node.split('.')[0])
    checks.push({ name: `Node.js ${process.versions.node}`, ok: major >= 18, fix: 'Install Node.js 22 LTS from nodejs.org' })
    checks.push({ name: 'git installed', ok: which('git'), fix: 'Install Git (xcode-select --install on macOS)' })
    checks.push({ name: 'Salesforce CLI (sf) installed', ok: which('sf'), fix: 'npm install -g @salesforce/cli' })
    checks.push({ name: 'Agentia CLI installed', ok: which('agentia'), fix: 'npm install -g @copado/agentia-cli@beta' })
    checks.push({ name: '.sunset.json found', ok: Boolean(cfg.configPath), fix: 'Copy .sunset.example.json to .sunset.json in your Salesforce project and fill it in' })
    checks.push({ name: 'pipelineId set', ok: Boolean(cfg.pipelineId), fix: 'Put your Copado pipeline ID in .sunset.json' })
    checks.push({ name: 'Salesforce project (sfdx-project.json)', ok: existsSync(`${cfg.root}/sfdx-project.json`), fix: 'Run Sunset from the root of your source-format project' })
    const git = new Git(cfg.root, cfg.gitRemote)
    checks.push({ name: 'Git repository with remote', ok: git.isRepo() && run('git', ['remote', 'get-url', cfg.gitRemote], { cwd: cfg.root, allowFail: true }).code === 0, fix: `Clone the Copado pipeline repository and make sure remote "${cfg.gitRemote}" exists` })
    for (const env of cfg.environments) {
      const r = run('sf', ['org', 'display', '-o', env.sfAlias, '--json'], { allowFail: true })
      checks.push({ name: `Salesforce login for ${env.name} (${env.sfAlias})`, ok: r.code === 0, fix: `sf org login web --alias ${env.sfAlias}  (add --instance-url https://test.salesforce.com for sandboxes)` })
    }
    // Only the development (first) environment's credential is used: story creation and Copado dependency lookups.
    const dev = cfg.environments[0]
    checks.push({ name: `Copado credential ID for ${dev.name} (development org)`, ok: Boolean(dev.credentialId), fix: 'agentia cicd credential list --environmentid <ENVIRONMENT_ID> --json' })
    if (which('agentia')) {
      const auth = new Agentia(cfg).auth() ?? {}
      const r = (auth as any).result ?? auth
      // Real shape (agentia 0.12x): { result: { credentials: [ { type: 'cicd'|'ai'|'crt', set, ready, missing } ] } }
      const creds: any[] = Array.isArray(r?.credentials) ? r.credentials : []
      const cred = (type: string) => creds.find((c) => String(c?.type).toLowerCase() === type) ?? r?.[type]
      const isSet = (v: any) => v === true || (v && typeof v === 'object' && (v.set === true || v.ready === true || v.configured === true))
      checks.push({ name: 'Agentia CI/CD credentials (agentia auth get)', ok: isSet(cred('cicd')), fix: 'Run: agentia setup (CI/CD section, Copado API key)' })
      checks.push({ name: 'Agentia AI credentials', ok: isSet(cred('ai')), fix: 'Run: agentia setup (AI section, personal access key)' })
      if (cfg.crt.enabled) {
        const c = cred('crt')
        const missing = Array.isArray(c?.missing) && c.missing.length ? ` missing: ${c.missing.join(', ')}` : ''
        checks.push({ name: 'Agentia Robotic Testing ready', ok: c?.ready === true, fix: `Run: agentia setup (CRT section)${missing}` })
      }
    }
    checks.push({ name: 'CRT smoke job configured (optional)', ok: !cfg.crt.enabled || Boolean(cfg.crt.projectId && cfg.crt.jobId), fix: 'Set crt.projectId and crt.jobId, or set crt.enabled to false' })

    this.log(`\n${color.bold(`${icon.sun}  Sunset doctor`)}\n`)
    for (const c of checks) this.log(`${c.ok ? color.green(icon.ok) : color.red(icon.stop)} ${c.name}${c.ok || !c.fix ? '' : color.dim(`  → ${c.fix}`)}`)
    const bad = checks.filter((c) => !c.ok).length
    this.log(bad ? color.yellow(`\n${bad} item(s) to fix.`) : color.green('\nAll good. Try: agentia sunset scan Account'))
    if (bad) this.exit(1)
  }
}
