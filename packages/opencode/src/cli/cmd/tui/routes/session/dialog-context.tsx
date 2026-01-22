import { Show, For, createSignal, createMemo } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { RGBA, TextAttributes } from "@opentui/core"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "../../ui/toast"
import { Clipboard } from "../../util/clipboard"
import { Log } from "@/util/log"

const TABS = [
  { name: "Overview", key: "overview" },
  { name: "Response", key: "response" },
  { name: "Titles", key: "generate_title" },
  { name: "Summaries", key: "summarize_message" },
]

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return n.toString()
}

function estimateTokensFromObject(obj: any): number {
  if (!obj) return 0
  if (typeof obj === "string") return Math.ceil(obj.length / 4)
  if (Array.isArray(obj)) return obj.reduce((sum, item) => sum + estimateTokensFromObject(item), 0)
  if (typeof obj === "object") {
    return Object.entries(obj).reduce((sum, [key, value]) => {
      return sum + estimateTokensFromObject(key) + estimateTokensFromObject(value)
    }, 0)
  }
  return 0
}

function generateTuiSequence(requestBody: Record<string, any>) {
  const sequence: { index: number; label: string; value: any; color: string }[] = []
  let idx = 0

  Log.Default.debug("dialog-context generateTuiSequence", { keys: Object.keys(requestBody), count: Object.keys(requestBody).length })

  Object.entries(requestBody).forEach(([key, value]) => {
    key = key.toLowerCase().trim()
    switch (key) {
      case "model":
        sequence.push({ index: ++idx, label: "MODEL", value, color: "accent" })
        break
      case "max_tokens":
        sequence.push({ index: ++idx, label: "MAX_TOKENS", value, color: "textMuted" })
        break
      case "temperature":
        sequence.push({ index: ++idx, label: "TEMPERATURE", value, color: "textMuted" })
        break
      case "top_p":
        sequence.push({ index: ++idx, label: "TOP_P", value, color: "textMuted" })
        break
      case "system":
        sequence.push({ index: ++idx, label: "SYSTEM", value, color: "error" })
        break
      case "messages":
        if (Array.isArray(value)) {
          value.forEach((msg) => {
            const role = msg.role?.toUpperCase() || "UNKNOWN"
            const roleColor =
              role === "SYSTEM" || role === "DEVELOPER" ? "error" :
              role === "USER" ? "success" :
              role === "ASSISTANT" ? "accent" : "info"
            sequence.push({ index: ++idx, label: role, value: msg, color: roleColor })
          })
        }
        break
      case "tools":
        if (Array.isArray(value)) {
          value.forEach((tool) => {
            const toolName = tool.function?.name || tool.name || "unknown"
            sequence.push({ index: ++idx, label: `TOOL: ${toolName}`, value: tool, color: "info" })
          })
        }
        break
      default:
        sequence.push({ index: ++idx, label: key.toUpperCase(), value, color: "textMuted" })
        break
    }
  })
  return sequence
}

