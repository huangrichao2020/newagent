import { createStepExecutor } from '../executor/step-executor.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { buildPromptContract } from '../prompts/prompt-contract.js'
import { createSessionStore } from '../session/session-store.js'
import { createAgentProfile } from './agent-profile.js'
import { isAbsolute, resolve, sep } from 'node:path'

function cleanString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function stripCodeFence(text) {
  const fencedMatch = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/iu)

  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  return String(text ?? '').trim()
}

function extractJsonObject(text) {
  const stripped = stripCodeFence(text)

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped
  }

  const firstBrace = stripped.indexOf('{')
  const lastBrace = stripped.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Execution response did not contain a JSON object')
  }

  return stripped.slice(firstBrace, lastBrace + 1)
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase()
}

function extractPortFromText(value) {
  const match = String(value ?? '').match(/\b([1-9]\d{1,4})\b/u)

  if (!match) {
    return null
  }

  const port = Number.parseInt(match[1], 10)
  return Number.isInteger(port) && port > 0 ? port : null
}

function extractPathLikeToken(value) {
  const match = String(value ?? '').match(/(\/[A-Za-z0-9._~!$&'()*+,;=:@%/\-]+(?:\.html)?\/?)/u)

  return match ? match[1] : null
}

function extractQuotedStrings(value) {
  const text = String(value ?? '')
  const matches = []
  const patterns = [
    /《([^》]+)》/gu,
    /“([^”]+)”/gu,
    /「([^」]+)」/gu,
    /『([^』]+)』/gu,
    /"([^"]+)"/gu
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const content = cleanString(match[1])

      if (content) {
        matches.push(content)
      }
    }
  }

  return [...new Set(matches)]
}

function parseStructuredStepMetadata(step) {
  const rawText = [
    step?.title ?? '',
    step?.notes ?? ''
  ].filter(Boolean).join('\n')
  const metadata = {}

  for (const line of rawText.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*[:=：]\s*(.+?)\s*$/u)

    if (!match) {
      continue
    }

    metadata[match[1].toLowerCase()] = match[2]
  }

  return metadata
}

function getStructuredMetadataValue(metadata, keys) {
  for (const key of keys) {
    const value = cleanString(metadata[key.toLowerCase()])

    if (value) {
      return value
    }
  }

  return null
}

function parseStructuredJsonValue(value) {
  const normalized = cleanString(value)

  if (!normalized) {
    return null
  }

  try {
    return JSON.parse(normalized)
  } catch {
    try {
      return JSON.parse(extractJsonObject(normalized))
    } catch {
      return null
    }
  }
}

