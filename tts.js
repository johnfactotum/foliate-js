const NS = {
    XML: 'http://www.w3.org/XML/1998/namespace',
    SSML: 'http://www.w3.org/2001/10/synthesis',
}

export const insertMarks = (textWalker, doc, granularity) => {
    const lang = doc.lang || doc.documentElement.getAttributeNS(NS.XML, 'lang') || 'en'
    const segmenter = new Intl.Segmenter(lang, { granularity })

    const granularityIsWord = granularity === 'word'
    const func = function* (strs, makeRange) {
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

    const clone = document.implementation.createHTMLDocument()
    clone.documentElement.replaceWith(clone.importNode(doc.documentElement, true))

    // we need the ranges on both the original document (for highlighting)
    // and the cloned document (for inserting marks)
    // so unfortunately we need to do it twice, as you can't copy the ranges
    // (not unless you serialize them, which is proly going to be even slower)
    const items = [...textWalker(doc, func)]
    const cloneItems = [...textWalker(clone, func)]

    for (const [name, range] of cloneItems) {
        const mark = clone.createElement('foliate-mark')
        mark.dataset.name = name
        range.insertNode(mark)
    }
    return { doc: clone, ranges: items }
}

export const toSSML = doc => {
    const ssml = document.implementation.createDocument(NS.SSML, 'speak')
    const lang = doc.lang || doc.documentElement.getAttributeNS(NS.XML, 'lang')
    if (lang) ssml.documentElement.setAttributeNS(NS.XML, 'lang', lang)

    const ps = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'dd']

    const convert = (node, parent, inheritedAlphabet) => {
        if (node.nodeType === 3) return ssml.createTextNode(node.textContent)
        if (node.nodeType === 4) return ssml.createCDATASection(node.textContent)
        if (node.nodeType !== 1) return

        let el
        const nodeName = node.nodeName.toLowerCase()
        if (nodeName === 'foliate-mark') {
            el = ssml.createElementNS(NS.SSML, 'mark')
            el.setAttribute('name', node.dataset.name)
        }
        else if (ps.includes(nodeName)) el = ssml.createElementNS(NS.SSML, 'p')
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
    return convert(doc.body, ssml.documentElement)
}
