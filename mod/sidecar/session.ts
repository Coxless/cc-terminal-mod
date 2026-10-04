// PTY + シェル + VT エミュレーション。画面の状態を持つのはここだけ。
import { Terminal } from '@xterm/headless'
import { readlinkSync } from 'node:fs'
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_ITALIC,
  ATTR_STRIKE,
  ATTR_UNDERLINE,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type Color,
  type Frame,
  type Run,
} from '../shared/protocol'

export type SessionOptions = {
  shell: string
  cwd: string
  cols: number
  rows: number
  scrollback: number
  env?: Record<string, string | undefined>
}

// 履歴の上限(行)。concept-mvp.md §23
export const DEFAULT_SCROLLBACK = 5000

// 出力が続いている間、フレームを返すのを少し待って 1 枚にまとめる
const SETTLE_MS = 4

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? Math.floor(n) : lo))

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const CONTROL_ALL = /[\x00-\x1f\x7f-\x9f]/g

const CUBE = [0, 95, 135, 175, 215, 255]
const cube = (i: number) => CUBE[i] ?? 0
// 256 色パレットの 16 以降は端末の設定に依らないので、RGB にして返す
function paletteColor(i: number): Color {
  if (i < 16) return i
  if (i < 232) {
    const n = i - 16
    return hex((cube(Math.floor(n / 36)) << 16) | (cube(Math.floor(n / 6) % 6) << 8) | cube(n % 6))
  }
  const v = 8 + 10 * (i - 232)
  return hex((v << 16) | (v << 8) | v)
}

export class Session {
  readonly shell: string
  cols: number
  rows: number
  ver = 1
  alive = true
  exitCode: number | null = null

  private term: Terminal
  private proc: Bun.Subprocess
  private waiters: (() => void)[] = []
  private cell