function selectFeishuWorkspaceToolForStep({ step, project }) {
  const rawText = [
    step?.title ?? '',
    step?.notes ?? ''
  ].filter(Boolean).join('\n')
  const haystack = rawText.toLowerCase()

  if (!/(飞书|feishu|文档|docx|云盘|drive|知识库|wiki|多维表格|bitable)/u.test(haystack)) {
    return null
  }

  const metadata = parseStructuredStepMetadata(step)
  const quotedStrings = extractQuotedStrings(rawText)
  const titleValue = getStructuredMetadataValue(metadata, ['title', 'name']) ?? quotedStrings[0] ?? null
  const contentValue = getStructuredMetadataValue(metadata, ['content', 'body', 'markdown', 'html'])
  const contentType = getStructuredMetadataValue(metadata, ['content_type', 'content-type'])
    ?? (Object.prototype.hasOwnProperty.call(metadata, 'html') ? 'html' : 'markdown')
  const documentId = getStructuredMetadataValue(metadata, ['document_id', 'doc_id'])
  const blockId = getStructuredMetadataValue(metadata, ['block_id'])
  const folderToken = getStructuredMetadataValue(metadata, ['folder_token'])
  const parentNode = getStructuredMetadataValue(metadata, ['parent_node']) ?? folderToken
  const fileToken = getStructuredMetadataValue(metadata, ['file_token'])
  const filePath = getStructuredMetadataValue(metadata, ['file_path'])
  const fileName = getStructuredMetadataValue(metadata, ['file_name'])
  const fileType = getStructuredMetadataValue(metadata, ['type'])
  const spaceId = getStructuredMetadataValue(metadata, ['space_id'])
  const nodeToken = getStructuredMetadataValue(metadata, ['node_token'])
  const parentNodeToken = getStructuredMetadataValue(metadata, ['parent_node_token'])
  const targetParentToken = getStructuredMetadataValue(metadata, ['target_parent_token'])
  const targetSpaceId = getStructuredMetadataValue(metadata, ['target_space_id'])
  const objToken = getStructuredMetadataValue(metadata, ['obj_token'])
  const objType = getStructuredMetadataValue(metadata, ['obj_type'])
    ?? (/(知识库|wiki)/u.test(haystack) && /(文档|docx|page)/u.test(haystack) ? 'docx' : null)
  const appToken = getStructuredMetadataValue(metadata, ['app_token'])
  const tableId = getStructuredMetadataValue(metadata, ['table_id'])
  const recordId = getStructuredMetadataValue(metadata, ['record_id'])
  const defaultViewName = getStructuredMetadataValue(metadata, ['default_view_name'])
  const timeZone = getStructuredMetadataValue(metadata, ['time_zone'])
  const fieldsValue = parseStructuredJsonValue(getStructuredMetadataValue(metadata, ['fields']))
  const tableValue = parseStructuredJsonValue(getStructuredMetadataValue(metadata, ['table']))

  if (/(文档|docx)/u.test(haystack) && !/(知识库|wiki)/u.test(haystack)) {
    if (/(追加|写入|补充|append|write|更新内容)/u.test(haystack) && documentId && contentValue) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_doc_write',
        tool_input: {
          document_id: documentId,
          block_id: blockId,
          content: contentValue,
          content_type: contentType
        }
      }
    }

    if (/(查看|读取|打开|获取|get|load|原文|内容)/u.test(haystack) && documentId) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_doc_get',
        tool_input: {
          document_id: documentId,
          include_raw_content: true
        }
      }
    }

    if (/(创建|新建|建立|新增|create)/u.test(haystack)) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_doc_create',
        tool_input: {
          title: titleValue,
          folder_token: folderToken,
          content: contentValue,
          content_type: contentType
        }
      }
    }
  }

  if (/(云盘|drive)/u.test(haystack)) {
    if (/(上传|upload)/u.test(haystack) && parentNode && (filePath || contentValue)) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_file_upload',
        tool_input: {
          parent_node: parentNode,
          file_path: filePath,
          file_name: fileName,
          content: filePath ? undefined : contentValue
        }
      }
    }

    if (/(创建|新建|建立|新增|create)/u.test(haystack) && /(目录|文件夹|folder)/u.test(haystack) && folderToken && titleValue) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_drive_create_folder',
        tool_input: {
          folder_token: folderToken,
          name: titleValue
        }
      }
    }

    if (/(移动|move)/u.test(haystack) && fileToken && folderToken) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_drive_move',
        tool_input: {
          file_token: fileToken,
          folder_token: folderToken,
          type: fileType
        }
      }
    }

    if (/(列表|列出|查看|浏览|list)/u.test(haystack)) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_drive_list',
        tool_input: {
          folder_token: folderToken
        }
      }
    }
  }

  if (/(知识库|wiki)/u.test(haystack)) {
    if (/(改标题|重命名|rename|标题改成|update title)/u.test(haystack) && spaceId && nodeToken && titleValue) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_wiki_update_title',
        tool_input: {
          space_id: spaceId,
          node_token: nodeToken,
          title: titleValue
        }
      }
    }

    if (/(挂到|挂载|移入|move doc|导入文档|导入知识库)/u.test(haystack) && spaceId && objToken && objType) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_wiki_move_doc',
        tool_input: {
          space_id: spaceId,
          obj_token: objToken,
          obj_type: objType,
          parent_wiki_token: parentNodeToken
        }
      }
    }

    if (/(移动|move)/u.test(haystack) && spaceId && nodeToken) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_wiki_move_node',
        tool_input: {
          space_id: spaceId,
          node_token: nodeToken,
          target_parent_token: targetParentToken,
          target_space_id: targetSpaceId
        }
      }
    }

    if (/(创建|新建|建立|新增|create)/u.test(haystack) && spaceId && objType) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_wiki_create_node',
        tool_input: {
          space_id: spaceId,
          obj_type: objType,
          parent_node_token: parentNodeToken,
          title: titleValue
        }
      }
    }

    if (/(列表|列出|查看|浏览|list)/u.test(haystack) && /(空间|space)/u.test(haystack)) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_wiki_list_spaces',
        tool_input: {}
      }
    }
  }

  if (/(多维表格|bitable)/u.test(haystack)) {
    if (/(更新|修改|update)/u.test(haystack) && /(记录|record)/u.test(haystack) && appToken && tableId && recordId && fieldsValue) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_record_update',
        tool_input: {
          app_token: appToken,
          table_id: tableId,
          record_id: recordId,
          fields: fieldsValue
        }
      }
    }

    if (/(新增|创建|写入|添加|create)/u.test(haystack) && /(记录|record)/u.test(haystack) && appToken && tableId && fieldsValue) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_record_create',
        tool_input: {
          app_token: appToken,
          table_id: tableId,
          fields: fieldsValue
        }
      }
    }

    if (/(列表|列出|查看|浏览|list)/u.test(haystack) && /(记录|record)/u.test(haystack) && appToken && tableId) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_list_records',
        tool_input: {
          app_token: appToken,
          table_id: tableId
        }
      }
    }

    if (/(创建|新建|建立|新增|create)/u.test(haystack) && /(表|table)/u.test(haystack) && appToken) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_create_table',
        tool_input: {
          app_token: appToken,
          table: tableValue ?? undefined,
          name: tableValue ? undefined : titleValue,
          default_view_name: defaultViewName
        }
      }
    }

    if (/(列表|列出|查看|浏览|list)/u.test(haystack) && /(表|table)/u.test(haystack) && appToken) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_list_tables',
        tool_input: {
          app_token: appToken
        }
      }
    }

    if (/(查看|读取|获取|get|load)/u.test(haystack) && /(应用|app)/u.test(haystack) && appToken) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_get_app',
        tool_input: {
          app_token: appToken
        }
      }
    }

    if (/(创建|新建|建立|新增|create)/u.test(haystack)) {
      return {
        supported: true,
        action: 'tool',
        project,
        tool_name: 'channel_feishu_bitable_create_app',
        tool_input: {
          name: titleValue,
          folder_token: folderToken,
          time_zone: timeZone
        }
      }
    }
  }

  return null
}

