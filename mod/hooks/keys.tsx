// Client の surface モジュール。生のキーを受けられるのはここだけ。
// onKey で受けたキーに連番を振り、hooks モジュールへ post する。post は 1 フレーム 1 件で
// 後勝ちなので、ack(props.ack)が来るまでの未送達分を毎回まとめて送る。
import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Props = {
  // ack がどのインスタンス宛てか。インスタンスが作り直されると連番が 1 に戻るため
  ackId: string
  ack: number
  hint: string
}
type SeqKey = ClientKeyEvent & { n: number }
type State = { id: string }

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
    // post が届かなかったときの再送
    surface.every(RESEND_MS, () => {
      if (queue.length > 0) surface.post({ id, keys: queue })
    })
    surface.setState({ id })
  }
  if (props.ackId === id) queue = queue.filter(k => k.n > props.ack)

  return (
    <Text inverse wrap="truncate">
      {' '}
      click here to type · {props.hint}{' '}
    </Text>
  )
}

export default Keys
