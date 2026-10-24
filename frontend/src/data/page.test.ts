import { describe, expect, it } from 'vitest'

import { MAX_PAGE, PAGE_SIZE, parsePageParam } from './page.ts'

describe('page parameter', () => {
  it('asks for page 1 when the URL says nothing', () => {
    expect(parsePageParam(null)).toBe(1)
  })

  it.each([
    ['2', 2],
    ['10', 10],
    [' 3 ', 3],
    [MAX_PAGE.toString(), MAX_PAGE],
  ])('reads %s as page %i', (raw, expected) => {
    expect(parsePageParam(raw)).toBe(expected)
  })

  it.each([
    ['', 'empty'],
    ['abc', 'letters'],
    ['-1', 'negative'],
    ['0', 'zero'],
    ['+2', 'explicit sign'],
    ['1.5', 'decimal'],
    ['1e3', 'exponent'],
    ['0x10', 'hexadecimal'],
    ['2 1', 'two numbers'],
    ['99999999999999999999999', 'beyond safe integers'],
  ])('falls back to page 1 for %s (%s) instead of crashing', (raw) => {
    expect(parsePageParam(raw)).toBe(1)
  })

  it('clamps to the server ceiling rather than sending a page it rejects', () => {
    expect(parsePageParam('10001')).toBe(MAX_PAGE)
    expect(parsePageParam('99999')).toBe(MAX_PAGE)
    expect(parsePageParam('10000')).toBe(MAX_PAGE)
  })

  it('uses the fixed page size the server defaults to', () => {
    expect(PAGE_SIZE).toBe(20)
  })
})
