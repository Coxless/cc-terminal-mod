// Claude に渡す Context Payload を作る純関数(concept-mvp.md §9)。
// 選択テキストは Terminal 由来の外部情報として、そのまま入れる。解釈も要約もしない。

const RULE = '----------------'

export const isEmptySelection = (text: string | undefined): boolean => text === undefined || text.trim() === ''

// cwd は、シェルの実際の cwd が確実に取れたときだけ渡す。取れなければ行ごと出さない
export function buildPayload(selected: string, cwd: string | null): string {
  const head = cwd === null || cwd === '' ? '[Terminal Context]' : `[Terminal Context]\nWorking directory: ${cwd}`
  // 行末の改行だけ落とす(罫線の前に空行を作らないため)。中身には触れない
  const body = selected.replace(/[\r\n]+$/, '')
  return `${head}\n\nSelected output:\n${RULE}\n${body}\n${RULE}`
}

// 全角を 2 として数えた、おおよその表示幅
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]
function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  return WIDE.some(([lo, hi]) => c >= lo && c <= hi) ? 2 : 1
}

function fit(line: string, width: number): string {
  let used = 0
  let out = ''
  for (const ch of line) {
    used += cellWidth(ch)
    if (used > width - 1) return out + '…'
    out += ch
  }
  return out
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

// Claude に渡した内容を人に見せるための行(トランスクリプトに出す。Claude には渡らない)。
// 見出しと、先頭の数行。中身は切り詰めるだけで、解釈しない
export function summarize(selected: string, cwd: string | null, width = 76, preview = 3): string[] {
  const lines = selected.replace(/[\r\n]+$/, '').split(/\r\n?|\n/)
  const where = cwd === null || cwd === '' ? '' : ` (${cwd})`
  const out = [`Terminal → Claude: ${plural(lines.length, 'line')}, ${plural(selected.length, 'char')}${where}`]
  // 制御文字を含む文字列は表示できない
  for (const line of lines.slice(0, preview)) out.push(fit(`│ ${line.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`, width))
  if (lines.length > preview) out.push(`│ … +${plural(lines.length - preview, 'line')}`)
  return out
}
