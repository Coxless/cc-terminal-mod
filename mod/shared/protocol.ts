// hooks モジュールと sidecar が共有する、Unix ソケット上の HTTP の型。
// ここには $ にも Bun にも触れないものだけを置く。

export const PROTOCOL_VERSION = 1

// 色: null = 端末の既定色、0〜15 = ANSI パレットの番号、文字列 = '#rrggbb'
export type Color = number | string | null

export const ATTR_BOLD = 1
export const ATTR_DIM = 2
export const ATTR_ITALIC = 4
export const ATTR_UNDERLINE = 8
export const ATTR_STRIKE = 16
// 反転。カーソル位置のセルは、sidecar がこのビットを反転させて返す
export const ATTR_INVERSE = 32

// 同じ属性が続くセルをまとめたもの
export type Run = [text: string, fg: Color, bg: Color, attrs: number]

export type Frame = {
  // 画面が変わるたびに増える。`since` に渡す
  ver: number
  cols: number
  rows: number
  alive: boolean
  // シェルが終了していれば終了コード
  exitCode: number | null
  // カーソル位置(0 始まり、画面内)
  cx: number
  cy: number
  cursorVisible: boolean
  // alternate screen(vim、less など)を表示中
  alt: boolean
  // DECCKM。矢印キーを `ESC O A` 形式で送るべきとき true
  appCursor: boolean
  bracketedPaste: boolean
  // 画面の上にある履歴の行数
  history: number
  // 末尾から何行さかのぼった位置を返しているか
  back: number
  // `since` から変化が無いときは省かれる。行ごとの Run の並び(行末の空白は省く)
  lines?: Run[][]
}

// GET /frame?since=<ver>&wait=<ms>&back=<lines>
export type FrameQuery = { since?: number; wait?: number; back?: number }

// GET /info
export type Info = {
  protocol: number
  pid: number
  shellPid: number
  watchPid: number
  alive: boolean
  exitCode: number | null
  cols: number
  rows: number
  ver: number
  // シェルの現在の cwd。取れなければ null
  cwd: string | null
  shell: string
}

// POST /input
export type InputRequest = { d: string }
// POST /resize
export type ResizeRequest = { cols: number; rows: number }
// POST /kill のボディは空
export type OkResponse = { ok: true } | { ok: false; error: string }

// 起動コマンド(`terminal-sidecar start ...`)が stdout に出す 1 行
export type StartResult = { ok: true; already: boolean; pid: number; shellPid: number } | { ok: false; error: string }

export const MIN_COLS = 2
export const MAX_COLS = 500
export const MIN_ROWS = 1
export const MAX_ROWS = 300
export const MAX_WAIT_MS = 25000
