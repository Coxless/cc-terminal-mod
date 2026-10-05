// Terminal Mod の sidecar。PTY とシェルを持ち、Unix ソケット上の HTTP で操作を受ける。
//
//   terminal-sidecar start --sock <path> [--cwd <dir>] [--cols N] [--rows N]
//                          [--watch-pid PID] [--shell <path>] [--scrollback N]
//
// `start` は daemon を親から切り離して起動し、ソケットが応答したら 1 行の JSON(StartResult)を
// 出してすぐ終了する。同じソケットですでに動いていれば、起動せずに `already: true` を返す。
// `daemon` は `start` が内部で使う常駐モード。
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Info, StartResult } from '../shared/protocol'
import { serve } from './server'
import { DEFAULT_SCROLLBACK, Session } from './session'

const HOST = 'http://sidecar'
const START_TIMEOUT_MS = 5000

type Args = {
  mode: string
  sock: string
  cwd: string
  cols: number
  rows: number
  watchPid: number
  shell: string
  scrollback: number
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>()
  for (let i = 1; i < argv.length; i += 2) {
    const name = argv[i]
    const value = argv[i + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined) throw new Error(`bad argument: ${name}`)
    flags.set(name.slice(2), value)
  }
  const int = (name: string, fallback: number) => {
    const n = Number(flags.get(name))
    return flags.has(name) && Number.isInteger(n) ? n : fallback
  }
  const sock = flags.get('sock')
  if (sock === undefined || !sock.startsWith('/')) throw new Error('--sock <absolute path> is required')
  return {
    mode: argv[0] ?? '',
    sock,
    cwd: flags.get('cwd') ?? process.cwd(),
    cols: int('cols', 80),
    rows: int('rows', 24),
    // 既定は起動したプロセス(= Claude Code)。消えたらシェルごと終了する。0 で監視しない
    watchPid: int('watch-pid', process.ppid),
    shell: flags.get('shell') || process.env.SHELL || '/bin/sh',
    scrollback: int('scrollback', DEFAULT_SCROLLBACK),
  }
}

// コンパイル済みバイナリでは execPath が自分自身。`bun main.ts` では bun + スクリプト
const selfArgv = (): string[] => (Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main])

async function request<T>(sock: string, path: string, method = 'GET'): Promise<T> {
  const res = await fetch(HOST + path, { unix: sock, method, signal: AbortSignal.timeout(1000) })
  return (await res.json()) as T
}

const probe = (sock: string): Promise<Info | undefined> => request<Info>(sock, '/info').catch(() => undefined)

// ソケットを置くディレクトリは 0700 で、自分のものでなければ使わない
function prepareDir(sock: string) {
  const dir = dirname(sock)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = statSync(dir)
  if (st.uid !== process.getuid?.()) throw new Error(`${dir} is owned by another user`)
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

const alivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function start(args: Args): Promise<StartResult> {
  prepareDir(args.sock)
  if (existsSync(args.sock)) {
    const running = await probe(args.sock)
    if (running?.alive === true) {
      return { ok: true, already: true, pid: running.pid, shellPid: running.shellPid }
    }
    if (running !== undefined) {
      // シェルが終了した sidecar が残っている。止めて作り直す
      await request(args.sock, '/kill', 'POST').catch(() => undefined)
      for (let i = 0; i < 100 && alivePid(running.pid); i++) await Bun.sleep(20)
    }
    try {
      unlinkSync(args.sock)
    } catch {}
  }

  const log = openSync(args.sock + '.log', 'a', 0o600)
  const child = Bun.spawn(
    [
      ...selfArgv(),
      'daemon',
      '--sock',
      args.sock,
      '--cwd',
      args.cwd,
      '--cols',
      String(args.cols),
      '--rows',
      String(args.rows),
      '--watch-pid',
      String(args.watchPid),
      '--shell',
      args.shell,
      '--scrollback',
      String(args.scrollback),
    ],
    // detached: 新しいセッションにして、起動元(と、その stdout の pipe)から切り離す
    { detached: true, stdio: ['ignore', log, log], cwd: '/' },
  )
  child.unref()
  closeSync(log)

  const t0 = Date.now()
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    const running = await probe(args.sock)
    if (running !== undefined) {
      return { ok: true, already: running.pid !== child.pid, pid: running.pid, shellPid: running.shellPid }
    }
    if (child.exitCode !== null) {
      return { ok: false, error: `sidecar exited with code ${child.exitCode} (see ${args.sock}.log)` }
    }
    await Bun.sleep(15)
  }
  return { ok: false, error: `sidecar did not respond (see ${args.sock}.log)` }
}

async function daemon(args: Args) {
  const note = (message: string) => console.error(`${new Date().toISOString()} [${process.pid}] ${message}`)
  if ((await probe(args.sock)) !== undefined) {
    note('another sidecar is already serving this socket')
    return
  }
  try {
    unlinkSync(args.sock)
  } catch {}

  let session: Session
  try {
    session = new Session({
      shell: args.shell,
      cwd: args.cwd,
      cols: args.cols,
      rows: args.rows,
      scrollback: args.scrollback,
      env: shellEnv(),
    })
  } catch (error) {
    note(`failed to start shell ${args.shell}: ${String(error)}`)
    process.exit(1)
  }

  let stopping = false
  const shutdown = (why: string) => {
    if (stopping) return
    stopping = true
    note(`shutdown: ${why}`)
    session.kill()
    // 正常に終わるときは、ソケットもログも残さない
    for (const path of [args.sock, args.sock + '.log']) {
      try {
        unlinkSync(path)
      } catch {}
    }
    // シェルが SIGHUP を処理する時間を置く
    setTimeout(() => process.exit(0), 100)
  }

  try {
    serve(session, { sock: args.sock, watchPid: args.watchPid, onKill: () => shutdown('kill request') })
  } catch (error) {
    note(`failed to listen on ${args.sock}: ${String(error)}`)
    session.kill()
    process.exit(1)
  }
  note(`listening on ${args.sock}, shell ${args.shell} pid ${session.shellPid}, watching ${args.watchPid}`)

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => shutdown(sig))
  process.on('uncaughtException', error => note(`uncaught: ${String(error)}`))
  process.on('unhandledRejection', error => note(`unhandled: ${String(error)}`))

  if (args.watchPid > 0) {
    setInterval(() => {
      if (!alivePid(args.watchPid)) shutdown(`watched pid ${args.watchPid} is gone`)
    }, 1000)
  }
}

// シェルは人間が使う。Claude Code が子プロセスに付ける目印は引き継がない
function shellEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

let args: Args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) } satisfies StartResult))
  process.exit(2)
}

if (args.mode === 'daemon') {
  await daemon(args)
} else if (args.mode === 'start') {
  let result: StartResult
  try {
    result = await start(args)
  } catch (error) {
    result = { ok: false, error: String(error) }
  }
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
} else {
  console.log(JSON.stringify({ ok: false, error: `unknown mode: ${args.mode}` } satisfies StartResult))
  process.exit(2)
}
