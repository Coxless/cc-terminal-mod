// Client の onKey で受けたキーを、PTY に書くバイト列へ変換する純関数。
// 届くキーと届かないキーの根拠は docs/architecture.md §2。

import type { SelectOp } from './protocol'

export type KeyEvent = { key: string; ctrl?: true; shift?: true; meta?: true }
export type KeyModes = { appCursor: boolean }

// Claude Code 本体が処理して Mod に届かないキーの代替。
//   ctrl+] → Escape、alt+c / alt+d / alt+z / alt+x → Ctrl+C / D / Z / X
const ALT_REMAP: Record<string, string> = { c: '\x03', d: '\x04', z: '\x1a', x: '\x18' }

// ペインに出すヘルプ(alt+h と [ Help ] ボタン)。キーの割り当てを変えたら、ここも直す
export const HELP_LINES = [
  'TERMINAL HELP · any key closes',
  'Type: click [ Terminal input ] · esc: back to Claude',
  '  ctrl+]              Esc',
  '  alt+c / d / z / x   Ctrl+C / D / Z / X',
  '  shift+PgUp / PgDn   history (or the wheel)',
  '  alt+h               this help',
  'Give text to Claude',
  '  alt+v               select: hjkl/arrows, v, V, enter, q',
  '  alt+a               add the mouse selection (/term-add)',
  'Paste is not supported: it goes to the Claude prompt',
]

// CSI <letter> 形式のキー。DECCKM のときは SS3 になる
const CURSOR: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
// CSI <n> ~ 形式のキー
const TILDE: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageup: 5,
  pagedown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
}
const SS3_FN: Record<string, string> = { f1: 'P', f2: 'Q', f3: 'R', f4: 'S' }
const SIMPLE: Record<string, string> = {
  return: '\r',
  enter: '\r',
  escape: '\x1b',
  space: ' ',
  tab: '\t',
  backspace: '\x7f',
}

// xterm の修飾パラメータ: 1 + shift(1) + alt(2) + ctrl(4)
const modifier = (k: KeyEvent) => 1 + (k.shift ? 1 : 0) + (k.meta ? 2 : 0) + (k.ctrl ? 4 : 0)

function ctrlChar(ch: string): string | undefined {
  if (ch === ' ' || ch === '`' || ch === '@') return '\x00'
  if (ch === '?') return '\x7f'
  const c = ch.toUpperCase().charCodeAt(0)
  return c >= 0x40 && c <= 0x5f ? String.fromCharCode(c & 0x1f) : undefined
}

export function keyToBytes(k: KeyEvent, modes: KeyModes = { appCursor: false }): string {
  const key = k.key
  if (key === '') return ''
  if (k.ctrl && !k.meta && key === ']') return '\x1b'
  if (k.meta && !k.ctrl && ALT_REMAP[key] !== undefined) return ALT_REMAP[key]

  // insert やファンクションキーは、生のエスケープシーケンスで届く。そのまま流す
  if (key.length > 1 && key.startsWith('\x1b')) return key

  const mod = modifier(k)

  if (CURSOR[key] !== undefined) {
    // alt+b / alt+f は本体が { key: 'left' / 'right', meta: true } に正規化して届ける。
    // 単語移動として、readline が必ず解釈する ESC b / ESC f を送る
    if (mod === 3 && key === 'left') return '\x1bb'
    if (mod === 3 && key === 'right') return '\x1bf'
    if (mod !== 1) return `\x1b[1;${mod}${CURSOR[key]}`
    return (modes.appCursor ? '\x1bO' : '\x1b[') + CURSOR[key]
  }
  if (TILDE[key] !== undefined) return mod === 1 ? `\x1b[${TILDE[key]}~` : `\x1b[${TILDE[key]};${mod}~`
  if (SS3_FN[key] !== undefined) return mod === 1 ? `\x1bO${SS3_FN[key]}` : `\x1b[1;${mod}${SS3_FN[key]}`

  if (key === 'tab' && k.shift) return '\x1b[Z'
  if (key === 'backspace' && k.ctrl) return '\x08'
  let s = SIMPLE[key]
  if (s === undefined) {
    s = key
    // 1 文字のときだけ ctrl を畳む(まとめて届いた複数文字はそのまま)
    if (k.ctrl && [...key].length === 1) s = ctrlChar(key) ?? key
  } else if (k.ctrl && key === 'space') {
    s = '\x00'
  }
  return k.meta ? '\x1b' + s : s
}

// 履歴のスクロールに使うキー(PTY には送らない)。実際の端末と同じ shift+PageUp / PageDown
export function scrollKey(k: KeyEvent): 'up' | 'down' | undefined {
  if (!k.shift || k.ctrl || k.meta) return undefined
  if (k.key === 'pageup') return 'up'
  if (k.key === 'pagedown') return 'down'
  return undefined
}

// 選択モード(キーボードでの選択)に入るキー。PTY には送らない
export const isSelectStart = (k: KeyEvent): boolean => k.meta === true && !k.ctrl && k.key === 'v'
// マウスで選択したテキストを Claude に渡すキー(/term-add と同じ)。PTY には送らない
export const isAddKey = (k: KeyEvent): boolean => k.meta === true && !k.ctrl && k.key === 'a'

// ヘルプを出すキー。PTY には送らない
export const isHelpKey = (k: KeyEvent): boolean => k.meta === true && !k.ctrl && k.key === 'h'

// 選択モードの間のキー。'send' は「選択を Claude に渡して、モードを出る」
export type SelectAction = SelectOp | 'send'

const SELECT_NAMED: Record<string, SelectAction> = {
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down',
  home: 'home',
  end: 'end',
  pageup: 'pageUp',
  pagedown: 'pageDown',
  return: 'send',
  enter: 'send',
  space: 'anchor',
}
// 名前で届くキーのうち、選択モードで使わないもの(文字の並びとして読まない)
const SELECT_IGNORED = /^(tab|backspace|delete|escape|insert|f\d+)$/
// vi 風の割り当て
const SELECT_CHAR: Record<string, SelectAction> = {
  h: 'left',
  j: 'down',
  k: 'up',
  l: 'right',
  '0': 'home',
  $: 'end',
  w: 'word',
  b: 'wordBack',
  g: 'top',
  G: 'bottom',
  v: 'anchor',
  ' ': 'anchor',
  V: 'line',
  q: 'cancel',
  '\r': 'send',
}

// 選択モードの間に届いたキーを操作に変える。割り当ての無いキーは捨てる(PTY には送らない)
export function selectActions(k: KeyEvent): SelectAction[] {
  if (k.ctrl) return !k.meta && k.key === ']' ? ['cancel'] : []
  const named = SELECT_NAMED[k.key]
  if (named !== undefined) {
    // alt+b / alt+f は left / right + meta として届く
    if (k.meta) return named === 'left' ? ['wordBack'] : named === 'right' ? ['word'] : []
    return [named]
  }
  if (k.meta || k.key.startsWith('\x1b') || SELECT_IGNORED.test(k.key)) return []
  const actions: SelectAction[] = []
  // まとめて届いた複数文字は、1 文字ずつ
  for (const ch of k.key) {
    const action = SELECT_CHAR[k.shift && ch.length === 1 ? ch.toUpperCase() : ch]
    if (action !== undefined) actions.push(action)
  }
  return actions
}
