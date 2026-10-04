// Terminal Mod の hooks モジュール。
// PTY と画面の状態は sidecar が持つ。ここは sidecar の起動、long-poll、描画、キーの中継だけを行う。
// 制約の根拠は docs/architecture.md。
import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  HELP_LINES,
  isAddKey,
  isHelpKey,
  isSelectStart,
  keyToBytes,
  scrollKey,
  selectActions,
  type KeyEvent,
} from '../shared/keys'
import { buildPayload, isEmptySelection, summarize } from '../shared/payload'
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_ITALIC,
  ATTR_STRIKE,
  ATTR_UNDERLINE,
  type Color,
  type Frame,
  type Info,
  type Run,
  type SelectOp,
  type SelectResponse,
  type SelectionResponse,
  type StartResult,
} from '../shared/protocol'

// session.start の $ を閉じ込めたクロージャの束。$ は保存も受け渡しもできないため、
// dispatch をまたぐ処理(long-poll、入力の送信、resize)はこれ経由で呼ぶ。
type Ops = {
  fetch: EngineInterface['http']['fetch']
  run: EngineInterface['process']['run']
  invalidate: () => void
  after: (ms: number, fn: () => void) => Timer
  pluginRoot: string
  // キーから始まる「Claude に渡す」操作が使う
  selection: AddIo['selection']
  append: AddIo['append']
  toast: AddIo['toast']
  log: AddIo['log']
}

// sidecar へ順に送る操作。キーの順序を保つため、PTY への書き込みと同じ 1 本のループで処理する
type Job =
  | { input: string }
  | { select: SelectOp }
  // 選択モードの範囲を Claude に渡す
  | { send: true }
  // マウスで選択したテキストを Claude に渡す
  | { add: true }

type Conn =
  | { kind: 'init' } // session.start がまだ終わっていない
  | { kind: 'idle' } // sidecar を起動していない
  | { kind: 'up' }
  | { kind: 'failed'; error: string } // シェルを起動できなかった
  | { kind: 'lost'; error: string } // sidecar と通信できなくなった

type SeqKey = KeyEvent & { n: number }

// 「選択を Claude に渡す」操作が使う、その dispatch の $ を閉じ込めたクロージャ
type AddIo = {
  selection: () => Promise<{ text: string; requestId?: string } | undefined>
  append: (text: string) => Promise<{ deny?: string }>
  toast: (text: string) => void
  // トランスクリプトに 1 行出す(Claude には渡らない)
  log: (text: string) => void
  isFullscreen: boolean | undefined
}

const PANE = 'terminal'
const HOST = 'http://sidecar'
const POLL_WAIT_MS = 20000
const RESIZE_DEBOUNCE_MS = 120
// inline(プロンプトの上)に置かれたときに頼む行数。実際の高さはレイアウトが決める
const INLINE_ROWS = 16
// 画面の下に置く行(入力の入り口、ボタン、状態)
const CHROME_ROWS = 1
const MIN_COLS = 20
const MAX_COLS = 200
const MIN_ROWS = 3
const MAX_ROWS = 60

