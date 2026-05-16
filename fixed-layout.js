const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #gen = 0
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
        }
    }
    async #createFrame({ index, src: srcOption }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.position = 'relative'
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)
        if (!src) return { blank: true, element, iframe, ensureReady: async () => {} }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                const observer = new ResizeObserver(() => requestAnimationFrame(() => {
                    if (![this.#left, this.#right, this.#center]
                        .some(f => f?.observer === observer)) return
                    this.#render()
                }))
                const ensureReady = async frame => {
                    // fonts deferred loading can change the position
                    // of text without resizing the frame
                    await doc.fonts.ready
                    if (![this.#left, this.#right, this.#center].includes(frame) ||
                        frame._overlayerRequested) return false
                    observer.observe(doc.body)
                    this.dispatchEvent(new CustomEvent('create-overlayer', {
                        detail: {
                            doc, index,
                            attach: overlayer => {
                                frame.overlayer = overlayer
                                element.append(overlayer.element)
                            },
                        },
                    }))
                    frame._overlayerRequested = true
                    return true
                }
                resolve({
                    element, iframe,
                    overlayer: null,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom, ensureReady,
                    observer,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    async #render(side = this.#side) {
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1

        const transform = async frame => {
            let { element, iframe, overlayer, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) await onZoom({ doc: frame.iframe.contentDocument, scale })
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: 'auto',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
            if (overlayer) this.#styleOverlayer(frame)
        }
        if (this.#center) {
            await transform(this.#center)
        } else {
            await Promise.all([transform(left), transform(right)])
        }
    }
    #styleOverlayer(frame) {
        const { overlayer, iframe, element } = frame
        if (!overlayer || !iframe) return
        const el = overlayer.element
        Object.assign(el.style, {
            margin: '0',
            width: iframe.style.width,
            height: iframe.style.height,
            transform: iframe.style.transform,
            transformOrigin: iframe.style.transformOrigin,
            display: iframe.style.display,
        })
        if (![element.style.display, el.style.display].includes('none')) overlayer.redraw()
    }
    async #renderPages(...pages) {
        await this.#render()
        await Promise.all(
            pages.map(async p => {
                if (await p.ensureReady(p)) this.#styleOverlayer(p)
            }))
    }
    async #showSpread({ left, right, center, side, gen, index }) {
        for (const f of [this.#left, this.#right, this.#center]) f?.observer?.disconnect()
        this.#root.replaceChildren()
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            const c = await this.#createFrame(center)
            if (index !== this.#index) return
            this.#center = c
            if (gen === this.#gen) this.#side = 'center'
            await this.#renderPages(this.#center)
        } else {
            const [l, r] = await Promise.all([this.#createFrame(left), this.#createFrame(right)])
            if (index !== this.#index) return
            this.#left = l
            this.#right = r
            if (gen === this.#gen)
                this.#side = this.#left.blank ? 'right'
                    : this.#right.blank ? 'left' : side
            await this.#renderPages(this.#left, this.#right)
        }
    }
    async #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            const gen = ++this.#gen
            this.#side = 'left'
            await this.#renderPages(this.#left)
            if (gen === this.#gen) this.#reportLocation('page')
            return true
        }
    }
    async #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            const gen = ++this.#gen
            this.#side = 'right'
            await this.#renderPages(this.#right)
            if (gen === this.#gen) this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            const newSide = this.#left?.blank ? 'right'
                : this.#right?.blank ? 'left' : side
            if (newSide !== this.#side) {
                const gen = ++this.#gen
                this.#side = newSide
                if (this.#side === 'left' && this.#left) {
                    await this.#renderPages(this.#left)
                }
                else if (this.#side === 'right' && this.#right) {
                    await this.#renderPages(this.#right)
                }
                if (gen === this.#gen) this.#reportLocation(reason)
            }
            else if (this.#left || this.#right || this.#center) {
                await this.#render()
            }
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        const gen = ++this.#gen
        if (spread.center) {
            const indexC = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            if (index !== this.#index) return
            await this.#showSpread({ center: { index: indexC, src }, gen, index })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            if (index !== this.#index) return
            await this.#showSpread({ left, right, side, gen, index })
        }
        if (gen === this.#gen) this.#reportLocation(reason)
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side, resolved.reason)
    }
    async next() {
        const s = await (this.rtl ? this.#goLeft() : this.#goRight())
        if (!s) return await this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = await (this.rtl ? this.#goRight() : this.#goLeft())
        if (!s) return await this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    getContents({ onlyVisible = true } = {}) {
        const contents = []
        const spread = this.#spreads[this.#index]
        if (spread?.center && this.#center) {
            contents.push({
                doc: this.#center.iframe.contentDocument,
                index: this.book.sections.indexOf(spread.center),
                overlayer: this.#center.overlayer,
            })
        }
        const pages = this.rtl
            ? [[spread?.right, this.#right], [spread?.left, this.#left]]
            : [[spread?.left, this.#left], [spread?.right, this.#right]]
        for (const [section, frame] of pages) {
            if (section && frame && !frame.blank &&
                    (frame.element.style.display !== 'none' || !onlyVisible)) {
                contents.push({
                    doc: frame.iframe.contentDocument,
                    index: this.book.sections.indexOf(section),
                    overlayer: frame.overlayer,
                })
            }
        }
        return contents
    }
    destroy() {
        for (const f of [this.#left, this.#right, this.#center]) f?.observer?.disconnect()
        this.#observer.unobserve(this)
    }
}

customElements.define('foliate-fxl', FixedLayout)
