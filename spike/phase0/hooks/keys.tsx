// Phase 0 spike: Client の surface モジュール。
// onKey で受けたキーを連番つきで hooks モジュールへ post する。post は 1 フレーム 1 件で
// 後勝ちなので、ack されるまでのキーを毎回まとめて送る。
// mode が client のときは、端末画面そのものも Text で描く(Client は Raster を持てない)。
import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Run = [string, string | null, string | null, boolean]
type Props = {
  mode: string
  ack: number
  pointer: boolean
  cols: number
  runs: Run[][] | null
}
type Key = ClientKeyEvent & { n: number }
type State = { count: number; last: string }

let queue: Key[] = []
let seq = 0
let pointerOn = false

const Keys: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  queue = queue.filter(k => k.n > props.ack)

  if (surface.state === undefined) {
    surface.onKey(event => {
      seq += 1
      queue.push({ ...event, n: seq })
      surface.post({ keys: queue })
      // 未知のキーは生のエスケープシーケンスで届く。制御文字を含む tree は拒否され unmount される
      surface.setState({ count: seq, last: JSON.stringify(event.key) })
    })
    surface.setState({ count: 0, last: '' })
  }
  if (props.pointer !== pointerOn) {
    pointerOn = props.pointer
    if (pointerOn) {
      surface.onPointer(event => {
        if (event.type !== 'move') surface.post({ keys: queue, pointer: event })
      })
    }
  }

  const state = surface.state ?? { count: 0, last: '' }
  const bar = (
    <Text inverse>
      {' '}click here, then type (Esc returns focus) · keys={String(state.count)} last={state.last}{' '}
    </Text>
  )
  if (props.mode !== 'client' || props.runs === null) return bar

  return (
    <Box flexDirection="column">
      {bar}
      {props.runs.map(row => (
        <Text wrap="truncate">
          {row.length === 0 ? ' ' : row.map(([text, fg, bg, bold]) => (
            <Text color={fg ?? undefined} backgroundColor={bg ?? undefined} bold={bold}>
              {text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export default Keys
