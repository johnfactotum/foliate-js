const NS = {
    XML: 'http://www.w3.org/XML/1998/namespace',
    SSML: 'http://www.w3.org/2001/10/synthesis',
}

const blockTags = new Set([
    'article', 'aside', 'audio', 'blockquote', 'caption',
    'details', 'dialog', 'div', 'dl', 'dt', 'dd',
    'figure', 'footer', 'form', 'figcaption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
    'main', 'math', 'nav', 'ol', 'p', 'pre', 'section', 'tr',
])

const getLang = el => {
    const x = el.lang || el?.getAttributeNS?.(NS.XML, 'lang')
    return x ? x : el.parentElement ? getLang(el.parentElement) : null
}

const getAlphabet = el => {
    const x = el?.getAttributeNS?.(NS.XML, 'lang')
    return x ? x : el.parentElement ? getAlphabet(el.parentElement) : null
}

const getWalker = (getRoot, walk) => function* (x, func) {
    const root = getRoot(x)
    const filter = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
        | NodeFilter.SHOW_CDATA_SECTION
    const { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter
    const acceptNode = node => {
        if (node.nodeType === 1) {
            const name = node.tagName.toLowerCase()
            if (name === 'script' || name === 'style') return FILTER_REJECT
            return FILTER_SKIP
        }
        return FILTER_ACCEPT
    }
    const walker = document.createTreeWalker(root, filter, { acceptNode })
    const nodes = walk(x, walker)
    const strs = nodes.map(node => node.nodeValue)
    const makeRange = (startIndex, startOffset, endIndex, endOffset) => {
        const range = document.createRange()
        range.setStart(nodes[startIndex], startOffset)
        range.setEnd(nodes[endIndex], endOffset)
        return range
    }
    for (const match of func(strs, makeRange)) yield match
}

const rangeWalker = getWalker(x => x.commonAncestorContainer, (range, walker) => {
    const nodes = []
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
        const compare = range.comparePoint(node, 0)
        if (compare === 0) nodes.push(node)
        else if (compare > 0) break
    }
    return nodes
})

const fragmentWalker = getWalker(x => x, (range, walker) => {
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)
    return nodes
})

const getSegmenter = (lang = 'en', granularity = 'word') => {
    const segmenter = new Intl.Segmenter(lang, { granularity })
    const granularityIsWord = granularity === 'word'
    return function* (strs, makeRange) {
        const str = strs.join('')
        let name = 0
        let strIndex = -1
        let sum = 0
        for (const { index, segment, isWordLike } of segmenter.segment(str)) {
            if (granularityIsWord && !isWordLike) continue
            while (sum <= index) sum += strs[++strIndex].length
            const startIndex = strIndex
            const startOffset = index - (sum - strs[strIndex].length)
            const end = index + segment.length
            if (end < str.length) while (sum <= end) sum += strs[++strIndex].length
            const endIndex = strIndex
            const endOffset = end - (sum - strs[strIndex].length)
            yield [(name++).toString(),
                makeRange(startIndex, startOffset, endIndex, endOffset)]
        }
    }
}

const fragmentToSSML = (fragment, inherited) => {
    const ssml = document.implementation.createDocument(NS.SSML, 'speak')
    const { lang } = inherited
    if (lang) ssml.documentElement.setAttributeNS(NS.XML, 'lang', lang)

    const convert = (node, parent, inheritedAlphabet) => {
        if (!node) return
        if (node.nodeType === 3) return ssml.createTextNode(node.textContent)
        if (node.nodeType === 4) return ssml.createCDATASection(node.textContent)
        if (node.nodeType !== 1) return

        let el
        const nodeName = node.nodeName.toLowerCase()
        if (nodeName === 'foliate-mark') {
            el = ssml.createElementNS(NS.SSML, 'mark')
            el.setAttribute('name', node.dataset.name)
        }
        else if (nodeName === 'br')
            el = ssml.createElementNS(NS.SSML, 'break')
        else if (nodeName === 'em' || nodeName === 'strong')
            el = ssml.createElementNS(NS.SSML, 'emphasis')

        const lang = node.lang || node.getAttributeNS(NS.XML, 'lang')
        if (lang) {
            if (!el) el = ssml.createElementNS(NS.SSML, 'lang')
            el.setAttributeNS(NS.XML, 'lang', lang)
        }

        const alphabet = node.getAttributeNS(NS.SSML, 'alphabet') || inheritedAlphabet
        if (!el) {
            const ph = node.getAttributeNS(NS.SSML, 'ph')
            if (ph) {
                el = ssml.createElementNS(NS.SSML, 'phoneme')
                if (alphabet) el.setAttribute('alphabet', alphabet)
                el.setAttribute('ph', ph)
            }
        }

        if (!el) el = parent

        let child = node.firstChild
        while (child) {
            const childEl = convert(child, el, alphabet)
            if (childEl && el !== childEl) el.append(childEl)
            child = child.nextSibling
        }
        return el
    }
    convert(fragment.firstChild, ssml.documentElement, inherited.alphabet)
    return ssml
}

