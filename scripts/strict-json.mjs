import assert from 'node:assert/strict';

export function parseJsonStrict(text, label = 'JSON') {
  assert.equal(typeof text, 'string', `${label} must be a string`);
  let index = 0;

  function fail(message) {
    throw new SyntaxError(`${label}: ${message} at character ${index}`);
  }

  function whitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  }

  function stringValue() {
    const start = index;
    if (text[index] !== '"') fail('expected string');
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) fail('unterminated escape sequence');
        const escape = text[index];
        if (escape === 'u') {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail('invalid escape sequence');
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail('unescaped control character in string');
      index += 1;
    }
    fail('unterminated string');
  }

  function primitive() {
    const remaining = text.slice(index);
    for (const literal of ['true', 'false', 'null']) {
      if (remaining.startsWith(literal)) {
        index += literal.length;
        return;
      }
    }
    const number = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail('invalid value');
    index += number[0].length;
  }

  function array() {
    index += 1;
    whitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      value();
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      if (text[index] !== ',') fail('expected comma or closing bracket');
      index += 1;
      whitespace();
    }
    fail('unterminated array');
  }

  function object() {
    index += 1;
    whitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    const keys = new Set();
    while (index < text.length) {
      if (text[index] !== '"') fail('expected object key');
      const key = stringValue();
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (text[index] !== ':') fail('expected colon after object key');
      index += 1;
      value();
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      if (text[index] !== ',') fail('expected comma or closing brace');
      index += 1;
      whitespace();
    }
    fail('unterminated object');
  }

  function value() {
    whitespace();
    const character = text[index];
    if (character === '{') return object();
    if (character === '[') return array();
    if (character === '"') {
      stringValue();
      return;
    }
    primitive();
  }

  value();
  whitespace();
  if (index !== text.length) fail('trailing content');
  return JSON.parse(text);
}
