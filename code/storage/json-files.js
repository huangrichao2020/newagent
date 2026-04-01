import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

function toJsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(tempPath, toJsonText(value), 'utf8')
  await rename(tempPath, filePath)
}

export async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

export async function appendJsonLine(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

export async function readJsonLines(filePath) {
  const raw = await readFile(filePath, 'utf8')

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
