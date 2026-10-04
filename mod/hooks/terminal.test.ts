// hooks モジュールの振る舞いのテスト(`claude plugin test ./mod`)。
// sidecar は on('http.fetch') と on('process.run') で置き換える。描画の見た目は検証しない。
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import type { Frame, Info } from '../shared/protocol'

const SOCK = '/run/user/1000/cc-term/4242.sock'
const PANE_PROPS = {
  title: 'Terminal',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

type World = {
  runs: string[][]
  requests: { path: string; method: string; body: string; socketPath?: string }[]
  appended: string[]
  toasts: string[]
  opened: string[]
  selection: { text: string; requestId?: string } | undefined
  startResult: string
  shellCwd: string | null
  // long-poll で待っているリクエストを、シェル終了のフレームで返す
  release: () => void
  clock: MockClock
}

const frame = (over: Partial<Frame> = {}): Frame => ({
  ver: 5,
  cols: 80,
  rows: 10,
  alive: true,
  exitCode: null,
  cx: 2,
  cy: 1,
  cursorVisible: true,
  alt: false,
  appCursor: false,
  bracketedPaste: false,
  history: 0,
  back: 0,
  lines: [
    [['hello 日本語', null, null, 0]],
    [
      ['$ ', null, null, 0],
      [' ', null, null, 32],
    ],
  ],
  ...over,
})

function world(on: On): World {
  const waiting: ((f: Frame) => void)[] = []
  const w: World = {
    runs: [],
    requests: [],
    appended: [],
    toasts: [],
    opened: [],
    selection: undefined,
    startResult: JSON.stringify({ ok: true, already: false, pid: 100, shellPid: 101 }),
    shellCwd: '/tmp',
    release: () => {
      for (const f of waiting.splice(0)) f(frame({ ver: 6, alive: false, exitCode: 0 }))
    },
    clock: mock.clock(on),
  }
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // $ の呼び出しに答える hook は { value } を返す
  const json = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })
  on('env.get', (_$, e) => ({ value: e.name === 'XDG_RUNTIME_DIR' ? '/run/user/1000' : undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    const out = e.argv[0] === 'sh' ? '4242\n1000\n' : w.startResult + '\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async (_$, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    w.requests.push({ path: url.pathname, method, body: e.init?.body ?? '', socketPath: e.init?.socketPath })
    // sidecar が起動するまでは、ソケットに繋がらない
    if (!w.runs.some(argv => argv.includes('start'))) throw new Error('ECONNREFUSED')
    if (url.pathname === '/info') return json({ alive: true, cwd: w.shellCwd } as Partial<Info>)
    if (url.pathname === '/frame') {
      if (Number(url.searchParams.get('since')) < 5) return json(frame())
      return json(await new Promise<Frame>(resolve => waiting.push(resolve)))
    }
    return json({ ok: true })
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.selection', () => ({ value: w.selection }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  // このビルド(2.1.289)のテストキットでは、プラグインの $.session.append はテストの hook に
  // 届かず「no implementation」で失敗する。届いた場合に備えて記録だけしておく。
  // 追加の成功と中身は、shared/payload.spec.ts と実機(docs/architecture.md)で確認している。
  on('session.append', (_$, e) => {
    const block = e.message.content[0]
    w.appended.push(block?.type === 'text' ? String(block.text) : '')
    return { deny: 'refused by the test' }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const command = async ($: Engine, name: string) =>
  (
    await $.command.run({
      command: name,
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 180 },
    })
  ).text ?? ''
const inputs = (w: World) => w.requests.filter(r => r.path === '/input').map(r => JSON.parse(r.body).d as string)

test('/term は Claude Code の PID から作ったソケットで sidecar を起動し、ペインを開く', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await command($, 'term')).toBe('Terminal opened.')
  const argv = w.runs.find(a => a.includes('start')) ?? []
  expect(argv[0]).toMatch(/\/bin\/terminal-sidecar$/)
  expect(argv.slice(argv.indexOf('--sock'), argv.indexOf('--sock') + 2)).toEqual(['--sock', SOCK])
  expect(argv.slice(argv.indexOf('--cwd'), argv.indexOf('--cwd') + 2)).toEqual(['--cwd', '/work'])
  expect(argv.slice(argv.indexOf('--watch-pid'), argv.indexOf('--watch-pid') + 2)).toEqual(['--watch-pid', '4242'])
  expect(w.opened).toEqual(['terminal'])
  expect(w.requests.every(r => r.socketPath === SOCK)).toBe(true)
  w.release()
})

test('シェルを起動できないときは、理由を返す', async ($, on) => {
  const w = world(on)
  w.startResult = JSON.stringify({ ok: false, error: 'no such shell' })
  await start($)
  expect(await command($, 'term')).toBe('Failed to start shell: no such shell')
  const ui = await $.ui.mount({
    plugin: 'terminal',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'terminal',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: /Failed to start shell/ })).toBeDefined()
  expect(await ui.find({ key: 'reconnect' })).toBeDefined()
  await ui.unmount()
})

test('画面を Text 行で描き、キーを順に PTY へ送る', async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'term')
  const ui = await $.ui.mount({
    plugin: 'terminal',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'terminal',
    props: PANE_PROPS,
  })
  await w.clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /hello 日本語/ })).toBeDefined()
  await ui.key({ key: 'l', in: 'keys' })
  await ui.key({ key: 's', in: 'keys' })
  await ui.key({ key: 'return', in: 'keys' })
  // 代替キー: alt+c = Ctrl+C、ctrl+] = Escape
  await ui.key({ key: 'c', meta: true, in: 'keys' })
  await ui.key({ key: ']', ctrl: true, in: 'keys' })
  await w.clock.advance(400)
  expect(inputs(w).join('')).toBe('ls\r\x03\x1b')
  await ui.unmount()
  w.release()
})

test('/term-add: 追加に失敗したら、理由と再実行の方法を伝え、成功の表示は出さない', async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'term')
  w.selection = { text: 'Expected: 200\nReceived: 500' }
  expect(await command($, 'term-add')).toMatch(
    /^Failed to add selection to Claude Context: .+\. Run \/term-add to retry\.$/,
  )
  expect(w.toasts).toEqual([])
  // 追加の前に、シェルの実際の cwd を sidecar に問い合わせている
  expect(w.requests.some(r => r.path === '/info' && r.method === 'GET')).toBe(true)
  w.release()
})

test('/term-add: 選択が無い、または Terminal の外なら何も渡さない', async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'term')
  w.selection = { text: '  ' }
  expect(await command($, 'term-add')).toMatch(/^Nothing is selected/)
  w.selection = { text: 'from the transcript', requestId: 'msg-1' }
  expect(await command($, 'term-add')).toMatch(/not in the terminal pane/)
  w.selection = undefined
  expect(await command($, 'term-add')).toMatch(/^Nothing is selected/)
  expect(w.appended).toEqual([])
  w.release()
})

test('画面の内容は、追加の操作をしない限り Claude に渡らない', async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'term')
  const ui = await $.ui.mount({
    plugin: 'terminal',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'terminal',
    props: PANE_PROPS,
  })
  await ui.key({ key: 'x', in: 'keys' })
  await w.clock.advance(100)
  await command($, 'term-hide')
  expect(w.appended).toEqual([])
  await ui.unmount()
  w.release()
})

test('session.end: /clear ではシェルを残し、終了では止める', async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'term')
  const kills = () => w.requests.filter(r => r.path === '/kill').length
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(kills()).toBe(0)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(kills()).toBe(1)
  w.release()
})
