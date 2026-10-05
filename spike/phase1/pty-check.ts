// Phase 1 Step 1: Bun の PTY + @xterm/headless + Unix ソケット HTTP + daemon 化の技術確認。
// 本実装ではない。docs/architecture.md §1 の /term-selftest と同じ項目を、Bun で通す。
//
//   bun spike/phase1/pty-check.ts            確認を実行(daemon を起動 → 検査 → kill)
//   bun build --compile spike/phase1/pty-check.ts --outfile <bin> && <bin>   バイナリで同じ確認
//
// 内部モード: `start <sock>`(daemon を起動してすぐ返る)、`daemon <sock>`(常駐)
import { Terminal } from '@xterm/headless'
import { chmodSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const HOST = 'http://sidecar'

// コンパイル済みバイナリでは execPath が自分自身。`bun file.ts` では bun + スクリプト。
const selfArgv = (): string[] =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main]

async function daemon(sock: string) {
  let cols = 80
  let rows = 24
  let ver = 1
  let alive = true
  let exitCode: number | null = null
  let bytes = 0
  let waiters: (() => void)[] = []
  const bump = () => {
    ver += 1
    const w = waiters
    waiters = []
    for (const f of w) f()
  }

  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  const proc = Bun.spawn([process.env.SHELL || '/bin/sh'], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
    terminal: {
      cols,
      rows,
      data(_t, data) {
        bytes += data.length
        term.write(data, bump)
      },
    },
    onExit(_p, code) {
      alive = false
      exitCode = code
      bump()
    },
  })
  const pty = proc.terminal!
  // 端末への問い合わせ(DA、カーソル位置)への応答を PTY に返す
  term.onData(d => pty.write(d))

  const screen = () => {
    const b = term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < rows; y++) lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '')
    return lines
  }
  const cell = (x: number, y: number) => {
    const b = term.buffer.active
    const c = b.getLine(b.baseY + y)?.getCell(x)
    if (!c) return null
    return {
      chars: c.getChars(),
      width: c.getWidth(),
      fg: c.getFgColor(),
      fgMode: c.isFgRGB() ? 'rgb' : c.isFgPalette() ? 'palette' : 'default',
      bold: c.isBold() !== 0,
    }
  }

  mkdirSync(dirname(sock), { recursive: true, mode: 0o700 })
  if (existsSync(sock)) unlinkSync(sock)
  const server = Bun.serve({
    unix: sock,
    idleTimeout: 60,
    async fetch(req) {
      const u = new URL(req.url)
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
      if (u.pathname === '/frame') {
        const since = Number(u.searchParams.get('since') ?? 0)
        const wait = Math.min(Number(u.searchParams.get('wait') ?? 0), 25000)
        if (ver <= since && alive && wait > 0) {
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, wait)
            waiters.push(() => (clearTimeout(t), resolve()))
          })
        }
        const b = term.buffer.active
        return Response.json({
          ver, cols, rows, alive, exitCode, bytes,
          cx: b.cursorX, cy: b.cursorY, alt: b.type === 'alternate', lines: screen(),
        })
      }
      if (u.pathname === '/cell') return Response.json(cell(Number(u.searchParams.get('x')), Number(u.searchParams.get('y'))))
      if (u.pathname === '/info') return Response.json({ pid: process.pid, shellPid: proc.pid, ppid: process.ppid, alive, cols, rows, ver, bytes })
      if (u.pathname === '/input') {
        pty.write(body.d)
        return Response.json({ ok: true })
      }
      if (u.pathname === '/resize') {
        cols = body.cols
        rows = body.rows
        pty.resize(cols, rows)
        term.resize(cols, rows)
        bump()
        return Response.json({ ok: true })
      }
      if (u.pathname === '/kill') {
        setTimeout(() => {
          try { process.kill(-proc.pid, 'SIGHUP') } catch {}
          try { proc.kill('SIGHUP') } catch {}
          server.stop(true)
          try { unlinkSync(sock) } catch {}
          process.exit(0)
        }, 100)
        return Response.json({ ok: true })
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
  chmodSync(sock, 0o600)
}

const api = async (sock: string, path: string, body?: unknown) => {
  const res = await fetch(HOST + path, {
    unix: sock,
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  } as RequestInit)
  return res.json() as Promise<any>
}

