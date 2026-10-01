import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Flags } from '@oclif/core'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Init extends SunsetCommand {
  static override description = 'Create .sunset.json in this project, protect backups from Git, and install the tombstone pre-commit hook'
  static override flags = { hook: Flags.boolean({ description: 'Install the git pre-commit tombstone guard', default: true, allowNo: true }) }

  async run() {
    const { flags } = await this.parse(Init)
    const root = process.cwd()
    const here = dirname(fileURLToPath(import.meta.url))
    const example = join(here, '..', '..', '..', '.sunset.example.json')
    const target = join(root, '.sunset.json')
    if (!existsSync(target)) {
      copyFileSync(example, target)
      this.log(`${icon.ok} Created .sunset.json. Fill in pipelineId, credential IDs and aliases.`)
    } else this.log(`${icon.ok} .sunset.json already exists`)

    // Backups can contain customer data: never commit capsules or test logs.
    const gi = join(root, '.gitignore')
    const lines = ['.sunset/capsules/', '.sunset/test-logs/', '.sunset/last-restore.json']
    const current = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
    const missing = lines.filter((l) => !current.includes(l))
    if (missing.length) {
      appendFileSync(gi, `${current.endsWith('\n') || !current ? '' : '\n'}# Sunset backups contain org data; keep them out of Git\n${missing.join('\n')}\n`)
      this.log(`${icon.ok} Added Sunset backup folders to .gitignore`)
    }
    if (flags.hook && existsSync(join(root, '.git'))) {
      const hook = join(root, '.git', 'hooks', 'pre-commit')
      if (!existsSync(hook)) {
        writeFileSync(hook, '#!/bin/sh\n# Sunset tombstone guard: block commits that bring a retired field back\nagentia sunset guard --staged || exit 1\n', { mode: 0o755 })
        this.log(`${icon.ok} Installed pre-commit tombstone guard`)
      }
    }
    this.log(`\nNext: ${color.cyan('agentia sunset doctor')}`)
  }
}
