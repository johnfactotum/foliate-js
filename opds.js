const NS = {
    ATOM: 'http://www.w3.org/2005/Atom',
    OPDS: 'http://opds-spec.org/2010/catalog',
    THR: 'http://purl.org/syndication/thread/1.0',
    DC: 'http://purl.org/dc/elements/1.1/',
    DCTERMS: 'http://purl.org/dc/terms/',
    FH: 'http://purl.org/syndication/history/1.0',
    PSE: 'http://vaemendis.net/opds-pse/ns',
    OS: 'http://a9.com/-/spec/opensearch/1.1/',
}

const MIME = {
    ATOM: 'application/atom+xml',
    OPDS2: 'application/opds+json',
}

export const REL = {
    ACQ: 'http://opds-spec.org/acquisition',
    FACET: 'http://opds-spec.org/facet',
    GROUP: 'http://opds-spec.org/group',
    COVER: [
        'http://opds-spec.org/image',
        'http://opds-spec.org/cover',
    ],
    THUMBNAIL: [
        'http://opds-spec.org/image/thumbnail',
        'http://opds-spec.org/thumbnail',
    ],
    STREAM: 'http://vaemendis.net/opds-pse/stream',
}

export const SYMBOL = {
    SUMMARY: Symbol('summary'),
    CONTENT: Symbol('content'),
}

const FACET_GROUP = Symbol('facetGroup')

const groupByArray = (arr, f) => {
    const map = new Map()
    if (arr) for (const el of arr) {
        const keys = f(el)
        for (const key of [keys].flat()) {
            const group = map.get(key)
            if (group) group.push(el)
            else map.set(key, [el])
        }
    }
    return map
}

// https://www.rfc-editor.org/rfc/rfc7231#section-3.1.1
const parseMediaType = str => {
    if (!str) return null
    const [mediaType, ...ps] = str.split(/ *; */)
    return {
        mediaType: mediaType.toLowerCase(),
        parameters: Object.fromEntries(ps.map(p => {
            const [name, val] = p.split('=')
            return [name.toLowerCase(), val?.replace(/(^"|"$)/g, '')]
        })),
    }
}

export const isOPDSCatalog = str => {
    const parsed = parseMediaType(str)
    if (!parsed) return false
    const { mediaType, parameters } = parsed
    if (mediaType === MIME.OPDS2) return true
    return mediaType === MIME.ATOM && parameters.profile?.toLowerCase() === 'opds-catalog'
}

// ignore the namespace if it doesn't appear in document at all
const useNS = (doc, ns) =>
    doc.lookupNamespaceURI(null) === ns || doc.lookupPrefix(ns) ? ns : null

const filterNS = ns => ns
    ? name => el => el.namespaceURI === ns && el.localName === name
    : name => el => el.localName === name

const getContent = el => {
    if (!el) return
    const type = el.getAttribute('type') ?? 'text'
    const value = type === 'xhtml' ? el.innerHTML
        : type === 'html' ? el.textContent
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&amp;', '&')
        : el.textContent
    return { value, type }
}

const getTextContent = el => {
    const content = getContent(el)
    if (content?.type === 'text') return content?.value
}

const getSummary = (a, b) => getTextContent(a) ?? getTextContent(b)

// Fetch only direct children to avoid polluting with nested deep indirect acquisitions
const getDirectChildren = (el, ns, localName, tagName) => {
    return Array.from(el.childNodes).filter(node =>
        node.nodeType === 1 &&
        (
            (node.namespaceURI === ns && node.localName === localName) ||
            (node.tagName === tagName)
        )
    )
}

const getPrice = link => {
    const prices = getDirectChildren(link, NS.OPDS, 'price', 'opds:price')
    if (!prices.length) return null
    const parsed = prices.map(price => ({
        currency: price.getAttribute('currencycode'),
        value: parseFloat(price.textContent),
    }))
    // Although OPDS 2.0 schema defines price as a single object, OPDS 1.x allows multiple.
    // Returning an array ensures no data loss, or a single object if there's only one.
    return parsed.length === 1 ? parsed[0] : parsed
}

const getIndirectAcquisition = el => {
    const ias = getDirectChildren(el, NS.OPDS, 'indirectAcquisition', 'opds:indirectAcquisition')
    if (!ias.length) return []
    return ias.map(ia => {
        const type = ia.getAttribute('type')
        const child = getIndirectAcquisition(ia)
        const res = { type }
        if (child.length > 0) res.child = child
        return res
    })
}