function latestManagerProjectKeys(snapshot) {
  for (let index = snapshot.timeline.length - 1; index >= 0; index -= 1) {
    const event = snapshot.timeline[index]

    if (event.kind === 'manager_plan_generated') {
      return Array.isArray(event.payload?.project_keys)
        ? event.payload.project_keys
        : []
    }
  }

  return []
}

function resolveProjectForStep({ step, projects, agentProjectKeys }) {
  const haystack = `${step.title ?? ''} ${step.notes ?? ''}`.toLowerCase()
  const byExplicitMention = projects.find((project) => {
    return haystack.includes(project.project_key.toLowerCase())
      || haystack.includes(project.name.toLowerCase())
  })

  if (byExplicitMention) {
    return byExplicitMention
  }

  if (agentProjectKeys.length === 1) {
    return projects.find((project) => project.project_key === agentProjectKeys[0]) ?? null
  }

  return null
}

function buildProjectSummary(project) {
  return [
    `project_key=${project.project_key}`,
    `role=${project.role}`,
    `source_root=${project.source_root}`,
    `runtime_root=${project.runtime_root ?? 'null'}`,
    `publish_root=${project.publish_root ?? 'null'}`,
    `pm2_name=${project.pm2_name ?? 'null'}`,
    `service_endpoint=${project.service_endpoint ?? 'null'}`,
    `status=${project.status}`
  ].join('\n')
}

function buildAgentExecutionSystemPrompt() {
  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: ['Convert one remote agent operate or deploy step into one executable shell command.']
      },
      {
        title: 'TASK',
        lines: [
          'Generate the smallest command that safely advances the requested agent step.',
          'Stay within the provided project paths and operating context.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only with no markdown fence and no prose outside the JSON object.',
          'Use this schema:',
          '{',
          '  "cwd": "/absolute/path/for/execution",',
          '  "command": "single shell command to run",',
          '  "summary": "short Chinese summary of what this command will do",',
          '  "timeout_ms": 120000',
          '}'
        ]
      },
      {
        title: 'EXECUTION PROTOCOL',
        lines: [
          'command must be explicit and directly executable.',
          'cwd must be one provided project path when relevant.',
          'prefer the smallest command that advances the requested step.',
          'do not wrap the command in markdown fences.',
          'do not include destructive cleanup unless the step explicitly requires it.',
          'do not use interactive commands.'
        ]
      }
    ]
  })
}

