const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.nodeName === 'svg') {
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
    if (viewport) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

class Container {
    #element = document.createElement('div')
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    constructor() {
        Object.assign(this.#element.style, {
            width: '100%',
            height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        new ResizeObserver(() => this.render()).observe(this.#element)
    }
    get element() {
        return this.#element
    }
    get side() {
        return this.#side
    }
    async #createFrame({ index, src }) {
        const element = document.createElement('div')
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
        iframe.classList.add('filter')
        this.#element.append(element)
        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            const onload = () => {
                iframe.removeEventListener('load', onload)
                const doc = iframe.contentDocument
                this.onLoad?.(doc, index)
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                })
            }
            iframe.addEventListener('load', onload)
            iframe.src = src
        })
    }
    render(side = this.#side) {
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right
        const target = side === 'left' ? left : right
        const { width, height } = this.#element.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width
        const blankHeight = left.height ?? right.height

        const scale = portrait
            ? Math.min(
                width / (target.width ?? blankWidth),
                height / (target.height ?? blankHeight))
            : Math.min(
                width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                height / Math.max(
                    left.height ?? blankHeight,
                    right.height ?? blankHeight))

        const transform = frame => {
            const { element, iframe, width, height } = frame
            Object.assign(iframe.style, {
                width: `${width}px`,
                height: `${height}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                display: 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
        }
        if (this.#center) {
            transform(this.#center)
        } else {
            transform(left)
            transform(right)
        }
    }
    async showSpread({ left, right, center, side }) {
        this.#element.replaceChildren()
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            this.render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = side
            this.render()
        }
    }
    goLeft() {
        if (this.#center) return
        if (this.#left?.blank) return true
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#right.element.style.display = 'none'
            this.#left.element.style.display = 'block'
            this.#side = 'left'
            return true
        }
    }
    goRight() {
        if (this.#center) return
        if (this.#right?.blank) return true
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#left.element.style.display = 'none'
            this.#right.element.style.display = 'block'
            this.#side = 'right'
            return true
        }
    }
}

export class FixedLayout {
    #spreads
    #index = -1
    #container = new Container()
    constructor({ book, onLoad, onRelocated }) {
        this.book = book
        this.#container.onLoad = onLoad
        this.onRelocated = onRelocated

        const { rendition } = book
        this.#container.spread = rendition?.spread
        this.#container.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section) => {
            const last = arr[arr.length - 1]
            const { linear, pageSpread } = section
            if (linear === 'no') return arr
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') newSpread().center = section
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right) last.left = section
                else last .right = section
            }
            return arr
        }, [{}])
    }
    get element() {
        return this.#container.element
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#container.side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
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
    async goToSpread(index, side) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#container.render(side)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#container.showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#container.showSpread({ left, right, side })
        }
        this.onRelocated?.(null, this.index, 0, 1)
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
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#container.goLeft() : this.#container.goRight()
        if (s) this.onRelocated?.(null, this.index, 0, 1)
        else return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left')
    }
    async prev() {
        const s = this.rtl ? this.#container.goRight() : this.#container.goLeft()
        if (s) this.onRelocated?.(null, this.index, 0, 1)
        else return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right')
    }
    deselect() {
        for (const frame of this.#container.element.querySelectorAll('iframe'))
            frame.contentWindow.getSelection().removeAllRanges()
    }
}
