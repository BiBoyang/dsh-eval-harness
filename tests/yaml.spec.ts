import { describe, expect, it } from 'vitest'
import { parseCase } from '../src/runner.ts'
import { parseYamlSubset } from '../src/yaml-mini.ts'

describe('parseYamlSubset', () => {
  it('parses the case-file shape (maps, flow seqs, scalars)', () => {
    const v = parseYamlSubset(
      [
        'name: echo-hello',
        'prompt: "请回复：hello eval"',
        'require_plugins: [some-plugin, "other"]',
        'assert:',
        '  turn_end: completed',
        '  tools_called: [tool_a, tool_b]',
        '  output_contains: ["关键词", \'x\']',
        '  max_steps: 8',
        '  max_tokens: 50000',
      ].join('\n'),
    )
    expect(v).toEqual({
      name: 'echo-hello',
      prompt: '请回复：hello eval',
      require_plugins: ['some-plugin', 'other'],
      assert: {
        turn_end: 'completed',
        tools_called: ['tool_a', 'tool_b'],
        output_contains: ['关键词', 'x'],
        max_steps: 8,
        max_tokens: 50000,
      },
    })
  })

  it('supports block sequences at the same indent as the key', () => {
    const v = parseYamlSubset('tools_called:\n- tool_a\n- tool_b\nnext: 1')
    expect(v).toEqual({ tools_called: ['tool_a', 'tool_b'], next: 1 })
  })

  it('supports literal block scalars for multi-line prompt', () => {
    const v = parseYamlSubset('prompt: |\n  第一行\n  第二行\nassert:\n  max_steps: 1')
    expect(v).toEqual({ prompt: '第一行\n第二行\n', assert: { max_steps: 1 } })
  })

  it('supports folded block scalars and strip chomping', () => {
    expect(parseYamlSubset('prompt: >\n  a\n  b')).toEqual({ prompt: 'a b\n' })
    expect(parseYamlSubset('prompt: |-\n  a\n  b\n')).toEqual({ prompt: 'a\nb' })
  })

  it('handles comments and # inside quotes', () => {
    const v = parseYamlSubset('# header\nname: "a # b" # trailing\nn: 1')
    expect(v).toEqual({ name: 'a # b', n: 1 })
  })

  it('parses booleans / null / negative numbers / bare strings', () => {
    expect(parseYamlSubset('a: true\nb: false\nc: null\nd: -3\ne: hello world')).toEqual({
      a: true,
      b: false,
      c: null,
      d: -3,
      e: 'hello world',
    })
  })

  it('double-quoted escapes', () => {
    expect(parseYamlSubset('p: "a\\nb\\"c\\\\"')).toEqual({ p: 'a\nb"c\\' })
  })

  it('key with null value when no children', () => {
    expect(parseYamlSubset('a:\nb: 1')).toEqual({ a: null, b: 1 })
  })

  it('parses sequence item maps with continuation lines', () => {
    const v = parseYamlSubset(
      ['tool_args_contains:', '- name: bash', '  contains: \'"command"\'', '- name: read', '  contains: /tmp', 'next: 1'].join('\n'),
    )
    expect(v).toEqual({
      tool_args_contains: [
        { name: 'bash', contains: '"command"' },
        { name: 'read', contains: '/tmp' },
      ],
      next: 1,
    })
  })

  it('parses sequence item map with nested value', () => {
    const v = parseYamlSubset('items:\n- name:\n    nested: 1\n- plain')
    expect(v).toEqual({ items: [{ name: { nested: 1 } }, 'plain'] })
  })

  it('rejects tab indentation', () => {
    expect(() => parseYamlSubset('a:\n\tb: 1')).toThrow(/tab indentation/)
  })

  it('rejects duplicate keys', () => {
    expect(() => parseYamlSubset('a: 1\na: 2')).toThrow(/duplicate key 'a'/)
  })
})

describe('parseCase validation', () => {
  const valid = 'name: x\nprompt: "p"\nassert:\n  turn_end: completed'

  it('parses a valid case', () => {
    const c = parseCase(valid, 'x.case.yml')
    expect(c).toEqual({ name: 'x', prompt: 'p', require_plugins: undefined, assert: { turn_end: 'completed' } })
  })

  it('throws eval_run: prefixed error on yaml syntax error', () => {
    expect(() => parseCase('name: x\n\tbad', 'bad.yml')).toThrow(/^eval_run: failed to parse case file 'bad\.yml': line 2/)
  })

  it('rejects missing name / prompt / assert', () => {
    expect(() => parseCase('prompt: p\nassert: {}', 'f.yml')).toThrow(/'name' must be/)
    expect(() => parseCase('name: x\nassert: {}', 'f.yml')).toThrow(/'prompt' must be/)
    expect(() => parseCase('name: x\nprompt: p', 'f.yml')).toThrow(/'assert' must be a mapping/)
  })

  it('rejects wrong field types', () => {
    expect(() => parseCase('name: x\nprompt: p\nrequire_plugins: [1]', 'f.yml')).toThrow(/require_plugins/)
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  max_steps: -1', 'f.yml')).toThrow(/max_steps.*non-negative integer/)
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  tools_called: a', 'f.yml')).toThrow(/tools_called.*list of strings/)
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  no_tool_errors: yes', 'f.yml')).toThrow(/no_tool_errors.*boolean/)
  })

  it('accepts no_tool_errors boolean', () => {
    const c = parseCase('name: x\nprompt: p\nassert:\n  no_tool_errors: true', 'f.yml')
    expect(c.assert.no_tool_errors).toBe(true)
  })

  it('rejects non-list new string assertions', () => {
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  tools_exact: a', 'f.yml')).toThrow(/tools_exact.*list of strings/)
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  tools_not_called: a', 'f.yml')).toThrow(/tools_not_called.*list of strings/)
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  output_not_contains: a', 'f.yml')).toThrow(/output_not_contains.*list of strings/)
  })

  it('rejects invalid output_matches regex with case name in the message', () => {
    expect(() => parseCase("name: my-case\nprompt: p\nassert:\n  output_matches: ['([']", 'f.yml')).toThrow(
      /case 'my-case'.*output_matches.*invalid regex '\(\['/,
    )
  })

  it('rejects tool_args_contains / tool_result_contains items missing name or contains', () => {
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  tool_args_contains:\n    - name: x', 'f.yml')).toThrow(
      /tool_args_contains/,
    )
    expect(() => parseCase('name: x\nprompt: p\nassert:\n  tool_result_contains:\n    - contains: y', 'f.yml')).toThrow(
      /tool_result_contains/,
    )
  })

  it('accepts a valid combination of new assertions (incl. block-map tool patterns)', () => {
    const c = parseCase(
      [
        'name: x',
        'prompt: p',
        'assert:',
        '  tools_exact: [bash, read]',
        '  tools_not_called: [write]',
        '  output_not_contains: ["抱歉"]',
        '  output_matches: ["^okay"]',
        '  tool_args_contains:',
        '    - name: bash',
        '      contains: \'"command"\'',
        '  tool_result_contains:',
        '    - name: bash',
        '      contains: total',
      ].join('\n'),
      'f.yml',
    )
    expect(c.assert).toEqual({
      tools_exact: ['bash', 'read'],
      tools_not_called: ['write'],
      output_not_contains: ['抱歉'],
      output_matches: ['^okay'],
      tool_args_contains: [{ name: 'bash', contains: '"command"' }],
      tool_result_contains: [{ name: 'bash', contains: 'total' }],
    })
  })
})