const getLink = link => {
    const obj = {
        rel: link.getAttribute('rel')?.split(/ +/),
        href: link.getAttribute('href'),
        type: link.getAttribute('type'),
        title: link.getAttribute('title'),
        properties: {},
    }

    // --- Prices & Indirect Acquisitions ---
    const price = getPrice(link)
    if (price) obj.properties.price = price

    const indirectAcquisition = getIndirectAcquisition(link)
    if (indirectAcquisition.length) obj.properties.indirectAcquisition = indirectAcquisition

    // --- Facet Grouping ---
    const facetGroup = link.getAttributeNS(NS.OPDS, 'facetGroup') || link.getAttribute('opds:facetGroup')
    if (facetGroup) obj[FACET_GROUP] = facetGroup

    // Map OPDS 1.x active facets to OPDS 2.0 "self" link
    const activeFacet = link.getAttributeNS(NS.OPDS, 'activeFacet') || link.getAttribute('opds:activeFacet')
    if (activeFacet === 'true') {
        obj.rel = [obj.rel ?? []].flat().concat('self')
    }

    // --- Pagination / Facet Counters ---
    // Maps OPDS 1.x thr:count seamlessly to OPDS 2.0 properties.numberOfItems
    const thrCount = link.getAttributeNS(NS.THR, 'count') || link.getAttribute('thr:count')
    const fallbackCount = link.getAttribute('count')
    const isStream = obj.rel?.includes(REL.STREAM)

    if (thrCount != null) {
        obj.properties.numberOfItems = Number(thrCount)
    } else if (!isStream && fallbackCount != null) {
        // Support for systems that incorrectly use standard `count` for facet hints
        obj.properties.numberOfItems = Number(fallbackCount)
    }

    // --- OPDS-PSE Extensions ---
    // Kept explicitly inside properties to map to OPDS 2.x standard extension mechanism
    const pseCount = link.getAttributeNS(NS.PSE, 'count') || link.getAttribute('pse:count')
    if (pseCount != null) {
        obj.properties['pse:count'] = Number(pseCount)
    } else if (isStream && fallbackCount != null) {
        obj.properties['pse:count'] = Number(fallbackCount)
    }

    const pseLastRead = link.getAttributeNS(NS.PSE, 'lastRead') || link.getAttribute('pse:lastRead')
    if (pseLastRead != null) obj.properties['pse:lastRead'] = Number(pseLastRead)

    const pseLastReadDate = link.getAttributeNS(NS.PSE, 'lastReadDate') || link.getAttribute('pse:lastReadDate')
    if (pseLastReadDate != null) obj.properties['pse:lastReadDate'] = pseLastReadDate
    // ---------------------------

    // Clean up empty properties
    if (Object.keys(obj.properties).length === 0) delete obj.properties

    return obj
}

const getPerson = person => {
    const NS = person.namespaceURI
    const uri = person.getElementsByTagNameNS(NS, 'uri')[0]?.textContent
    return {
        name: person.getElementsByTagNameNS(NS, 'name')[0]?.textContent ?? '',
        links: uri ? [{ href: uri }] : [],
    }
}

export const getPublication = entry => {
    const filter = filterNS(useNS(entry.ownerDocument, NS.ATOM))
    const children = Array.from(entry.children)
    const filterDCEL = filterNS(NS.DC)
    const filterDCTERMS = filterNS(NS.DCTERMS)
    const filterDC = x => {
        const a = filterDCEL(x), b = filterDCTERMS(x)
        return y => a(y) || b(y)
    }
    const links = children.filter(filter('link')).map(getLink)
    const linksByRel = groupByArray(links, link => link.rel)
    return {
        metadata: {
            title: children.find(filter('title'))?.textContent ?? '',
            author: children.filter(filter('author')).map(getPerson),
            contributor: children.filter(filter('contributor')).map(getPerson),
            publisher: children.find(filterDC('publisher'))?.textContent,
            published: (children.find(filterDCTERMS('issued'))
                ?? children.find(filterDC('date')))?.textContent,
            language: children.find(filterDC('language'))?.textContent,
            identifier: children.find(filterDC('identifier'))?.textContent,
            subject: children.filter(filter('category')).map(category => ({
                name: category.getAttribute('label'),
                code: category.getAttribute('term'),
                scheme: category.getAttribute('scheme'),
            })),
            rights: children.find(filter('rights'))?.textContent ?? '',
            [SYMBOL.CONTENT]: getContent(children.find(filter('content'))
                ?? children.find(filter('summary'))),
        },
        links,
        images: REL.COVER.concat(REL.THUMBNAIL)
            .map(R => linksByRel.get(R)?.[0]).filter(x => x),
    }
}

