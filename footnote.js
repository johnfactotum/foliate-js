const refTypes = ['annoref', 'biblioref', 'glossref', 'noteref']
const refRoles = ['doc-biblioref', 'doc-glossref', 'doc-noteref']
const isFootnote = a => {
    const types = a.getAttributeNS('http://www.idpf.org/2007/ops', 'type')?.split(' ')
    const roles = a.getAttribute('role')?.split(' ')
    return {
        yes: types?.some(t => refTypes.includes(t)) || roles?.some(r => refRoles.includes(r)),
        maybe: () => !types?.includes('backlink') && !roles?.includes('doc-backlink')
            && (getComputedStyle(a).verticalAlign === 'super'
            || a.children.length === 1 && getComputedStyle(a.children[0]).verticalAlign === 'super')
            || getComputedStyle(a.parentElement).verticalAlign === 'super',
    }
}

const isInline = 'a, span, sup, sub, em, strong, i, b, small, big'
const extractFootnote = (doc, anchor) => {
    let el = anchor(doc)
    while (el.matches(isInline)) {
        const parent = el.parentElement
        if (!parent) break
        el = parent
    }
    return el
}

export class FootnoteHandler extends EventTarget {
    detectFootnotes = true
    #showFragment(book, { index, anchor }, getHref) {
        const view = document.createElement('foliate-view')
        view.addEventListener('load', e => {
            const { doc } = e.detail
            const el = anchor(doc)
            if (el) {
                const range = el.startContainer ? el : doc.createRange()
                if (!el.startContainer) {
                    if (el.matches('li, aside')) range.selectNodeContents(el)
                    else range.selectNode(el)
                }
                const frag = range.extractContents()
                doc.body.replaceChildren()
                doc.body.appendChild(frag)
            }
            const detail = { view, href: getHref(el) }
            this.dispatchEvent(new CustomEvent('render', { detail }))
        })
        view.open(book)
            .then(() => this.dispatchEvent(new CustomEvent('before-render', { detail: { view } })))
            .then(() => view.goTo(index))
    }
    handle(book, e) {
        const { a, href } = e.detail
        const { yes, maybe } = isFootnote(a)
        if (yes) {
            e.preventDefault()
            Promise.resolve(book.resolveHref(href)).then(target =>
                this.#showFragment(book, target, el => el?.matches?.('aside') ? null : href))
        }
        else if (this.detectFootnotes && maybe()) {
            e.preventDefault()
            Promise.resolve(book.resolveHref(href)).then(({ index, anchor }) => {
                const target = { index, anchor: doc => extractFootnote(doc, anchor) }
                this.#showFragment(book, target, () => href)
            })
        }
    }
}
