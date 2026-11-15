// Pages
// =====
// A text that is too long for one message is logged as pages: messages in a
// row, of at most PAGE characters each. A text that is kept is never cut: it
// goes in pages (a message that is logged, a zoom).
//
// Ported from the old code (ref/src/clip.ts: clip_end, clip_pages,
// clip_page). The head-and-tail form of a long result is not here: it is
// the output limit (limit.ts).

// The most characters of one page. It is also the most text that a model
// gets in one piece.
export const PAGE = 30000

// Where the page of `text` that starts at `at` ends: PAGE characters on,
// after its last newline if it has one, else where a character ends (not
// between the two halves of a surrogate pair).
export const pageEnd = (text: string, at: number): number => {
  if (text.length - at <= PAGE) {
    return text.length
  }
  const newline = text.lastIndexOf("\n", at + PAGE - 1)
  const low = text.charCodeAt(at + PAGE) >> 10 === 0x37
  return newline >= at ? newline + 1 : at + PAGE - (low ? 1 : 0)
}

// A text in pages. An empty text is one empty page.
export const pages = (text: string): Array<string> => {
  const out: Array<string> = []
  let at = 0
  do {
    const end = pageEnd(text, at)
    out.push(text.slice(at, end))
    at = end
  } while (at < text.length)
  return out
}

// The page of `text` from `at`, and, when the text goes on, a line that says
// where to continue.
export const page = (text: string, at: number): string => {
  const end = pageEnd(text, at)
  const on = "\n[characters " + (at + 1) + "-" + end + " of " + text.length + "; go on with at " + end + "]"
  return text.slice(at, end) + (end < text.length ? on : "")
}
