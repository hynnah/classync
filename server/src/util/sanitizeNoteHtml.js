const xss = require('xss');

// The exact formatting the Notes editor's toolbar can produce — nothing
// else survives. Regex-validated style *values* (not just property names)
// so a size/align can't smuggle something like `expression()` or a `url()`
// through an otherwise-legitimate CSS property. Text color was a toolbar
// option too until it was removed — no longer whitelisted, so any color
// style already saved from that window is stripped (not the surrounding
// tag) the next time the note round-trips through here.
//
// stripIgnoreTag deliberately left at its default (false): turning it on
// makes the underlying parser swallow a literal "<" not followed by a real
// tag — e.g. "score < 70 means fail" silently lost everything from the "<"
// onward in testing. Left at default, an unsupported tag (never sent by the
// toolbar itself, only reachable via a direct API call) shows up as inert
// escaped text instead — safe either way, but this way nothing legitimate
// ever goes missing.
const filterXSS = new xss.FilterXSS({
  whiteList: {
    b: [],
    i: [],
    span: ['style'],
    div: ['style'],
    p: ['style'],
    br: [],
    ul: [],
    li: [],
  },
  css: {
    whiteList: {
      'text-align': /^(left|center|right)$/,
      'font-size': /^(1[0-9]|2[0-4])px$/, // 10px - 24px, matches the toolbar's own size options
    },
  },
  stripIgnoreTagBody: ['script', 'style'],
});

// Only ever called for a note's own description — a Task/Event's
// description stays plain text (this would mangle a legitimate "<" in
// something like "score < 70 means fail" if applied there).
function sanitizeNoteHtml(html) {
  if (!html) return html;
  return filterXSS.process(html);
}

module.exports = { sanitizeNoteHtml };
