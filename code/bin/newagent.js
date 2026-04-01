#!/usr/bin/env node

import { loadNewagentEnv } from '../config/load-env.js'
import { executeCli } from '../shell/cli/session-cli.js'

await loadNewagentEnv()

const result = await executeCli({
  argv: process.argv.slice(2)
})

if (result.stdout) {
  process.stdout.write(result.stdout)
}

if (result.stderr) {
  process.stderr.write(result.stderr)
}

process.exitCode = result.exitCode
