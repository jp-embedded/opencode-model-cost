/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { SessionMessageInfo, TokenUsageInfo } from "@opencode/client"

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

interface ModelEntry {
  name: string
  tokens: number
  cost: number
}

interface ModelAgg {
  key: string
  name: string
  tokens: number
  cost: number
  tps: number
  running: boolean
}

const LIVE_STALE_MS = 1500
const SAMPLE_WINDOW_MS = 5000
const SINGLE_SAMPLE_MIN_MS = 250
const SINGLE_SAMPLE_MAX_MS = 1000
function setup(api: Plugin.Context) {
  const byMessage = new Map<string, MessageInfo>()
  const samples: Sample[] = []
  const lastTps = new Map<string, number>()
  const hydratedRoots = new Set<string>()
  const hydratingRoots = new Set<string>()
  const rootBySession = new Map<string, string>()
  let disposed = false

  const [version, setVersion] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  function estimateTokens(text: string): number {
    const byteLen = new TextEncoder().encode(text).length
    return Math.max(1, Math.ceil(byteLen / 5))
  }

  function inTree(sessionID: string, root: string): boolean {
    if (rootBySession.get(sessionID) === root) return true
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (typeof id === "string" && !seen.has(id)) {
      if (id === root) return true
      seen.add(id)
      id = api.data.session.get(id)?.parentID
    }
    return false
  }

  function addMessage(sessionID: string, info: SessionMessageInfo) {
    if (info.type !== "assistant") return
    // A history request can race a live step-ended event. Do not replace final
    // usage with the older, incomplete message returned by that request.
    if (!info.tokens && byMessage.has(info.id)) return
    byMessage.set(info.id, {
      sessionID,
      providerID: info.model.providerID,
      modelID: info.model.id,
      tokens: info.tokens ? info.tokens.input + info.tokens.output + info.tokens.reasoning : 0,
      cost: info.cost ?? 0,
    })
  }

  async function hydrateTree(root: string) {
    if (hydratedRoots.has(root) || hydratingRoots.has(root)) return
    hydratingRoots.add(root)

    try {
      const queue = [root]
      const seen = new Set<string>()
      while (queue.length > 0 && !disposed) {
        const sessionID = queue.shift()!
        if (seen.has(sessionID)) continue
        seen.add(sessionID)
        rootBySession.set(sessionID, root)

        let cursor: string | undefined
        do {
          const messages = await api.client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) })
          if (disposed) return
          for (const message of messages.data) addMessage(sessionID, message)
          if (messages.data.length === 0) break
          cursor = messages.cursor.next ?? undefined
        } while (cursor)
        cursor = undefined
        do {
          const children = await api.client.session.list({ parentID: sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) })
          if (disposed) return
          for (const child of children.data) queue.push(child.id)
          if (children.data.length === 0) break
          cursor = children.cursor.next ?? undefined
        } while (cursor)
      }
      hydratedRoots.add(root)
      setVersion((v) => v + 1)
    } finally {
      hydratingRoots.delete(root)
    }
  }

  function dropSamples(match: (sample: Sample) => boolean) {
    const before = samples.length
    for (let i = samples.length - 1; i >= 0; i--) {
      if (match(samples[i])) samples.splice(i, 1)
    }
    if (samples.length !== before) setVersion((v) => v + 1)
  }

  const unsubStarted = api.data.on("session.step.started", ({ data }) => {
    byMessage.set(data.assistantMessageID, {
      sessionID: data.sessionID,
      providerID: data.model.providerID,
      modelID: data.model.id,
      tokens: 0,
      cost: 0,
    })
    setVersion((v) => v + 1)
  })

  function finishStep(data: { sessionID: string; assistantMessageID: string; tokens?: TokenUsageInfo; cost?: number }) {
    const info = byMessage.get(data.assistantMessageID)
    if (info && data.tokens) {
      info.tokens = data.tokens.input + data.tokens.output + data.tokens.reasoning
      info.cost = data.cost ?? 0
    }
    dropSamples((s) => s.messageID === data.assistantMessageID)
    setVersion((v) => v + 1)
  }
  const unsubEnded = api.data.on("session.step.ended", ({ data }) => finishStep(data))
  const unsubFailed = api.data.on("session.step.failed", ({ data }) => finishStep(data))
  const unsubCreated = api.data.on("session.created", () => {
    hydratedRoots.clear()
    setVersion((v) => v + 1)
  })

  function delta(data: { sessionID: string; assistantMessageID: string; delta: string }) {
    const { sessionID, assistantMessageID: messageID } = data
    if (!byMessage.has(messageID)) {
      const message = api.data.session.message.get(sessionID, messageID)
      if (message) addMessage(sessionID, message)
    }
    if (!byMessage.has(messageID) || !data.delta) return
    samples.push({
      messageID,
      sessionID,
      tokens: estimateTokens(data.delta),
      timestamp: Date.now(),
    })
    setVersion((v) => v + 1)
  }
  const unsubDelta = api.data.on("session.text.delta", ({ data }) => delta(data))
  const unsubReasoning = api.data.on("session.reasoning.delta", ({ data }) => delta(data))
  const unsubTool = api.data.on("session.tool.called", ({ data }) => {
    dropSamples((s) => s.sessionID === data.sessionID)
  })

  const interval = setInterval(() => {
    const cutoff = Date.now() - SAMPLE_WINDOW_MS
    dropSamples((s) => s.timestamp < cutoff)
    setTick((t) => t + 1)
  }, 1000)

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

  function costStr(cost: number): string {
    if (cost <= 0) return ""
    if (cost < 1) return `$${cost.toFixed(3)}`
    return `$${cost.toFixed(2)}`
  }

  function tpsStr(value: number): string {
    if (value < 0) return ""
    if (value < 10) return `${value.toFixed(2)}tps`
    if (value < 100) return `${value.toFixed(1)}tps`
    return `${Math.round(value)}tps`
  }

  function computeEntries(root: string): { models: ModelAgg[]; totalTokens: number; totalCost: number } {
    for (const sessionID of new Set([root, ...api.data.session.family(root)])) {
      for (const info of api.data.session.message.list(sessionID)) addMessage(sessionID, info)
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

    const models: ModelAgg[] = []
    let totalTokens = 0
    let totalCost = 0
    for (const [key, entry] of perModel) {
      const live = calcTps(activeByModel.get(key) ?? [])
      const running = live >= 0
      if (running) lastTps.set(key, live)
      models.push({
        key,
        name: entry.name,
        tokens: entry.tokens,
        cost: entry.cost,
        tps: running ? live : (lastTps.get(key) ?? -1),
        running,
      })
      totalTokens += entry.tokens
      totalCost += entry.cost
    }
    models.sort((a, b) => b.tokens - a.tokens)
    return { models, totalTokens, totalCost }
  }

  const unslot = api.ui.slot({
    append: "sidebar.content",
    render(props) {
        createEffect(() => {
          version()
          void hydrateTree(props.sessionID).catch((error) => {
            if (!disposed) api.ui.toast.show({ message: `Model usage: ${String(error)}`, variant: "error" })
          })
        })

        const stats = createMemo(() => {
          version()
          tick()
          return computeEntries(props.sessionID)
        })

        const heading = createMemo(() => {
          const { models, totalTokens, totalCost } = stats()
          if (models.length === 0) return "Models"
          const cost = costStr(totalCost)
          return `Models${cost ? `  ${cost}` : ""}  ${formatTokens(totalTokens)} tok`
        })

        const lines = createMemo(() =>
          stats().models.map((m) => {
            const cost = costStr(m.cost)
            const tps = tpsStr(m.tps)
            return {
               text: `${m.name}  ${formatTokens(m.tokens)}${cost ? `  ${cost}` : ""}${tps ? `  ·~${tps}` : ""}`,
              running: m.running,
            }
          }),
        )

        const text = api.theme.text.base
        const textMuted = api.theme.text.muted
        const accent = api.theme.text.feedback.info.base

        return (
          <box flexDirection="column" gap={0}>
            <text fg={text}>
              <b>{heading()}</b>
            </text>
            <box flexDirection="column" gap={0}>
              {lines().map((line) => (
                <text fg={line.running ? accent : textMuted} wrapMode="none">
                  {line.text}
                </text>
              ))}
            </box>
          </box>
        )
    },
  })
  return () => {
    disposed = true
    unslot()
    unsubStarted()
    unsubEnded()
    unsubFailed()
    unsubCreated()
    unsubDelta()
    unsubReasoning()
    unsubTool()
    clearInterval(interval)
  }
}

export default Plugin.define({
  id: "opencode-model-cost",
  setup,
})
