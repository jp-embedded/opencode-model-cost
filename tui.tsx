/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

interface MessageInfo {
  sessionID: string
  providerID: string
  modelID: string
  tokens: number
  cost: number
}

interface Sample {
  messageID: string
  sessionID: string
  tokens: number
  timestamp: number
}

interface PartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

interface ModelEntry {
  name: string
  tokens: number
  cost: number
}

const LIVE_STALE_MS = 1500
const SAMPLE_WINDOW_MS = 5000
const SINGLE_SAMPLE_MIN_MS = 250
const SINGLE_SAMPLE_MAX_MS = 1000
const MAX_ENTRIES = 4

const tui: TuiPlugin = async (api, _options, _meta) => {
  const byMessage = new Map<string, MessageInfo>()
  const samples: Sample[] = []

  const [version, setVersion] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  function estimateTokens(text: string): number {
    const byteLen = new TextEncoder().encode(text).length
    return Math.max(1, Math.ceil(byteLen / 5))
  }

  function inTree(sessionID: string, root: string): boolean {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (typeof id === "string" && !seen.has(id)) {
      if (id === root) return true
      seen.add(id)
      id = api.state.session.get(id)?.parentID
    }
    return false
  }

  function dropSamples(match: (sample: Sample) => boolean) {
    const before = samples.length
    for (let i = samples.length - 1; i >= 0; i--) {
      if (match(samples[i])) samples.splice(i, 1)
    }
    if (samples.length !== before) setVersion((v) => v + 1)
  }

  const unsubUpdated = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.role !== "assistant") return
    if (info.summary) return
    byMessage.set(info.id, {
      sessionID: info.sessionID,
      providerID: info.providerID,
      modelID: info.modelID,
      tokens: info.tokens.input + info.tokens.output + info.tokens.reasoning,
      cost: info.cost,
    })
    if (info.time.completed) dropSamples((s) => s.messageID === info.id)
    setVersion((v) => v + 1)
  })

  const unsubRemoved = api.event.on("message.removed", (evt) => {
    if (byMessage.delete(evt.properties.messageID)) setVersion((v) => v + 1)
  })

  const unsubDelta = api.event.on("message.part.delta" as unknown as "message.part.delta", (evt: PartDeltaEvent) => {
    const { sessionID, messageID, field } = evt.properties
    if (!sessionID || !messageID) return
    if (field !== "text") return
    if (!byMessage.has(messageID)) return
    if (api.state.session.status(sessionID)?.type === "idle") return
    const deltaText = evt.properties.delta
    if (!deltaText || typeof deltaText !== "string") return
    samples.push({
      messageID,
      sessionID,
      tokens: estimateTokens(deltaText),
      timestamp: Date.now(),
    })
    setVersion((v) => v + 1)
  })

  const unsubPartUpdated = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    const state = part.state
    if (state.status === "running" || state.status === "completed" || state.status === "error") {
      dropSamples((s) => s.sessionID === part.sessionID)
    }
  })

  const interval = setInterval(() => {
    const cutoff = Date.now() - SAMPLE_WINDOW_MS
    dropSamples((s) => s.timestamp < cutoff)
    setTick((t) => t + 1)
  }, 1000)

  api.lifecycle.onDispose(() => {
    unsubUpdated()
    unsubRemoved()
    unsubDelta()
    unsubPartUpdated()
    clearInterval(interval)
  })

  function shortName(modelID: string): string {
    const base = modelID.split("/").pop() ?? modelID
    return base.split(":")[0]
  }

  function singleSampleDuration(active: Sample[]): number {
    const elapsed = Date.now() - active[0].timestamp
    return Math.max(SINGLE_SAMPLE_MIN_MS, Math.min(elapsed, SINGLE_SAMPLE_MAX_MS))
  }

  function activeDurationMs(active: Sample[]): number {
    if (active.length < 2) return singleSampleDuration(active)
    let total = 0
    for (let i = 1; i < active.length; i++) {
      total += Math.max(0, active[i].timestamp - active[i - 1].timestamp)
    }
    const tail = Date.now() - active[active.length - 1].timestamp
    total += Math.min(tail, 1000)
    return Math.max(total, SINGLE_SAMPLE_MIN_MS)
  }

  function calcTps(active: Sample[]): number {
    if (active.length === 0) return -1
    if (Date.now() - active[active.length - 1].timestamp > LIVE_STALE_MS) return -1
    const tokens = active.reduce((sum, s) => sum + s.tokens, 0)
    const duration = activeDurationMs(active)
    if (duration <= 0) return -1
    return (tokens / duration) * 1000
  }

  function formatTokens(n: number): string {
    if (n < 1000) return `${n}`
    if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`
    return `${(n / 1_000_000).toFixed(1)}M`
  }

  function formatCost(cost: number): string {
    if (cost <= 0) return ""
    if (cost < 1) return `·$${cost.toFixed(3)}`
    return `·$${cost.toFixed(2)}`
  }

  function formatTps(value: number): string {
    if (value < 0) return ""
    if (value < 10) return `·${value.toFixed(2)}tps`
    if (value < 100) return `·${value.toFixed(1)}tps`
    return `·${Math.round(value)}tps`
  }

  function computeStats(root: string): string {
    for (const info of api.state.session.messages(root)) {
      if (info.role !== "assistant") continue
      if (info.summary) continue
      byMessage.set(info.id, {
        sessionID: info.sessionID,
        providerID: info.providerID,
        modelID: info.modelID,
        tokens: info.tokens.input + info.tokens.output + info.tokens.reasoning,
        cost: info.cost,
      })
    }

    const perModel = new Map<string, ModelEntry>()
    for (const info of byMessage.values()) {
      if (info.sessionID !== root && !inTree(info.sessionID, root)) continue
      const key = `${info.providerID}/${info.modelID}`
      const entry = perModel.get(key) ?? { name: shortName(info.modelID), tokens: 0, cost: 0 }
      entry.tokens += info.tokens
      entry.cost += info.cost
      perModel.set(key, entry)
    }

    const cutoff = Date.now() - SAMPLE_WINDOW_MS
    const activeByModel = new Map<string, Sample[]>()
    for (const sample of samples) {
      if (sample.timestamp < cutoff) continue
      if (sample.sessionID !== root && !inTree(sample.sessionID, root)) continue
      const info = byMessage.get(sample.messageID)
      if (!info) continue
      const key = `${info.providerID}/${info.modelID}`
      const active = activeByModel.get(key) ?? []
      active.push(sample)
      activeByModel.set(key, active)
    }

    const entries = [...perModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
    const parts: string[] = []
    for (const [key, entry] of entries.slice(0, MAX_ENTRIES)) {
      const tps = calcTps(activeByModel.get(key) ?? [])
      parts.push(`${entry.name} ${formatTokens(entry.tokens)}${formatCost(entry.cost)}${formatTps(tps)}`)
    }
    if (entries.length > MAX_ENTRIES) parts.push(`+${entries.length - MAX_ENTRIES}`)
    return parts.join("  ")
  }

  api.slots.register({
    slots: {
      session_prompt_right(ctx, props) {
        const stats = createMemo(() => {
          version()
          tick()
          return computeStats(props.session_id)
        })

        const textMuted = ctx.theme.current.textMuted

        return <text fg={textMuted}>{stats()}</text>
      },
    },
  })
}

export default {
  id: "opencode-model-cost",
  tui,
}
