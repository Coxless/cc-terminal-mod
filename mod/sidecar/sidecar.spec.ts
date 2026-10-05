// sidecar の結合テスト。実際に daemon とシェルを起動する(`workshop run -- test`)。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ATTR_BOLD,
  ATTR_INVERSE,
  type Frame,
  type Info,
  type SelectOp,
  type SelectResponse,
  type SelectionResponse,
  type StartResult,
} from '../shared/protocol'

const MAIN = join(import.meta.dir, 'main.ts')
const home = mkdtempSync(join(tmpdir(), 'cc-term-test-'))
const sockOf = (name: string) => join(home, 'run', `${name}.sock`)

const launch = (name: string, extra: string[] = []): StartResult => {
  const p = Bun.spawnSync(
    [process.execPath, MAIN, 'start', '--sock', sockOf(name), '--shell', '/bin/bash', '--cwd', home, ...extra],
    // rc ファイルを読ませない(プロンプトを決まった形にする)
    { env: { ...process.env, HOME: home, PS1: undefined }, stdout: 'pipe', stderr: 'pipe' },
  )
  return JSON.parse(p.stdout.toString())
}

const api = async <T>(name: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch('http://sidecar' + path, {
    unix: sockOf(name),
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

const text = (f: Frame) => (f.lines ?? []).map(l => l.map(r => r[0]).join(''))
const send = (name: string, d: string) => api(name, '/input', { d })
const snapshot = (name: string, back = 0) => api<Frame>(name, `/frame?since=0&wait=0&back=${back}`)
const select = async (name: string, ops: SelectOp[], back = 0) => {
  let last: SelectResponse = { ok: false, error: 'no op' }
  for (const op of ops) {
    last = await api<SelectResponse>(name, '/select', { op, back })
    if (!last.ok) throw new Error(last.error)
    back = last.back
  }
  return last as Extract<SelectResponse, { ok: true }>
}
const selection = async (name: string) => (await api<SelectionResponse>(name, '/selection')).text

async function until(name: string, test: string | ((f: Frame, lines: string[]) => boolean), ms = 10000) {
  const t0 = Date.now()
  let since = 0
  let lines: string[] = []
  while (Date.now() - t0 < ms) {
    const f = await api<Frame>(name, `/frame?since=${since}&wait=300`)
    since = f.ver
    if (f.lines === undefined) continue
    lines = text(f)
    if (typeof test === 'string' ? lines.join('\n').includes(test) : test(f, lines)) return f
  }
  throw new Error(`timed out waiting; screen was:\n${lines.join('\n')}`)
}

const gone = async (pid: number, ms = 5000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!existsSync(`/proc/${pid}`)) return true
    await Bun.sleep(50)
  }
  return false
}

describe('sidecar', () => {
  const S = 'main'
  let started: StartResult

  beforeAll(async () => {
    started = launch(S, ['--watch-pid', String(process.pid)])
    if (started.ok) await until(S, '$')
  })
  afterAll(async () => {
    await api(S, '/kill', {}).catch(() => undefined)
    await Bun.sleep(200)
    rmSync(home, { recursive: true, force: true })
  })

  test('起動: daemon は切り離され、ソケットは所有者だけが使える', async () => {
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.already).toBe(false)
    const stat = (await Bun.file(`/proc/${started.pid}/stat`).text()).split(') ')[1]!.split(' ')
    expect(Number(stat[3])).toBe(started.pid) // セッションリーダー
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700)
    expect(statSync(sockOf(S)).mode & 0o777).toBe(0o600)
  })

  test('二重起動: 同じソケットでは新しく起動しない', () => {
    const again = launch(S)
    expect(again).toEqual({ ok: true, already: true, pid: (started as any).pid, shellPid: (started as any).shellPid })
  })

  test('入出力', async () => {
    await send(S, 'echo MARK-$((6*7))\n')
    await until(S, 'MARK-42')
  })

  test('cwd: 引数の cwd で始まり、cd に追従する', async () => {
    expect((await api<Info>(S, '/info')).cwd).toBe(home)
    await send(S, 'cd /tmp; echo moved\n')
    await until(S, (_f, l) => l.includes('moved'))
    expect((await api<Info>(S, '/info')).cwd).toBe('/tmp')
    await send(S, `cd ${home}\n`)
  })

  test('resize: シェルに伝わり、画面内容が残る', async () => {
    await send(S, 'clear; echo KEEP-THIS\n')
    await until(S, (_f, l) => l.includes('KEEP-THIS'))
    await api(S, '/resize', { cols: 100, rows: 30 })
    await send(S, 'stty size\n')
    const f = await until(S, '30 100')
    expect(f.cols).toBe(100)
    expect(f.rows).toBe(30)
    expect(f.lines).toHaveLength(30)
    expect(text(f)).toContain('KEEP-THIS')
    const bad = await api<{ ok: boolean }>(S, '/resize', { cols: 'x' })
    expect(bad.ok).toBe(false)
  })

  test('制御文字: Ctrl+C / Ctrl+D / Ctrl+Z', async () => {
    await send(S, 'clear; sleep 100\n')
    await Bun.sleep(300)
    await send(S, '\x03')
    await send(S, 'echo rc=$?\n')
    await until(S, 'rc=130')
    await send(S, 'cat\n')
    await send(S, 'typed\n')
    await Bun.sleep(300)
    await send(S, '\x04')
    await send(S, 'echo eof=$?\n')
    await until(S, 'eof=0')
    await send(S, 'sleep 100\n')
    await Bun.sleep(300)
    await send(S, '\x1a')
    await until(S, 'Stopped')
    await send(S, 'kill %1; wait; clear\n')
  })

  test('全角、色、カーソル', async () => {
    await send(
      S,
      "clear; printf '日本語 abc\\n\\033[1;31mRED\\033[0m \\033[38;2;1;2;3mRGB\\033[0m \\033[48;5;196mBG\\033[0m\\n'\n",
    )
    const f = await until(S, (_f, l) => l.includes('日本語 abc'))
    const y = text(f).indexOf('日本語 abc')
    expect(f.lines![y]).toEqual([['日本語 abc', null, null, 0]])
    expect(f.lines![y + 1]).toEqual([
      ['RED', 1, null, ATTR_BOLD],
      [' ', null, null, 0],
      ['RGB', '#010203', null, 0],
      [' ', null, null, 0],
      ['BG', null, '#ff0000', 0],
    ])
    // カーソルはプロンプトの後ろにあり、そのセルが反転している
    expect(f.cursorVisible).toBe(true)
    expect(f.cy).toBe(y + 2)
    const cursorLine = f.lines![f.cy]!
    expect(cursorLine[cursorLine.length - 1]).toEqual([' ', null, null, ATTR_INVERSE])
    expect(cursorLine.map(r => r[0]).join('').length).toBe(f.cx + 1)
  })

  test('alternate screen: vi を終了すると元の画面に戻る', async () => {
    await send(S, 'clear; echo BEFORE-VI\n')
    await until(S, (_f, l) => l.includes('BEFORE-VI'))
    await send(S, 'vi\n')
    const inVi = await until(S, f => f.alt)
    expect(text(inVi)).not.toContain('BEFORE-VI')
    await send(S, ':q!\n')
    const back = await until(S, f => !f.alt)
    expect(text(back)).toContain('BEFORE-VI')
  })

  test('大量出力(2 MB 超)と履歴', async () => {
    await send(S, 'clear; seq 1 300000; echo DONE-$((1+1))\n')
    const f = await until(S, (_f, l) => l.includes('DONE-2'), 60000)
    expect(text(f)).toContain('300000')
    expect(f.history).toBeGreaterThan(1000)
    // 履歴をさかのぼる
    const up = await snapshot(S, 1000)
    expect(up.back).toBe(1000)
    const first = Number(text(up)[0])
    expect(text(up)[1]).toBe(String(first + 1))
    expect(first).toBeLessThan(300000 - 900)
    // 範囲外は上限に丸める
    const top = await snapshot(S, 10 ** 9)
    expect(top.back).toBe(top.history)
  }, 70000)

  test('選択モード: キーボードの操作だけで範囲を選び、テキストを取れる', async () => {
    await send(S, "clear; printf 'alpha beta-gamma\\n日本語 テスト\\n'\n")
    const f0 = await until(S, (_f, l) => l.includes('日本語 テスト'))
    const row = text(f0).indexOf('alpha beta-gamma')
    expect(await selection(S)).toBeNull()

    // Terminal のカーソルの位置から始まる。始点を置くまでは何も選んでいない
    const started = await select(S, ['start'])
    expect(started.active).toBe(true)
    expect(started.select).toEqual({ anchored: false, lines: 0, chars: 0 })
    expect(await selection(S)).toBe('')
    const f1 = await snapshot(S)
    expect(f1.select).toEqual({ anchored: false, lines: 0, chars: 0 })
    expect(f1.lines![f0.cy]!.some(r => r[2] === 3)).toBe(true) // 選択カーソル

    // 全角は 1 文字ずつ動き、終点の文字を含む
    await select(S, ['up', 'home', 'anchor', 'right', 'right'])
    expect(await selection(S)).toBe('日本語')
    await select(S, ['end'])
    expect(await selection(S)).toBe('日本語 テスト')

    // 行単位。行末の空白は入らない
    const lines = await select(S, ['line', 'up'])
    expect(await selection(S)).toBe('alpha beta-gamma\n日本語 テスト')
    expect(lines.select).toEqual({ anchored: true, lines: 2, chars: 'alpha beta-gamma\n日本語 テスト'.length })
    const f2 = await snapshot(S)
    expect(f2.lines![row]!.some(r => (r[3] & ATTR_INVERSE) !== 0)).toBe(true)
    expect(f2.lines![row + 1]!.every(r => (r[3] & ATTR_INVERSE) !== 0)).toBe(true)

    // 単語単位の移動
    await select(S, ['start', 'up', 'up', 'home', 'anchor', 'word'])
    expect(await selection(S)).toBe('alpha b')
    await select(S, ['word'])
    expect(await selection(S)).toBe('alpha beta-')
    await select(S, ['wordBack', 'wordBack'])
    expect(await selection(S)).toBe('a')
    await select(S, ['word', 'word', 'word', 'word'])
    expect(await selection(S)).toBe('alpha beta-gamma\n日')

    // 取り消すと、ハイライトも消える
    expect((await select(S, ['cancel'])).active).toBe(false)
    expect(await selection(S)).toBeNull()
    const f3 = await snapshot(S)
    expect(f3.select).toBeUndefined()
    expect(f3.lines).toEqual(f0.lines)
    expect(((await api(S, '/select', { op: 'nope' })) as any).ok).toBe(false)
  })

  test('選択モード: 折り返された行はつなぎ、出力が増えても位置がずれない', async () => {
    const { cols, rows } = await snapshot(S)
    const long = 'x'.repeat(cols + 20)
    await send(S, `clear; echo ${long}; echo AFTER\n`)
    await until(S, (_f, l) => l.includes('AFTER'))
    await select(S, ['start', 'up', 'up', 'up', 'line', 'down'])
    expect(await selection(S)).toBe(long)

    // 行末まで書かれた空白は落とす
    await select(S, ['cancel'])
    await send(S, "clear; printf 'pad   \\nnext  \\n'\n")
    await until(S, (_f, l) => l.includes('next'))
    await select(S, ['start', 'up', 'up', 'line', 'down'])
    expect(await selection(S)).toBe('pad\nnext')
    await select(S, ['cancel'])
    await send(S, `clear; echo ${long}; echo AFTER\n`)
    await until(S, (_f, l) => l.includes('AFTER') && l[0]!.startsWith('x'))
    await select(S, ['start', 'up', 'up', 'up', 'line', 'down'])

    // 選択したまま出力を流す。選んだ行は履歴に入るが、取れるテキストは変わらない
    await send(S, 'seq 1 200; echo FLOOD-$((1+1))\n')
    const f = await until(S, (_f, l) => l.includes('FLOOD-2'))
    expect(f.select).toEqual({ anchored: true, lines: 1, chars: long.length })
    expect(await selection(S)).toBe(long)

    // 窓の外の選択カーソルを動かすと、見える位置まで窓が動く
    const moved = await select(S, ['up'])
    expect(moved.back).toBeGreaterThan(0)
    const view = await snapshot(S, moved.back)
    expect(text(view)[0]).toStartWith('x')
    // 末尾へ飛ぶと窓も戻る
    expect((await select(S, ['bottom'], moved.back)).back).toBe(0)
    expect((await select(S, ['pageUp'], 0)).back).toBe(0)
    expect((await select(S, ['pageUp'], 0)).back).toBe(rows - 1)
    await select(S, ['cancel'])
  })

  test('選択モード: vi の画面でも選べ、画面が切り替わると終わる', async () => {
    await send(S, `clear; printf 'one\\ntwo\\nthree\\n' > ${home}/sel.txt; vi ${home}/sel.txt\n`)
    await until(S, (f, l) => f.alt && l.includes('three'))
    await select(S, ['start', 'top', 'down', 'line', 'down'])
    expect(await selection(S)).toBe('two\nthree')
    await send(S, ':q!\n')
    const back = await until(S, f => !f.alt)
    expect(back.select).toBeUndefined()
    expect(await selection(S)).toBeNull()
  })

  test('変化が無ければ lines を省く', async () => {
    const f = await snapshot(S)
    const t0 = Date.now()
    const same = await api<Frame>(S, `/frame?since=${f.ver}&wait=200`)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    expect(same.lines).toBeUndefined()
    expect(same.ver).toBe(f.ver)
  })

  test('long-poll は 10 秒(Bun.serve の既定の idleTimeout)を超えて待てる', async () => {
    const f = await snapshot(S)
    const t0 = Date.now()
    const same = await api<Frame>(S, `/frame?since=${f.ver}&wait=12000`)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(11900)
    expect(same.ver).toBe(f.ver)
  }, 20000)

  test('不正なリクエストで落ちない', async () => {
    const res = await fetch('http://sidecar/input', { unix: sockOf(S), method: 'POST', body: '{broken' })
    expect(res.status).toBe(500)
    expect(((await api(S, '/nope')) as any).ok).toBe(false)
    expect((await api<Info>(S, '/info')).alive).toBe(true)
  })

  test('シェルの終了: 終了コードを返し、次の start で作り直す', async () => {
    await send(S, 'exit 7\n')
    const f = await until(S, f => !f.alive)
    expect(f.exitCode).toBe(7)
    expect(((await send(S, 'x')) as any).ok).toBe(false)
    const next = launch(S, ['--watch-pid', String(process.pid)])
    expect(next.ok).toBe(true)
    if (!next.ok || !started.ok) return
    expect(next.already).toBe(false)
    expect(next.pid).not.toBe(started.pid)
    expect((await api<Info>(S, '/info')).alive).toBe(true)
  })

  test('/kill: シェルもソケットも残らない', async () => {
    const info = await api<Info>(S, '/info')
    await send(S, 'sleep 1000\n')
    await api(S, '/kill', {})
    expect(await gone(info.pid)).toBe(true)
    expect(await gone(info.shellPid)).toBe(true)
    expect(existsSync(sockOf(S))).toBe(false)
  })
})

test('監視: 監視対象の PID が消えたらシェルごと終了する', async () => {
  const parent = Bun.spawn(['sleep', '1000'])
  const started = launch('watch', ['--watch-pid', String(parent.pid)])
  expect(started.ok).toBe(true)
  if (!started.ok) return
  parent.kill('SIGKILL')
  await parent.exited
  expect(await gone(started.pid)).toBe(true)
  expect(await gone(started.shellPid)).toBe(true)
  expect(existsSync(sockOf('watch'))).toBe(false)
})

test('起動失敗: シェルが無ければエラーを返す', () => {
  const p = Bun.spawnSync([process.execPath, MAIN, 'start', '--sock', sockOf('bad'), '--shell', '/nonexistent/shell'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const result = JSON.parse(p.stdout.toString()) as StartResult
  expect(result.ok).toBe(false)
  expect(p.exitCode).toBe(1)
})