const getFragmentWithMarks = (range, granularity) => {
    const lang = getLang(range.commonAncestorContainer)
    const alphabet = getAlphabet(range.commonAncestorContainer)

    const segmenter = getSegmenter(lang, granularity)
    const fragment = range.cloneContents()

    // we need ranges on both the original document (for highlighting)
    // and the document fragment (for inserting marks)
    // so unfortunately need to do it twice, as you can't copy the ranges
    const entries = [...rangeWalker(range, segmenter)]
    const fragmentEntries = [...fragmentWalker(fragment, segmenter)]

    for (const [name, range] of fragmentEntries) {
        const mark = document.createElement('foliate-mark')
        mark.dataset.name = name
        range.insertNode(mark)
    }
    const ssml = fragmentToSSML(fragment, { lang, alphabet })
    return { entries, ssml }
}

const rangeIsEmpty = range => !range.toString().trim()

function* getBlocks(doc) {
    let last
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const name = node.tagName.toLowerCase()
        if (blockTags.has(name)) {
            if (last) {
                last.setEndBefore(node)
                if (!rangeIsEmpty(last)) yield last
            }
            last = doc.createRange()
            last.setStart(node, 0)
        }
    }
    if (!last) {
        last = doc.createRange()
        last.setStart(doc.body.firstChild ?? doc.body, 0)
    }
    last.setEndAfter(doc.body.lastChild ?? doc.body)
    if (!rangeIsEmpty(last)) yield last
}

class ListIterator {
    #arr = []
    #iter
    #index = -1
    #f
    constructor(iter, f = x => x) {
        this.#iter = iter
        this.#f = f
    }
    current() {
        if (this.#arr[this.#index]) return this.#f(this.#arr[this.#index])
    }
    first() {
        const newIndex = 0
        if (this.#arr[newIndex]) {
            this.#index = newIndex
            return this.#f(this.#arr[newIndex])
        }
    }
    prev() {
        const newIndex = this.#index - 1
        if (this.#arr[newIndex]) {
            this.#index = newIndex
            return this.#f(this.#arr[newIndex])
        }
    }
    next() {
        const newIndex = this.#index + 1
        if (this.#arr[newIndex]) {
            this.#index = newIndex
            return this.#f(this.#arr[newIndex])
        }
        while (true) {
            const { done, value } = this.#iter.next()
            if (done) break
            this.#arr.push(value)
            if (this.#arr[newIndex]) {
                this.#index = newIndex
                return this.#f(this.#arr[newIndex])
            }
        }
    }
    find(f) {
        const index = this.#arr.findIndex(x => f(x))
        if (index > -1) {
            this.#index = index
            return this.#f(this.#arr[index])
        }
        while (true) {
            const { done, value } = this.#iter.next()
            if (done) break
            this.#arr.push(value)
            if (f(value)) {
                this.#index = this.#arr.length - 1
                return this.#f(value)
            }
        }
    }
}

export class TTS {
    #list
    #ranges
    #lastMark
    #serializer = new XMLSerializer()
    constructor(doc, highlight) {
        this.doc = doc
        this.highlight = highlight
        this.#list = new ListIterator(getBlocks(doc), range => {
            const { entries, ssml } = getFragmentWithMarks(range)
            this.#ranges = new Map(entries)
            return [ssml, range]
        })
    }
    #getMarkElement(doc, mark) {
        if (!mark) return null
        return doc.querySelector(`mark[name="${CSS.escape(mark)}"`)
    }
    #speak(doc, getNode) {
        if (!doc) return
        if (!getNode) return this.#serializer.serializeToString(doc)
        const ssml = document.implementation.createDocument(NS.SSML, 'speak')
        ssml.documentElement.replaceWith(ssml.importNode(doc.documentElement, true))
        let node = getNode(ssml)?.previousSibling
        while (node) {
            const next = node.previousSibling ?? node.parentNode?.previousSibling
            node.parentNode.removeChild(node)
            node = next
        }
        return this.#serializer.serializeToString(ssml)
    }
    start() {
        this.#lastMark = null
        const [doc] = this.#list.first() ?? []
        if (!doc) return this.next()
        return this.#speak(doc, ssml => this.#getMarkElement(ssml, this.#lastMark))
    }
    resume() {
        const [doc] = this.#list.current() ?? []
        if (!doc) return this.next()
        return this.#speak(doc, ssml => this.#getMarkElement(ssml, this.#lastMark))
    }
    prev(paused) {
        this.#lastMark = null
        const [doc, range] = this.#list.prev() ?? []
        if (paused && range) this.highlight(range.cloneRange())
        return this.#speak(doc)
    }
    next(paused) {
        this.#lastMark = null
        const [doc, range] = this.#list.next() ?? []
        if (paused && range) this.highlight(range.cloneRange())
        return this.#speak(doc)
    }
    from(range) {
        this.#lastMark = null
        const [doc] = this.#list.find(range_ =>
            range.compareBoundaryPoints(Range.END_TO_START, range_) <= 0)
        let mark
        for (const [name, range_] of this.#ranges.entries())
            if (range.compareBoundaryPoints(Range.START_TO_START, range_) <= 0) {
                mark = name
                break
            }
        return this.#speak(doc, ssml => this.#getMarkElement(ssml, mark))
    }
    setMark(mark) {
        const range = this.#ranges.get(mark)
        if (range) {
            this.#lastMark = mark
            this.highlight(range.cloneRange())
        }
    }
}