export function DialogContext(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme, syntax } = useTheme()
  const toast = useToast()

  dialog.setSize("large")

  const [activeTab, setActiveTab] = createSignal(0)
  const [activeExchange, setActiveExchange] = createSignal(0)
  const [currentPartIndex, setCurrentPartIndex] = createSignal(0)

  const activeOrigin = createMemo(() => {
    const tab = activeTab()
    if (tab === 0) return null
    const origins = ["response", "generate_title", "summarize_message"]
    return tab <= origins.length ? origins[tab - 1] : null
  })

  const filteredExchanges = createMemo(() => {
    const all = sync.data.session_context[props.sessionID] ?? []
    const origin = activeOrigin()
    if (!origin) return all
    return all.filter((e) => e.messageOrigin === origin)
  })

  const hasExchanges = createMemo(() => (sync.data.session_context[props.sessionID]?.length ?? 0) > 0)

  const currentExchange = createMemo(() => {
    const idx = activeExchange()
    const exchanges = filteredExchanges()
    return exchanges[idx] ?? null
  })

  const currentSequence = createMemo(() => {
    const exchange = currentExchange()
    if (!exchange) return []
    return generateTuiSequence(exchange.request.body || {})
  })

  const currentPart = createMemo(() => {
    const seq = currentSequence()
    const idx = currentPartIndex()
    return seq[idx] || null
  })

  const recentExchanges = createMemo(() => {
    const all = filteredExchanges()
    return [...all].reverse().slice(0, 10)
  })

  const overviewStats = createMemo(() => {
    const all = sync.data.session_context[props.sessionID] ?? []
    const origin = activeOrigin()
    const filtered = origin ? all.filter((e) => e.messageOrigin === origin) : all
    const total = filtered.length
    const totalInput = filtered.reduce((sum, e) => sum + (e.response?.usage?.inputTokens || 0), 0)
    const totalOutput = filtered.reduce((sum, e) => sum + (e.response?.usage?.outputTokens || 0), 0)
    const totalEstimatedInput = filtered.reduce((sum, e) => sum + estimateTokensFromObject(e.request.body), 0)
    const totalEstimatedOutput = filtered.reduce((sum, e) => sum + estimateTokensFromObject(e.response?.body), 0)
    return { total, totalInput, totalOutput, totalEstimatedInput, totalEstimatedOutput, origin }
  })

  useKeyboard((evt) => {
    if (activeTab() !== 0) {
      const exchanges = filteredExchanges()
      if (exchanges.length === 0) return

      if (evt.name === "up") {
        evt.preventDefault()
        evt.stopPropagation()
        const seq = currentSequence()
        const next = Math.max(0, currentPartIndex() - 1)
        setCurrentPartIndex(next)
        return
      }
      if (evt.name === "down") {
        evt.preventDefault()
        evt.stopPropagation()
        const seq = currentSequence()
        const next = Math.min(seq.length - 1, currentPartIndex() + 1)
        setCurrentPartIndex(next)
        return
      }
      if (evt.name === "-" || evt.name === "_") {
        evt.preventDefault()
        evt.stopPropagation()
        const next = Math.max(0, activeExchange() - 1)
        setActiveExchange(next)
        setCurrentPartIndex(0)
        return
      }
      if (evt.name === "=" || evt.name === "+") {
        evt.preventDefault()
        evt.stopPropagation()
        const next = Math.min(exchanges.length - 1, activeExchange() + 1)
        setActiveExchange(next)
        setCurrentPartIndex(0)
        return
      }
    }
  })

  const formattedContent = createMemo(() => {
    const part = currentPart()
    if (!part) return ""
    if (typeof part.value === "string") {
      try {
        return JSON.stringify(JSON.parse(part.value), null, 2)
      } catch {
        return part.value
      }
    }
    if (part.value && typeof part.value === "object" && part.value.role) {
      const msg = part.value
      let result = ""
      if (msg.content) {
        if (typeof msg.content === "string") {
          result = msg.content
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((item: any, idx: number) => {
            if (item.type === "text") {
              result += `[${idx}] Text: ${item.text}\n`
            } else             if (item.type === "tool-call") {
              result += `Tool Call: ${item.function.name}\n\nArguments:\n${JSON.stringify(item.function.arguments || {}, null, 2)}\n`
            } else             if (item.type === "tool-result") {
              result += `Tool Result: ${item.toolCallId}\n\nResult:\n${JSON.stringify(item.result || {}, null, 2)}\n`
            } else {
              result += `[${idx}] ${item.type}: ${JSON.stringify(item)}\n`
            }
          })
        }
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        result += `\n--- TOOL CALLS ---\n`
        msg.tool_calls.forEach((call: any) => {
          result += `Function: ${call.function.name}\n`
          result += `Arguments: ${JSON.stringify(call.function.arguments, null, 2)}\n`
          result += `\n`
        })
        result += `------------------`
      }
      return result
    }
    if (part.label.startsWith("TOOL:")) {
      const tool = part.value
      if (tool.function) {
        return `Name: ${tool.function.name}\n\nParameters:\n${JSON.stringify(tool.function.parameters || {}, null, 2)}`
      }
      return JSON.stringify(part.value, null, 2)
    }
    return JSON.stringify(part.value, null, 2)
  })

  const handleTextSelection = () => {
    const contentToCopy = formattedContent()
    if (contentToCopy.trim()) {
      Clipboard.copy(contentToCopy)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(() => toast.error("Failed to copy text"))
    }
  }

  return (
    <box
      onMouseUp={(e) => { e.stopPropagation(); handleTextSelection() }}
      width="100%"
      height="100%"
      backgroundColor={theme.backgroundPanel}
      padding={1}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Context Analysis Dialog</text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <box width="100%" flexShrink={0} paddingTop={1}>
        <tab_select
          height={2}
          width="100%"
          options={TABS.map((tab, index) => ({ name: tab.name, value: index, description: "" }))}
          onChange={(index: number) => {
            setActiveTab(index)
            setCurrentPartIndex(0)
            setActiveExchange(0)
          }}
          focused
        />
      </box>

      <box flexDirection="column" flexGrow={1} overflow="hidden" paddingTop={1}>
        <Show
          when={hasExchanges()}
          fallback={
            <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                No exchanges recorded yet.
                <br />
                Send a message to start recording context data.
              </text>
            </box>
          }
        >
          <Show when={activeTab() === 0}>
            <box flexDirection="column" flexGrow={1} overflow="hidden">
              <scrollbox flexGrow={1} overflow="hidden">
                <box flexDirection="column" paddingBottom={1}>
                  <text attributes={TextAttributes.BOLD} fg={theme.accent}>Overview - All Exchanges</text>
                  <box paddingTop={1} flexDirection="row" gap={4}>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Total Exchanges</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{overviewStats().total}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Actual Input Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{formatNumber(overviewStats().totalInput)}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Actual Output Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{formatNumber(overviewStats().totalOutput)}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Estimated Input Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{formatNumber(overviewStats().totalEstimatedInput)}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Estimated Output Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{formatNumber(overviewStats().totalEstimatedOutput)}</text>
                    </box>
                  </box>
                </box>

                <box paddingTop={2} flexDirection="column">
                  <text attributes={TextAttributes.BOLD} fg={theme.accent}>Recent Exchanges</text>
                  <For each={recentExchanges()}>
                    {(exchange) => (
                      <box flexDirection="column" paddingTop={1} border={["bottom"]} borderColor={theme.borderSubtle}>
                        <text fg={theme.textMuted}>{exchange.request.body?.model ?? "Unknown"}</text>
                        <text fg={theme.textMuted}>
                          {formatNumber(exchange.response?.usage?.inputTokens || 0)} →{" "}
                          {formatNumber(exchange.response?.usage?.outputTokens || 0)} tokens
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </scrollbox>
            </box>
          </Show>

          <Show when={activeTab() !== 0}>
            <box flexDirection="row" gap={1} flexGrow={1} overflow="hidden">
              <box width="30%" flexDirection="column" flexGrow={1} overflow="hidden">
                <box flexShrink={0} flexDirection="column">
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Keybinds:</text>
                  <text fg={theme.textMuted}>[↑/↓] Prev/Next Part</text>
                  <text fg={theme.textMuted}>[-/_] Prev Exchange</text>
                  <text fg={theme.textMuted}>[+/=] Next Exchange</text>
                  <box border={["bottom"]} borderColor={theme.borderSubtle} />

                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Exchange Details:</text>
                  <Show when={currentExchange()}>
                    <text fg={theme.textMuted}>Origin: {currentExchange()?.messageOrigin}</text>
                    <text fg={theme.text}>
                      {activeExchange() + 1} / {filteredExchanges().length}: {currentExchange()?.request.body?.model ?? "Unknown"}
                    </text>
                  </Show>
                  <Show when={currentExchange()?.response?.usage}>
                    <text fg={theme.textMuted}>
                      {formatNumber(currentExchange()?.response?.usage?.inputTokens || 0)} /{" "}
                      {formatNumber(currentExchange()?.response?.usage?.outputTokens || 0)} tokens
                    </text>
                  </Show>
                  <Show when={currentExchange()?.response?.finishReason}>
                    <text fg={theme.textMuted}>Finish: {currentExchange()?.response?.finishReason}</text>
                  </Show>
                  <box border={["bottom"]} borderColor={theme.borderSubtle} />
                </box>

                <scrollbox flexGrow={1} overflow="hidden">
                  <For each={currentSequence()}>
                    {(item, i) => {
                      const isSelected = () => i() === currentPartIndex()
                      const colorValue = (theme as unknown as Record<string, RGBA | string | undefined>)[item.color] ?? theme.text
                      const borderColor = isSelected() ? (colorValue as RGBA | string) : theme.borderSubtle
                      return (
                        <box flexDirection="column" paddingBottom={0}>
                          {isSelected() && <box border={["bottom"]} borderColor={borderColor as RGBA | string | undefined} />}
                          <text
                            fg={colorValue as RGBA | string | undefined}
                            attributes={isSelected() ? TextAttributes.BOLD : undefined}
                          >
                            {isSelected() ? "▶ " : ""}[{item.index}] {item.label}
                          </text>
                          {isSelected() && <box border={["bottom"]} borderColor={borderColor as RGBA | string | undefined} />}
                        </box>
                      )
                    }}
                  </For>
                </scrollbox>
              </box>

              <box border={["left"]} borderColor={theme.borderSubtle} />

              <box width="70%" flexDirection="column" flexGrow={1} overflow="hidden">
                <scrollbox flexGrow={1} overflow="hidden">
                  <code
                    filetype="json"
                    drawUnstyledText={false}
                    streaming={true}
                    syntaxStyle={syntax()}
                    content={formattedContent()}
                    fg={theme.text}
                  />
                </scrollbox>
              </box>
            </box>
          </Show>
        </Show>
      </box>
    </box>
  )
}
