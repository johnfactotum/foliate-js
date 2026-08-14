import { search, searchMatcher } from '../search.js'
import { textWalker } from '../text-walker.js'

// `search()` yields `{ range, excerpt }`, where the range is a set of indices
// into `strs`; the tests below it cover those, the ones at the end cover the
// DOM ranges `searchMatcher()` builds from them
const matches = (strs, query, options) =>
    Array.from(search(strs, query, options), ({ excerpt }) => excerpt)

// what `searchMatcher()` passes for a plain, case-insensitive search
const GRAPHEME = { granularity: 'grapheme', sensitivity: 'base' }

{
    // a match spanning more than two text runs must keep the runs in between;
    // `makeExcerpt()` used to index `strs` with the run contents rather than
    // the run indices, which silently dropped everything in the middle
    const [excerpt] = matches(
        ['Hello ', 'beautiful ', 'world'], 'lo beautiful wo', GRAPHEME)
    const a = excerpt?.match
    const b = 'lo beautiful wo'
    console.assert(a === b, `expected ${b}, got ${a}`)
}

{
    // two runs can hold identical text; the excerpt must be built from the run
    // positions, not by comparing the runs themselves
    const [excerpt] = matches(['abc', 'abc'], 'ca', GRAPHEME)
    const a = excerpt?.match
    const b = 'ca'
    console.assert(a === b, `expected ${b}, got ${a}`)
}

{
    // matches within a single run, and the surrounding context, are unaffected
    const [excerpt] = matches(['one two three'], 'two', GRAPHEME)
    for (const [key, b] of [['pre', 'one '], ['match', 'two'], ['post', ' three']]) {
        const a = excerpt?.[key]
        console.assert(a === b, `expected ${key} ${b}, got ${a}`)
    }
}

// matching case or diacritics without whole words goes through `simpleSearch()`
const SIMPLE = { granularity: 'grapheme', sensitivity: 'variant' }

{
    // a match reaching the very end of the text must not walk past the last
    // run while looking for the one holding the (exclusive) end offset
    for (const strs of [['abc'], ['ab', 'c'], ['a', 'b', 'c']]) {
        let excerpt
        try {
            [excerpt] = matches(strs, 'abc', SIMPLE)
        } catch (e) {
            console.assert(false, `threw for ${JSON.stringify(strs)}: ${e}`)
        }
        const a = excerpt?.match
        console.assert(a === 'abc', `expected abc for ${JSON.stringify(strs)}, got ${a}`)
    }
}

{
    // a match ending on a run boundary still keeps the following run as context
    const [excerpt] = matches(['ab', 'cd'], 'ab', SIMPLE)
    for (const [key, b] of [['match', 'ab'], ['post', 'cd']]) {
        const a = excerpt?.[key]
        console.assert(a === b, `expected ${key} ${b}, got ${a}`)
    }
}

{
    // overlapping matches: walking to the end of one match must not move the
    // cursor used to find the start of the next, which begins before it ends
    const results = Array.from(search(['a', 'a', 'a'], 'aa', SIMPLE))
    console.assert(results.length === 2, `expected 2 matches, got ${results.length}`)
    for (const [i, b] of [[0, [0, 0, 2, 0]], [1, [1, 0, 2, 1]]]) {
        const { range, excerpt } = results[i] ?? {}
        const a = range && [
            range.startIndex, range.startOffset, range.endIndex, range.endOffset]
        console.assert(a?.join() === b.join(), `expected range ${b}, got ${a}`)
        console.assert(excerpt?.match === 'aa', `expected aa, got ${excerpt?.match}`)
    }
}

// the real path: `searchMatcher()` walks the document, so a single match can
// span several text nodes, and the offsets it yields are passed straight to
// `Range.setStart()` / `.setEnd()`, which reject invalid ones outright
const parser = new DOMParser()
const doc = body => parser.parseFromString('<html xmlns='
    + '"http://www.w3.org/1999/xhtml"><head><title>…</title></head><body>'
    + `${body}</body></html>`, 'application/xhtml+xml')

// case and diacritics without whole words is the `simpleSearch()` route
const EXACT = { matchCase: true, matchDiacritics: true }

{
    // inline markup splits a paragraph into separate text nodes, so an
    // ordinary match already spans several of them
    const matcher = searchMatcher(textWalker, {})
    const [result] = Array.from(matcher(
        doc('<p>Hello <em>beautiful</em> world</p>'), 'lo beautiful wo'))
    const a = result?.range.toString()
    const b = 'lo beautiful wo'
    console.assert(a === b, `expected ${b}, got ${a}`)
}

{
    // a match ending at the end of the last text node must not overrun it
    const matcher = searchMatcher(textWalker, EXACT)
    const [result] = Array.from(matcher(
        doc('<p>Hello <em>beautiful</em> world</p>'), 'world'))
    const a = result?.range.toString()
    console.assert(a === 'world', `expected world, got ${a}`)
}

{
    // overlapping matches across text nodes: sharing the cursor between the
    // start and the end of a match left a negative offset, which is not a
    // wrong range but no range at all, as `setStart()` throws on it
    const matcher = searchMatcher(textWalker, EXACT)
    let results
    try {
        results = Array.from(matcher(doc('<p>a<em>a</em>a</p>'), 'aa'))
    } catch (e) {
        console.assert(false, `matching threw: ${e}`)
    }
    console.assert(results?.length === 2, `expected 2 matches, got ${results?.length}`)
    for (const { range } of results ?? [])
        console.assert(range.toString() === 'aa', `expected aa, got ${range}`)
}