// Text の color は「テーマのキー、色の名前、hex」。ANSI の 16 色は名前で渡し、端末の配色に従わせる
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
]
const color = (c: Color): string | undefined => (c === null ? undefined : typeof c === 'number' ? ANSI[c] : c)

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export const register: Register = on => {
  let ops: Ops | undefined
  let conn: Conn = { kind: 'init' }
  let cwd = ''
  let sock = ''
  let claudePid = ''

  let frame: Frame | undefined
  let lines: Run[][] = []
  let ver = 0
  let generation = 0
  // ペインが開いている間だけ long-poll する
  let visible = false
  let want = { cols: 80, rows: 24 }
  let resizeTimer: Timer | undefined
  // 履歴を末尾から何行さかのぼって表示しているか
  let back = 0

  let keysId = ''
  let lastKey = 0
  let jobs: Job[] = []
  let sending = false
  // 選択モード。位置と範囲は sidecar が持つ。ここは、キーをどちらへ送るかを決めるためだけに覚える
  let selecting = false
  // Client(下の行の [ Terminal input ])がキーを受けていると分かっているか。フォーカスを得た・失ったを直接知る
  // API は無いので、帯のクリックとキーで立て、キーが他へ行ったと分かったときに下ろす
  let typing = false
  // Terminal の行の代わりにヘルプを出しているか
  let help = false

  const keyProps = () => ({
    ackId: keysId,
    ack: lastKey,
    typing,
    mode: selecting ? 'select' : 'type',
  })

  const setHelp = (next: boolean) => {
    if (help === next) return
    help = next
    ops?.invalidate()
  }

  const setTyping = (next: boolean) => {
    if (typing === next) return
    typing = next
    ops?.invalidate()
  }

  const api = async <T,>(path: string, body?: unknown): Promise<T> => {
    const res = await (ops as Ops).fetch(HOST + path, {
      socketPath: sock,
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return JSON.parse(res.text) as T
  }

  const lost = (error: unknown) => {
    if (conn.kind !== 'up') return
    conn = { kind: 'lost', error: String(error) }
    generation += 1
    ops?.invalidate()
  }

  const apply = (next: Frame) => {
    if (next.lines === undefined) return
    // さかのぼって見ている間に出力が増えても、見ている位置を保つ
    if (back > 0 && frame !== undefined && next.history > frame.history) {
      back = Math.min(next.history, back + next.history - frame.history)
    }
    frame = next
    lines = next.lines
    // 送信待ちの操作があるときは、その結果のほうが新しい
    if (jobs.length === 0 && !sending) selecting = next.select !== undefined
    ver = next.ver
    ops?.invalidate()
  }

  const poll = async () => {
    const mine = ++generation
    while (mine === generation && visible && conn.kind === 'up') {
      const asked = back
      let next: Frame
      try {
        next = await api<Frame>(`/frame?since=${ver}&wait=${POLL_WAIT_MS}&back=${asked}`)
      } catch (error) {
        if (mine === generation) lost(error)
        return
      }
      if (mine !== generation) return
      // 待っている間にスクロール位置が変わっていたら、取り直す
      if (asked !== back && next.back !== back) {
        ver = 0
        continue
      }
      apply(next)
      if (!next.alive) return
    }
  }

  // 画面を取り直して long-poll をやり直す
  const refresh = () => {
    ver = 0
    void poll()
  }

  const scrollTo = (target: number) => {
    const max = frame?.alt === true ? 0 : (frame?.history ?? 0)
    const next = clamp(Math.round(target), 0, max)
    if (next === back) return
    back = next
    ops?.after(0, refresh)
  }

  // 渡すテキストを Context に追加し、渡した内容をトランスクリプトに出す。
  // 渡すのは、人間が選択してこの操作をしたときだけ。中身は解釈しない。
  const deliver = async (io: Omit<AddIo, 'selection' | 'isFullscreen'>, text: string): Promise<[boolean, string]> => {
    const failed = (why: unknown): [boolean, string] => [
      false,
      `Failed to add selection to Claude Context: ${String(why)}. Run /term-add to retry.`,
    ]
    // シェルの実際の cwd。取れなければ Working directory の行を出さない
    let cwdNow: string | null = null
    try {
      if (conn.kind === 'up') cwdNow = (await api<Info>('/info')).cwd
    } catch {
      // cwd なしで渡す
    }
    try {
      const appended = await io.append(buildPayload(text, cwdNow))
      if (appended.deny !== undefined) return failed(appended.deny)
    } catch (error) {
      return failed(error)
    }
    // $.ui.log は改行を出せないので、1 行にまとめる
    io.log(summarize(text, cwdNow).join(' '))
    const done = `Added ${text.length} characters to Claude Context`
    io.toast(done)
    return [true, `${done}.`]
  }

  // マウスで選択したテキストを Claude に渡す。戻り値は人に見せる結果の 1 行。
  const addToClaude = async (io: AddIo): Promise<string> => {
    let selected: { text: string; requestId?: string } | undefined
    try {
      selected = await io.selection()
    } catch (error) {
      return `Failed to add selection to Claude Context: ${String(error)}. Run /term-add to retry.`
    }
    if (selected === undefined && io.isFullscreen === false) {
      return (
        'Cannot read the selection: Claude Code is not in the fullscreen layout here (the default inside tmux), ' +
        'and selections can only be read there. Try starting Claude Code with CLAUDE_CODE_NO_FLICKER=1, ' +
        'or select with the keyboard (alt+v in the terminal pane).'
      )
    }
    if (selected === undefined || isEmptySelection(selected.text)) {
      return 'Nothing is selected. Drag over text in the terminal pane (or press alt+v there), then run /term-add.'
    }
    if (selected.requestId !== undefined) {
      return 'The selection is in the conversation, not in the terminal pane. Nothing was added.'
    }
    return (await deliver(io, selected.text))[1]
  }

  const runSelect = async (op: SelectOp) => {
    const r = await api<SelectResponse>('/select', { op, back })
    if (!r.ok) {
      // 古い sidecar が動いている(Mod を更新した後など)
      selecting = false
      ops?.toast(`Keyboard selection is unavailable: ${r.error}. Exit the shell and run /term to restart it.`)
      return
    }
    selecting = r.active
    // 選択カーソルが窓の外へ出たら、sidecar が見える位置を返す
    if (r.back !== back) {
      back = r.back
      refresh()
    }
  }

  // 選択モードの範囲を Claude に渡して、モードを出る
  const sendSelection = async (o: Ops) => {
    const { text } = await api<SelectionResponse>('/selection')
    if (text === null) {
      selecting = false
      return
    }
    if (isEmptySelection(text)) {
      o.toast('Nothing is selected. Press v (or V for whole lines), move, then press enter.')
      return
    }
    const [ok, result] = await deliver(o, text)
    if (ok) await runSelect('cancel')
    else o.toast(result)
  }

  const pump = async () => {
    const o = ops
    if (sending || o === undefined) return
    sending = true
    try {
      for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
        if ('input' in job) await api('/input', { d: job.input })
        else if ('select' in job) await runSelect(job.select)
        else if ('send' in job) await sendSelection(o)
        else o.toast(await addToClaude({ ...o, toast: () => undefined, isFullscreen: undefined }))
      }
    } catch (error) {
      jobs = []
      lost(error)
    } finally {
      sending = false
      o.invalidate()
    }
  }

  const enqueue = (job: Job) => {
    if (conn.kind !== 'up') return
    const last = jobs[jobs.length - 1]
    if ('input' in job && last !== undefined && 'input' in last) last.input += job.input
    else jobs.push(job)
    // dispatch の中で始めた呼び出しは、その dispatch と一緒に中断されることがある
    ops?.after(0, () => void pump())
  }

  const sendInput = (d: string) => {
    if (d === '' || conn.kind !== 'up') return
    // 入力したら末尾へ戻る
    if (back !== 0) scrollTo(0)
    enqueue({ input: d })
  }

  // sidecar を起動する(動いていればそれに繋ぐ)。失敗の理由は conn に残す
  const connect = async () => {
    const o = ops
    if (o === undefined) return
    let result: StartResult
    try {
      const ran = await o.run([
        `${o.pluginRoot}/bin/terminal-sidecar`,
        'start',
        '--sock',
        sock,
        '--cwd',
        cwd,
        '--cols',
        String(want.cols),
        '--rows',
        String(want.rows),
        '--watch-pid',
        claudePid,
      ])
      const out = ran.stdout.trim()
      result =
        out === ''
          ? { ok: false, error: ran.stderr.trim() || `sidecar exited with code ${ran.exitCode}` }
          : (JSON.parse(out) as StartResult)
    } catch (error) {
      result = { ok: false, error: String(error) }
    }
    if (!result.ok) {
      conn = { kind: 'failed', error: result.error }
      generation += 1
    } else {
      conn = { kind: 'up' }
      if (!result.already) {
        frame = undefined
        lines = []
        back = 0
      }
      refresh()
    }
    o.invalidate()
  }

  const requestSize = (cols: number, rows: number) => {
    if (ops === undefined || (cols === want.cols && rows === want.rows)) return
    want = { cols, rows }
    // 本体側の変化(プロンプト欄の行数、許可ダイアログ)で高さが揺れるので、落ち着いてから送る。
    // ui.render の dispatch 内で始めた $ 呼び出しは次の再描画で中断されるため、タイマーで外へ出す。
    resizeTimer?.cancel()
    resizeTimer = ops.after(RESIZE_DEBOUNCE_MS, () => {
      if (conn.kind === 'up') void api('/resize', want).catch(lost)
    })
  }

  on('session.start', async ($, e, next) => {
    ops = {
      fetch: (url, init) => $.http.fetch(url, init),
      run: (argv, init) => $.process.run(argv, init),
      invalidate: () => $.ui.invalidate('ui.render'),
      after: (ms, fn) => $.clock.after(ms, fn),
      pluginRoot: $.plugin.root,
      selection: () => $.ui.selection(),
      append: payload => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: payload }] } }),
      toast: line => $.ui.toast(line),
      log: line => $.ui.log(line),
    }
    cwd = e.cwd
    // ソケット名は Claude Code 本体の PID から作る。session id は /clear で変わり、
    // その後 session.start も来ないので使えない。
    const [pid = '', uid = ''] = (await $.process.run(['sh', '-c', 'echo $PPID; id -u'])).stdout.trim().split('\n')
    claudePid = pid
    const runtime = await $.env.get('XDG_RUNTIME_DIR')
    const dir = runtime !== undefined && runtime !== '' ? `${runtime}/cc-term` : `/tmp/cc-term-${uid}`
    sock = `${dir}/${pid}.sock`

    await $.command.register({ name: 'term', description: 'Open the terminal pane', immediate: true })
    await $.command.register({
      name: 'term-add',
      description: 'Add the text selected in the terminal pane to Claude context',
      immediate: true,
    })
    await $.command.register({
      name: 'term-hide',
      description: 'Hide the terminal pane (the shell keeps running)',
      immediate: true,
    })

    // モジュールのリロード後: sidecar が生きていれば繋ぎ直す
    try {
      await api<Info>('/info')
      conn = { kind: 'up' }
      visible = (await $.ui.panes()).some(p => p.id === PANE)
      if (visible) refresh()
    } catch {
      conn = { kind: 'idle' }
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear でも来る。そのときはシェルを残す
    if (e.reason !== 'clear' && sock !== '') {
      generation += 1
      try {
        await $.http.fetch(`${HOST}/kill`, { socketPath: sock, method: 'POST', body: '{}' })
      } catch {
        // sidecar が無ければ何もしない
      }
    }
    return next(e)
  })

  on('command.run', { command: 'term' }, async $ => {
    if (ops === undefined) return { text: 'Terminal is still starting. Try again in a moment.' }
    await connect()
    visible = true
    const opened = await $.ui.open({ id: PANE, title: 'Terminal', focus: true, rows: INLINE_ROWS + CHROME_ROWS })
    if (conn.kind === 'failed') return { text: `Failed to start shell: ${conn.error}` }
    refresh()
    return {
      text: opened.isPlaced
        ? 'Terminal opened. Click [ Terminal input ] at the bottom of the pane to type in it.'
        : 'Terminal is ready but the pane could not be placed.',
    }
  })

  on('command.run', { command: 'term-hide' }, async $ => {
    await $.ui.close({ id: PANE })
    return { text: 'Terminal hidden. The shell keeps running; /term shows it again.' }
  })

  on('command.run', { command: 'term-add' }, async ($, e) => {
    const text = await addToClaude({
      selection: () => $.ui.selection(),
      append: payload => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: payload }] } }),
      toast: line => $.ui.toast(line),
      log: line => $.ui.log(line),
      isFullscreen: e.presentation?.isFullscreen,
    })
    return { text }
  })

  // プロンプト欄にキーが入ったら、Terminal はもうキーを受けていない
  on('prompt.edit', async ($, e, next) => {
    setTyping(false)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      typing = false
      help = false
      visible = false
      generation += 1
    }
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'keys') return next(e)
    const data = e.data as { id?: string; keys?: SeqKey[] }
    // 帯がクリックされたか、キーが届いた
    typing = true
    if (typeof data.id === 'string' && data.id !== keysId) {
      keysId = data.id
      lastKey = 0
    }
    const fresh = (data.keys ?? []).filter(k => k.n > lastKey)
    const newest = fresh[fresh.length - 1]
    if (newest !== undefined) {
      lastKey = newest.n
      const page = Math.max(1, (frame?.rows ?? want.rows) - 1)
      for (const k of fresh) {
        // ヘルプは、どのキーでも閉じる(そのキーは PTY に送らない)
        if (help || isHelpKey(k)) {
          setHelp(!help)
          continue
        }
        // 選択モードの間は、キーを PTY に送らない
        if (selecting) {
          for (const action of selectActions(k)) {
            if (action === 'send') enqueue({ send: true })
            else {
              if (action === 'cancel') selecting = false
              enqueue({ select: action })
            }
          }
          continue
        }
        if (isSelectStart(k)) {
          selecting = true
          enqueue({ select: 'start' })
          continue
        }
        if (isAddKey(k)) {
          enqueue({ add: true })
          continue
        }
        const dir = scrollKey(k)
        if (dir === 'up') scrollTo(back + page)
        else if (dir === 'down') scrollTo(back - page)
        else sendInput(keyToBytes(k, { appCursor: frame?.appCursor === true }))
      }
    }
    return { props: keyProps() }
  })

  // ホイールで履歴をさかのぼる。ペインの中身は常に 1 画面ぶんなので、窓は自分で動かす
  on('ui.scroll', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE || e.origin.kind !== 'person') return next(e)
    scrollTo(back - e.by)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Client } = $.ui.resolve(e)

    const cols = clamp(e.props.bodyColumns, MIN_COLS, MAX_COLS)
    // inline のペインは中身の高さに合わせて縮み、bodyRows は「中身とレイアウトの上限の小さいほう」
    // になる。中身を bodyRows に合わせると縮む一方になるので、中身の高さは minHeight で常に
    // 頼んだ行数に保ち、bodyRows(= 実際に見えている窓)に Terminal を収める。
    // 窓からはみ出した下の余白は見えない(ui.scroll の hook が窓を動かさない)。
    const inline = e.props.placement === 'inline'
    const fullRows = inline ? INLINE_ROWS + CHROME_ROWS : undefined
    const rows = clamp(e.props.scroll.bodyRows - CHROME_ROWS, MIN_ROWS, inline ? INLINE_ROWS : MAX_ROWS)
    requestSize(cols, rows)
    // ペインの枠(ボタン)がキーボードを持っている間、Client はキーを受けていない
    if (e.props.isFocused) typing = false

    const reconnect = (
      <Button
        key="reconnect"
        label={conn.kind === 'failed' ? 'Retry' : 'Reconnect'}
        onPress={async () => {
          await connect()
        }}
      />
    )
    if (conn.kind === 'init' || conn.kind === 'idle') {
      return (
        <Box flexDirection="column" minHeight={fullRows}>
          <Text dimColor>{conn.kind === 'init' ? 'Starting…' : 'No terminal is running. Run /term to start one.'}</Text>
        </Box>
      )
    }
    if (conn.kind === 'failed') {
      return (
        <Box flexDirection="column" minHeight={fullRows}>
          <Text color="error">Failed to start shell.</Text>
          <Text dimColor wrap="wrap">
            {conn.error}
          </Text>
          {reconnect}
        </Box>
      )
    }
    if (conn.kind === 'lost') {
      return (
        <Box flexDirection="column" minHeight={fullRows}>
          <Text color="error">Terminal process disconnected.</Text>
          <Text dimColor wrap="wrap">
            {conn.error}
          </Text>
          {reconnect}
        </Box>
      )
    }

    const f = frame
    // resize が sidecar に届くまでの間も、高さを変えずに描く
    const shown = help ? [] : lines.length > rows ? lines.slice(lines.length - rows) : lines
    const helpLines = help ? HELP_LINES.slice(0, rows) : []
    const blank = Math.max(0, rows - shown.length - helpLines.length)
    const status =
      f === undefined
        ? 'connecting…'
        : !f.alive
          ? `shell exited${f.exitCode === null ? '' : ` (code ${f.exitCode})`} · /term starts a new one`
          : back > 0
            ? `history -${back}/${f.history}`
            : ''
    const sel = f?.select
    const selectStatus =
      sel === undefined
        ? undefined
        : sel.anchored
          ? `${sel.lines} line${sel.lines === 1 ? '' : 's'}, ${sel.chars} chars · enter: add to Claude · q: cancel`
          : 'hjkl/arrows: move · v: start · V: lines · q: cancel'

    // 選択モードの間、キーは Client に行くので、ボタンは出さない
    const controls =
      selectStatus !== undefined
        ? [
            <Text color="yellow" wrap="truncate">
              {' '}
              {selectStatus}
            </Text>,
          ]
        : [
            <Text> </Text>,
            <Button
              key="add"
              label="Add to Claude"
              onPress={async () => {
                const result = await addToClaude({
                  selection: () => $.ui.selection(),
                  append: payload =>
                    $.session.append({ message: { type: 'user', content: [{ type: 'text', text: payload }] } }),
                  // 成功時は addToClaude が toast を出す。それ以外の結果は下でまとめて出す
                  toast: () => undefined,
                  log: line => $.ui.log(line),
                  isFullscreen: e.viewport?.isFullscreen,
                })
                $.ui.toast(result)
              }}
            />,
            <Text> </Text>,
            <Button key="help" label="Help" onPress={async () => setHelp(!help)} />,
            <Text dimColor wrap="truncate">
              {' '}
              {status}
            </Text>,
          ]
    return (
      <Box flexDirection="column" minHeight={fullRows}>
        {helpLines.map((line, i) => (
          <Text bold={i === 0} wrap="truncate">
            {line}
          </Text>
        ))}
        {shown.map(runs => (
          <Text wrap="truncate">
            {runs.length === 0
              ? ' '
              : runs.map(([text, fg, bg, attrs]) =>
                  fg === null && bg === null && attrs === 0 ? (
                    text
                  ) : (
                    <Text
                      color={color(fg)}
                      backgroundColor={color(bg)}
                      bold={(attrs & ATTR_BOLD) !== 0}
                      dimColor={(attrs & ATTR_DIM) !== 0}
                      italic={(attrs & ATTR_ITALIC) !== 0}
                      underline={(attrs & ATTR_UNDERLINE) !== 0}
                      strikethrough={(attrs & ATTR_STRIKE) !== 0}
                      inverse={(attrs & ATTR_INVERSE) !== 0}
                    >
                      {text}
                    </Text>
                  ),
                )}
          </Text>
        ))}
        {Array.from({ length: blank }, () => (
          <Text> </Text>
        ))}
        <Box>
          <Client key="keys" module="./keys.tsx" props={keyProps()} />
          {controls}
        </Box>
      </Box>
    )
  })
}
