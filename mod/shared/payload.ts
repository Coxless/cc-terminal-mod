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

// ペーストとして PTY に書くバイト列。アプリが bracketed paste を有効にしていれば括る
export function pasteBytes(text: string, bracketed: boolean): string {
  const body = text.replace(/\r\n?|\n/g, '\r')
  if (!bracketed) return body
  // 中身に終端のマーカーがあると、そこでペーストが終わったことにされる
  return `\x1b[200~${body.replaceAll('\x1b[201~', '')}\x1b[201~`
}
