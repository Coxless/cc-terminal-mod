// PTY + シェル + VT エミュレーション。画面の状態を持つのはここだけ。
import { Terminal, type IMarker } from '@xterm/headless'
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
  type SelectInfo,
  type SelectOp,
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

// 選択モードの位置。y は履歴も含めたバッファ上の行。履歴が上限で削られると行がずれるので、
// 通常の画面では marker で追う(alternate screen には履歴が無い)
type Pos = { x: number; y: number; m?: IMarker }
type Selection = { cur: Pos; anchor: Pos | null; line: boolean; alt: boolean }
// 1 行の中で反転する範囲(セル、両端を含む)と、選択カーソルの位置。無ければ -1
type Highlight = { from: number; to: number; cur: number }

// 選択カーソルの色(ANSI パレットの番号)
const SELECT_CURSOR_FG = 0
const SELECT_CURSOR_BG = 3

// 単語単位の移動で使う文字の種類: 0 = 空白、1 = 単語、2 = 記号
const WORD = /[\p{L}\p{N}_]/u
const charClass = (ch: string) => (ch === ' ' ? 0 : WORD.test(ch) ? 1 : 2)

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
  private sel: Selection | null = null

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
    if (this.sel !== null) {
      this.sel.cur.x = Math.min(this.sel.cur.x, cols - 1)
      if (this.sel.anchor !== null) this.sel.anchor.x = Math.min(this.sel.anchor.x, cols - 1)
    }
    this.bump()
  }

  private pin(x: number, y: number): Pos {
    const b = this.term.buffer.active
    const m = b.type === 'normal' ? this.term.registerMarker(y - (b.baseY + b.cursorY)) : undefined
    return { x, y, m: m ?? undefined }
  }

  private rowOf(p: Pos): number {
    if (p.m === undefined) return p.y
    // 履歴から削られた行は、先頭に丸める
    return p.m.isDisposed || p.m.line < 0 ? 0 : p.m.line
  }

  private clearSelect() {
    this.sel?.cur.m?.dispose()
    this.sel?.anchor?.m?.dispose()
    this.sel = null
  }

  // 行のセルごとの文字。全角文字の 2 セル目は ''、空のセルは ' '
  private rowCells(y: number): string[] {
    const line = this.term.buffer.active.getLine(y)
    const cells: string[] = []
    for (let x = 0; x < this.cols; x++) {
      const c = line?.getCell(x, this.cell)
      cells.push(c === undefined ? ' ' : c.getWidth() === 0 ? '' : c.getChars() || ' ')
    }
    return cells
  }

  // 行末の空白を除いた長さ(セル)
  private rowLength(cells: string[]): number {
    let len = 0
    for (let x = 0; x < cells.length; x++) {
      if (cells[x] !== ' ' && cells[x] !== '') len = x + (cells[x + 1] === '' ? 2 : 1)
    }
    return len
  }

  // セルごとの文字の種類。全角文字の 2 セル目は、1 セル目と同じ
  private rowClasses(y: number): number[] {
    const classes: number[] = []
    for (const ch of this.rowCells(y)) classes.push(ch === '' ? (classes[classes.length - 1] ?? 0) : charClass(ch))
    return classes
  }

  // x を行の中身の範囲に収め、全角文字の 2 セル目なら 1 セル目に寄せる
  private clampX(x: number, y: number): number {
    const cells = this.rowCells(y)
    x = clamp(x, 0, Math.max(0, this.rowLength(cells) - 1))
    return cells[x] === '' && x > 0 ? x - 1 : x
  }

  // 選択モードの操作。`back` はいま表示している位置で、選択カーソルが見えるように動かして返す
  select(op: SelectOp, back: number): { active: boolean; back: number; select: SelectInfo | null } {
    const b = this.term.buffer.active
    const alt = b.type === 'alternate'
    const last = b.baseY + this.rows - 1
    back = alt ? 0 : clamp(back, 0, b.baseY)
    if (op === 'cancel') {
      if (this.sel !== null) {
        this.clearSelect()
        this.bump()
      }
      return { active: false, back, select: null }
    }
    if (op === 'start' || this.sel === null || this.sel.alt !== alt) {
      this.clearSelect()
      // Terminal のカーソルが見えていればそこから、さかのぼっていれば窓の最後の行から
      const top = b.baseY - back
      const cursorRow = b.baseY + b.cursorY
      const y = cursorRow >= top && cursorRow < top + this.rows ? cursorRow : top + this.rows - 1
      this.sel = { cur: this.pin(this.clampX(y === cursorRow ? b.cursorX : 0, y), y), anchor: null, line: false, alt }
      this.bump()
      return { active: true, back, select: this.selectInfo() }
    }

    const sel = this.sel
    let x = sel.cur.x
    let y = this.rowOf(sel.cur)
    const page = Math.max(1, this.rows - 1)
    switch (op) {
      case 'left':
        x -= 1
        break
      case 'right':
        x += this.rowCells(y)[x + 1] === '' ? 2 : 1
        break
      case 'up':
        y -= 1
        break
      case 'down':
        y += 1
        break
      case 'home':
        x = 0
        break
      case 'end':
        x = this.cols
        break
      case 'top':
        y = 0
        x = 0
        break
      case 'bottom':
        y = last
        x = 0
        break
      case 'pageUp':
        y -= page
        break
      case 'pageDown':
        y += page
        break
      case 'word': {
        let classes = this.rowClasses(y)
        const here = classes[x] ?? 0
        let i = x
        if (here !== 0) while (i < this.cols && classes[i] === here) i++
        while (i < this.cols && classes[i] === 0) i++
        if (i < this.cols) {
          x = i
          break
        }
        // 行末まで来たら、次に文字のある行の先頭の単語へ
        x = this.cols
        for (let next = y + 1; next <= last; next++) {
          classes = this.rowClasses(next)
          const first = classes.findIndex(c => c !== 0)
          if (first >= 0) {
            y = next
            x = first
            break
          }
        }
        break
      }
      case 'wordBack': {
        let classes = this.rowClasses(y)
        let i = x - 1
        while (i >= 0 && classes[i] === 0) i--
        // 行頭まで来たら、前に文字のある行の最後の単語へ
        for (let prev = y - 1; i < 0 && prev >= 0; prev--) {
          classes = this.rowClasses(prev)
          i = classes.length - 1
          while (i >= 0 && classes[i] === 0) i--
          if (i >= 0) y = prev
        }
        if (i < 0) {
          x = 0
          break
        }
        while (i > 0 && classes[i - 1] === classes[i]) i--
        x = i
        break
      }
      case 'anchor':
        if (sel.anchor !== null && !sel.line) {
          sel.anchor.m?.dispose()
          sel.anchor = null
        } else {
          sel.anchor ??= this.pin(x, y)
          sel.line = false
        }
        break
      case 'line':
        if (sel.anchor !== null && sel.line) {
          sel.anchor.m?.dispose()
          sel.anchor = null
          sel.line = false
        } else {
          sel.anchor ??= this.pin(x, y)
          sel.line = true
        }
        break
    }
    y = clamp(y, 0, last)
    x = this.clampX(x, y)
    sel.cur.m?.dispose()
    sel.cur = this.pin(x, y)

    if (!alt) {
      const top = b.baseY - back
      if (y < top) back = b.baseY - y
      else if (y > top + this.rows - 1) back = b.baseY - (y - this.rows + 1)
      back = clamp(back, 0, b.baseY)
    }
    this.bump()
    return { active: true, back, select: this.selectInfo() }
  }

  // 選択範囲(セル、両端を含む)。始点を置いていなければ null
  private selectRange(): { y1: number; x1: number; y2: number; x2: number } | null {
    const sel = this.sel
    if (sel === null || sel.anchor === null) return null
    const a = { x: sel.anchor.x, y: this.rowOf(sel.anchor) }
    const c = { x: sel.cur.x, y: this.rowOf(sel.cur) }
    const [from, to] = a.y < c.y || (a.y === c.y && a.x <= c.x) ? [a, c] : [c, a]
    if (sel.line) return { y1: from.y, x1: 0, y2: to.y, x2: this.cols - 1 }
    // 終点が全角文字なら、2 セル目まで含める
    const x2 = this.rowCells(to.y)[to.x + 1] === '' ? to.x + 1 : to.x
    return { y1: from.y, x1: from.x, y2: to.y, x2 }
  }

  // 選択範囲のテキスト。折り返された行はつなぎ、行末の空白は落とす。
  // 選択モードでなければ null、始点を置いていなければ空文字列
  selectionText(): string | null {
    if (this.sel === null) return null
    const r = this.selectRange()
    if (r === null) return ''
    const b = this.term.buffer.active
    let out = ''
    for (let y = r.y1; y <= r.y2; y++) {
      const row = b.getLine(y)?.translateToString(true, y === r.y1 ? r.x1 : 0, y === r.y2 ? r.x2 + 1 : this.cols) ?? ''
      // 次の行へ折り返していれば、そのままつなぐ
      if (y < r.y2 && b.getLine(y + 1)?.isWrapped === true) out += row
      // vim などは行末まで空白を書く。translateToString が落とすのは、書かれていないセルだけ
      else out += row.trimEnd() + (y < r.y2 ? '\n' : '')
    }
    return out
  }

  private selectInfo(): SelectInfo | null {
    if (this.sel === null) return null
    const text = this.selectionText() ?? ''
    return this.sel.anchor === null
      ? { anchored: false, lines: 0, chars: 0 }
      : { anchored: true, lines: text.split('\n').length, chars: text.length }
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
    // 画面が切り替わったら(vi の起動・終了)、選択していた位置は意味を失う
    if (this.sel !== null && this.sel.alt !== alt) this.clearSelect()
    const select = this.selectInfo()
    if (select !== null) frame.select = select
    if (!withLines) return frame
    const top = b.baseY - back
    // 選択モードの間は、Terminal のカーソルの代わりに選択カーソルを出す
    const cursorRow = cursorVisible && this.alive && this.sel === null ? b.baseY + b.cursorY : -1
    const range = this.selectRange()
    const selRow = this.sel === null ? -1 : this.rowOf(this.sel.cur)
    const lines: Run[][] = []
    for (let i = 0; i < this.rows; i++) {
      const y = top + i
      const hl: Highlight = { from: -1, to: -1, cur: y === selRow ? (this.sel?.cur.x ?? -1) : -1 }
      if (range !== null && y >= range.y1 && y <= range.y2) {
        hl.from = y === range.y1 ? range.x1 : 0
        hl.to = y === range.y2 ? range.x2 : this.cols - 1
      }
      lines.push(this.encodeLine(y, y === cursorRow ? frame.cx : -1, hl))
    }
    frame.lines = lines
    return frame
  }

  private encodeLine(y: number, cursorX: number, hl: Highlight): Run[] {
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
      let fg: Color = c.isFgDefault() ? null : c.isFgRGB() ? hex(c.getFgColor()) : paletteColor(c.getFgColor())
      let bg: Color = c.isBgDefault() ? null : c.isBgRGB() ? hex(c.getBgColor()) : paletteColor(c.getBgColor())
      let attrs = 0
      if (c.isBold()) attrs |= ATTR_BOLD
      if (c.isDim()) attrs |= ATTR_DIM
      if (c.isItalic()) attrs |= ATTR_ITALIC
      if (c.isUnderline()) attrs |= ATTR_UNDERLINE
      if (c.isStrikethrough()) attrs |= ATTR_STRIKE
      if (c.isInverse()) attrs |= ATTR_INVERSE
      // カーソルが全角文字の 2 セル目にあるときも、その文字を反転する
      if (cursorX === x || (width === 2 && cursorX === x + 1)) attrs ^= ATTR_INVERSE
      if (x >= hl.from && x <= hl.to) attrs ^= ATTR_INVERSE
      if (x === hl.cur) {
        fg = SELECT_CURSOR_FG
        bg = SELECT_CURSOR_BG
        attrs &= ~(ATTR_INVERSE | ATTR_DIM)
      }
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