// daemon を起動し、ソケットが応答したら 1 行の JSON を出して返る。
async function start(sock: string) {
  mkdirSync(dirname(sock), { recursive: true, mode: 0o700 })
  const log = openSync(sock + '.log', 'a', 0o600)
  const child = Bun.spawn([...selfArgv(), 'daemon', sock], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  const t0 = Date.now()
  while (Date.now() - t0 < 5000) {
    try {
      const info = await api(sock, '/info')
      console.log(JSON.stringify({ ok: true, ...info }))
      return
    } catch {
      await Bun.sleep(20)
    }
  }
  console.log(JSON.stringify({ ok: false, error: 'daemon did not respond' }))
  process.exitCode = 1
}

async function check() {
  const sock = `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/cc-term-check/${process.pid}.sock`
  const result: Record<string, unknown> = {}
  const t0 = Date.now()
  // 起動コマンドがすぐ返ること(stdout を pipe で読み切る = $.process.run と同じ待ち方)
  const launcher = Bun.spawnSync([...selfArgv(), 'start', sock], { stdout: 'pipe', stderr: 'pipe' })
  result.startMs = Date.now() - t0
  result.start = launcher.stdout.toString().trim() + launcher.stderr.toString().trim()
  const started = JSON.parse(launcher.stdout.toString())
  // daemon はランチャーの子ではなくなっている(セッションリーダー)
  const stat = (await Bun.file(`/proc/${started.pid}/stat`).text()).split(') ')[1].split(' ')
  result.detached = { ppid: Number(stat[1]), sid: Number(stat[3]), isSessionLeader: Number(stat[3]) === started.pid }

  const send = (d: string) => api(sock, '/input', { d })
  const until = async (test: string | ((f: any) => boolean), ms = 5000) => {
    const t = Date.now()
    let since = 0
    let f: any
    while (Date.now() - t < ms) {
      f = await api(sock, `/frame?since=${since}&wait=500`)
      since = f.ver
      const hit = typeof test === 'string' ? f.lines.join('\n').includes(test) : test(f)
      if (hit) return { ok: true, ms: Date.now() - t }
    }
    return { ok: false, ms: Date.now() - t, tail: f?.lines.filter((l: string) => l !== '').slice(-4) }
  }

  await until(f => f.lines.join('').trim() !== '', 3000)
  await send('echo MARK-$((6*7))\n')
  result.stdin = await until('MARK-42')
  await api(sock, '/resize', { cols: 100, rows: 30 })
  await send('stty size\n')
  result.resize = await until('30 100')
  await send('sleep 100\n')
  await Bun.sleep(300)
  await send('\x03')
  await send('echo rc=$?\n')
  result.ctrlC = await until('rc=130')
  await send('cat\n')
  await send('typed\n')
  await Bun.sleep(300)
  await send('\x04')
  await send('echo eof=$?\n')
  result.ctrlD = await until('eof=0')
  await send('sleep 100\n')
  await Bun.sleep(300)
  await send('\x1a')
  result.ctrlZ = await until('Stopped')
  await send('kill %1; clear\n')

  // 全角、色、カーソル
  await send("clear; printf '日本語 abc\\n\\033[1;31mRED\\033[0m \\033[38;2;1;2;3mRGB\\033[0m\\n'\n")
  result.wideText = await until(f => f.lines.includes('日本語 abc'))
  const f1 = await api(sock, '/frame?since=0&wait=0')
  const y = f1.lines.indexOf('日本語 abc')
  result.wideCells = [await api(sock, `/cell?x=0&y=${y}`), await api(sock, `/cell?x=1&y=${y}`), await api(sock, `/cell?x=7&y=${y}`)]
  result.colorCells = [await api(sock, `/cell?x=0&y=${y + 1}`), await api(sock, `/cell?x=4&y=${y + 1}`)]
  result.cursor = { cx: f1.cx, cy: f1.cy }

  // alternate screen: vi を開いて閉じると、元の画面に戻る(pyte でできなかったこと)
  await send('clear; echo BEFORE-VI\n')
  await until('BEFORE-VI')
  await send('vi\n')
  result.viAlt = await until(f => f.alt === true)
  await send(':q!\n')
  result.viBack = await until(f => f.alt === false && f.lines.join('\n').includes('BEFORE-VI'))

  // resize 後の内容
  await send("clear; echo KEEP-THIS-LINE\n")
  await until('KEEP-THIS-LINE')
  await api(sock, '/resize', { cols: 60, rows: 20 })
  const f2 = await api(sock, '/frame?since=0&wait=0')
  result.resizeKeeps = { ok: f2.lines.join('\n').includes('KEEP-THIS-LINE'), cols: f2.cols, rows: f2.rows, lines: f2.lines.length }

  const tFlood = Date.now()
  await send('seq 1 200000; echo DONE-$((1+1))\n')
  result.flood = await until(f => f.lines.includes('DONE-2'), 60000)
  result.info = await api(sock, '/info')
  result.floodMs = Date.now() - tFlood

  await api(sock, '/kill', {})
  await Bun.sleep(600)
  try {
    await api(sock, '/info')
    result.killed = false
  } catch (error) {
    result.killed = true
    result.afterKill = String(error).slice(0, 120)
  }
  result.shellGone = !existsSync(`/proc/${started.shellPid}`)
  console.log(JSON.stringify(result, null, 1))
}

const [mode, sock] = process.argv.slice(2)
if (mode === 'daemon') await daemon(sock)
else if (mode === 'start') await start(sock)
else await check()