export const getFeed = doc => {
    const ns = useNS(doc, NS.ATOM)
    const filter = filterNS(ns)
    const children = Array.from(doc.documentElement.children)
    const entries = children.filter(filter('entry'))
    const links = children.filter(filter('link')).map(getLink)
    const linksByRel = groupByArray(links, link => link.rel)

    const filterFH = filterNS(NS.FH)
    const filterOS = filterNS(NS.OS)

    const groupedItems = new Map([[null, []]])
    const groupLinkMap = new Map()
    for (const entry of entries) {
        const children = Array.from(entry.children)
        const links = children.filter(filter('link')).map(getLink)
        const linksByRel = groupByArray(links, link => link.rel)
        const isPub = [...linksByRel.keys()]
            .some(rel => rel?.startsWith(REL.ACQ) || rel === 'preview' || rel === REL.STREAM)

        const groupLinks = linksByRel.get(REL.GROUP) ?? linksByRel.get('collection')
        const groupLink = groupLinks?.length
            ? groupLinks.find(link => groupedItems.has(link.href)) ?? groupLinks[0] : null
        if (groupLink && !groupLinkMap.has(groupLink.href))
            groupLinkMap.set(groupLink.href, groupLink)

        const item = isPub
            ? getPublication(entry)
            : Object.assign(links.find(link => isOPDSCatalog(link.type)) ?? links[0] ?? {}, {
                title: children.find(filter('title'))?.textContent,
                [SYMBOL.SUMMARY]: getSummary(children.find(filter('summary')),
                    children.find(filter('content'))),
            })

        const arr = groupedItems.get(groupLink?.href ?? null)
        if (arr) arr.push(item)
        else groupedItems.set(groupLink.href, [item])
    }
    const [items, ...groups] = Array.from(groupedItems, ([key, items]) => {
        const itemsKey = items[0]?.metadata ? 'publications' : 'navigation'
        if (key == null) return { [itemsKey]: items }
        const link = groupLinkMap.get(key)
        return {
            metadata: {
                title: link.title,
                numberOfItems: link.properties?.numberOfItems,
            },
            links: [{ rel: 'self', href: link.href, type: link.type }],
            [itemsKey]: items,
        }
    })

    const metadata = {
        title: children.find(filter('title'))?.textContent,
        subtitle: children.find(filter('subtitle'))?.textContent,
    }

    // --- OPDS 2.0 Pagination (derived from OpenSearch / RFC 5005) ---
    const totalResults = children.find(filterOS('totalResults'))?.textContent
    const itemsPerPage = children.find(filterOS('itemsPerPage'))?.textContent
    const startIndex = children.find(filterOS('startIndex'))?.textContent

    if (totalResults != null) metadata.numberOfItems = Number(totalResults)
    if (itemsPerPage != null) metadata.itemsPerPage = Number(itemsPerPage)
    if (startIndex != null && itemsPerPage != null) {
        const start = Number(startIndex)
        const items = Number(itemsPerPage)
        // Resolves typical 1-based offset to a page number
        metadata.currentPage = Math.floor((start > 0 ? start - 1 : 0) / items) + 1
    }

    const isComplete = !!children.find(filterFH('complete'))
    const isArchive = !!children.find(filterFH('archive'))
    // ----------------------------------------------------------------

    return {
        metadata,
        links,
        isComplete,
        isArchive,
        ...items,
        groups,
        facets: Array.from(
            groupByArray(linksByRel.get(REL.FACET) ?? [], link => link[FACET_GROUP]),
            ([facet, links]) => ({ metadata: { title: facet }, links })),
    }
}

export const getSearch = async link => {
    const { replace, getVariables } = await import('./uri-template.js')
    return {
        metadata: {
            title: link.title,
        },
        search: map => replace(link.href, map.get(null)),
        params: Array.from(getVariables(link.href), name => ({ name })),
    }
}

export const getOpenSearch = doc => {
    const defaultNS = doc.documentElement.namespaceURI
    const filter = filterNS(defaultNS)
    const children = Array.from(doc.documentElement.children)

    const $$urls = children.filter(filter('Url'))
    const $url = $$urls.find(url => isOPDSCatalog(url.getAttribute('type'))) ?? $$urls[0]
    if (!$url) throw new Error('document must contain at least one Url element')

    const regex = /{(?:([^}]+?):)?(.+?)(\?)?}/g
    const defaultMap = new Map([
        ['count', '100'],
        ['startIndex', $url.getAttribute('indexOffset') ?? '0'],
        ['startPage', $url.getAttribute('pageOffset') ?? '0'],
        ['language', '*'],
        ['inputEncoding', 'UTF-8'],
        ['outputEncoding', 'UTF-8'],
    ])

    const template = $url.getAttribute('template')
    return {
        metadata: {
            title: (children.find(filter('LongName')) ?? children.find(filter('ShortName')))?.textContent,
            description: children.find(filter('Description'))?.textContent,
        },
        search: map => template.replace(regex, (_, prefix, param) => {
            const namespace = prefix ? $url.lookupNamespaceURI(prefix) : null
            const ns = namespace === defaultNS ? null : namespace
            const val = map.get(ns)?.get(param)
            return encodeURIComponent(val ? val : (!ns ? defaultMap.get(param) ?? '' : ''))
        }),
        params: Array.from(template.matchAll(regex), ([, prefix, param, optional]) => {
            const namespace = prefix ? $url.lookupNamespaceURI(prefix) : null
            const ns = namespace === defaultNS ? null : namespace
            return {
                ns, name: param,
                required: !optional,
                value: ns && ns !== defaultNS ? '' : defaultMap.get(param) ?? '',
            }
        }),
    }
}
