import * as CFI from './epubcfi.js'
import { TOCProgress, SectionProgress } from './progress.js'

const textWalker = function* (doc, func) {
    const filter = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
        | NodeFilter.SHOW_CDATA_SECTION
    const { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) return FILTER_SKIP
        return FILTER_ACCEPT
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)
    const strs = nodes.map(node => node.nodeValue)
    const makeRange = (startIndex, startOffset, endIndex, endOffset) => {
        const range = doc.createRange()
        range.setStart(nodes[startIndex], startOffset)
        range.setEnd(nodes[endIndex], endOffset)
        return range
    }
    for (const match of func(strs, makeRange)) yield match
}

const frameRect = (frame, rect) => {
    const left = rect.left + frame.left
    const right = rect.right + frame.left
    const top = rect.top + frame.top
    const bottom = rect.bottom + frame.top
    return { left, right, top, bottom }
}

const pointIsInView = ({ x, y }) =>
    x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight

export const getPosition = target => {
    // TODO: vertical text
    const frameElement = (target.getRootNode?.() ?? target?.endContainer?.getRootNode?.())
        ?.defaultView?.frameElement
    const frame = frameElement?.getBoundingClientRect() ?? { top: 0, left: 0 }
    const rects = Array.from(target.getClientRects())
    const first = frameRect(frame, rects[0])
    const last = frameRect(frame, rects.at(-1))
    const start = {
        point: { x: (first.left + first.right) / 2, y: first.top },
        dir: 'up',
    }
    const end = {
        point: { x: (last.left + last.right) / 2, y: last.bottom },
        dir: 'down',
    }
    const startInView = pointIsInView(start.point)
    const endInView = pointIsInView(end.point)
    if (!startInView && !endInView) return { point: { x: 0, y: 0 } }
    if (!startInView) return end
    if (!endInView) return start
    return start.point.y > window.innerHeight - end.point.y ? start : end
}

// https://www.w3.org/TR/epub-ssv-11/
const SSV = Object.fromEntries(Array.from(Object.entries({
    isRef: ['annoref', 'biblioref', 'glossref', 'noteref'],
    isLink: ['backlink'],
    isNote: ['annotation', 'note', 'footnote', 'endnote', 'rearnote'],
}), ([k, v]) => [k, el =>
    el.getAttributeNS('http://www.idpf.org/2007/ops', 'type')
        ?.split(/s/)?.some(t => v.includes(t))]))

