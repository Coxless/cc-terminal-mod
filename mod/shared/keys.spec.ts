import { expect, test } from 'bun:test'
import { isAddKey, isSelectStart, keyToBytes, scrollKey, selectActions } from './keys'

test('文字と基本のキー', () => {
  expect(keyToBytes({ key: 'a' })).toBe('a')
  expect(keyToBytes({ key: 'A', shift: true })).toBe('A')
  expect(keyToBytes({ key: '日' })).toBe('日')
  expect(keyToBytes({ key: 'return' })).toBe('\r')
  expect(keyToBytes({ key: 'tab' })).toBe('\t')
  expect(keyToBytes({ key: 'tab', shift: true })).toBe('\x1b[Z')
  expect(keyToBytes({ key: 'backspace' })).toBe('\x7f')
  expect(keyToBytes({ key: 'backspace', meta: true })).toBe('\x1b\x7f')
  expect(keyToBytes({ key: 'space' })).toBe(' ')
  expect(keyToBytes({ key: '' })).toBe('')
})

test('まとめて届いた複数文字はそのまま', () => {
  expect(keyToBytes({ key: 'hello world' })).toBe('hello world')
})

test('矢印、Home / End と DECCKM', () => {
  expect(keyToBytes({ key: 'up' })).toBe('\x1b[A')
  expect(keyToBytes({ key: 'left' })).toBe('\x1b[D')
  expect(keyToBytes({ key: 'home' })).toBe('\x1b[H')
  expect(keyToBytes({ key: 'end' })).toBe('\x1b[F')
  expect(keyToBytes({ key: 'up' }, { appCursor: true })).toBe('\x1bOA')
  expect(keyToBytes({ key: 'end' }, { appCursor: true })).toBe('\x1bOF')
})

test('修飾つきキー', () => {
  expect(keyToBytes({ key: 'right', ctrl: true })).toBe('\x1b[1;5C')
  expect(keyToBytes({ key: 'up', shift: true })).toBe('\x1b[1;2A')
  expect(keyToBytes({ key: 'up', shift: true }, { appCursor: true })).toBe('\x1b[1;2A')
  expect(keyToBytes({ key: 'delete', ctrl: true })).toBe('\x1b[3;5~')
  // alt+b / alt+f は left / right + meta に正規化されて届く
  expect(keyToBytes({ key: 'left', meta: true })).toBe('\x1bb')
  expect(keyToBytes({ key: 'right', meta: true })).toBe('\x1bf')
})

test('PageUp / PageDown / Delete / Insert / ファンクションキー', () => {
  expect(keyToBytes({ key: 'pageup' })).toBe('\x1b[5~')
  expect(keyToBytes({ key: 'pagedown' })).toBe('\x1b[6~')
  expect(keyToBytes({ key: 'delete' })).toBe('\x1b[3~')
  expect(keyToBytes({ key: 'insert' })).toBe('\x1b[2~')
  expect(keyToBytes({ key: 'f1' })).toBe('\x1bOP')
  expect(keyToBytes({ key: 'f5' })).toBe('\x1b[15~')
  expect(keyToBytes({ key: 'f12', shift: true })).toBe('\x1b[24;2~')
})

test('生のエスケープシーケンスで届くキーはそのまま流す', () => {
  expect(keyToBytes({ key: '\x1b[2~' })).toBe('\x1b[2~')
  expect(keyToBytes({ key: '\x1bOP' })).toBe('\x1bOP')
})

test('Ctrl つきの文字', () => {
  expect(keyToBytes({ key: 'a', ctrl: true })).toBe('\x01')
  expect(keyToBytes({ key: 'w', ctrl: true })).toBe('\x17')
  expect(keyToBytes({ key: '\\', ctrl: true })).toBe('\x1c')
  expect(keyToBytes({ key: '_', ctrl: true })).toBe('\x1f')
  // ctrl+space はバッククォートの ctrl つきで届く
  expect(keyToBytes({ key: '`', ctrl: true })).toBe('\x00')
  expect(keyToBytes({ key: 'space', ctrl: true })).toBe('\x00')
  // ctrl+j
  expect(keyToBytes({ key: '\n' })).toBe('\n')
})

