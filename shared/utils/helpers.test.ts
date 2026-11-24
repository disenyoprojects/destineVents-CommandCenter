import { describe, it, expect } from 'vitest';
import { jsArg } from './helpers.ts';

// What the browser hands to the JavaScript engine: the attribute's text with
// HTML entities decoded.
const decodeAttribute = (s: string) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Runs the handler text the way a click would, returning the argument received.
const runHandler = (arg: string): string => {
  let received = '';
  new Function('capture', `capture(${decodeAttribute(arg)})`)((v: string) => { received = v; });
  return received;
};

describe('jsArg', () => {
  it.each([
    ['plain', 'SOB-2026-001'],
    ['apostrophe', "Client's SOB"],
    ['double quote', 'The "big" one'],
    ['backslash at the end', 'OR\\'],
    ['backslash escape look-alike', 'C:\\x41\\u00'],
    ['newline', 'line one\nline two'],
    ['html', '<img src=x onerror=alert(1)>'],
  ])('passes a value with %s through a click unchanged', (_label, value) => {
    expect(runHandler(jsArg(value))).toBe(value);
  });

  it('never leaves a raw quote or angle bracket in the attribute', () => {
    expect(jsArg(`a'b"c<d>`)).not.toMatch(/["'<>]/);
  });

  it('turns a missing value into an empty string', () => {
    expect(runHandler(jsArg(null))).toBe('');
  });
});
