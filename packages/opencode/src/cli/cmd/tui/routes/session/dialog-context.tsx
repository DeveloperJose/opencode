import { Show, For, createSignal, createMemo } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "../../ui/toast"
import { Clipboard } from "../../util/clipboard"
import type { EventMessageExchangeAfter } from "@opencode-ai/sdk/v2"

const TABS = [
  { name: "Overview", key: "overview" },
  { name: "Response", key: "response" },
  { name: "Titles", key: "generate_title" },
]

function fmt(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return n.toString()
}

function tokens(obj: unknown): number {
  if (!obj) return 0
  if (typeof obj === "string") return Math.ceil(obj.length / 4)
  if (Array.isArray(obj)) return obj.reduce((sum, item) => sum + tokens(item), 0)
  if (typeof obj === "object") {
    return Object.entries(obj).reduce((sum, [k, v]) => sum + tokens(k) + tokens(v), 0)
  }
  return 0
}

type SeqItem = { idx: number; label: string; val: unknown; color: string; tk: number }

function seq(body: Record<string, unknown>): SeqItem[] {
  const s: SeqItem[] = []
  let i = 0
  const roles: Record<string, string> = {
    SYSTEM: "error",
    DEVELOPER: "error",
    USER: "success",
    ASSISTANT: "accent",
  }

  Object.entries(body).forEach(([k, v]) => {
    const key = k.toLowerCase().trim()
    switch (key) {
      case "system":
        s.push({ idx: ++i, label: "SYSTEM", val: v, tk: tokens(v), color: "error" })
        break
      case "messages":
      case "input":
        if (Array.isArray(v)) {
          v.forEach((msg) => {
            const role = msg.role?.toUpperCase() || "UNKNOWN"
            const color = roles[role] ?? "textMuted"

            if (role === "ASSISTANT" && Array.isArray(msg.tool_calls)) {
              msg.tool_calls.forEach((tc: { function?: { name?: string }; name?: string }) => {
                const fn = tc.function?.name || tc.name || "?"
                s.push({ idx: ++i, label: `TOOL CALL - ${fn}`, val: tc, tk: tokens(tc), color: "error" })
              })
            } else if (msg.tool_call_id) {
              s.push({ idx: ++i, label: `TOOL RESULT`, val: msg, tk: tokens(msg), color: "info" })
            } else {
              s.push({ idx: ++i, label: role, val: msg, tk: tokens(msg), color: color })
            }
          })
        }
        break
      case "tools":
        if (Array.isArray(v)) {
          v.forEach((tool) => {
            const name = tool.function?.name || tool.name || "?"
            s.push({ idx: ++i, label: `TOOL DEF: ${name}`, val: tool, tk: tokens(tool), color: "error" })
          })
        }
        break
      default:
        s.push({ idx: ++i, label: key.toUpperCase(), val: v, tk: 0, color: "textMuted" })
        break
    }
  })
  return s
}

