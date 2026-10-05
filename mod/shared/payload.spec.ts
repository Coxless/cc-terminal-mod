import { expect, test } from 'bun:test'
import { buildPayload, isEmptySelection, summarize } from './payload'

test('ペイロード: concept-mvp.md §9 の形式', () => {
  expect(buildPayload('Expected: 200\nReceived: 500', '/workspace/project')).toBe(
    [
      '[Terminal Context]',
      'Working directory: /workspace/project',
      '',
      'Selected output:',
      '----------------',
      'Expected: 200',
      'Received: 500',
      '----------------',
    ].join('\n'),
  )
})

test('ペイロード: 複数行と全角はそのまま、末尾の改行だけ落とす', () => {
  const p = buildPayload('  日本語テスト abc\n\n  2 行目  \n', '/tmp')
  expect(p).toContain('----------------\n  日本語テスト abc\n\n  2 行目  \n----------------')
})

test('ペイロード: cwd が取れないときは Working directory の行を出さない', () => {
  expect(buildPayload('x', null)).toBe('[Terminal Context]\n\nSelected output:\n----------------\nx\n----------------')
  expect(buildPayload('x', '')).not.toContain('Working directory')
})

test('空の選択', () => {
  expect(isEmptySelection(undefined)).toBe(true)
  expect(isEmptySelection('')).toBe(true)
  expect(isEmptySelection(' \n ')).toBe(true)
  expect(isEmptySelection(' a ')).toBe(false)
})

test('渡した内容の要約: 見出しと先頭の 3 行', () => {
  expect(summarize('Expected: 200\nReceived: 500\n', '/work')).toEqual([
    'Terminal → Claude: 2 lines, 28 chars (/work)',
    '│ Expected: 200',
    '│ Received: 500',
  ])
  expect(summarize('a\nb\nc\nd\ne', null)).toEqual([
    'Terminal → Claude: 5 lines, 9 chars',
    '│ a',
    '│ b',
    '│ c',
    '│ … +2 lines',
  ])
  expect(summarize('one', null)).toEqual(['Terminal → Claude: 1 line, 3 chars', '│ one'])
  expect(summarize('a\nb\nc\nd', null)[4]).toBe('│ … +1 line')
})

test('渡した内容の要約: 長い行は幅で切り、全角は 2 として数え、制御文字は出さない', () => {
  const [, long] = summarize('x'.repeat(200), null, 20)
  expect(long).toBe('│ ' + 'x'.repeat(17) + '…')
  const [, wide] = summarize('日'.repeat(50), null, 20)
  expect(wide).toBe('│ ' + '日'.repeat(8) + '…')
  expect(summarize('a\tb\x1b[0m', null)[1]).toBe('│ a b [0m')
})
