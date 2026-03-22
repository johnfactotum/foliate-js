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

// Transforms ALL children of the container so multi-view layouts
// animate as a unified whole. Extra elements (e.g. background) are
// also transformed so they slide in sync with the content.
const animateScroll = (element, scrollProp, startValue, endValue, duration, extraElements = []) => new Promise(resolve => {
    if (document.hidden) {
        element[scrollProp] = endValue
        return resolve()
    }

    const children = [...element.children]
    if (!children.length) {
        element[scrollProp] = endValue
        return resolve()
    }

    const allElements = [...children, ...extraElements]
    const isHorizontal = scrollProp === 'scrollLeft'
    const delta = endValue - startValue
    const transformProp = isHorizontal ? 'translateX' : 'translateY'

    // Prepare all elements for animation
    for (const el of allElements) {
        el.style.willChange = 'transform'
        el.style.transform = `${transformProp}(0px)`
        el.style.transition = 'none'
    }

    // Force reflow to apply initial state
    element.getBoundingClientRect()

    // Start animation on all elements
    for (const el of allElements) {
        el.style.transition = `transform ${duration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`
        el.style.transform = `${transformProp}(${-delta}px)`
    }

    let resolved = false
    const cleanup = () => {
        if (resolved) return
        resolved = true

        for (const el of allElements) {
            el.style.willChange = ''
            el.style.transform = ''
            el.style.transition = ''
        }

        // Apply final scroll position
        element[scrollProp] = endValue
        resolve()
    }

    // Listen for transition end on the first child
    const first = children[0]
    const onTransitionEnd = (e) => {
        if (e.target === first && e.propertyName === 'transform') {
            first.removeEventListener('transitionend', onTransitionEnd)
            cleanup()
        }
    }
    first.addEventListener('transitionend', onTransitionEnd)

    // Fallback timeout in case transitionend doesn't fire
    setTimeout(cleanup, duration + 50)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
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

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            if (left === 0 && right === 0) return FILTER_REJECT
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
            if (left === 0 && right === 0) return FILTER_REJECT
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
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument?.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
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

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStyles = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v)
}

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #columnCount = 1
    #layout = {}
    #padding = { before: 1, after: 1 }
    #alignColumns = 0
    #contentPages = 0
    fontReady = Promise.resolve()
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'flex-start',
            alignItems: 'center',
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
    get contentPages() {
        return this.#contentPages
    }
    set padding(val) {
        if (this.#padding.before === val.before && this.#padding.after === val.after) return
        this.#padding = val
        this.expand()
    }
    get padding() {
        return this.#padding
    }
    set alignColumns(val) {
        if (this.#alignColumns !== val) {
            this.#alignColumns = val
            this.expand()
        }
    }
    get alignColumns() {
        return this.#alignColumns
    }
    async load(src, data, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                this.#iframe.setAttribute('aria-label', doc.title)
                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                this.docBackground = getBackground(doc)
                doc.body.style.background = 'none'
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                this.fontReady = doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            if (data) {
                this.#iframe.srcdoc = data
            } else {
                this.#iframe.src = src
            }
        })
    }
    render(layout) {
        if (!layout || !this.document?.documentElement) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ width, height, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        const availableWidth = Math.trunc(width - marginLeft - marginRight)
        const availableHeight = Math.trunc(height - marginTop - marginBottom)
        setStyles(doc.documentElement, {
            'padding': vertical
                ? `${marginTop * 1.5}px ${marginRight}px ${marginBottom * 1.5}px ${marginLeft}px`
                : `${marginTop}px ${gap / 2 + marginRight / 2}px ${marginBottom}px ${gap / 2 + marginLeft / 2}px`,
            '--page-margin-top': `${vertical ? marginTop * 1.5 : marginTop}px`,
            '--page-margin-right': `${vertical ? marginRight : marginRight + gap /2}px`,
            '--page-margin-bottom': `${vertical ? marginBottom * 1.5 : marginBottom}px`,
            '--page-margin-left': `${vertical ? marginLeft : marginLeft + gap / 2}px`,
            '--full-width': `${Math.trunc(window.innerWidth)}`,
            '--full-height': `${Math.trunc(window.innerHeight)}`,
            '--available-width': `${availableWidth}`,
            '--available-height': `${availableHeight}`,
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize(availableWidth, availableHeight)
        this.expand()
    }
    columnize({ width, height, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth, columnCount }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width
        this.#columnCount = columnCount || 1

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': vertical ? `${(marginTop + marginBottom) * 1.5}px` : `${gap + marginRight / 2 + marginLeft / 2}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        const availableWidth = Math.trunc(columnWidth - marginLeft - marginRight - gap)
        const availableHeight = Math.trunc(height - marginTop - marginBottom)
        setStyles(doc.documentElement, {
            'padding': vertical
                ? `${marginTop * 1.5}px ${marginRight}px ${marginBottom * 1.5}px ${marginLeft}px`
                : `${marginTop}px ${gap / 2 + marginRight / 2}px ${marginBottom}px ${gap / 2 + marginLeft / 2}px`,
            '--page-margin-top': `${vertical ? marginTop * 1.5 : marginTop}px`,
            '--page-margin-right': `${vertical ? marginRight : marginRight / 2 + gap /2}px`,
            '--page-margin-bottom': `${vertical ? marginBottom * 1.5 : marginBottom}px`,
            '--page-margin-left': `${vertical ? marginLeft : marginLeft / 2 + gap / 2}px`,
            '--full-width': `${Math.trunc(window.innerWidth)}`,
            '--full-height': `${Math.trunc(window.innerHeight)}`,
            '--available-width': `${availableWidth}`,
            '--available-height': `${availableHeight}`,
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize(availableWidth, availableHeight)
        this.expand()
    }
    setImageSize(availableWidth, availableHeight) {
        const { width, height, marginTop, marginRight, marginBottom, marginLeft } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        const pageFullscreen = doc.documentElement.hasAttribute('data-duokan-page-fullscreen')
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            let { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            if (parseInt(maxWidth) > availableWidth) {
                maxWidth = `${availableWidth}px`
            }
            if (parseInt(maxHeight) > availableHeight) {
                maxHeight = `${availableHeight}px`
            }
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - (pageFullscreen ? 0 : (marginTop + marginBottom))}px`,
                'max-width': vertical
                    ? `${width - (pageFullscreen ? 0 : (marginLeft + marginRight))}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': pageFullscreen ? 'cover': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
            if (pageFullscreen) {
                setStylesImportant(el, {
                    position: 'fixed',
                    inset: '0',
                })
                let ancestor = el.parentElement
                while (ancestor && ancestor !== doc.body) {
                    setStylesImportant(ancestor, {
                        position: 'relative',
                        width: '100%',
                        height: '100%',
                        margin: '0',
                        padding: '0',
                    })
                    ancestor = ancestor.parentElement
                }
                if (el.localName === 'svg') {
                    el.setAttribute('preserveAspectRatio', 'xMidYMid slice')
                }
            }
        }
    }
    get #zoom() {
        // Safari does not zoom the client rects, while Chrome, Edge and Firefox does
        if (/^((?!chrome|android).)*AppleWebKit/i.test(navigator.userAgent) && !window.chrome) {
            return window.getComputedStyle(this.document.body).zoom || 1.0
        }
        return 1.0
    }
    expand() {
        if (!this.document?.documentElement) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = (contentStart + contentRect[side]) * this.#zoom
            // Size content by individual columns, not full spreads.
            // This allows adjacent sections to share a spread when a
            // section doesn't fill all available columns.
            const columnSize = this.#size / this.#columnCount
            const pageCount = Math.ceil(contentSize / columnSize)
            this.#contentPages = pageCount
            const { before, after } = this.#padding
            const expandedSize = pageCount * columnSize
            // Use CSS padding on the element to position the iframe after
            // the before-padding space. With content-box sizing, total
            // rendered size = padding + content width.
            // alignColumns adds blank columns before the content to push
            // short sections to the end of a spread.
            const alignPx = this.#alignColumns * columnSize
            const beforePx = this.#size * before + alignPx
            const afterPx = this.#size * after
            this.#element.style.padding = '0'
            if (this.#vertical) {
                this.#element.style.paddingTop = `${beforePx}px`
                this.#element.style.paddingBottom = `${afterPx}px`
            } else if (this.#rtl) {
                this.#element.style.paddingRight = `${beforePx}px`
                this.#element.style.paddingLeft = `${afterPx}px`
            } else {
                this.#element.style.paddingLeft = `${beforePx}px`
                this.#element.style.paddingRight = `${afterPx}px`
            }
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            // One column per "page" — overflow columns extend into adjacent pages
            documentElement.style[side] = `${columnSize}px`
            const beforeOffset = beforePx
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${beforeOffset}px`
                this.#overlayer.element.style.top = this.#vertical ? `${beforeOffset}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    #loupeEl = null
    #loupeScaler = null
    #loupeCursor = null
    // Show a magnifier loupe inside the iframe document.
    // winX/winY are in main-window (screen) coordinates.
    showLoupe(winX, winY, { isVertical, color, gap, margin, radius, magnification }) {
        const doc = this.document
        if (!doc) return

        const frameRect = this.#iframe.getBoundingClientRect()
        // Cursor in iframe-viewport coordinates.
        const vpX = winX - frameRect.left
        const vpY = winY - frameRect.top

        // Cursor in document coordinates (accounts for scroll).
        const scrollX = doc.scrollingElement?.scrollLeft ?? 0
        const scrollY = doc.scrollingElement?.scrollTop ?? 0
        const docX = vpX + scrollX
        const docY = vpY + scrollY

        const MAGNIFICATION = magnification
        const MARGIN = margin

        // Capsule dimensions: elongated along the reading direction.
        // For horizontal text the capsule is wider; for vertical it is taller.
        const shortSide = radius * 2
        const longSide  = Math.round(radius * 3.6)
        const loupeW = isVertical ? shortSide : longSide
        const loupeH = isVertical ? longSide  : shortSide
        const halfW = loupeW / 2
        const halfH = loupeH / 2
        const borderRadius = shortSide / 2  // fully rounded ends

        // Position loupe above the cursor (or to the left for vertical text).
        const GAP = gap
        let loupeLeft = isVertical ? vpX - loupeW - GAP : vpX - halfW
        let loupeTop  = isVertical ? vpY - halfH        : vpY - loupeH - GAP
        loupeLeft = Math.max(MARGIN, Math.min(loupeLeft, frameRect.width  - loupeW - MARGIN))
        loupeTop  = Math.max(MARGIN, Math.min(loupeTop,  frameRect.height - loupeH - MARGIN))

        // CSS-transform math: map document point (docX, docY) to loupe centre.
        //   visual_pos = offset + coord × MAGNIFICATION = halfW (or halfH)
        //   ⟹ offset = half − coord × MAGNIFICATION
        const offsetX = halfW - docX * MAGNIFICATION
        const offsetY = halfH - docY * MAGNIFICATION

        // Build loupe DOM structure once; cache it across hide/show cycles so
        // the expensive body clone is not repeated on every drag start.
        if (!this.#loupeEl || !this.#loupeEl.isConnected) {
            this.#loupeEl = doc.createElement('div')

            // Clone the live body once — inside the iframe the epub's CSS
            // variables, @font-face fonts, and styles apply automatically.
            const bodyClone = doc.body.cloneNode(true)

            // Wrap the clone in a div that replicates documentElement's inline
            // styles (column-width, column-gap, padding, height, etc.) so text
            // flows with the same column layout as the original document.
            const htmlWrapper = doc.createElement('div')
            htmlWrapper.style.cssText = doc.documentElement.style.cssText
            // expand() constrains documentElement's page-axis dimension to one
            // page size (width for horizontal, height for vertical).  Override
            // with the full scroll dimension so all columns are rendered.
            if (this.#vertical)
                htmlWrapper.style.height = `${doc.documentElement.scrollHeight}px`
            else
                htmlWrapper.style.width = `${doc.documentElement.scrollWidth}px`
            htmlWrapper.appendChild(bodyClone)

            this.#loupeScaler = doc.createElement('div')
            this.#loupeScaler.appendChild(htmlWrapper)

            const cursorLen = Math.round(shortSide * 0.44)
            this.#loupeCursor = doc.createElement('div')
            this.#loupeCursor.style.cssText = isVertical
                ? `position:absolute;left:calc(50% - ${cursorLen / 2}px);top:50%;`
                + `margin-top:-1px;width:${cursorLen}px;height:2px;background:${color};pointer-events:none;z-index:1;box-sizing:border-box;`
                : `position:absolute;left:50%;top:calc(50% - ${cursorLen / 2}px);`
                + `margin-left:-1px;width:2px;height:${cursorLen}px;background:${color};pointer-events:none;z-index:1;box-sizing:border-box;`

            this.#loupeEl.appendChild(this.#loupeScaler)
            this.#loupeEl.appendChild(this.#loupeCursor)
            doc.documentElement.appendChild(this.#loupeEl)

            // Static loupe shell styles (set once).
            this.#loupeEl.style.cssText = `
                position: absolute;
                width: ${loupeW}px;
                height: ${loupeH}px;
                border-radius: ${borderRadius}px;
                overflow: hidden;
                border: 2.5px solid ${color};
                box-shadow: 0 6px 24px rgba(0,0,0,0.28);
                background-color: var(--theme-bg-color);
                z-index: 9999;
                pointer-events: none;
                user-select: none;
                box-sizing: border-box;
                contain: strict;
            `

            // Static scaler styles (set once; only left/top change per move).
            this.#loupeScaler.style.cssText = `
                position: absolute;
                transform: scale(${MAGNIFICATION});
                transform-origin: 0 0;
                pointer-events: none;
            `
        }

        // Ensure visible (hideLoupe hides via CSS instead of removing).
        this.#loupeEl.style.display = ''

        // Update only the dynamic position values (fast path on every move).
        this.#loupeScaler.style.left = `${offsetX}px`
        this.#loupeScaler.style.top = `${offsetY}px`
        this.#loupeScaler.style.width = `${doc.documentElement.scrollWidth}px`
        this.#loupeScaler.style.height = `${doc.documentElement.scrollHeight}px`
        this.#loupeEl.style.left = `${loupeLeft + scrollX}px`
        this.#loupeEl.style.top = `${loupeTop + scrollY}px`

        // Cut a capsule-shaped hole in the overlayer so highlights don't paint
        // over the loupe.
        if (this.#overlayer) {
            const overlayerRect = this.#overlayer.element.getBoundingClientRect()
            const dx = frameRect.left - overlayerRect.left
            const dy = frameRect.top - overlayerRect.top

            const pad = 3
            const cx = loupeLeft + halfW + dx
            const cy = loupeTop + halfH + dy

            this.#overlayer.setHole(cx, cy, loupeW + pad * 2, loupeH + pad * 2, borderRadius + pad)
        }
    }
    hideLoupe() {
        // Hide via CSS instead of removing — keeps the cached body clone so
        // the next showLoupe call skips the expensive cloneNode(true).
        if (this.#loupeEl) {
            this.#loupeEl.style.display = 'none'
        }
        if (this.#overlayer)
            this.#overlayer.clearHole()
    }
    destroyLoupe() {
        if (this.#loupeEl) {
            this.#loupeEl.remove()
            this.#loupeEl = null
            this.#loupeScaler = null
            this.#loupeCursor = null
        }
        if (this.#overlayer)
            this.#overlayer.clearHole()
    }
    destroy() {
        if (this.document?.body) this.#observer.unobserve(this.document.body)
        this.destroyLoupe()
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'max-inline-size', 'max-block-size', 'max-column-count', 'no-preload',
    ]
    #root = this.attachShadow({ mode: 'open' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #views = new Map() // Map<sectionIndex, View>
    #primaryIndex = -1
    #vertical = false
    #rtl = false
    #marginTop = 0
    #marginBottom = 0
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    #scrollLocked = false
    #isAnimating = false
    #filling = false // true while #fillVisibleArea is running
    #fillPromise = null // tracks in-progress #fillVisibleArea for awaiting
    #stabilizing = false // true while #display is stabilizing layout
    #rendered = false // true after first #display completes
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin-top: 48px;
            --_margin-right: 48px;
            --_margin-bottom: 48px;
            --_margin-left: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: var(--_max-column-count);
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_half-margin-left: calc(var(--_margin-left) / 2);
            --_half-margin-right: calc(var(--_margin-right) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(0, 1fr)
                var(--_margin-left)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_margin-right)
                minmax(0, 1fr);
            grid-template-rows:
                minmax(var(--_margin-top), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin-bottom), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 1 / -1;
            overflow: hidden;
            display: flex;
            flex-direction: row;
            /* GPU acceleration hints for smoother scrolling on high refresh rate displays */
            transform: translateZ(0);
            backface-visibility: hidden;
            -webkit-backface-visibility: hidden;
            perspective: 1000px;
            -webkit-perspective: 1000px;
            transition: opacity 50ms ease-in;
        }
        :host([dir="rtl"]) #container {
            flex-direction: row-reverse;
        }
        #container.vertical {
            flex-direction: column;
        }
        #container > * {
            /* Ensure child elements are GPU-accelerated for smooth transform animations */
            transform: translateZ(0);
            backface-visibility: hidden;
            -webkit-backface-visibility: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 2 / 5;
            grid-row: 1 / -1;
            overflow: auto;
            overflow-anchor: auto;
            flex-direction: column;
        }
        :host([flow="scrolled"]) #container.vertical {
            flex-direction: row-reverse;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header {
            display: grid;
            height: var(--_margin-top);
        }
        #footer {
            display: grid;
            height: var(--_margin-bottom);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => {
            // Don't dispatch scroll events during animation to prevent jank
            if (!this.#isAnimating) this.dispatchEvent(new Event('scroll'))
            // In scrolled mode, preload next section when near bottom edge
            if (this.scrolled && !this.noPreload && !this.#filling && !this.#stabilizing) {
                const threshold = this.size // ~1 viewport height
                if (this.#renderedViewSize - this.#renderedEnd < threshold) {
                    const sorted = this.#sortedViews
                    const lastIndex = sorted[sorted.length - 1]?.[0]
                    if (lastIndex != null) {
                        const nextIdx = this.#adjacentIndex(1, lastIndex)
                        if (nextIdx != null && !this.#views.has(nextIdx)) {
                            this.#filling = true
                            this.#loadAdjacentSection(nextIdx)
                                .then(() => this.#updateViewPadding())
                                .finally(() => { this.#filling = false })
                        }
                    }
                }
            }
        })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled && !this.#isAnimating) {
                // Skip entirely while stabilizing — preserve #justAnchored
                // so the first post-stabilization fire still sees it.
                if (this.#stabilizing) return
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
                // Load previous section when user scrolls near the top.
                // Done in debounced handler (not instant) to avoid cascade
                // from rapid DOM insertions breaking scroll anchoring.
                if (!this.noPreload && !this.#filling && this.#renderedStart < this.size) {
                    const sorted = this.#sortedViews
                    const firstIndex = sorted[0]?.[0]
                    if (firstIndex != null) {
                        const prevIdx = this.#adjacentIndex(-1, firstIndex)
                        if (prevIdx != null && !this.#views.has(prevIdx)) {
                            this.#filling = true
                            this.#loadAdjacentSection(prevIdx)
                                .then(() => this.#updateViewPadding())
                                .finally(() => { this.#filling = false })
                        }
                    }
                }
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                // FIXME: this won't work on Android WebView, disable for now
                if (!isPointerSelecting && isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => {
                if (this.scrolled) return null
                if (this.#container && this.#container.contains(e.target)) {
                    // NOTE: `requestAnimationFrame` is needed in WebKit
                    requestAnimationFrame(() => this.#scrollToAnchor(e.target))
                }
            })
        })

        this.#mediaQueryListener = () => {
            const view = this.#primaryView
            if (!view) return
            this.#replaceBackground()
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    get #primaryView() {
        return this.#views.get(this.#primaryIndex)
    }
    get #sortedViews() {
        return [...this.#views.entries()].sort(([a], [b]) => a - b)
    }
    get primaryIndex() {
        return this.#primaryIndex
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'margin-top':
            case 'margin-bottom':
            case 'margin-left':
            case 'margin-right':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/([{\s;])-epub-/gi, '$1')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView(index) {
        // Destroy existing view for this index if any
        const existing = this.#views.get(index)
        if (existing) {
            existing.destroy()
            this.#container.removeChild(existing.element)
            this.#views.delete(index)
        }
        const view = new View({
            container: this,
            onExpand: () => {
                // Only the primary view's resize should adjust scroll;
                // non-primary views (preloaded/adjacent) must not scroll
                if (this.#filling || this.#stabilizing || this.scrolled) return
                if (this.#primaryIndex === index)
                    this.#scrollToAnchor(this.#anchor)
            },
        })
        this.#views.set(index, view)
        const sorted = this.#sortedViews
        const myPos = sorted.findIndex(([i]) => i === index)
        const nextEntry = sorted[myPos + 1]
        if (nextEntry) this.#container.insertBefore(view.element, nextEntry[1].element)
        else this.#container.append(view.element)
        return view
    }
    #destroyView(index) {
        const view = this.#views.get(index)
        if (!view) return
        view.destroy()
        this.#container.removeChild(view.element)
        this.#views.delete(index)
        this.sections[index]?.unload?.()
    }
    #destroyAllViews() {
        for (const [index] of this.#views) this.#destroyView(index)
    }
    #clearViewsExcept(keepIndices) {
        for (const [index] of this.#views) {
            if (!keepIndices.has(index)) this.#destroyView(index)
        }
    }
    // Update the #background grid so each column shows the correct section's
    // background. Pass atPosition to pre-compute for a destination scroll
    // position (e.g. before an animation starts).
    #replaceBackground(atPosition) {
        const doc = this.#primaryView?.document
        if (!doc?.documentElement) return
        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)
        const themeBgColor = htmlStyle.getPropertyValue('--theme-bg-color')
        const overrideColor = htmlStyle.getPropertyValue('--override-color') === 'true'
        const bgTextureId = htmlStyle.getPropertyValue('--bg-texture-id')
        const isDarkMode = htmlStyle.getPropertyValue('color-scheme') === 'dark'
        const fallbackBg = themeBgColor || ''

        const resolveBackground = (background) => {
            if (!background) return fallbackBg
            if (themeBgColor) {
                const parsed = background.split(/\s(?=(?:url|rgb|hsl|#[0-9a-fA-F]{3,6}))/)
                if ((isDarkMode || overrideColor) && (bgTextureId === 'none' || !bgTextureId)) {
                    parsed[0] = themeBgColor
                }
                return parsed.join(' ')
            }
            return background
        }

        const cc = this.columnCount
        const columnSize = this.size / cc
        const sorted = this.#sortedViews

        this.#background.innerHTML = ''
        this.#background.style.display = 'grid'
        this.#background.style.gridTemplateColumns = `repeat(${cc}, 1fr)`

        const scrollPos = atPosition ?? this.#renderedStart
        for (let i = 0; i < cc; i++) {
            const columnMid = Math.abs(scrollPos) + (i + 0.5) * columnSize
            let bg = fallbackBg

            // Find which view's content area contains this column
            let offset = 0
            for (const [, view] of sorted) {
                const viewSize = view.element.getBoundingClientRect()[this.sideProp]
                if (columnMid < offset + viewSize) {
                    const beforePad = view.padding.before * this.size
                        + view.alignColumns * columnSize
                    const contentStart = offset + beforePad
                    const contentEnd = contentStart + view.contentPages * columnSize
                    if (columnMid >= contentStart && columnMid < contentEnd) {
                        bg = resolveBackground(view.docBackground)
                    }
                    break
                }
                offset += viewSize
            }

            const col = document.createElement('div')
            col.style.background = bg
            col.style.backgroundAttachment = 'initial'
            col.style.width = '100%'
            col.style.height = '100%'
            this.#background.appendChild(col)
        }
    }
    #beforeRender({ vertical, rtl }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)
        this.#container.classList.toggle('vertical', vertical)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const marginTop = parseFloat(style.getPropertyValue('--_margin-top'))
        const marginRight = parseFloat(style.getPropertyValue('--_margin-right'))
        const marginBottom = parseFloat(style.getPropertyValue('--_margin-bottom'))
        const marginLeft = parseFloat(style.getPropertyValue('--_margin-left'))
        this.#marginTop = marginTop
        this.#marginBottom = marginBottom

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            this.columnCount = 1
            this.#replaceBackground()

            return { width, height, flow, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth, columnCount: 1 }
        }

        const divisor = Math.min(maxColumnCount + (vertical ? 1 : 0), Math.ceil(Math.floor(size) / Math.floor(maxInlineSize)))
        const columnWidth = vertical
            ? (size / divisor - marginTop * 1.5 - marginBottom * 1.5)
            : (size / divisor - gap - marginRight / 2 - marginLeft / 2)
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.columnCount = divisor
        this.#replaceBackground()

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(Math.floor(width) / Math.floor(maxInlineSize)))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { width, height, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth, columnCount: divisor }
    }
    render() {
        if (this.#views.size === 0) return
        const primaryView = this.#primaryView
        if (!primaryView) return
        const needsStabilize = !this.#stabilizing
        if (needsStabilize) {
            this.#stabilizing = true
            if (!this.#rendered) this.#container.style.opacity = '0'
        }
        const layout = this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        })
        for (const [, view] of this.#views) {
            if (view.document) view.render(layout)
        }
        this.#updateViewPadding()
        if (needsStabilize) {
            // Defer scrollToAnchor to RAF for mode switches — the browser
            // needs a frame to compute the new layout (e.g. CSS multi-column
            // positions) before getClientRects() returns correct values
            requestAnimationFrame(() => {
                this.#scrollToAnchor(this.#anchor)
                this.#container.style.opacity = '1'
                this.dispatchEvent(new Event('stabilized'))
                // In scrolled mode, keep #stabilizing true until any
                // pending fill completes to prevent backward cascade
                if (this.scrolled && this.#fillPromise) {
                    this.#fillPromise.then(() => { this.#stabilizing = false })
                } else {
                    this.#stabilizing = false
                }
            })
        } else {
            // Same-mode re-render (e.g. resize within stabilization) —
            // scroll immediately in paginated mode
            if (!this.scrolled) this.#scrollToAnchor(this.#anchor)
        }
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get noPreload() {
        return this.hasAttribute('no-preload')
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
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        const primaryView = this.#primaryView
        if (!primaryView) return 0
        return primaryView.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return this.#renderedStart - this.#getViewOffset(this.#primaryIndex)
    }
    get end() {
        return this.#renderedEnd - this.#getViewOffset(this.#primaryIndex)
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        const primaryView = this.#primaryView
        if (!primaryView) return 0
        const viewSize = primaryView.element.getBoundingClientRect()[this.sideProp]
        return Math.ceil(viewSize / this.size)
    }
    get containerPosition() {
        return this.#container[this.scrollProp]
    }
    get isOverflowX() {
        return false
    }
    get isOverflowY() {
        return false
    }
    get #renderedViewSize() {
        if (this.#views.size === 0) return 0
        let total = 0
        for (const [, view] of this.#views)
            total += view.element.getBoundingClientRect()[this.sideProp]
        return total
    }
    get #renderedStart() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get #renderedEnd() {
        return this.#renderedStart + this.size
    }
    get #renderedPage() {
        return Math.floor(((this.#renderedStart + this.#renderedEnd) / 2) / this.size)
    }
    get #renderedPages() {
        return Math.ceil(this.#renderedViewSize / this.size)
    }
    set containerPosition(newVal) {
        this.#container[this.scrollProp] = newVal
    }
    set scrollLocked(value) {
        this.#scrollLocked = value
    }

    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        this.containerPosition = Math.max(min, Math.min(max,
            this.containerPosition + delta))
    }

    // vx, vy: velocity at the end of the swipe (pixels per ms)
    // dx, dy: total distance swiped
    // dt: total time of the swipe (ms)
    snap(vx, vy, dx, dy, dt) {
        const velocity = this.#vertical ? vy : vx
        const avgVelocity = this.#vertical ? dy / dt : dx / dt
        const horizontal = Math.abs(vx) * 2 > Math.abs(vy)
        const orthogonal = this.#vertical ? !horizontal : horizontal
        const [offset, a, b] = this.#scrollBounds
        const size = this.size
        const start = this.#renderedStart
        const end = this.#renderedEnd
        const pages = this.#renderedPages
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const snapping = this.hasAttribute('animated') && !this.hasAttribute('eink')
        const v =  snapping ? velocity : avgVelocity
        const d = v * (this.#rtl ? -size : size) * (orthogonal ? 1 : 0)
        const snapOffset = (isNaN(d) ? 0 : snapping ? d * 2 : d * 10)
        const page = Math.floor(Math.max(min, Math.min(max, (start + end) / 2 + snapOffset)) / size)
        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) {
                const sorted = this.#sortedViews
                const edgeIndex = dir < 0
                    ? sorted[0]?.[0] ?? this.#primaryIndex
                    : sorted[sorted.length - 1]?.[0] ?? this.#primaryIndex
                return this.#goTo({
                    index: this.#adjacentIndex(dir, edgeIndex),
                    anchor: dir < 0 ? () => 1 : () => 0,
                })
            }
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
            dx: 0, dy: 0,
            dt: 0,
        }
        // Hint to browser that scrolling will occur for better GPU layer management
        const pv = this.#primaryView
        if (pv?.element) {
            pv.element.style.willChange = 'transform'
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const doc = this.#primaryView?.document
        const selection = doc?.getSelection()
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
            return
        }
        const touch = e.changedTouches[0]
        const isStylus = touch.touchType === 'stylus'
        if (!isStylus) e.preventDefault()
        if (this.#scrollLocked) return
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        state.dx += dx
        state.dy += dy
        state.dt += dt
        this.#touchScrolled = true
        if (!this.hasAttribute('animated') || this.hasAttribute('eink')) return
        if (!this.#vertical && Math.abs(state.dx) >= Math.abs(state.dy) && !this.hasAttribute('eink') && (!isStylus || Math.abs(dx) > 1)) {
            this.scrollBy(dx, 0)
        } else if (this.#vertical && Math.abs(state.dx) < Math.abs(state.dy) && !this.hasAttribute('eink') && (!isStylus || Math.abs(dy) > 1)) {
            this.scrollBy(0, dy)
        }
    }
    #onTouchEnd() {
        // Remove will-change hint to free GPU resources
        // if (this.#view?.element) {
        //     this.#view.element.style.willChange = 'auto'
        // }

        if (!this.#touchScrolled) return
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1) {
                const { vx, vy, dx, dy, dt } = this.#touchState
                this.snap(vx, vy, dx, dy, dt)
            }
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper(view) {
        if (this.scrolled) {
            const size = view ? view.element.getBoundingClientRect()[this.sideProp] : this.#renderedViewSize
            const marginTop = this.#marginTop
            const marginBottom = this.#marginBottom
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - marginTop, right: size - left - marginBottom })
                : ({ top, bottom }) => ({ left: top - marginTop, right: bottom - marginBottom })
        }
        const pxSize = this.#renderedPages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            // rect is in iframe-local coordinates; add view offset
            // to convert to container scroll coordinates
            const localOffset = this.#getRectMapper()(rect).left - 3
            const viewOffset = this.#getViewOffset(this.#primaryIndex)
            return this.#scrollTo(viewOffset + localOffset, reason)
        }
        // rect is in iframe-local coordinates. Convert to container
        // coordinates by adding the primary view's offset.
        const localOffset = this.#getRectMapper()(rect).left
        const viewOffset = this.#getViewOffset(this.#primaryIndex)
        const primaryView = this.#primaryView
        const beforePad = primaryView
            ? primaryView.padding.before * this.size
                + primaryView.alignColumns * (this.size / this.columnCount)
            : 0
        const containerOffset = viewOffset + beforePad + localOffset
        return this.#scrollToPage(Math.floor(containerOffset / this.size), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const { size } = this
        if (this.containerPosition === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated') && !this.hasAttribute('eink')) {
            const startPosition = this.containerPosition
            // Pre-set background for the destination so it's already
            // correct when the slide animation reveals the new page
            if (!this.scrolled) this.#replaceBackground(offset)
            // Use GPU-accelerated scroll animation for smoother experience on high refresh rate screens
            this.#isAnimating = true
            return animateScroll(
                this.#container,
                this.scrollProp,
                startPosition,
                offset,
                300,
            ).then(() => {
                this.#isAnimating = false
                this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
                this.#afterScroll(reason)
            })
        } else {
            this.containerPosition = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select, smooth) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation', smooth)
    }
    async #scrollToAnchor(anchor, reason = 'anchor', smooth = false) {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            // focus the element when navigating with keyboard or screen reader
            if (reason === 'navigation') {
                let node = anchor.focus ? anchor : undefined
                if (!node && anchor.startContainer) {
                    node = anchor.startContainer
                    if (node.nodeType === Node.TEXT_NODE) {
                        node = node.parentElement
                    }
                }
                if (node && node.focus) {
                    node.tabIndex = -1
                    node.style.outline = 'none'
                    node.focus({ preventScroll: true })
                }
            }
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            // In scrolled mode with multi-view, offset to the primary view's position
            const primaryOffset = this.#getViewOffset(this.#primaryIndex)
            const primaryView = this.#primaryView
            const primarySize = primaryView
                ? primaryView.element.getBoundingClientRect()[this.sideProp] : this.#renderedViewSize
            await this.#scrollTo(primaryOffset + anchor * primarySize, reason, smooth)
            return
        }
        // In paginated mode, account for pages before the primary section
        const primaryView = this.#primaryView
        if (!primaryView) return
        const pagesBeforePrimary = this.#getPagesBeforeView(this.#primaryIndex)
        const textPages = primaryView.contentPages
        if (!textPages) return
        // textPages is in column units; convert to spread page for scrolling
        const newColumn = Math.round(anchor * (textPages - 1))
        const newSpreadPage = Math.floor(newColumn / this.columnCount)
        await this.#scrollToPage(pagesBeforePrimary + primaryView.padding.before + newSpreadPage, reason, smooth)
    }
    // Get the pixel offset of a view within the container
    #getViewOffset(index) {
        let offset = 0
        for (const [i, view] of this.#sortedViews) {
            if (i === index) return offset
            offset += view.element.getBoundingClientRect()[this.sideProp]
        }
        return offset
    }
    // Get number of pages (spreads) before a given view, using pixel offsets
    #getPagesBeforeView(index) {
        return Math.floor(this.#getViewOffset(index) / this.size)
    }
    #getVisibleRange() {
        const targetView = this.#primaryView
        if (!targetView?.document) return
        const viewOffset = this.#getViewOffset(this.#primaryIndex)
        if (this.scrolled) {
            // In scrolled mode, the primary view may be scrolled out of
            // the viewport at a section boundary. Try all visible views
            // and return the first valid (non-collapsed) range.
            for (const [index, v] of this.#sortedViews) {
                if (!v.document) continue
                const off = this.#getViewOffset(index)
                const vSize = v.element.getBoundingClientRect()[this.sideProp]
                // Skip views entirely outside the viewport
                if (off + vSize <= this.#renderedStart || off >= this.#renderedEnd) continue
                const range = getVisibleRange(v.document,
                    this.#renderedStart - off, this.#renderedEnd - off,
                    this.#getRectMapper(v))
                if (range && !range.collapsed) return { range, index }
            }
            return
        }
        // In paginated mode, also account for before-padding
        const beforePad = targetView.padding.before * this.size
        const range = getVisibleRange(targetView.document,
            this.#renderedStart - viewOffset - beforePad,
            this.#renderedEnd - viewOffset - beforePad,
            this.#getRectMapper(targetView))
        return range ? { range, index: this.#primaryIndex } : undefined
    }
    // Determine which view is primary based on scroll position
    #detectPrimaryView() {
        if (this.#views.size <= 1) return
        const visibleStart = this.#renderedStart
        let offset = 0
        for (const [index, view] of this.#sortedViews) {
            const viewSize = view.element.getBoundingClientRect()[this.sideProp]
            if (visibleStart < offset + viewSize) {
                if (index !== this.#primaryIndex) {
                    this.#primaryIndex = index
                    this.#trimDistantViews()
                    this.#replaceBackground()
                    this.#fillPromise = this.#preloadNext()
                }
                return
            }
            offset += viewSize
        }
    }
    // Pre-load adjacent sections from the current primary so the
    // next/prev sections are ready when the user paginates.
    // Does NOT re-scroll to avoid fighting with the user's current
    // scroll position.
    async #preloadNext() {
        if (this.noPreload) return
        this.#filling = true
        try {
            // Load next 2 sections forward
            let fromIndex = this.#primaryIndex
            for (let i = 0; i < 2; i++) {
                const nextIdx = this.#adjacentIndex(1, fromIndex)
                if (nextIdx == null) break
                await this.#loadAdjacentSection(nextIdx)
                fromIndex = nextIdx
            }
            // In scrolled mode, DON'T preload previous sections here —
            // inserting content above the viewport during background
            // loading can break scroll anchoring and cause a cascade
            // back to section 0. Previous sections are loaded on-demand
            // by the scroll event handler when the user nears the top.
            // Only update padding (to set correct first/last markers).
            // Do NOT trim distant views here — removing elements during
            // background pre-loading shifts scroll position without
            // re-scrolling, causing the visible content to jump.
            // Trimming happens in #goTo / #fillVisibleArea instead.
            this.#updateViewPadding()
            // Wait a frame so ResizeObserver callbacks from padding
            // updates fire while #filling is still true, preventing
            // onExpand from re-scrolling to a stale anchor position.
            await new Promise(r => requestAnimationFrame(r))
        } finally {
            this.#filling = false
        }
    }
    #afterScroll(reason) {
        // In multi-view, detect which section is primary
        if (this.#views.size > 1 && reason !== 'anchor' && reason !== 'navigation') {
            this.#detectPrimaryView()
        }
        const { range, index: visibleIndex } = this.#getVisibleRange() || {}
        if (!range) return
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = visibleIndex ?? this.#primaryIndex
        const primaryView = this.#primaryView
        const detail = { reason, range, index }
        if (this.scrolled) {
            const primaryOffset = this.#getViewOffset(index)
            const primarySize = primaryView
                ? primaryView.element.getBoundingClientRect()[this.sideProp] : this.#renderedViewSize
            detail.fraction = primarySize > 0
                ? Math.max(0, Math.min(1, (this.#renderedStart - primaryOffset) / primarySize)) : 0
        } else if (this.#renderedPages > 0 && primaryView) {
            const page = this.#renderedPage
            const pagesBeforePrimary = this.#getPagesBeforeView(index)
            const beforePad = primaryView.padding.before
            const textPages = primaryView.contentPages
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            // page is in spread units, textPages is in column units
            const localPage = page - pagesBeforePrimary - beforePad
            const localColumn = localPage * this.columnCount
            detail.fraction = textPages > 0 ? Math.max(0, Math.min(1, localColumn / textPages)) : 0
            detail.size = textPages > 0 ? this.columnCount / textPages : 1
        }
        // Update per-column backgrounds for the current scroll position
        if (!this.scrolled) this.#replaceBackground()
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        this.#stabilizing = true
        this.#container.style.opacity = '0'
        const { index, src, data, anchor, onLoad, select } = await promise
        this.#primaryIndex = index
        const hasFocus = this.#primaryView?.document?.hasFocus()
        if (src) {
            const view = this.#createView(index)
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.sections[index].spineProperties?.forEach(
                        prop => doc.documentElement.setAttribute('data-' + prop, ''))
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, data, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
        }
        // Pre-load previous section when needed:
        // - Short primary alignment (section shorter than one spread)
        // - Scrolled mode with anchor in top half — so the user can
        //   scroll backward into the previous section immediately
        const primaryView = this.#primaryView
        if (!this.noPreload && primaryView) {
            const needsPrev = (primaryView.contentPages > 0 && primaryView.contentPages < this.columnCount)
            if (needsPrev || this.scrolled) {
                const sorted = this.#sortedViews
                const firstIndex = sorted[0]?.[0]
                if (firstIndex != null) {
                    const prevIdx = this.#adjacentIndex(-1, firstIndex)
                    if (prevIdx != null) {
                        await this.#loadAdjacentSection(prevIdx)
                    }
                }
            }
            this.#updateViewPadding()
        }
        const resolvedAnchor = (typeof anchor === 'function'
            ? anchor(primaryView.document) : anchor) ?? 0
        await this.scrollToAnchor(resolvedAnchor, select)
        if (hasFocus) this.focusView()
        // Reveal content now that primary section is positioned
        this.#container.style.opacity = '1'
        this.#rendered = true
        // Emit stabilized so listeners can react, but keep #stabilizing
        // true until fill completes to prevent the debounced scroll
        // handler from loading backward sections during rapid DOM changes.
        this.dispatchEvent(new Event('stabilized'))
        // Load remaining adjacent sections progressively (non-blocking).
        // In scrolled mode, skip reanchor — browser scroll anchoring
        // preserves position when content is added above/below.
        this.#fillPromise = this.#fillVisibleArea(
            { reanchor: !this.scrolled })
        this.#fillPromise.then(() => { this.#stabilizing = false })
    }
    // Load an adjacent section without changing primary index
    async #loadAdjacentSection(index) {
        if (this.#views.has(index) || !this.#canGoToIndex(index)) return
        const section = this.sections[index]
        if (!section || section.linear === 'no') return
        try {
            const src = await section.load()
            const data = await section.loadContent?.()
            const view = this.#createView(index)
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    section.spineProperties?.forEach(
                        prop => doc.documentElement.setAttribute('data-' + prop, ''))
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, data, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
        } catch (e) {
            console.warn(e)
            console.warn(new Error(`Failed to load adjacent section ${index}`))
        }
    }
    // Fill remaining visible space with adjacent sections.
    // When reanchor is false (background pre-loading), skip re-scrolling
    // to avoid fighting with the user's current scroll position.
    async #fillVisibleArea({ reanchor = true } = {}) {
        if (this.noPreload || this.#filling) return
        this.#filling = true
        try {
            const { size } = this
            if (!size) return
            const maxSections = 5

            // If the primary section is shorter than one spread and
            // there's no section already loaded before it, load the
            // previous section to fill the leading columns
            const primaryView = this.#primaryView
            if (primaryView && primaryView.contentPages > 0
                && primaryView.contentPages < this.columnCount) {
                const sorted = this.#sortedViews
                const firstIndex = sorted[0]?.[0]
                if (firstIndex != null && firstIndex >= this.#primaryIndex) {
                    const prevIdx = this.#adjacentIndex(-1, firstIndex)
                    if (prevIdx != null) {
                        await this.#loadAdjacentSection(prevIdx)
                    }
                }
            }

            // Load sections after the last loaded section.
            // Always load at least two next sections: one to fill the
            // current spread's remaining columns, and one more so the
            // next section is pre-loaded for instant page turns.
            let iterations = 0
            while (this.#views.size < maxSections && iterations < 6) {
                iterations++
                const sorted = this.#sortedViews
                const lastIndex = sorted[sorted.length - 1]?.[0]
                if (lastIndex == null) break
                // Always pre-load at least 3 next sections;
                // only check threshold for additional ones beyond that
                if (iterations > 3) {
                    const totalSize = this.#renderedViewSize
                    if (totalSize >= size * 3) break
                }
                const nextIdx = this.#adjacentIndex(1, lastIndex)
                if (nextIdx == null) break
                await this.#loadAdjacentSection(nextIdx)
                if (!this.#views.has(nextIdx)) break
            }
            // Do NOT trim views here — removing elements shifts scroll
            // position without re-scrolling, causing visible content jumps.
            // Trimming happens in #goTo when the user explicitly navigates.
            this.#updateViewPadding()
            if (reanchor) this.#scrollToAnchor(this.#anchor)
        } finally {
            this.#filling = false
        }
    }
    // Assign padding based on view position
    #updateViewPadding() {
        if (this.scrolled) {
            // In scrolled mode, no blank padding pages needed
            for (const [, view] of this.#views) {
                view.padding = { before: 0, after: 0 }
                view.alignColumns = 0
            }
            return
        }
        const sorted = this.#sortedViews
        if (sorted.length === 0) return
        if (sorted.length === 1) {
            sorted[0][1].padding = { before: 1, after: 1 }
            sorted[0][1].alignColumns = 0
            return
        }
        for (let i = 0; i < sorted.length; i++) {
            const [, view] = sorted[i]
            const before = i === 0 ? 1 : 0
            const after = i === sorted.length - 1 ? 1 : 0
            view.padding = { before, after }
            view.alignColumns = 0
        }
    }
    // Trim distant views. Only destroys views AFTER primary+3 —
    // never removes views before the primary, as that would shift
    // scroll position and cause visible layout jumps.
    #trimDistantViews() {
        const sorted = this.#sortedViews.map(([i]) => i)
        const primaryPos = sorted.indexOf(this.#primaryIndex)
        if (primaryPos < 0) return
        for (let i = sorted.length - 1; i > primaryPos + 3; i--) {
            this.#destroyView(sorted[i])
        }
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select }) {
        if (this.#views.has(index)) {
            // View already loaded — reuse it without
            // clearing/reloading. Just change primary and scroll.
            this.#stabilizing = true
            this.#container.style.opacity = '0'
            const hasFocus = this.#primaryView?.document?.hasFocus()
            this.#primaryIndex = index
            this.#trimDistantViews()
            // Handle short section alignment
            const primaryView = this.#primaryView
            if (!this.noPreload && primaryView && primaryView.contentPages > 0
                && primaryView.contentPages < this.columnCount) {
                const sorted = this.#sortedViews
                const firstIndex = sorted[0]?.[0]
                if (firstIndex != null) {
                    const prevIdx = this.#adjacentIndex(-1, firstIndex)
                    if (prevIdx != null) {
                        await this.#loadAdjacentSection(prevIdx)
                    }
                }
            }
            this.#updateViewPadding()
            await this.scrollToAnchor((typeof anchor === 'function'
                ? anchor(primaryView.document) : anchor) ?? 0, select)
            this.#container.style.opacity = '1'
            if (hasFocus) this.focusView()
            // Load remaining adjacent sections progressively;
            // keep #stabilizing true until fill completes
            this.#fillPromise = this.#fillVisibleArea()
            this.#fillPromise.then(() => { this.#stabilizing = false })
        } else {
            // Keep already-loaded views near the target instead of
            // clearing everything — avoids reloading sections that
            // are still useful as adjacent views
            const keep = new Set([index])
            for (const [i] of this.#views) {
                if (Math.abs(i - index) <= 2) keep.add(i)
            }
            this.#clearViewsExcept(keep)
            const oldIndex = this.#primaryIndex
            const onLoad = detail => {
                if (oldIndex >= 0 && !this.#views.has(oldIndex))
                    this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(async src => {
                    const data = await this.sections[index].loadContent?.()
                    return { index, src, data, anchor, onLoad, select }
                }).catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (this.#views.size === 0) return true
        if (this.scrolled) {
            if (this.#renderedStart > 0) return this.#scrollTo(
                Math.max(0, this.#renderedStart - (distance ?? this.size)), null, true)
            return !this.atStart
        }
        if (this.atStart) return
        const page = this.#renderedPage - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (this.#views.size === 0) return true
        if (this.scrolled) {
            if (this.#renderedViewSize - this.#renderedEnd > 2) return this.#scrollTo(
                Math.min(this.#renderedViewSize, distance ? this.#renderedStart + distance : this.#renderedEnd), null, true)
            return !this.atEnd
        }
        if (this.atEnd) return
        const page = this.#renderedPage + 1
        const pages = this.#renderedPages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        const sorted = this.#sortedViews
        const firstIndex = sorted[0]?.[0] ?? this.#primaryIndex
        if (this.scrolled) return this.#adjacentIndex(-1, firstIndex) == null && this.#renderedStart <= 0
        return this.#adjacentIndex(-1, firstIndex) == null && this.#renderedPage <= 1
    }
    get atEnd() {
        const sorted = this.#sortedViews
        const lastIndex = sorted[sorted.length - 1]?.[0] ?? this.#primaryIndex
        if (this.scrolled) return this.#adjacentIndex(1, lastIndex) == null && this.#renderedViewSize - this.#renderedEnd <= 2
        return this.#adjacentIndex(1, lastIndex) == null && this.#renderedPage >= this.#renderedPages - 2
    }
    #adjacentIndex(dir, fromIndex) {
        if (fromIndex === undefined) fromIndex = this.#primaryIndex
        for (let index = fromIndex + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const prev = dir === -1
        const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
        if (shouldGo) {
            // Wait for any in-progress background pre-loading to complete —
            // it may already be loading the section we need, so awaiting
            // it lets #goTo reuse the view instead of loading from scratch
            if (this.#fillPromise) await this.#fillPromise
            const sorted = this.#sortedViews
            const edgeIndex = prev
                ? sorted[0]?.[0] ?? this.#primaryIndex
                : sorted[sorted.length - 1]?.[0] ?? this.#primaryIndex
            await this.#goTo({
                index: this.#adjacentIndex(dir, edgeIndex),
                anchor: prev ? () => 1 : () => 0,
            })
        }
        if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        this.#locked = false
    }
    async prev(distance) {
        return await this.#turnPage(-1, distance)
    }
    async next(distance) {
        return await this.#turnPage(1, distance)
    }
    async pan(dx, dy) {
        if (this.#locked) return
        this.#locked = true
        this.scrollBy(dx, dy)
        this.#locked = false
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
    getContents() {
        const contents = []
        for (const [index, view] of this.#sortedViews) {
            if (view.document) contents.push({
                index,
                overlayer: view.overlayer,
                doc: view.document,
            })
        }
        return contents
    }
    setStyles(styles) {
        this.#styles = styles
        for (const [, view] of this.#views) {
            const $$styles = this.#styleMap.get(view.document)
            if (!$$styles) continue
            const [$beforeStyle, $style] = $$styles
            if (Array.isArray(styles)) {
                const [beforeStyle, style] = styles
                $beforeStyle.textContent = beforeStyle
                $style.textContent = style
            } else $style.textContent = styles

            // needed because the resize observer doesn't work in Firefox
            view.document?.fonts?.ready?.then(() => view.expand())
        }

        // NOTE: needs `requestAnimationFrame` in Chromium
        const primaryView = this.#primaryView
        if (primaryView) {
            requestAnimationFrame(() => this.#replaceBackground())
        }
    }
    focusView() {
        this.#primaryView?.document?.defaultView?.focus()
    }
    showLoupe(winX, winY, { isVertical, color, gap, margin, radius, magnification }) {
        this.#primaryView?.showLoupe(winX, winY, { isVertical, color, gap, margin, radius, magnification })
    }
    hideLoupe() {
        this.#primaryView?.hideLoupe()
    }
    destroyLoupe() {
        this.#primaryView?.destroyLoupe()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#destroyAllViews()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