export function DialogContext(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const ui = useTheme()
  const t = useToast()
  dialog.setSize("x-large")

  const [tab, setTab] = createSignal(0)
  const [idx, setIdx] = createSignal(0)
  const [p, setP] = createSignal(0)

  const origin = createMemo(() => {
    if (tab() === 0) return null
    const origins = ["response", "generate_title"]
    return tab() <= origins.length ? origins[tab() - 1] : null
  })

  const exchanges = createMemo(() => {
    const all = sync.data.session_context[props.sessionID] ?? []
    const o = origin()
    return o ? all.filter((e) => e.properties.request.messageOrigin === o) : all
  })

  const has = createMemo(() => (sync.data.session_context[props.sessionID]?.length ?? 0) > 0)

  const curr = createMemo(() => exchanges()[idx()] ?? null)

  const s = createMemo(() => {
    const c = curr()
    const body = c?.properties.request.body
    return body ? seq(body) : []
  })

  const item = createMemo(() => s()[p()] ?? null)

  const recent = createMemo(() => [...exchanges()].reverse().slice(0, 10))

  const stats = createMemo(() => {
    const all = sync.data.session_context[props.sessionID] ?? []
    const o = origin()
    const list = o ? all.filter((e) => e.properties.request.messageOrigin === o) : all
    return {
      total: list.length,
      in: list.reduce((sum, e) => sum + (e.properties.response?.usage?.inputTokens || 0), 0),
      out: list.reduce((sum, e) => sum + (e.properties.response?.usage?.outputTokens || 0), 0),
      ein: list.reduce((sum, e) => sum + tokens(e.properties.request.body), 0),
      eout: list.reduce((sum, e) => sum + tokens(e.properties.response?.body), 0),
    }
  })

  useKeyboard((evt) => {
    if (tab() === 0) return
    const list = exchanges()
    if (list.length === 0) return

    if (evt.name === "up") {
      evt.preventDefault()
      evt.stopPropagation()
      setP(Math.max(0, p() - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      evt.stopPropagation()
      setP(Math.min(s().length - 1, p() + 1))
      return
    }
    if (evt.name === "-" || evt.name === "_") {
      evt.preventDefault()
      evt.stopPropagation()
      setIdx(Math.max(0, idx() - 1))
      setP(0)
      return
    }
    if (evt.name === "=" || evt.name === "+") {
      evt.preventDefault()
      evt.stopPropagation()
      setIdx(Math.min(list.length - 1, idx() + 1))
      setP(0)
      return
    }
  })

  const json = createMemo(() => (item() ? JSON.stringify(item()!.val, null, 2) : ""))

  const copy = () => {
    const data = json()
    if (data.trim()) {
      Clipboard.copy(data)
        .then(() => t.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(() => t.error("Failed to copy text"))
    }
  }

  const theme = ui.theme
  const syntax = ui.syntax

  return (
    <box
      onMouseUp={(e) => { e.stopPropagation(); copy() }}
      backgroundColor={theme.backgroundPanel}
      padding={1}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Context Analysis Dialog</text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <box flexShrink={0} paddingTop={1}>
        <tab_select
          height={2}
          options={TABS.map((t, i) => ({ name: t.name, value: i, description: "" }))}
          onChange={(v: number) => { setTab(v); setP(0); setIdx(0) }}
          focused
        />
      </box>

      <box flexDirection="column" flexGrow={1} overflow="hidden" paddingTop={1}>
        <Show
          when={has()}
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
          <Show when={tab() === 0}>
            <box flexDirection="column" flexGrow={1} overflow="hidden">
              <scrollbox flexGrow={1} overflow="hidden">
                <box flexDirection="column" paddingBottom={1}>
                  <text attributes={TextAttributes.BOLD} fg={theme.accent}>Overview - All Exchanges</text>
                  <box paddingTop={1} flexDirection="row" gap={4}>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Total Exchanges</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{stats().total}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Actual Input Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{fmt(stats().in)}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Actual Output Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{fmt(stats().out)}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Estimated Input Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{fmt(stats().ein)}</text>
                    </box>
                    <box flexDirection="column">
                      <text fg={theme.textMuted}>Estimated Output Tokens</text>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>{fmt(stats().eout)}</text>
                    </box>
                  </box>
                </box>

                <box paddingTop={2} flexDirection="column">
                  <text attributes={TextAttributes.BOLD} fg={theme.accent}>Recent Exchanges</text>
                  <For each={recent()}>
                    {(ex) => (
                      <box flexDirection="column" paddingTop={1} border={["bottom"]} borderColor={theme.borderSubtle}>
                        <text fg={theme.textMuted}>{ex.properties.request.body?.model ?? "Unknown"}</text>
                        <text fg={theme.textMuted}>
                          {fmt(ex.properties.response?.usage?.inputTokens || 0)} →{" "}
                          {fmt(ex.properties.response?.usage?.outputTokens || 0)} tokens
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </scrollbox>
            </box>
          </Show>

          <Show when={tab() !== 0}>
            <box flexDirection="row" gap={1} flexGrow={1} overflow="hidden">
              <box width="30%" flexDirection="column" flexGrow={1} overflow="hidden">
                <box flexShrink={0} flexDirection="column">
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Keybinds:</text>
                  <text fg={theme.textMuted}>[↑/↓] Prev/Next Part</text>
                  <text fg={theme.textMuted}>[-/_] Prev Exchange</text>
                  <text fg={theme.textMuted}>[+/=] Next Exchange</text>

                  <box border={["bottom"]} borderColor={theme.borderSubtle} />
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Response:</text>
                  <Show when={curr()?.properties.response?.usage}>
                    <text fg={theme.textMuted}>
                      {fmt(curr()!.properties.response!.usage!.inputTokens || 0)} input tokens
                    </text>
                  </Show>
                  <Show when={curr()?.properties.response?.finishReason}>
                    <text fg={theme.textMuted}>Finish Reason: "{curr()!.properties.response!.finishReason}"</text>
                  </Show>
                  <box border={["bottom"]} borderColor={theme.borderSubtle} />

                  <Show when={curr()}>
                    <text fg={theme.text}>
                      Exchange #{idx() + 1} / {exchanges().length}
                    </text>
                  </Show>
                </box>

                <scrollbox flexGrow={1} overflow="hidden">
                  <For each={s()}>
                    {(it, i) => {
                      const sel = () => i() === p()
                      const tot = s().length
                      const color = (theme as Record<string, unknown>)[it.color] as string ?? theme.text
                      const b = sel() ? color : theme.borderSubtle
                      return (
                        <box flexDirection="column" paddingBottom={0}>
                          {sel() && <box border={["bottom"]} borderColor={b} />}
                          <text
                            fg={color}
                            attributes={sel() ? TextAttributes.BOLD : undefined}
                          >
                            {sel() ? "▶ " : ""}[{i() + 1}/{tot}] {it.label} ({fmt(it.tk || 0)})
                          </text>
                          {sel() && <box border={["bottom"]} borderColor={b} />}
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
                    content={json()}
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
