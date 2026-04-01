import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'newagent-m1-approval-demo-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })

  const targetPath = join(workspaceRoot, 'approved.txt')

  const started = await runCommand([
    'start',
    '--storage-root',
    storageRoot,
    '--title',
    'M1 Approval Demo Session',
    '--project-key',
    'newagent',
    '--request',
    'Demonstrate approval pause and resume',
    '--json'
  ])

  await runCommand([
    'plan-create',
    '--storage-root',
    storageRoot,
    '--session-id',
    started.session.id,
    '--steps-json',
    JSON.stringify([
      {
        title: 'Write an approved file',
        kind: 'implementation'
      }
    ]),
    '--json'
  ])

  const firstAttempt = await runCommand([
    'step-run',
    '--storage-root',
    storageRoot,
    '--workspace-root',
    workspaceRoot,
    '--session-id',
    started.session.id,
    '--input',
    'Try the dangerous write and pause for approval.',
    '--tool-name',
    'write_file',
    '--tool-input-json',
    JSON.stringify({
      path: targetPath,
      content: 'approved path demo\n'
    }),
    '--json'
  ])

  const approval = await runCommand([
    'approve',
    '--storage-root',
    storageRoot,
    '--workspace-root',
    workspaceRoot,
    '--session-id',
    started.session.id,
    '--approval-id',
    firstAttempt.tool_result.approval.id,
    '--resolved-by',
    'demo-user',
    '--continue',
    '--input',
    'Resume the approved write.',
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
  const content = await readFile(targetPath, 'utf8')

  const output = {
    root,
    storage_root: storageRoot,
    workspace_root: workspaceRoot,
    session_id: started.session.id,
    first_attempt_status: firstAttempt.status,
    approval_status: approval.approval.status,
    continued_status: approval.execution.status,
    final_status: status,
    written_content: content
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

await main()