test('Alt つきの文字', () => {
  expect(keyToBytes({ key: 'f', meta: true })).toBe('\x1bf')
  expect(keyToBytes({ key: '.', meta: true })).toBe('\x1b.')
})

test('代替キー', () => {
  expect(keyToBytes({ key: ']', ctrl: true })).toBe('\x1b')
  expect(keyToBytes({ key: 'c', meta: true })).toBe('\x03')
  expect(keyToBytes({ key: 'd', meta: true })).toBe('\x04')
  expect(keyToBytes({ key: 'z', meta: true })).toBe('\x1a')
  expect(keyToBytes({ key: 'x', meta: true })).toBe('\x18')
})

test('履歴のスクロールキー', () => {
  expect(scrollKey({ key: 'pageup', shift: true })).toBe('up')
  expect(scrollKey({ key: 'pagedown', shift: true })).toBe('down')
  expect(scrollKey({ key: 'pageup' })).toBeUndefined()
})

test('選択モードに入るキーと、追加のキー', () => {
  expect(isSelectStart({ key: 'v', meta: true })).toBe(true)
  expect(isSelectStart({ key: 'v' })).toBe(false)
  expect(isSelectStart({ key: 'v', meta: true, ctrl: true })).toBe(false)
  expect(isAddKey({ key: 'a', meta: true })).toBe(true)
  expect(isAddKey({ key: 'a' })).toBe(false)
})

test('選択モードの間のキー', () => {
  expect(selectActions({ key: 'h' })).toEqual(['left'])
  expect(selectActions({ key: 'j' })).toEqual(['down'])
  expect(selectActions({ key: 'k' })).toEqual(['up'])
  expect(selectActions({ key: 'l' })).toEqual(['right'])
  expect(selectActions({ key: 'up' })).toEqual(['up'])
  expect(selectActions({ key: '0' })).toEqual(['home'])
  expect(selectActions({ key: '$', shift: true })).toEqual(['end'])
  expect(selectActions({ key: 'end' })).toEqual(['end'])
  expect(selectActions({ key: 'w' })).toEqual(['word'])
  expect(selectActions({ key: 'b' })).toEqual(['wordBack'])
  // alt+b / alt+f は left / right + meta として届く
  expect(selectActions({ key: 'left', meta: true })).toEqual(['wordBack'])
  expect(selectActions({ key: 'right', meta: true })).toEqual(['word'])
  expect(selectActions({ key: 'g' })).toEqual(['top'])
  expect(selectActions({ key: 'G', shift: true })).toEqual(['bottom'])
  expect(selectActions({ key: 'g', shift: true })).toEqual(['bottom'])
  expect(selectActions({ key: 'pageup' })).toEqual(['pageUp'])
  expect(selectActions({ key: 'v' })).toEqual(['anchor'])
  expect(selectActions({ key: 'space' })).toEqual(['anchor'])
  expect(selectActions({ key: 'V', shift: true })).toEqual(['line'])
  expect(selectActions({ key: 'return' })).toEqual(['send'])
  expect(selectActions({ key: 'q' })).toEqual(['cancel'])
  expect(selectActions({ key: ']', ctrl: true })).toEqual(['cancel'])
})

test('選択モード: まとめて届いた文字は 1 文字ずつ、割り当ての無いキーは捨てる', () => {
  expect(selectActions({ key: 'Vjj' })).toEqual(['line', 'down', 'down'])
  expect(selectActions({ key: 'x' })).toEqual([])
  expect(selectActions({ key: 'c', meta: true })).toEqual([])
  expect(selectActions({ key: 'a', ctrl: true })).toEqual([])
  expect(selectActions({ key: '\x1b[2~' })).toEqual([])
  expect(selectActions({ key: 'tab' })).toEqual([])
})