function buildAgentExecutionPrompt({
  step,
  project,
  operatorRequest,
  sessionSummary
}) {
  const sections = [
    {
      title: 'MANAGER STEP',
      bullet: false,
      lines: [
        `title: ${step.title}`,
        step.notes ? `notes: ${step.notes}` : null
      ]
    }
  ]

  if (operatorRequest) {
    sections.push({
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (project) {
    sections.push({
      title: 'TARGET PROJECT CONTEXT',
      bullet: false,
      lines: [
        `name: ${project.name} (${project.project_key})`,
        buildProjectSummary(project)
      ]
    })
  }

  return buildPromptContract({
    sections
  })
}

function parseAgentExecutionResponse({
  text,
  defaultCwd
}) {
  const parsed = JSON.parse(extractJsonObject(text))
  const command = cleanString(parsed.command ?? parsed.shell_command)

  if (!command) {
    throw new Error('Execution response did not include a command')
  }

  const cwd = cleanString(parsed.cwd) ?? defaultCwd
  const summary = cleanString(parsed.summary) ?? `已生成执行命令：${command}`
  const timeoutMs = Number.isInteger(parsed.timeout_ms) && parsed.timeout_ms > 0
    ? parsed.timeout_ms
    : 120000

  return {
    cwd,
    command,
    summary,
    timeout_ms: timeoutMs
  }
}

function resolveProjectWorkspace(project, workspaceRoot) {
  return project?.source_root
    ?? project?.runtime_root
    ?? workspaceRoot
}

function isPathWithinRoot(candidatePath, rootPath) {
  const normalizedCandidate = resolve(candidatePath)
  const normalizedRoot = resolve(rootPath)

  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

function resolveAllowedExecutionRoots(project, workspaceRoot) {
  return [
    project?.source_root,
    project?.runtime_root,
    project?.publish_root,
    resolveProjectWorkspace(project, workspaceRoot)
  ]
    .filter(Boolean)
    .map((path) => resolve(path))
    .filter((path, index, list) => list.indexOf(path) === index)
}

function assertExecutionCwdAllowed({
  cwd,
  project,
  workspaceRoot
}) {
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error('Execution response cwd must be an absolute path')
  }

  const allowedRoots = resolveAllowedExecutionRoots(project, workspaceRoot)

  if (!allowedRoots.some((root) => isPathWithinRoot(cwd, root))) {
    throw new Error(`Execution response cwd must stay within the target project roots: ${cwd}`)
  }
}

function buildQwenInstruction({
  mode,
  step,
  project,
  operatorRequest,
  sessionSummary
}) {
  const protocolLines = []
  const responseRules = []

  if (mode === 'review') {
    protocolLines.push('Review the target workspace for this remote agent task.')
    protocolLines.push('Focus on correctness, regressions, deployment risk, path drift, service health, and missing verification.')
    responseRules.push('Report actionable findings first, ordered by severity.')
  } else {
    protocolLines.push('Repair the target workspace for this remote agent task.')
    protocolLines.push('Apply the minimal safe fix that resolves the requested issue.')
    protocolLines.push('Preserve unrelated files and keep edits scoped.')
    responseRules.push('Leave a concise explanation of what changed and why.')
  }

  const sections = [
    {
      title: 'ROLE',
      lines: [
        mode === 'review'
          ? 'Act as a review specialist for remote agent tasks.'
          : 'Act as a repair specialist for remote agent tasks.'
      ]
    },
    {
      title: 'TASK',
      bullet: false,
      lines: [
        `Agent step title: ${step.title}`,
        step.notes ? `Agent step notes: ${step.notes}` : null
      ]
    }
  ]

  if (operatorRequest) {
    sections.push({
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (project) {
    sections.push({
      title: 'TARGET PROJECT CONTEXT',
      bullet: false,
      lines: [
        `Target project: ${project.name} (${project.project_key})`,
        buildProjectSummary(project)
      ]
    })
  }

  sections.push({
    title: 'EXECUTION PROTOCOL',
    lines: protocolLines
  })
  sections.push({
    title: 'RESPONSE RULES',
    lines: responseRules
  })

  return buildPromptContract({
    sections
  })
}

function summarizePathCheck(output) {
  const lines = []

  for (const key of ['source_root', 'runtime_root', 'publish_root']) {
    const entry = output[key]

    if (!entry) {
      continue
    }

    lines.push(`${key}=${entry.exists ? entry.type : 'missing'}:${entry.path}`)
  }

  return lines.join('\n')
}

function summarizeSelectionOutput({ toolName, output }) {
  if (toolName === 'project_list_registry') {
    const projectKeys = (output.projects ?? []).map((project) => project.project_key)
    return `已读取 ${projectKeys.length} 个注册项目：${projectKeys.join('、')}`
  }

  if (toolName === 'project_get_registry') {
    return `已读取项目 ${output.project.project_key} 配置\n${buildProjectSummary(output.project)}`
  }

  if (toolName === 'project_resolve_registry') {
    return `已解析 ${output.matches?.length ?? 0} 个项目候选`
  }

  if (toolName === 'project_search_code') {
    return [
      `已搜索项目 ${output.project_key}`,
      `pattern=${output.pattern}`,
      `matches=${output.results?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'project_probe_endpoint') {
    return [
      `已探活 ${output.project_key ?? output.url}`,
      `status=${output.status}`,
      `ok=${output.ok}`,
      `url=${output.url}`,
      `error=${output.error_message ?? 'null'}`,
      `body_preview=${output.body_preview ?? ''}`
    ].join('\n')
  }

  if (toolName === 'project_check_paths') {
    return `已检查 ${output.project_key} 路径\n${summarizePathCheck(output)}`
  }

  if (toolName === 'infrastructure_list_registry') {
    return [
      '已读取基础设施 registry',
      `projects=${output.projects?.length ?? 0}`,
      `services=${output.services?.length ?? 0}`,
      `routes=${output.routes?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'infrastructure_resolve_registry') {
    return [
      '已解析基础设施映射',
      `projects=${output.matches?.projects?.length ?? 0}`,
      `services=${output.matches?.services?.length ?? 0}`,
      `routes=${output.matches?.routes?.length ?? 0}`,
      `listen_port=${output.listen_port ?? 'null'}`,
      `path_prefix=${output.path_prefix ?? 'null'}`,
      `entry_html=${output.entry_html ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'server_ops_capability_matrix') {
    return [
      '已读取服务器能力矩阵',
      `deployment_target=${output.deployment_target}`,
      `capabilities=${output.capabilities?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'server_ops_port_matrix') {
    return [
      '已读取端口矩阵',
      `entries=${output.entries?.length ?? 0}`,
      `listen_port=${output.listen_port ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'server_ops_service_probe_matrix') {
    return [
      '已批量探活服务',
      `runs=${output.runs?.length ?? 0}`,
      `ok=${(output.runs ?? []).filter((run) => run.ok === true).length}`,
      `failed=${(output.runs ?? []).filter((run) => run.ok === false).length}`
    ].join('\n')
  }

  if (toolName === 'server_ops_network_interfaces') {
    return [
      '已读取网络接口',
      `interfaces=${output.interfaces?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'tool_catalog_list') {
    return [
      '已读取工具目录',
      `tools=${output.tools?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_scope_list') {
    return [
      '已读取飞书权限面',
      `ready=${output.ready}`,
      `granted=${output.granted?.length ?? 0}`,
      `pending=${output.pending?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_capability_matrix') {
    return [
      '已读取飞书能力矩阵',
      `ready=${output.scopes?.ready ?? output.config?.ready ?? false}`,
      `capabilities=${output.capabilities?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_doc_create') {
    return [
      '已创建飞书文档',
      `document_id=${output.document?.document_id ?? 'null'}`,
      `title=${output.document?.title ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_doc_get') {
    return [
      '已读取飞书文档',
      `document_id=${output.document?.document_id ?? 'null'}`,
      `has_raw_content=${output.raw_content ? 'true' : 'false'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_doc_write') {
    return [
      '已写入飞书文档',
      `target_block_id=${output.target_block_id ?? 'null'}`,
      `descendants=${output.descendant_count ?? 0}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_drive_list') {
    return [
      '已读取飞书云盘目录',
      `files=${output.files?.length ?? 0}`,
      `has_more=${output.has_more ?? false}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_drive_create_folder') {
    return [
      '已创建飞书云盘目录',
      `token=${output.token ?? output.file_token ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_drive_move') {
    return '已移动飞书云盘文件'
  }

  if (toolName === 'channel_feishu_file_upload') {
    return [
      '已上传飞书文件',
      `file_token=${output.file_token ?? 'null'}`,
      `file_name=${output.file_name ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_wiki_list_spaces') {
    return [
      '已读取飞书知识库空间',
      `items=${output.items?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_wiki_create_node') {
    return [
      '已创建飞书知识库节点',
      `node_token=${output.node?.node_token ?? 'null'}`,
      `title=${output.node?.title ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_wiki_move_node' || toolName === 'channel_feishu_wiki_move_doc') {
    return `已完成飞书知识库对象移动 ${toolName}`
  }

  if (toolName === 'channel_feishu_wiki_update_title') {
    return [
      '已更新飞书知识库标题',
      `node_token=${output.node_token ?? 'null'}`,
      `title=${output.title ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_bitable_create_app') {
    return [
      '已创建飞书多维表格应用',
      `app_token=${output.app?.app_token ?? 'null'}`,
      `name=${output.app?.name ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_bitable_get_app') {
    return [
      '已读取飞书多维表格应用',
      `app_token=${output.app?.app_token ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_bitable_create_table') {
    return '已创建飞书多维表格数据表'
  }

  if (toolName === 'channel_feishu_bitable_list_tables' || toolName === 'channel_feishu_bitable_list_records') {
    return [
      `已读取飞书多维表格 ${toolName}`,
      `items=${output.items?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'channel_feishu_bitable_record_create' || toolName === 'channel_feishu_bitable_record_update') {
    return [
      `已写入飞书多维表格 ${toolName}`,
      `record_id=${output.record?.record_id ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'news_source_list') {
    return [
      '已读取资讯源清单',
      `sources=${output.sources?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'news_general_collect' || toolName === 'news_stock_collect' || toolName === 'news_hot_collect') {
    return [
      `已拉取资讯 ${toolName}`,
      `source=${output.source?.source_key ?? 'null'}`,
      `items=${output.items?.length ?? 0}`
    ].join('\n')
  }

  if (toolName === 'project_pm2_status') {
    return [
      `已检查 ${output.project_key} 的 PM2 状态`,
      `pm2_name=${output.pm2_name}`,
      `found=${output.found}`,
      `status=${output.status ?? 'null'}`,
      `pid=${output.pid ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'qwen_review_workspace') {
    return [
      `已在 ${output.cwd} 执行 Qwen review`,
      output.stdout?.trim() ?? ''
    ].filter(Boolean).join('\n')
  }

  if (toolName === 'qwen_repair_workspace') {
    return [
      `已在 ${output.cwd} 执行 Qwen repair`,
      output.stdout?.trim() ?? ''
    ].filter(Boolean).join('\n')
  }

  if (toolName === 'run_shell_command') {
    return [
      `已在 ${output.cwd ?? 'default'} 执行 shell 命令`,
      output.command ?? '',
      output.stdout?.trim() ?? '',
      output.stderr?.trim() ?? ''
    ].filter(Boolean).join('\n')
  }

  return `已执行 ${toolName}`
}

export function selectAgentToolForStep({
  step,
  projects,
  agentProjectKeys,
  workspaceRoot = process.cwd(),
  operatorRequest = null,
  sessionSummary = null,
  agentProfile = createAgentProfile()
}) {
  const normalizedKind = normalizeText(step.kind)
  const normalizedTitle = normalizeText(step.title)
  const normalizedNotes = normalizeText(step.notes)
  const haystack = `${normalizedTitle} ${normalizedNotes}`
  const project = resolveProjectForStep({
    step,
    projects,
    agentProjectKeys
  })
  const rawStepText = `${step.title ?? ''} ${step.notes ?? ''}`
  const explicitPort = extractPortFromText(rawStepText)
  const explicitPath = extractPathLikeToken(rawStepText)
  const feishuToolSelection = selectFeishuWorkspaceToolForStep({
    step,
    project
  })

  if (normalizedKind === 'report') {
    return {
      supported: true,
      action: 'report',
      project
    }
  }

  if (normalizedKind === 'review') {
    if (!agentProfile.qwen_integration.allow_review) {
      return {
        supported: false,
        reason: 'Qwen review is disabled for this environment'
      }
    }

    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: agentProfile.qwen_integration.review_tool_name,
      tool_input: {
        cwd: resolveProjectWorkspace(project, workspaceRoot),
        json: true,
        instruction: buildQwenInstruction({
          mode: 'review',
          step,
          project,
          operatorRequest,
          sessionSummary
        })
      }
    }
  }

  if (normalizedKind === 'repair') {
    if (!agentProfile.qwen_integration.allow_repair) {
      return {
        supported: false,
        reason: 'Qwen repair is disabled for this environment'
      }
    }

    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: agentProfile.qwen_integration.repair_tool_name,
      tool_input: {
        cwd: resolveProjectWorkspace(project, workspaceRoot),
        full_auto: true,
        instruction: buildQwenInstruction({
          mode: 'repair',
          step,
          project,
          operatorRequest,
          sessionSummary
        })
      }
    }
  }

  if (feishuToolSelection) {
    return feishuToolSelection
  }

  if (normalizedKind === 'operate' || normalizedKind === 'deploy') {
    return {
      supported: true,
      action: 'execution',
      project,
      execution_kind: normalizedKind
    }
  }

  if (normalizedKind !== 'inspect') {
    return {
      supported: false,
      reason: `Unsupported agent step kind: ${step.kind}`
    }
  }

  if (
    /工具目录|tool catalog|tool-runtime|tool runtime|工具面|工具族|内部工具/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'tool_catalog_list',
      tool_input: {
        query: step.title
      }
    }
  }

  if (
    /(飞书|feishu)/.test(haystack)
    && /scope|权限|授权|grant/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'channel_feishu_scope_list',
      tool_input: {}
    }
  }

  if (
    /(飞书|feishu|wiki|知识库|docx|文档|云盘|drive|bitable|多维表格)/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'channel_feishu_capability_matrix',
      tool_input: {}
    }
  }

  if (
    /资讯源|source registry|新闻源|news source/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'news_source_list',
      tool_input: {}
    }
  }

  if (
    /股票资讯|stock news|财经快讯|财联社|东财快讯|news.*stock|stock.*news/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'news_stock_collect',
      tool_input: {
        limit: 10
      }
    }
  }

  if (
    /热榜|热门|hot topic|hot news|v2ex|自媒体/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'news_hot_collect',
      tool_input: {
        limit: 10
      }
    }
  }

  if (
    /新闻|资讯|news/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'news_general_collect',
      tool_input: {
        limit: 10
      }
    }
  }

  if (
    /全局|整体|所有服务|批量探活|health matrix|service matrix|在线情况|服务器状态/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'server_ops_service_probe_matrix',
      tool_input: {
        project_key: project?.project_key ?? null
      }
    }
  }

  if (
    /列表|list|inventory|registry|有哪些项目|盘一下|基线/.test(haystack)
    && !project
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_list_registry',
      tool_input: {}
    }
  }

  if (
    /能力|capability|ssh|channel|通道|协作|co-worker/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'server_ops_capability_matrix',
      tool_input: {}
    }
  }

  if (
    /网络|network|网卡|ip 地址|网口|interface/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'server_ops_network_interfaces',
      tool_input: {}
    }
  }

  if (
    /端口矩阵|监听端口|port table|port matrix|端口清单/.test(haystack)
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'server_ops_port_matrix',
      tool_input: {
        project_key: project?.project_key ?? null,
        listen_port: explicitPort
      }
    }
  }

  if (
    /端口|port|路由|route|入口|entry|html|页面|静态|映射|path prefix|upstream|public url/.test(haystack)
    || explicitPort
    || explicitPath
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'infrastructure_resolve_registry',
      tool_input: {
        project_key: project?.project_key ?? null,
        query: step.title,
        listen_port: explicitPort,
        path_prefix: explicitPath && !explicitPath.endsWith('.html') ? explicitPath : null,
        entry_html: explicitPath?.endsWith('.html') ? explicitPath : null
      }
    }
  }

  if (
    /归谁|哪个项目|pm2 名称|public base path|service endpoint|源码路径/.test(haystack)
    && !project
  ) {
    return {
      supported: true,
      action: 'tool',
      project: null,
      tool_name: 'project_resolve_registry',
      tool_input: {
        query: step.title
      }
    }
  }

  if (
    /pm2|进程|process|daemon/.test(haystack)
    && project?.pm2_name
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_pm2_status',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  if (
    /health|endpoint|api|在线|探活|状态|服务/.test(haystack)
    && project?.service_endpoint
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_probe_endpoint',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  if (
    /目录|路径|path|runtime|publish|source|release|发布目录/.test(haystack)
    && project
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_check_paths',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  if (project) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_get_registry',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  return {
    supported: true,
    action: 'tool',
    project: null,
    tool_name: 'project_list_registry',
    tool_input: {}
  }
}

function summarizeCompletedAgentSteps(snapshot) {
  return snapshot.plan_steps
    .filter((step) => step.status === 'completed')
    .map((step) => `- ${step.title}`)
}

function summarizeRecentAgentExecution(snapshot) {
  return snapshot.timeline
    .filter((event) => event.kind === 'agent_step_executed')
    .slice(-4)
    .map((event) => event.payload?.summary)
    .filter(Boolean)
}

function buildManagerReportText(snapshot) {
  const lines = []
  const completedSteps = summarizeCompletedAgentSteps(snapshot)
  const executionHighlights = summarizeRecentAgentExecution(snapshot)
  const nextStep = snapshot.plan_steps.find((step) => step.status === 'ready')

  lines.push('阶段汇报：')

  if (snapshot.session.summary) {
    lines.push(`当前摘要：${snapshot.session.summary}`)
  }

  if (completedSteps.length > 0) {
    lines.push(`已完成：${completedSteps.join('；')}`)
  }

  if (executionHighlights.length > 0) {
    lines.push(`执行结论：${executionHighlights.join('；')}`)
  }

  if (nextStep) {
    lines.push(`下一步：${nextStep.title}`)
  } else {
    lines.push('当前计划已执行完成。')
  }

  return lines.join('\n')
}

export function createAgentExecutor({
  storageRoot,
  workspaceRoot,
  qwenCommand = 'qwen',
  fetchFn = globalThis.fetch,
  executionProvider = null,
  agentProfile = createAgentProfile()
}) {
  const sessionStore = createSessionStore({ storageRoot })
  const projectRegistry = createProjectRegistry({ storageRoot })
  const stepExecutor = createStepExecutor({
    storageRoot,
    workspaceRoot,
    qwenCommand,
      fetchFn
  })

  async function buildExecutionSelection({
    step,
    project,
    operatorRequest,
    sessionSummary
  }) {
    if (!project) {
      return {
        supported: false,
        reason: 'Operate/deploy steps require a resolved target project'
      }
    }

    if (!executionProvider || typeof executionProvider.invokeByIntent !== 'function') {
      return {
        supported: false,
        reason: 'Operate/deploy steps require an execution provider'
      }
    }

    const defaultCwd = resolveProjectWorkspace(project, workspaceRoot)
    const providerResult = await executionProvider.invokeByIntent({
      intent: 'operate',
      systemPrompt: buildAgentExecutionSystemPrompt(),
      prompt: buildAgentExecutionPrompt({
        step,
        project,
        operatorRequest,
        sessionSummary
      })
    })
    const executionPlan = parseAgentExecutionResponse({
      text: providerResult.response.content ?? '',
      defaultCwd
    })
    assertExecutionCwdAllowed({
      cwd: executionPlan.cwd,
      project,
      workspaceRoot
    })

    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'run_shell_command',
      tool_input: {
        cwd: executionPlan.cwd,
        command: executionPlan.command,
        timeout_ms: executionPlan.timeout_ms
      },
      summary: executionPlan.summary,
      provider_result: {
        route: providerResult.route,
        request: providerResult.request,
        response: {
          id: providerResult.response.id,
          model: providerResult.response.model,
          finish_reason: providerResult.response.finish_reason,
          usage: providerResult.response.usage
        }
      }
    }
  }

  async function executeManagerReportStep({
    sessionId,
    step
  }) {
    await sessionStore.startPlanStep(sessionId, step.id)

    const runningSnapshot = await sessionStore.loadSession(sessionId)
    const reportText = buildManagerReportText(runningSnapshot)

    await sessionStore.appendTimelineEvent(sessionId, {
      stepId: step.id,
      kind: 'assistant_message_added',
      actor: 'assistant:agent',
      payload: {
        content: reportText
      }
    })
    await sessionStore.appendTimelineEvent(sessionId, {
      stepId: step.id,
      kind: 'agent_report_generated',
      actor: 'agent:executor',
      payload: {
        content: reportText
      }
    })
    await sessionStore.updateSessionSummary(sessionId, reportText)

    const completion = await sessionStore.completePlanStep(sessionId, step.id, {
      resultSummary: reportText
    })

    return {
      status: completion.task.status === 'completed' ? 'completed' : 'planned',
      summary: reportText,
      report_text: reportText,
      session: completion.session,
      task: completion.task,
      plan_steps: completion.plan_steps
    }
  }

  async function executeCurrentAgentStep({
    sessionId,
    currentInput = null,
    skillRefs = [],
    abortSignal = null
  }) {
    const snapshot = await sessionStore.loadSession(sessionId)
    const step = snapshot.plan_steps.find(
      (item) => item.id === snapshot.task.current_step_id
    ) ?? null

    if (!step) {
      return {
        status: 'error',
        error: {
          message: 'No current agent step is ready to execute'
        }
      }
    }

    const projects = await projectRegistry.listProjects()
    const agentProjectKeys = latestManagerProjectKeys(snapshot)
    const initialSelection = selectAgentToolForStep({
      step,
      projects,
      agentProjectKeys,
      workspaceRoot,
      operatorRequest: currentInput ?? snapshot.task.user_request,
      sessionSummary: snapshot.session.summary,
      agentProfile
    })
    let selection = initialSelection

    if (selection.action === 'execution') {
      try {
        selection = await buildExecutionSelection({
          step,
          project: selection.project,
          operatorRequest: currentInput ?? snapshot.task.user_request,
          sessionSummary: snapshot.session.summary
        })
      } catch (error) {
        const failed = await sessionStore.failPlanStep(sessionId, step.id, {
          errorMessage: error.message
        })

        return {
          status: 'failed',
          selection: {
            ...selection,
            supported: false,
            reason: error.message
          },
          summary: error.message,
          error: {
            message: error.message
          },
          execution: {
            session: failed.session,
            task: failed.task,
            plan_steps: failed.plan_steps
          }
        }
      }
    }

    if (!selection.supported) {
      await sessionStore.appendTimelineEvent(sessionId, {
        stepId: step.id,
        kind: 'agent_step_deferred',
        actor: 'agent:executor',
        payload: {
          reason: selection.reason
        }
      })

      return {
        status: 'deferred',
        selection,
        summary: selection.reason
      }
    }

    if (selection.action === 'report') {
      const execution = await executeManagerReportStep({
        sessionId,
        step
      })

      return {
        status: execution.status,
        selection,
        summary: execution.summary,
        report_text: execution.report_text,
        execution
      }
    }

    await sessionStore.appendTimelineEvent(sessionId, {
      stepId: step.id,
      kind: 'agent_tool_selected',
      actor: 'agent:executor',
      payload: {
        tool_name: selection.tool_name,
        command: selection.tool_input?.command ?? null,
        cwd: selection.tool_input?.cwd ?? null
      }
    })

    const execution = await stepExecutor.executeCurrentStep({
      sessionId,
      currentInput: currentInput ?? snapshot.task.user_request,
      toolName: selection.tool_name,
      toolInput: selection.tool_input,
      skillRefs,
      abortSignal
    })

    if (execution.status === 'planned' || execution.status === 'completed') {
      const summary = summarizeSelectionOutput({
        toolName: selection.tool_name,
        output: execution.tool_result.output
      })

      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'agent_step_executed',
        actor: 'agent:executor',
        payload: {
          tool_name: selection.tool_name,
          summary
        }
      })

      return {
        status: execution.status,
        selection,
        summary,
        execution
      }
    }

    return {
      status: execution.status,
      selection,
      execution
    }
  }

  async function runAgentLoop({
    sessionId,
    currentInput = null,
    maxSteps = 4,
    skillRefs = [],
    onProgress = null,
    shouldStop = null,
    abortSignal = null
  }) {
    const runs = []

    async function finalizeLoop(statusOverride = null) {
      const finalSnapshot = await sessionStore.loadSession(sessionId)
      const latestReport = [...runs]
        .reverse()
        .find((run) => run.report_text)?.report_text ?? null

      return {
        status: statusOverride ?? runs.at(-1)?.status ?? 'error',
        runs,
        report_text: latestReport,
        session: finalSnapshot.session,
        task: finalSnapshot.task,
        plan_steps: finalSnapshot.plan_steps,
        approvals: finalSnapshot.approvals
      }
    }

    for (let index = 0; index < maxSteps; index += 1) {
      if (typeof shouldStop === 'function' && shouldStop()) {
        return finalizeLoop('stopped')
      }

      const result = await executeCurrentAgentStep({
        sessionId,
        currentInput,
        skillRefs,
        abortSignal
      })

      runs.push(result)

      if (typeof onProgress === 'function') {
        await onProgress({
          step_index: index + 1,
          result,
          runs: [...runs]
        })
      }

      if (typeof shouldStop === 'function' && shouldStop()) {
        return finalizeLoop('stopped')
      }

      if (!['planned', 'completed'].includes(result.status)) {
        break
      }

      if (result.status === 'completed') {
        break
      }
    }

    return finalizeLoop()
  }

  return {
    executeCurrentAgentStep,
    runAgentLoop
  }
}
