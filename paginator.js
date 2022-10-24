const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) return endContainer
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(a.getBoundingClientRect())
            const q = mapRect(b.getBoundingClientRect())
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(a.getBoundingClientRect())
            const q = mapRect(b.getBoundingClientRect())
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

class View {
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container }) {
        this.container = container
        this.#iframe.classList.add('filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl })
                this.#iframe.style.display = 'block'
                this.render(layout)
                new ResizeObserver(() => this.expand()).observe(doc.body)

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        Object.assign(doc.documentElement.style, {
            boxSizing: 'border-box',
            padding: vertical ? `${gap}px 0` : `0 ${gap}px`,
            columnWidth: 'auto',
            height: 'auto',
            width: 'auto',
        })
        Object.assign(doc.body.style, {
            [vertical ? 'maxHeight' : 'maxWidth']: `${columnWidth}px`,
            margin: 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        const gapPadding = `${gap / 2}px`
        const marginPadding = `${margin}px`
        Object.assign(doc.documentElement.style, {
            boxSizing: 'border-box',
            columnWidth: `${columnWidth}px`,
            columnGap: `${gap}px`,
            columnFill: 'auto',
            ...(vertical
                ? { width: `${width}px` }
                : { height: `${height}px` }),
            padding: (vertical
                ? [gapPadding, marginPadding]
                : [marginPadding, gapPadding]).join(' '),
            overflow: 'hidden',
            // force wrap long words
            overflowWrap: 'anywhere',
            // reset some potentially problematic props
            position: 'static', border: '0', margin: '0',
            maxHeight: 'none', maxWidth: 'none',
            minHeight: 'none', minWidth: 'none',
        })
        Object.assign(doc.body.style, {
            maxHeight: 'none',
            maxWidth: 'none',
            margin: '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            Object.assign(el.style, {
                maxHeight: vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                maxWidth: vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                objectFit: 'contain',
                pageBreakInside: 'avoid',
                breakInside: 'avoid',
                boxSizing: 'border-box',
            })
        }
    }
    expand() {
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentSize = this.#contentRange.getBoundingClientRect()[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const doc = this.document
            const contentSize = doc?.documentElement?.getBoundingClientRect()?.[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator {
    #element = document.createElement('div')
    #view
    #vertical = false
    #rtl = false
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #locked = false // while true, prevent any further navigation
    #styleMap = new WeakMap()
    layout = {
        margin: 48,
        gap: 40,
        maxColumnWidth: 700,
    }
    constructor({ book, onLoad, onRelocated, createOverlayer }) {
        this.sections = book.sections
        this.onLoad = onLoad
        this.onRelocated = onRelocated
        this.createOverlayer = createOverlayer
        Object.assign(this.#element.style, {
            display: 'flex',
            flexWrap: 'nowrap',
            overflow: 'hidden',
            position: 'absolute',
        })
        new ResizeObserver(() => this.render()).observe(this.#element)
        this.#element.addEventListener('scroll', debounce(() => {
            if (this.scrolled) this.#afterScroll('scroll')
        }, 250))
    }
    get element() {
        return this.#element
    }
    #createView() {
        if (this.#view) this.#element.removeChild(this.#view.element)
        this.#view = new View({ container: this.#element })
        this.#element.append(this.#view.element)
        return this.#view
    }
    #beforeRender({ vertical, rtl }) {
        this.#vertical = vertical
        this.#rtl = rtl
        const { flow, margin, gap, maxColumnWidth } = this.layout
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.#element.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            Object.assign(this.#element.style, {
                width: '100%',
                height: '100%',
                margin: '0',
                overflow: 'scroll',
            })
            const columnWidth = this.layout.maxColumnWidth
            return { flow, margin, gap, columnWidth }
        }
        const { width, height } = this.#element.getBoundingClientRect()
        const size = vertical ? height : width
        const divisor = Math.ceil(size / maxColumnWidth)
        const columnWidth = (size / divisor) - gap
        this.#element.setAttribute('dir', rtl ? 'rtl' : 'ltr')
        Object.assign(this.#element.style, {
            width: vertical ? '100%' : `calc(100% - ${gap}px)`,
            height: vertical ? `calc(100% - ${margin}px)` : '100%',
            marginLeft: vertical ? '0' : `${gap / 2}px`,
            marginTop: vertical ? `${margin / 2}px` : '0',
            overflow: 'hidden',
        })
        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor()
    }
    get scrolled() {
        return this.layout.flow === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#element.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#element[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return this.viewSize / this.size
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.layout.margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
            + this.layout.margin / 2
        return this.#scrollToPage(Math.floor(offset / this.size), reason)
    }
    async #scrollTo(offset, reason) {
        const element = this.#element
        const { scrollProp } = this
        if (element[scrollProp] === offset) {
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        element[scrollProp] = offset
        this.#afterScroll(reason)
        /*return new Promise((resolve, reject) => {
            try {
                const onScroll = () => {
                    if (element[scrollProp] - offset > 2) return
                    element.removeEventListener('scroll', onScroll)
                    resolve()
                    this.#afterScroll(reason)
                }
                element.addEventListener('scroll', onScroll)
                if (this.scrolled) {
                    const coord = scrollProp === 'scrollLeft' ? 'left' : 'top'
                    element.scrollTo({ [coord]: offset, behavior: 'smooth' })
                }
                element[scrollProp] = offset
            } catch (e) {
                reject(e)
            }
        })*/
    }
    async #scrollToPage(page, reason) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason)
    }
    async #scrollToAnchor(select) {
        const rect = uncollapse(this.#anchor).getBoundingClientRect?.()
        // if anchor is an element or a range
        if (rect) {
            await this.#scrollToRect(rect, 'anchor')
            if (select) this.#selectAnchor()
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(this.#anchor * this.viewSize, 'anchor')
            return
        }
        const { pages } = this
        if (!pages) return
        const newPage = Math.round(this.#anchor * (pages - 1))
        await this.#scrollToPage(newPage, 'anchor')
    }
    #selectAnchor() {
        const { defaultView } = this.#view.document
        if (this.#anchor instanceof defaultView.Range) {
            const sel = defaultView.getSelection()
            sel.removeAllRanges()
            sel.addRange(this.#anchor)
        }
    }
    #getVisibleRange() {
        return getVisibleRange(this.#view.document,
            this.start, this.end, this.#getRectMapper(), this.scrolled)
    }
    #afterScroll(reason) {
        const range = this.#getVisibleRange()
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'anchor') this.#anchor = range
        const index = this.#index
        if (this.scrolled)
            this.onRelocated?.(range, index, this.end / this.viewSize)
        else if (this.pages > 0)
            this.onRelocated?.(range, index, (this.page + 1) / this.pages)
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, $style)
                }
                onLoad?.(doc, index)
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            const overlayer = this.createOverlayer?.(view.document, index)
            if (overlayer) view.overlayer = overlayer
            this.#view = view
        }
        this.#anchor = (typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0
        await this.#scrollToAnchor(select)
    }
    #canScrollToPage(page) {
        return page > -1 && page < this.pages
    }
    scrollPrev() {
        if (!this.#view) return null
        if (this.scrolled) {
            if (this.start > 0)
                return this.#scrollTo(Math.max(0, this.start - this.size))
            else return null
        }
        const page = this.page - 1
        if (this.#canScrollToPage(page)) return this.#scrollToPage(page)
        return null
    }
    scrollNext() {
        if (!this.#view) return null
        if (this.scrolled) {
            if (this.viewSize - this.end > 2)
                return this.#scrollTo(Math.min(this.viewSize, this.end))
            else return null
        }
        const page = this.page + 1
        if (this.#canScrollToPage(page)) return this.#scrollToPage(page)
        return null
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo(tryScroll, target, lock) {
        if (this.#locked) return
        if (lock) this.#locked = true
        const scroll = tryScroll?.()
        if (scroll) await scroll
        else {
            const { index, anchor, select } = await target
            if (!this.#canGoToIndex(index)) {
                this.#locked = false
                return null
            }
            if (index === this.#index) await this.#display({ index, anchor, select })
            else {
                const oldIndex = this.#index
                const onLoad = (...args) => {
                    this.sections[oldIndex]?.unload?.()
                    this.onLoad?.(...args)
                }
                await this.#display(Promise.resolve(this.sections[index].load())
                    .then(src => ({ index, src, anchor, onLoad, select }))
                    .catch(e => {
                        console.warn(e)
                        console.warn(new Error(`Failed to load section ${index}`))
                        return {}
                    }))
            }
        }
        if (lock) {
            await wait(100) // throttle by 100ms
            this.#locked = false
        }
    }
    async goTo(target) {
        return this.#goTo(null, target)
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    prev() {
        const index = this.#adjacentIndex(-1)
        return this.#goTo(() => this.scrollPrev(), { index, anchor: () => 1 }, true)
    }
    next() {
        const index = this.#adjacentIndex(1)
        return this.#goTo(() => this.scrollNext(), { index }, true)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getOverlayer() {
        if (this.#view) return {
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }
    }
    setStyle(style) {
        const $style = this.#styleMap.get(this.#view?.document)
        if ($style) $style.textContent = style
    }
    async #setAnchor(anchor, select) {
        this.#anchor = anchor
        await this.#scrollToAnchor(select)
    }
}
