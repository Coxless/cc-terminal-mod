// Phase 0 spike: PTY sidecar + Terminal Pane の最小 PoC。本実装ではない。
// 観測した事実は JSONL のログ(logPath)に書き、docs/architecture.md の根拠にする。
import type { EngineInterface, Register } from 'claude-code'

type Run = [string, string | null, string | null, boolean]
type Frame = {
  ver: number
  cols: number
  rows: number
  alive: boolean
  bytes: number
  cells?: string
  runs?: Run[][]
  wide?: number
  encodeMs?: number
}
type Mode = 'raster' | 'text' | 'client'
type Key = { n: number; key: string; ctrl?: true; shift?: true; meta?: true }

type Ops = {
  fetch: EngineInterface['http']['fetch']
  run: EngineInterface['process']['run']
  blit: EngineInterface['ui']['blit']
  invalidate: () => void
  write: (path: string, text: string) => Promise<void>
  after: (ms: number, fn: () => void) => void
  sleep: (ms: number) => Promise<unknown>
  submit: (text: string) => Promise<unknown>
  pluginRoot: string
}

const PANE = 'term'
const HOST = 'http://sidecar'
const SPECIAL: Record<string, string> = {
  return: '\r', enter: '\r', tab: '\t', backspace: '\x7f', delete: '\x1b[3~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  insert: '\x1b[2~', escape: '\x1b', space: ' ',
}

// Client に届かないキーの代替(スパイク用の仮割り当て):
//   Escape → ctrl+]、Ctrl+C → alt+c、Ctrl+D → alt+d、Ctrl+Z → alt+z、Ctrl+X → alt+x
const REMAP_META: Record<string, string> = { c: '\x03', d: '\x04', z: '\x1a', x: '\x18' }

function keyBytes(k: Key): string {
  if (k.ctrl && k.key === ']') return '\x1b'
  if (k.meta && REMAP_META[k.key] !== undefined) return REMAP_META[k.key]
  let s = SPECIAL[k.key]
  if (s === undefined) {
    s = k.key
    if (k.ctrl && s.length === 1) {
      const c = s.toUpperCase().charCodeAt(0)
      if (c >= 0x40 && c <= 0x5f) s = String.fromCharCode(c & 0x1f)
      else if (s === ' ') s = '\x00'
    }
  }
  return k.meta ? '\x1b' + s : s
}

function screenText(f: Frame): string {
  return (f.runs ?? []).map(row => row.map(r => r[0]).join('').trimEnd()).join('\n')
}

export const register: Register = on => {
  // $ は保存も受け渡しもできない(validate が拒否する)。session.start の $ を閉じ込めた
  // クロージャの束を持ち、dispatch をまたぐ処理はこれ経由で呼ぶ。
  let ops: Ops | undefined
  let dir = ''
  let sock = ''
  let logPath = ''
  let cwd = ''
  const lines: string[] = []
  let flushing = false

  let mode: Mode = 'raster'
  let pointer = false
  let frame: Frame | undefined
  let ver = 0
  let want = { cols: 80, rows: 24 }
  let mounted: { cols: number; rows: number } | undefined
  let generation = 0
  let lastKey = 0
  let pendingContext: string[] = []
  const stats = { frames: 0, blits: 0, blitDenied: 0, blitMs: 0, blitMaxMs: 0, invalidates: 0, renders: 0 }

  const log = (event: string, data: Record<string, unknown> = {}) => {
    lines.push(JSON.stringify({ t: Date.now(), event, ...data }))
    if (flushing || ops === undefined || logPath === '') return
    flushing = true
    const o = ops
    o.after(150, () => {
      flushing = false
      void o.write(logPath, lines.join('\n') + '\n').catch(() => undefined)
    })
  }

  const api = async (path: string, body?: unknown, socketPath = sock) => {
    const res = await (ops as Ops).fetch(HOST + path, {
      socketPath,
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return JSON.parse(res.text)
  }

  const startSidecar = async (socketPath: string, cols: number, rows: number) => {
    const o = ops as Ops
    const t0 = Date.now()
    const ran = await o.run([
      'python3', `${o.pluginRoot}/sidecar/ptyd.py`,
      '--sock', socketPath, '--cwd', cwd, '--cols', String(cols), '--rows', String(rows),
    ])
    const out = { exitCode: ran.exitCode, stdout: ran.stdout.trim(), stderr: ran.stderr.trim(), ms: Date.now() - t0 }
    log('sidecar.start', out)
    return out
  }

  const clientProps = () => ({
    mode,
    ack: lastKey,
    pointer,
    cols: want.cols,
    runs: mode === 'client' ? (frame?.runs ?? null) : null,
  })

  const paint = async () => {
    const o = ops as Ops
    const f = frame
    if (f === undefined) return
    const fits = mounted !== undefined && mounted.cols === f.cols && mounted.rows === f.rows
    if (mode === 'raster' && fits && f.cells !== undefined) {
      const t0 = Date.now()
      const done = await o.blit({ requestId: PANE, key: 'screen', cells: f.cells })
      const ms = Date.now() - t0
      stats.blits += 1
      stats.blitMs += ms
      stats.blitMaxMs = Math.max(stats.blitMaxMs, ms)
      if (done.deny !== undefined) {
        stats.blitDenied += 1
        log('blit.deny', { deny: done.deny })
        o.invalidate()
      }
    } else {
      stats.invalidates += 1
      o.invalidate()
    }
  }

  const poll = async () => {
    const mine = ++generation
    log('poll.start', { generation: mine, mode })
    while (mine === generation) {
      let next: Frame
      try {
        next = await api(`/frame?since=${ver}&wait=20000&fmt=${mode === 'raster' ? 'cells' : 'runs'}`)
      } catch (error) {
        log('poll.error', { error: String(error) })
        frame = undefined
        ;(ops as Ops).invalidate()
        return
      }
      if (mine !== generation) return
      if (next.ver > ver) {
        ver = next.ver
        frame = next
        stats.frames += 1
        await paint()
      }
      if (!next.alive) {
        log('poll.shell-exited', {})
        return
      }
    }
  }

  const prepare = async (args: string) => {
    const words = args.split(/\s+/).filter(Boolean)
    const asked = words.find(w => w === 'raster' || w === 'text' || w === 'client') as Mode | undefined
    if (asked !== undefined) mode = asked
    pointer = words.includes('pointer')
    const started = await startSidecar(sock, want.cols, want.rows)
    if (started.exitCode !== 0 || !started.stdout.includes('"ok": true')) {
      return `Failed to start shell: ${started.stderr || started.stdout}`
    }
    return undefined
  }

  const selftest = async () => {
    const s = `${dir}/selftest.sock`
    const result: Record<string, unknown> = {}
    const started = await startSidecar(s, 80, 24)
    result.startMs = started.ms
    result.start = started.stdout
    const send = (d: string) => api('/input', { d }, s)
    const until = async (needle: string, ms = 5000) => {
      const t0 = Date.now()
      let since = 0
      while (Date.now() - t0 < ms) {
        const f: Frame = await api(`/frame?since=${since}&wait=500&fmt=runs`, undefined, s)
        since = f.ver
        if (f.runs !== undefined && screenText(f).includes(needle)) return { ok: true, ms: Date.now() - t0 }
      }
      return { ok: false, ms: Date.now() - t0 }
    }
    await until('$', 3000)
    await send('echo MARK-$((6*7))\n')
    result.stdin = await until('MARK-42')
    await api('/resize', { cols: 100, rows: 30 }, s)
    await send('stty size\n')
    result.resize = await until('30 100')
    await send('sleep 100\n')
    await send('\x03')
    await send('echo rc=$?\n')
    result.ctrlC = await until('rc=130')
    await send('cat\n')
    await send('typed\n')
    await send('\x04')
    await send('echo eof=$?\n')
    result.ctrlD = await until('eof=0')
    await send('sleep 100\n')
    await send('\x1a')
    result.ctrlZ = await until('Stopped')
    await send('kill %1; clear\n')
    await send('seq 1 200000; echo DONE-$((1+1))\n')
    result.flood = await until('DONE-2', 60000)
    result.info = await api('/info', undefined, s)
    await api('/kill', {}, s)
    try {
      await (ops as Ops).sleep(600)
      await api('/info', undefined, s)
      result.killed = false
    } catch (error) {
      result.killed = true
      result.afterKill = String(error).slice(0, 120)
    }
    log('selftest', result)
    return JSON.stringify(result, null, 1)
  }

  const payload = (text: string) =>
    `[Terminal Context]\nWorking directory: ${cwd}\n\nSelected output:\n----------------\n${text}\n----------------`


  on('session.start', async ($, e, next) => {
    ops = {
      fetch: (url, init) => $.http.fetch(url, init),
      run: (argv, init) => $.process.run(argv, init),
      blit: args => $.ui.blit(args),
      invalidate: () => $.ui.invalidate('ui.render'),
      write: (path, text) => $.fs.write(path, text),
      after: (ms, fn) => void $.clock.after(ms, fn),
      sleep: ms => $.clock.sleep(ms),
      submit: text => $.prompt.submit({ text }),
      pluginRoot: $.plugin.root,
    }
    cwd = e.cwd
    // session id は /clear で変わる(その後 session.start も来ない)ので、ソケット名には使えない。
    // Claude Code 本体の PID はプロセスの寿命のあいだ安定している。
    const id = await $.session.id()
    const pid = (await $.process.run(['sh', '-c', 'echo $PPID'])).stdout.trim()
    const run = (await $.env.get('XDG_RUNTIME_DIR')) ?? '/tmp'
    dir = `${run}/cc-term`
    sock = `${dir}/${pid}.sock`
    logPath = (await $.env.get('CC_TERM_SPIKE_LOG')) ?? `${dir}/spike-log.jsonl`
    try {
      const prior = await $.fs.read(logPath)
      if (typeof prior === 'string') lines.push(...prior.split('\n').filter(Boolean))
    } catch {
      // 初回はログが無い
    }
    log('session.start', { sessionId: id, pid, surface: e.surface, isInteractive: e.isInteractive, sock, pluginRoot: $.plugin.root })

    await $.command.register({ name: 'term', description: 'Open the terminal pane', argumentHint: '[raster|text|client] [pointer]', immediate: true })
    await $.command.register({ name: 'term-add', description: 'Add the selection to Claude context', argumentHint: '[append|fill|submit|context]', immediate: true })
    await $.command.register({ name: 'term-selftest', description: 'Run the sidecar self test', immediate: true })
    await $.command.register({ name: 'term-stats', description: 'Log render statistics', immediate: true })
    await $.command.register({ name: 'term-hide', description: 'Hide the terminal pane (PTY stays)', immediate: true })

    // モジュールのリロード後: sidecar が生きていれば再接続する
    try {
      const info = await api('/info')
      log('reattach', { info })
      const panes = await $.ui.panes()
      log('reattach.panes', { panes })
      void poll()
    } catch {
      log('reattach.none', {})
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    log('session.end', { reason: e.reason })
    if (e.reason === 'clear') return next(e)
    try {
      await api('/kill', {})
      log('session.end.kill', { reason: e.reason })
    } catch {
      // sidecar が無ければ何もしない
    }
    return next(e)
  })

  on('command.run', { command: 'term' }, async ($, e) => {
    log('command.term', { args: e.args, presentation: e.presentation })
    const failed = await prepare(e.args)
    if (failed !== undefined) return { text: failed }
    const opened = await $.ui.open({ id: PANE, title: 'Terminal', focus: true, rows: 20 })
    log('pane.open', { opened, mode, pointer })
    ver = 0
    void poll()
    return { text: `Terminal pane (${mode}) ${opened.isPlaced ? 'opened' : 'not placed'}.` }
  })

  on('command.run', { command: 'term-hide' }, async $ => {
    await $.ui.close({ id: PANE })
    mounted = undefined
    return { text: 'Terminal hidden.' }
  })

  on('command.run', { command: 'term-add' }, async ($, e) => {
    const method = e.args.trim() || 'append'
    const selected = await $.ui.selection()
    log('selection', { method, selected: selected ?? null })
    if (selected === undefined || selected.text === '') return { text: 'Nothing is selected.' }
    const text = payload(selected.text)
    try {
      if (method === 'fill') {
        const filled = await $.prompt.fill({ text: text + '\n', mode: 'append' })
        log('context.fill', { filled })
      } else if (method === 'submit') {
        // command.run の hook から直接 $.prompt.submit すると拒否される(hook が握っているターンを
        // 待つことになるため)。dispatch の外(タイマー)から送る。
        const o = ops as Ops
        o.after(0, () => {
          void o.submit(text).then(
            r => log('context.submit.resolved', { r }),
            error => log('context.submit.rejected', { error: String(error) }),
          )
        })
      } else if (method === 'context') {
        pendingContext.push(text)
      } else {
        const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        log('context.append', { appended })
      }
    } catch (error) {
      log('context.error', { method, error: String(error) })
      return { text: `Failed to add selection to Claude Context: ${String(error)}` }
    }
    $.ui.toast(`Added ${selected.text.length} characters to Claude Context (${method})`)
    return { text: `Added ${selected.text.length} characters to Claude Context (${method}).` }
  })

  on('command.run', { command: 'term-selftest' }, async () => ({ text: await selftest() }))

  on('command.run', { command: 'term-stats' }, async () => {
    const snapshot = { ...stats, mode, ver, want, mounted, bytes: frame?.bytes, encodeMs: frame?.encodeMs }
    log('stats', snapshot)
    return { text: JSON.stringify(snapshot) }
  })

  on('prompt.submit', ($, e, next) => {
    if (pendingContext.length === 0 || e.origin.kind === 'plugin') return next(e)
    const context = [...(e.context ?? []), ...pendingContext]
    pendingContext = []
    log('context.attached', { entries: context.length })
    return next({ ...e, context })
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const data = e.data as { keys?: Key[]; pointer?: unknown }
    if (data.pointer !== undefined) log('pointer', { pointer: data.pointer })
    const fresh = (data.keys ?? []).filter(k => k.n > lastKey)
    if (fresh.length > 0) {
      lastKey = fresh[fresh.length - 1].n
      const d = fresh.map(keyBytes).join('')
      log('keys', { keys: fresh, bytes: JSON.stringify(d) })
      try {
        await api('/input', { d })
      } catch (error) {
        log('input.error', { error: String(error) })
      }
    }
    return { props: clientProps() }
  })

  on('ui.close', async ($, e, next) => {
    log('ui.close', { e })
    mounted = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Client, Raster } = $.ui.resolve(e)
    stats.renders += 1
    const cols = Math.max(20, Math.min(200, e.props.bodyColumns))
    // inline のペインは中身の高さに合わせて伸びるので、bodyRows から行数を決めると循環する。固定にする。
    const rows = e.props.placement === 'inline' ? 16 : Math.max(5, Math.min(60, e.props.scroll.bodyRows - 3))
    // リロード直後は session.start より先に render が走ることがある(sock が未設定)
    if (sock !== '' && (cols !== want.cols || rows !== want.rows)) {
      want = { cols, rows }
      log('resize', { cols, rows, placement: e.props.placement, isFocused: e.props.isFocused, viewport: e.viewport })
      // render の dispatch 内で始めた呼び出しは、再描画が来ると `ui.render: superseded` で中断される。
      // 副作用はタイマー経由で dispatch の外へ出す。
      const size = want
      ;(ops as Ops).after(0, () => {
        void api('/resize', size).catch(error => log('resize.error', { error: String(error) }))
      })
    }
    const f = frame
    const ready = f !== undefined && f.cols === cols && f.rows === rows
    mounted = mode === 'raster' && ready && f.cells !== undefined ? { cols, rows } : undefined

    return (
      <Box flexDirection="column">
        <Client key="keys" module="./keys.tsx" props={clientProps()} />
        {f === undefined && <Text>Terminal process disconnected. Run /term to reconnect.</Text>}
        {f !== undefined && !ready && mode !== 'client' && <Text dimColor>resizing…</Text>}
        {mode === 'raster' && ready && f.cells !== undefined && (
          <Raster key="screen" columns={cols} rows={rows} cells={f.cells} />
        )}
        {mode === 'text' && ready && (f.runs ?? []).map(row => (
          <Text wrap="truncate">
            {row.length === 0 ? ' ' : row.map(([text, fg, bg, bold]) => (
              <Text color={fg ?? undefined} backgroundColor={bg ?? undefined} bold={bold}>{text}</Text>
            ))}
          </Text>
        ))}
        <Box>
          <Button
            key="add"
            hotkey="a"
            label="Add to Claude"
            onPress={async () => {
              const selected = await $.ui.selection()
              log('selection', { method: 'button', selected: selected ?? null })
              if (selected === undefined || selected.text === '') return $.ui.toast('Nothing is selected.')
              await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: payload(selected.text) }] } })
              $.ui.toast(`Added ${selected.text.length} characters to Claude Context`)
            }}
          />
          <Text dimColor> {mode} {cols}x{rows} v{String(ver)} {f?.alive === false ? 'exited' : ''}</Text>
        </Box>
      </Box>
    )
  })
}
