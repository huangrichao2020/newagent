function normalizeSectionLines(lines) {
  if (!Array.isArray(lines)) {
    return []
  }

  return lines
    .flatMap((line) => String(line ?? '').split('\n'))
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
}

function formatSection(section) {
  const title = String(section?.title ?? '').trim()
  const lines = normalizeSectionLines(section?.lines)

  if (!title || lines.length === 0) {
    return null
  }

  const bullet = section?.bullet !== false
  const body = bullet
    ? lines.map((line) => `- ${line}`)
    : lines

  return [
    `${title}:`,
    ...body
  ].join('\n')
}

export function buildPromptContract({ sections = [] } = {}) {
  return sections
    .map((section) => formatSection(section))
    .filter(Boolean)
    .join('\n\n')
}