export class View {
    #sectionProgress
    #tocProgress
    #pageProgress
    language = 'en'
    textDirection = ''
    isCJK = false
    isFixedLayout = false
    #css
    constructor(book, emit) {
        this.book = book
        this.emit = emit

        if (book.metadata?.language) try {
            const language = book.metadata.language
            book.metadata.language = Intl.getCanonicalLocales(language)[0]
            const tag = typeof language === 'string' ? language : language[0]
            const locale = new Intl.Locale(tag)
            this.isCJK = ['zh', 'ja', 'kr'].includes(locale.language)
            this.textDirection = locale.textInfo.direction
        } catch(e) {
            console.warn(e)
        }

        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 150, 1600)
            const splitHref = book.splitTOCHref.bind(book)
            const getFragment = book.getTOCFragment.bind(book)
            this.#tocProgress = new TOCProgress({
                toc: book.toc ?? [], ids, splitHref, getFragment })
            this.#pageProgress = new TOCProgress({
                toc: book.pageList ?? [], ids, splitHref, getFragment })
        }
    }
    async display() {
        const opts = {
            book: this.book,
            onLoad: this.#onLoad.bind(this),
            onRelocated: this.#onRelocated.bind(this),
        }
        this.isFixedLayout = this.book.rendition?.layout === 'pre-paginated'
        if (this.isFixedLayout) {
            const { FixedLayout } = await import('./fixed-layout.js')
            this.renderer = new FixedLayout(opts)
        } else {
            const { Paginator } = await import('./paginator.js')
            this.renderer = new Paginator(opts)
        }
        return this.renderer.element
    }
    #onRelocated(range, index, fraction) {
        if (!this.#sectionProgress) return
        const progress = this.#sectionProgress.getProgress(index, fraction)
        const tocItem = this.#tocProgress.getProgress(index, range)
        const pageItem = this.#pageProgress.getProgress(index, range)
        const cfi = this.getCFI(index, range)
        this.emit?.({ type: 'relocated', ...progress, tocItem, pageItem, cfi })
    }
    #onLoad(doc, index) {
        const { book } = this

        // set language and dir if not already set
        doc.documentElement.lang ||= this.language
        doc.documentElement.dir ||= this.isCJK ? '' : this.textDirection

        this.renderer.setStyle(this.#css)

        // set `document` background to `doc` background
        // this is needed cause the iframe does not fill the whole viewport
        const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
        document.body.style.background =
            bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
            && bodyStyle.backgroundImage === 'none'
                ? doc.defaultView.getComputedStyle(doc.documentElement).background
                : bodyStyle.background

        // set handlers for links
        const section = book.sections[index]
        for (const a of doc.querySelectorAll('a[href]'))
            a.addEventListener('click', e => {
                e.preventDefault()
                const href = a.getAttribute('href')
                const uri = section?.resolveHref?.(href) ?? href
                if (book?.isExternal?.(uri))
                    this.emit?.({ type: 'external-link', uri })
                else if (SSV.isRef(a)) {
                    const { index, anchor } = book.resolveHref(uri)
                    const pos = getPosition(a)
                    Promise.resolve(book.sections[index].createDocument())
                        .then(doc => [anchor(doc), doc.contentType])
                        .then(([el, type]) =>
                            [el?.innerHTML, type, SSV.isNote(el)])
                        .then(([content, contentType, isNote]) => content
                            ? this.emit?.({
                                type: 'reference',
                                href: isNote ? null : uri,
                                content, contentType, pos,
                            }) : null)
                        .catch(e => console.error(e))
                    return
                } else this.goTo(uri)
            })

        this.emit?.({ type: 'loaded', doc })
    }
    getCFI(index, range) {
        if (!range) return ''
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        return CFI.joinIndir(baseCFI, CFI.fromRange(range))
    }
    resolveCFI(cfi) {
        if (this.book.resolveCFI)
            return this.book.resolveCFI(cfi)
        else {
            const parts = CFI.parse(cfi)
            const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
            const anchor = doc => CFI.toRange(doc, parts)
            return { index, anchor }
        }
    }
    resolveNavigation(target) {
        try {
            if (typeof target === 'number') return { index: target }
            if (CFI.isCFI.test(target)) return this.resolveCFI(target)
            return this.book.resolveHref(target)
        } catch (e) {
            console.error(e)
            console.error(`Could not resolve target ${target}`)
        }
    }
    async goTo(target) {
        const resolved = this.resolveNavigation(target)
        try {
            await this.renderer.goTo(resolved)
            return resolved
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    async goToFraction(frac) {
        const [index, anchor] = this.#sectionProgress.getSection(frac)
        return this.renderer.goTo({ index, anchor })
    }
    async select(target) {
        try {
            const obj = await this.resolveNavigation(target)
            await this.renderer.goTo({ ...obj, select: true })
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    goLeft() {
        return this.book.dir === 'rtl' ? this.renderer.next() : this.renderer.prev()
    }
    goRight() {
        return this.book.dir === 'rtl' ? this.renderer.prev() : this.renderer.next()
    }
    setAppearance({ layout, css }) {
        if (this.isFixedLayout) return
        Object.assign(this.renderer.layout, layout)
        this.#css = css
        this.renderer.setStyle(css)
        this.renderer.render()
    }
    async * #searchSection(matcher, query, index) {
        const doc = await this.book.sections[index].createDocument()
        for (const { range, excerpt } of matcher(doc, query))
            yield { cfi: this.getCFI(index, range), excerpt }
    }
    async * #searchBook(matcher, query) {
        const { sections } = this.book
        for (const [index, { createDocument }] of sections.entries()) {
            if (!createDocument) continue
            const doc = await createDocument()
            const subitems = Array.from(matcher(doc, query), ({ range, excerpt }) =>
                ({ cfi: this.getCFI(index, range), excerpt }))
            const progress = (index + 1) / sections.length
            yield { progress }
            if (subitems.length) yield { index, subitems }
        }
    }
    async * search(opts) {
        const { searchMatcher } = await import('./search.js')
        const { query, index } = opts
        const matcher = searchMatcher(textWalker,
            { defaultLocale: this.language, ...opts })
        const iter = index != null
            ? this.#searchSection(matcher, query, index)
            : this.#searchBook(matcher, query)
        for await (const result of iter) yield 'subitems' in result ? {
            label: this.#tocProgress.getProgress(result.index)?.label ?? '',
            subitems: result.subitems,
        } : result
    }
}
