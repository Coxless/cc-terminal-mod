// sidecar の結合テスト。実際に daemon とシェルを起動する(`workshop run -- test`)。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTR_BOLD, ATTR_INVERSE, type Frame, type Info, type StartResult } from '../shared/protocol'

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
