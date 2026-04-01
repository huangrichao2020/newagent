import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeCli } from '../shell/cli/session-cli.js'

async function runCommand(argv) {
  const result = await executeCli({ argv })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Command failed: ${argv.join(' ')}`)
  }

  return JSON.parse(result.stdout)
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-m1-demo-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })

  const notePath = join(workspaceRoot, 'note.txt')
  await writeFile(notePath, 'hello from the M1 demo\n', 'utf8')

  const started = await runCommand([
    'start',
    '--storage-root',
    storageRoot,
    '--title',
    'M1 Demo Session',
    '--project-key',
    'newagent',
    '--request',
    'Demonstrate the minimal M1 shell flow',
    '--json'
  ])

  const planned = await runCommand([
    'plan-create',
    '--storage-root',
    storageRoot,
    '--session-id',
    started.session.id,
    '--steps-json',
    JSON.stringify([
      {
        title: 'Read the demo note',
        kind: 'implementation'
      }
    ]),
    '--json'
  ])

  const executed = await runCommand([
    'step-run',
    '--storage-root',
    storageRoot,
    '--workspace-root',
    workspaceRoot,
    '--session-id',
    started.session.id,
    '--input',
    'Use the current step to read the demo note.',
    '--tool-name',
    'read_file',
    '--tool-input-json',
    JSON.stringify({
      path: notePath
    }),
    '--json'
  ])

  const remembered = await runCommand([
    'memory',
    'add',
    '--storage-root',
    storageRoot,
    '--session-id',
    started.session.id,
    '--scope',
    'session',
    '--kind',
    'summary',
    '--content',
    'The M1 demo completed a safe single-step execution.',
    '--tags',
    'demo,m1',
    '--json'
  ])

  const status = await runCommand([
    'status',
    '--storage-root',
    storageRoot,
    '--session-id',
    started.session.id,
    '--json'
  ])

  const output = {
    root,
    storage_root: storageRoot,
    workspace_root: workspaceRoot,
    session_id: started.session.id,
    plan_step_count: planned.steps.length,
    execution_status: executed.status,
    tool_status: executed.tool_result.status,
    memory_id: remembered.entry.id,
    final_status: status
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

await main()
