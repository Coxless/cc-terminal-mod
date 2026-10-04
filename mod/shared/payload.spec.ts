import { expect, test } from 'bun:test'
import { buildPayload, isEmptySelection, pasteBytes } from './payload'

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

test('ペースト', () => {
  expect(pasteBytes('a\nb\r\nc', false)).toBe('a\rb\rc')
  expect(pasteBytes('a\nb', true)).toBe('\x1b[200~a\rb\x1b[201~')
  expect(pasteBytes('x\x1b[201~rm -rf', true)).toBe('\x1b[200~xrm -rf\x1b[201~')
})