  constructor(opts: SessionOptions) {
    this.shell = opts.shell
    this.cols = clamp(opts.cols, MIN_COLS, MAX_COLS)
    this.rows = clamp(opts.rows, MIN_ROWS, MAX_ROWS)
    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: opts.scrollback,
      allowProposedApi: true,
    })
    this.cell = this.term.buffer.active.getNullCell()
    this.proc = Bun.spawn([opts.shell], {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      terminal: {
        cols: this.cols,
        rows: this.rows,
        data: (_t, data) => {
          this.term.write(data, () => this.bump())
        },
      },
      onExit: (_p, code, signal) => {
        this.alive = false
        this.exitCode = code ?? (typeof signal === 'number' ? 128 + signal : null)
        this.bump()
      },
    })
    // 端末への問い合わせ(DA、カーソル位置の報告)への応答を PTY に返す
    this.term.onData(d => this.write(d))
  }

  get shellPid(): number {
    return this.proc.pid
  }

  private bump() {
    this.ver += 1
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }

  write(d: string): boolean {
    if (!this.alive) return false
    try {
      this.proc.terminal?.write(d)
      return true
    } catch {
      return false
    }
  }

  resize(cols: number, rows: number) {
    cols = clamp(cols, MIN_COLS, MAX_COLS)
    rows = clamp(rows, MIN_ROWS, MAX_ROWS)
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    if (this.alive) {
      try {
        this.proc.terminal?.resize(cols, rows)
      } catch {
        // シェルが終了した直後
      }
    }
    this.term.resize(cols, rows)
    this.bump()
  }

  // シェルの現在の cwd(Linux)。取れなければ null
  cwd(): string | null {
    if (!this.alive) return null
    try {
      return readlinkSync(`/proc/${this.proc.pid}/cwd`)
    } catch {
      return null
    }
  }

  kill() {
    if (!this.alive) return
    // シェルは PTY のセッションリーダー。フォアグラウンドのジョブごと止める
    try {
      process.kill(-this.proc.pid, 'SIGHUP')
    } catch {}
    try {
      this.proc.kill('SIGHUP')
    } catch {}
    try {
      this.proc.terminal?.close()
    } catch {}
  }

  // 書き込み済みの出力が画面に反映されるまで待つ(テスト用)
  flush(): Promise<void> {
    return new Promise(resolve => this.term.write('', resolve))
  }

  // `since` より新しい画面になるか、`wait` ms 経つまで待つ
  async frame(since: number, wait: number, back: number): Promise<Frame> {
    if (this.ver <= since && this.alive && wait > 0) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, wait)
        this.waiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
      if (this.ver > since) await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    }
    return this.snapshot(this.ver > since, back)
  }

  snapshot(withLines: boolean, back = 0): Frame {
    const b = this.term.buffer.active
    const alt = b.type === 'alternate'
    const history = b.baseY
    back = alt ? 0 : clamp(back, 0, history)
    const core = (this.term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core
    const cursorVisible = core?.coreService?.isCursorHidden !== true
    const frame: Frame = {
      ver: this.ver,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      cx: Math.min(b.cursorX, this.cols - 1),
      cy: b.cursorY,
      cursorVisible,
      alt,
      appCursor: this.term.modes.applicationCursorKeysMode,
      bracketedPaste: this.term.modes.bracketedPasteMode,
      history,
      back,
    }
    if (!withLines) return frame
    const top = b.baseY - back
    const cursorRow = cursorVisible && this.alive ? b.baseY + b.cursorY : -1
    const lines: Run[][] = []
    for (let y = 0; y < this.rows; y++) {
      lines.push(this.encodeLine(top + y, top + y === cursorRow ? frame.cx : -1))
    }
    frame.lines = lines
    return frame
  }

  private encodeLine(y: number, cursorX: number): Run[] {
    const line = this.term.buffer.active.getLine(y)
    const runs: Run[] = []
    if (line === undefined) return runs
    const cell = this.cell
    let last: Run | undefined
    for (let x = 0; x < this.cols; x++) {
      const c = line.getCell(x, cell)
      if (c === undefined) break
      const width = c.getWidth()
      // 全角文字の 2 セル目
      if (width === 0) continue
      let text = c.getChars()
      if (text === '' || c.isInvisible()) text = width === 2 ? '  ' : ' '
      // 制御文字を含む文字列は、Mod の描画ツリーごと拒否される
      else if (CONTROL.test(text)) text = text.replace(CONTROL_ALL, ' ')
      const fg: Color = c.isFgDefault() ? null : c.isFgRGB() ? hex(c.getFgColor()) : paletteColor(c.getFgColor())
      const bg: Color = c.isBgDefault() ? null : c.isBgRGB() ? hex(c.getBgColor()) : paletteColor(c.getBgColor())
      let attrs = 0
      if (c.isBold()) attrs |= ATTR_BOLD
      if (c.isDim()) attrs |= ATTR_DIM
      if (c.isItalic()) attrs |= ATTR_ITALIC
      if (c.isUnderline()) attrs |= ATTR_UNDERLINE
      if (c.isStrikethrough()) attrs |= ATTR_STRIKE
      if (c.isInverse()) attrs |= ATTR_INVERSE
      // カーソルが全角文字の 2 セル目にあるときも、その文字を反転する
      if (cursorX === x || (width === 2 && cursorX === x + 1)) attrs ^= ATTR_INVERSE
      if (last !== undefined && last[1] === fg && last[2] === bg && last[3] === attrs) {
        last[0] += text
      } else {
        last = [text, fg, bg, attrs]
        runs.push(last)
      }
    }
    // 行末の、属性のない空白を省く
    for (;;) {
      const r = runs[runs.length - 1]
      if (r === undefined) break
      if (r[2] !== null || (r[3] & (ATTR_INVERSE | ATTR_UNDERLINE | ATTR_STRIKE)) !== 0) break
      r[0] = r[0].trimEnd()
      if (r[0] !== '') break
      runs.pop()
    }
    return runs
  }
}
