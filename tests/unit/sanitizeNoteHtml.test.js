const { sanitizeNoteHtml } = require('../../server/src/util/sanitizeNoteHtml');

describe('sanitizeNoteHtml', () => {
  test('keeps allowed formatting: bold, italic, alignment, font-size, lists, line breaks', () => {
    expect(sanitizeNoteHtml('<b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeNoteHtml('<i>italic</i>')).toBe('<i>italic</i>');
    expect(sanitizeNoteHtml('<div style="text-align:center">c</div>')).toBe('<div style="text-align:center;">c</div>');
    expect(sanitizeNoteHtml('<span style="font-size:16px">s</span>')).toBe('<span style="font-size:16px;">s</span>');
    expect(sanitizeNoteHtml('<ul><li>one</li><li>two</li></ul>')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(sanitizeNoteHtml('line1<br>line2')).toBe('line1<br>line2');
  });

  test('strips a color style — removed from the toolbar, no longer in the allowlist, but keeps the surrounding tag and text', () => {
    const out = sanitizeNoteHtml('<span style="color:#ff0000">red</span>');
    expect(out).not.toMatch(/color/i);
    expect(out).toContain('red');
  });

  test('strips a <script> tag and its content entirely, not just the tag', () => {
    expect(sanitizeNoteHtml('<script>alert(1)</script>hi')).toBe('hi');
  });

  test('neutralizes an unsupported <img onerror> tag — never a live element, at worst inert escaped text', () => {
    const out = sanitizeNoteHtml('<img src=x onerror=alert(1)>hi');
    // img is not in the allowlist, so the whole tag is HTML-entity-escaped
    // into inert text rather than becoming a real element — no raw "<img"
    // survives, only its escaped "&lt;img" form.
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain('&lt;img');
  });

  test('neutralizes a javascript: link — <a> is not in the allowlist, so it can never become a live element', () => {
    const out = sanitizeNoteHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toMatch(/<a\s/i);
    expect(out).toContain('&lt;a');
  });

  test('rejects a CSS injection attempt (expression()) but keeps the surrounding tag', () => {
    const out = sanitizeNoteHtml('<span style="font-size: expression(alert(1))">bad</span>');
    expect(out).not.toMatch(/expression/i);
    expect(out).toContain('bad');
  });

  test('strips an onclick attribute but keeps a legitimate style value on the same element', () => {
    const out = sanitizeNoteHtml('<div onclick="alert(1)" style="text-align:center">x</div>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('text-align:center');
  });

  test('preserves literal angle brackets in plain text — does not silently drop trailing content', () => {
    expect(sanitizeNoteHtml('score < 70 means fail')).toBe('score &lt; 70 means fail');
    expect(sanitizeNoteHtml('a < b and c > d')).toBe('a &lt; b and c &gt; d');
  });

  test('null, undefined, and empty string pass through unchanged rather than throwing', () => {
    expect(sanitizeNoteHtml(null)).toBeNull();
    expect(sanitizeNoteHtml(undefined)).toBeUndefined();
    expect(sanitizeNoteHtml('')).toBe('');
  });
});
