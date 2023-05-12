import * as CFI from './epubcfi.js'
import { TOCProgress, SectionProgress } from './progress.js'
import { Overlayer } from './overlayer.js'

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

export class View {
    #sectionProgress
    #tocProgress
    #pageProgress
    #css
    language = 'en'
    textDirection = ''
    isCJK = false
    isFixedLayout = false
    constructor(book, emit) {
        this.book = book
        this.emit = emit

        if (book.metadata?.language) try {
            const language = book.metadata.language
            book.metadata.language = Intl.getCanonicalLocales(language)[0]
            const tag = typeof language === 'string' ? language : language[0]
            const locale = new Intl.Locale(tag)
            this.isCJK = ['zh', 'ja', 'kr'].includes(locale.language)
            this.textDirection = (locale.getTextInfo?.() ?? locale.textInfo)?.direction
        } catch(e) {
            console.warn(e)
        }

        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 1500, 1600)
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
            createOverlayer: this.#createOverlayer.bind(this),
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
    async init({ lastLocation }) {
        if (lastLocation) {
            const resolved = this.resolveNavigation(lastLocation)
            if (resolved) await this.renderer.goTo(resolved)
            else await this.renderer.next()
        } else await this.renderer.next()
    }
    #onRelocated(range, index, fraction, size) {
        if (!this.#sectionProgress) return
        const progress = this.#sectionProgress.getProgress(index, fraction, size)
        const tocItem = this.#tocProgress.getProgress(index, range)
        const pageItem = this.#pageProgress.getProgress(index, range)
        const cfi = this.getCFI(index, range)
        this.emit?.({ type: 'relocated', ...progress, tocItem, pageItem, cfi, range })
    }
    #onLoad(doc, index) {
        // set language and dir if not already set
        doc.documentElement.lang ||= this.language
        doc.documentElement.dir ||= this.isCJK ? '' : this.textDirection

        this.renderer.setStyle?.(this.#css)
        this.handleLinks(doc, index, this.emit)

        this.emit?.({ type: 'loaded', doc, index })
    }
    handleLinks(doc, index, emit) {
        const { book } = this
        const section = book.sections[index]
        for (const a of doc.querySelectorAll('a[href]'))
            a.addEventListener('click', e => {
                e.preventDefault()
                const href_ = a.getAttribute('href')
                const href = section?.resolveHref?.(href_) ?? href_
                if (book?.isExternal?.(href))
                    Promise.resolve(emit?.({ type: 'external-link', a, href }))
                        .then(x => x ? null : window.open(href, '_blank'))
                        .catch(e => console.error(e))
                else Promise.resolve(emit?.({ type: 'link', a, href }))
                    .then(x => x ? null : this.goTo(href))
                    .catch(e => console.error(e))
            })
    }
    async addAnnotation(annotation, remove) {
        const { value } = annotation
        const { index, anchor } = await this.resolveNavigation(value)
        const obj = this.#getOverlayer(index)
        if (obj) {
            const { overlayer, doc } = obj
            overlayer.remove(value)
            if (!remove) {
                const range = doc ? anchor(doc) : anchor
                const [func, opts] = this
                    .emit({ type: 'draw-annotation', annotation, doc, range })
                overlayer.add(value, range, func, opts)
            }
        }
        const label = this.#tocProgress.getProgress(index)?.label ?? ''
        return { index, label }
    }
    deleteAnnotation(annotation) {
        return this.addAnnotation(annotation, true)
    }
    #getOverlayer(index) {
        const obj = this.renderer.getOverlayer()
        if (obj.index === index) return obj
    }
    #createOverlayer(doc, index) {
        const overlayer = new Overlayer()
        doc.addEventListener('click', e => {
            const [value, range] = overlayer.hitTest(e)
            if (value) {
                this.emit?.({ type: 'show-annotation', value, range })
            }
        }, false)
        this.emit?.({ type: 'create-overlay', index })
        return overlayer
    }
    async showAnnotation(annotation) {
        const { value } = annotation
        const { index, anchor } = await this.goTo(value)
        const { doc } =  this.#getOverlayer(index)
        const range = anchor(doc)
        this.emit?.({ type: 'show-annotation', value, range })
    }
    getCFI(index, range) {
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        if (!range) return baseCFI
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
    deselect() {
        return this.renderer.deselect?.()
    }
    async getTOCItemOf(target) {
        try {
            const { index, anchor } = await this.resolveNavigation(target)
            const doc = await this.book.sections[index].createDocument()
            const frag = anchor(doc)
            const isRange = frag instanceof Range
            const range = isRange ? frag : doc.createRange()
            if (!isRange) range.selectNodeContents(frag)
            return this.#tocProgress.getProgress(index, range)
        } catch(e) {
            console.error(e)
            console.error(`Could not get ${target}`)
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
        yield 'done'
    }
    destroy() {
        this.book.destroy?.()
        this.renderer?.destroy?.()
    }
}
