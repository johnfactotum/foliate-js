import '../quote-image.js'

const timeout = (promise, ms) => Promise.race([promise,
    new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))])

{
    // the SVG is serialized into a data URL, and `#` starts the URL fragment,
    // so anything after the first one used to be dropped, leaving an image
    // that could never load and a promise that never settled; note the
    // template's own colours contain `#`, so this held for any input at all
    const el = document.createElement('foliate-quoteimage')
    document.body.append(el)
    let blob
    try {
        blob = await timeout(el.getBlob({
            title: 'The #1 Book',
            author: '100% Author',
            // `%20` would be decoded were only `#` escaped, and the lone
            // surrogate is what a selection split through a pair produces
            text: 'Chapter #3, 50%20 done, 中文, 😀, \uD800',
        }), 10000)
    } catch (e) {
        console.assert(false, `getBlob() rejected: ${e.message}`)
    }
    console.assert(blob instanceof Blob, `expected a Blob, got ${blob}`)
    console.assert(blob?.size > 0, `expected a non-empty blob, got ${blob?.size}`)
    el.remove()
}
