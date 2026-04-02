/**
 * 后台预计算 - cheapest first 四重门控设计
 * 
 * Gate 1: 时间检查 (纳秒级) - 99% 请求在此返回
 * Gate 1.5: 扫描节流 (10 分钟)
 * Gate 2: Session 数量 (≥5 个)
 * Gate 3: 并发锁
 */

import { join } from 'node:path'
import { mkdir, stat, rm } from 'node:fs/promises'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

const DEFAULT_CONFIG = {
  gate1_window_ms: 5 * 60 * 1000,
  gate1_5_scan_window_ms: 10 * 60 * 1000,
  gate2_min_sessions: 5,
  gate3_lock_timeout_ms: 5 * 60 * 1000,
  max_consecutive_failures: 3
}

function nowIso() {
  return new Date().toISOString()
}

function nowMs() {
  return Date.now()
}

function formatRelativeTime(timestamp) {
  const diffMs = nowMs() - timestamp
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return `${diffDays} days ago`
  if (diffHours > 0) return `${diffHours} hours ago`
  if (diffMinutes > 0) return `${diffMinutes} minutes ago`
  return `${diffSeconds} seconds ago`
}

export function createBackgroundPrecompute({
  storageRoot,
  bailianProvider = null,
  agentProfile = null,
  nowFn = nowMs
} = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...(agentProfile?.background_precompute?.cheapest_first_gates || {})
  }

  const stateFile = join(storageRoot, 'background', 'precompute-state.json')
  const lockFile = join(storageRoot, 'background', 'precompute.lock')

  async function ensureDirectories() {
    await mkdir(join(storageRoot, 'background'), { recursive: true })
  }

  async function getState() {
    try {
      return await readJson(stateFile)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          last_run_at: null,
          last_scan_at: null,
          consecutive_failures: 0,
          circuit_breaker_open: false,
          circuit_breaker_opened_at: null
        }
      }
      throw error
    }
  }

  async function saveState(state) {
    await ensureDirectories()
    await writeJsonAtomic(stateFile, {
      ...state,
      updated_at: nowIso()
    })
  }

  async function tryAcquireLock() {
    try {
      const lockStat = await stat(lockFile)
      const lockAge = nowMs() - lockStat.mtimeMs

      if (lockAge > config.gate3_lock_timeout_ms) {
        await rm(lockFile, { force: true })
        return { acquired: true, reason: 'stale_lock_cleaned' }
      }

      return { acquired: false, reason: 'lock_exists' }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await writeJsonAtomic(lockFile, {
          acquired_at: nowIso(),
          acquired_at_ms: nowMs(),
          pid: process.pid
        })
        return { acquired: true, reason: 'new_lock' }
      }
      throw error
    }
  }

  async function releaseLock() {
    await rm(lockFile, { force: true })
  }

  async function gate1_timeCheck(state) {
    if (!state.last_run_at) {
      return { passed: false, reason: 'no_previous_run' }
    }

    const lastRunMs = new Date(state.last_run_at).getTime()
    const elapsed = nowMs() - lastRunMs

    if (elapsed < config.gate1_window_ms) {
      return {
        passed: false,
        reason: 'too_soon',
        elapsed: formatRelativeTime(lastRunMs),
        cost: 'nanosecond'
      }
    }

    return { passed: true, elapsed: formatRelativeTime(lastRunMs), cost: 'nanosecond' }
  }

  async function gate1_5_scanThrottle(state) {
    if (!state.last_scan_at) {
      return { passed: false, reason: 'no_previous_scan' }
    }

    const lastScanMs = new Date(state.last_scan_at).getTime()
    const elapsed = nowMs() - lastScanMs

    if (elapsed < config.gate1_5_scan_window_ms) {
      return {
        passed: false,
        reason: 'scan_too_soon',
        elapsed: formatRelativeTime(lastScanMs),
        cost: 'filesystem_stat'
      }
    }

    return { passed: true, elapsed: formatRelativeTime(lastScanMs), cost: 'filesystem_stat' }
  }

  async function gate2_sessionCount() {
    const sessionsDir = join(storageRoot, 'sessions')
    try {
      const files = await readdir(sessionsDir)
      const sessionCount = files.filter(f => f.endsWith('.json')).length

      if (sessionCount < config.gate2_min_sessions) {
        return {
          passed: false,
          reason: 'not_enough_sessions',
          count: sessionCount,
          required: config.gate2_min_sessions,
          cost: 'filesystem_readdir'
        }
      }

      return {
        passed: true,
        count: sessionCount,
        cost: 'filesystem_readdir'
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { passed: false, reason: 'no_sessions_dir', cost: 'filesystem_readdir' }
      }
      throw error
    }
  }

  async function gate3_concurrencyLock() {
    const lockResult = await tryAcquireLock()

    if (!lockResult.acquired) {
      return {
        passed: false,
        reason: 'concurrent_run_in_progress',
        detail: lockResult.reason,
        cost: 'filesystem_stat'
      }
    }

    return { passed: true, detail: lockResult.reason, cost: 'filesystem_stat' }
  }

  async function runCheapestFirstGates(state) {
    const gateResults = {}

    gateResults.gate1 = await gate1_timeCheck(state)
    if (!gateResults.gate1.passed) {
      return { shouldRun: false, gates: gateResults, stoppedAt: 'gate1' }
    }

    gateResults.gate1_5 = await gate1_5_scanThrottle(state)
    if (!gateResults.gate1_5.passed) {
      return { shouldRun: false, gates: gateResults, stoppedAt: 'gate1_5' }
    }

    gateResults.gate2 = await gate2_sessionCount()
    if (!gateResults.gate2.passed) {
      return { shouldRun: false, gates: gateResults, stoppedAt: 'gate2' }
    }

    gateResults.gate3 = await gate3_concurrencyLock()
    if (!gateResults.gate3.passed) {
      return { shouldRun: false, gates: gateResults, stoppedAt: 'gate3' }
    }

    return { shouldRun: true, gates: gateResults, stoppedAt: null }
  }

  async function executePrecompute() {
    if (!bailianProvider) {
      return { status: 'disabled', reason: 'no_provider' }
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'background',
        systemPrompt: 'You are a background precompute agent. Analyze recent conversations and extract useful patterns.',
        prompt: 'Analyze recent sessions and extract patterns.'
      })

      return {
        status: 'success',
        provider: result.route.provider,
        model: result.route.model
      }
    } catch (error) {
      return {
        status: 'failed',
        error: error.message
      }
    }
  }

  async function run() {
    const state = await getState()

    if (state.circuit_breaker_open) {
      const openedAt = new Date(state.circuit_breaker_opened_at).getTime()
      const elapsed = nowMs() - openedAt

      if (elapsed < config.reset_timeout_ms) {
        return {
          status: 'circuit_breaker_open',
          reason: 'Too many consecutive failures',
          opened_ago: formatRelativeTime(openedAt)
        }
      }

      state.circuit_breaker_open = false
      state.consecutive_failures = 0
    }

    const gateResult = await runCheapestFirstGates(state)

    if (!gateResult.shouldRun) {
      return {
        status: 'skipped',
        reason: gateResult.stoppedAt,
        gates: gateResult.gates
      }
    }

    const precomputeResult = await executePrecompute()

    await releaseLock()

    if (precomputeResult.status === 'success') {
      await saveState({
        ...state,
        last_run_at: nowIso(),
        last_scan_at: nowIso(),
        consecutive_failures: 0
      })

      return {
        status: 'completed',
        gates: gateResult.gates,
        precompute: precomputeResult
      }
    } else {
      const newFailures = state.consecutive_failures + 1
      const shouldOpenCircuit = newFailures >= config.max_consecutive_failures

      await saveState({
        ...state,
        last_run_at: nowIso(),
        last_scan_at: nowIso(),
        consecutive_failures: newFailures,
        circuit_breaker_open: shouldOpenCircuit,
        circuit_breaker_opened_at: shouldOpenCircuit ? nowIso() : null
      })

      return {
        status: 'failed',
        gates: gateResult.gates,
        precompute: precomputeResult,
        consecutive_failures: newFailures,
        circuit_breaker_open: shouldOpenCircuit
      }
    }
  }

  return {
    run,
    getState,
    runCheapestFirstGates,
    formatRelativeTime
  }
}
