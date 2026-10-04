// Client の surface モジュール。生のキーを受けられるのはここだけ。
// onKey で受けたキーに連番を振り、hooks モジュールへ post する。post は 1 フレーム 1 件で
// 後勝ちなので、ack(props.ack)が来るまでの未送達分を毎回まとめて送る。
import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Props = {
  // ack がどのインスタンス宛てか。インスタンスが作り直されると連番が 1 に戻るため
  ackId: string
  ack: number
  // この帯がキーを受けている、と hooks モジュールが判断しているか
  typing: boolean
  // 'select' は選択モード(キーは PTY に行かず、選択の操作になる)
  mode: string
}
type SeqKey = ClientKeyEvent & { n: number }
// hover は、ポインタが領域の上にあるか
type State = { id: string; hover: boolean }

const RESEND_MS = 150

let id = ''
let seq = 0
let queue: SeqKey[] = []

const Keys: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements

  if (surface.state === undefined) {
    id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
    seq = 0
    queue = []
    surface.onKey(event => {
      seq += 1
      queue.push({ ...event, n: seq })
      surface.post({ id, keys: queue })
    })
    // クリックでフォーカスを得る。そのことを hooks モジュールに知らせる
    surface.onPointer(event => {
      if (event.type === 'down') surface.post({ id, keys: queue })
      const hover = event.type !== 'leave'
      if (surface.state?.hover !== hover) surface.setState({ id, hover })
    })
    // post が届かなかったときの再送
    surface.every(RESEND_MS, () => {
      if (queue.length > 0) surface.post({ id, keys: queue })
    })
    surface.setState({ id, hover: false })
  }
  if (props.ackId === id) queue = queue.filter(k => k.n > props.ack)

  const select = props.typing && props.mode === 'select'
  const label = select ? ' SELECT ' : props.typing ? ' TERMINAL · alt+h: help ' : '[ Terminal input ]'
  // キーを受けていない間は Button と同じ見た目にする。本体は Button を太字で描き、ポインタが乗ると反転する
  const inverse = props.typing || surface.state?.hover === true
  return (
    <Text bold inverse={inverse} color={select ? 'yellow' : props.typing ? 'green' : undefined} wrap="truncate">
      {label}
    </Text>
  )
}

export default Keys
