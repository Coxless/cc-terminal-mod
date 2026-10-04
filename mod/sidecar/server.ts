// Unix ソケット上の HTTP。hooks モジュールは $.http.fetch(url, { socketPath }) で呼ぶ。
import { chmodSync } from 'node:fs'
import {
  MAX_WAIT_MS,
  PROTOCOL_VERSION,
  SELECT_OPS,
  type Info,
  type InputRequest,
  type OkResponse,
  type ResizeRequest,
  type SelectOp,
  type SelectRequest,
  type SelectResponse,
  type SelectionResponse,
} from '../shared/protocol'
import type { Session } from './session'

export type ServerOptions = {
  sock: string
  watchPid: number
  // POST /kill を受けたときに呼ぶ。応答を返した後に実行される
  onKill: () => void
}

const num = (v: string | null, fallback: number) => {
  const n = Number(v)
  return v !== null && Number.isFinite(n) ? n : fallback
}

export function info(session: Session, watchPid: number): Info {
  return {
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    shellPid: session.shellPid,
    watchPid,
    alive: session.alive,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
    ver: session.ver,
    cwd: session.cwd(),
    shell: session.shell,
  }
}

export function serve(session: Session, opts: ServerOptions) {
  const ok = (): Response => Response.json({ ok: true } satisfies OkResponse)
  const fail = (error: string, status = 400): Response =>
    Response.json({ ok: false, error } satisfies OkResponse, { status })

  // ソケットは作成時から所有者だけが使えるようにする
  const old = process.umask(0o177)
  try {
    const options = {
      unix: opts.sock,
      // long-poll(最大 MAX_WAIT_MS)より長くする
      idleTimeout: 60,
      async fetch(req: Request): Promise<Response> {
        try {
          const u = new URL(req.url)
          if (req.method === 'GET') {
            if (u.pathname === '/frame') {
              const since = num(u.searchParams.get('since'), 0)
              const wait = Math.max(0, Math.min(num(u.searchParams.get('wait'), 0), MAX_WAIT_MS))
              const back = num(u.searchParams.get('back'), 0)
              return Response.json(await session.frame(since, wait, back))
            }
            if (u.pathname === '/selection') {
              return Response.json({ text: session.selectionText() } satisfies SelectionResponse)
            }
            if (u.pathname === '/info') return Response.json(info(session, opts.watchPid))
            return fail('not found', 404)
          }
          if (req.method !== 'POST') return fail('method not allowed', 405)
          const text = await req.text()
          const body: unknown = text === '' ? {} : JSON.parse(text)
          if (u.pathname === '/input') {
            const { d } = body as Partial<InputRequest>
            if (typeof d !== 'string') return fail('d must be a string')
            return session.write(d) ? ok() : fail('shell is not running', 409)
          }
          if (u.pathname === '/resize') {
            const { cols, rows } = body as Partial<ResizeRequest>
            if (typeof cols !== 'number' || typeof rows !== 'number') {
              return fail('cols and rows must be numbers')
            }
            session.resize(cols, rows)
            return ok()
          }
          if (u.pathname === '/select') {
            const { op, back } = body as Partial<SelectRequest>
            if (!SELECT_OPS.includes(op as SelectOp)) return fail('unknown op')
            const result = session.select(op as SelectOp, typeof back === 'number' ? back : 0)
            return Response.json({ ok: true, ...result } satisfies SelectResponse)
          }
          if (u.pathname === '/kill') {
            setTimeout(opts.onKill, 50)
            return ok()
          }
          return fail('not found', 404)
        } catch (error) {
          // 不正なリクエストで daemon を落とさない
          return fail(String(error), 500)
        }
      },
    }
    // Bun 1.4.2 の型は unix ソケットで idleTimeout を受け付けないが、実行時には効く
    // (既定の 10 秒のままだと long-poll が切られる)
    const server = Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0])
    chmodSync(opts.sock, 0o600)
    return server
  } finally {
    process.umask(old)
  }
}
