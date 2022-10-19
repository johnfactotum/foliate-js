# foliate-js

Library for rendering e-books in the browser.

Features:
- Supports EPUB, MOBI, KF8, FB2, CBZ
- Pure JavaScript
- Small and modular
- No dependencies
- Does not depend on or include any library for unzipping; bring your own Zip library
- Does not require loading whole file into memory
- Does not care about older browsers
- No continuous scrolling mode :(

## Demo

Serve the files with a server, and open `reader.html`. Or visit https://johnfactotum.github.io/foliate-js/reader.html.

Note that deobfuscating fonts with the IDPF algorithm requires a SHA-1 function. By default it uses Web Crypto, which is only available in secure contexts. Without HTTPS, you will need to modify `reader.js` and pass your own SHA-1 implementation.

## Documentation

### Overview

The project is designed to be modular. It has two renderers, one for paginating reflowable books, and one for fixed layout. The `View` class defined in `view.js` is the one that strings everything together.

Processors for each book format return an object that implements the following interface:
- `.sections`: an array of sections in the book. Each item has the following properties:
    - `.load()`: returns a string containing the URL that will be rendered. May be async.
    - `.unload()`: returns nothing. If present, can be used to free the section.
    - `.createDocument()`: returns a `Document` object of the section. Used for searching. May be async.
    - `.size`: a number, the byte size of the section. Used for showing reading progress.
    - `.linear`: a string. If it is `"no"`, the section is not part of the linear reading sequence (see the [`linear`](https://www.w3.org/publishing/epub32/epub-packages.html#attrdef-itemref-linear) attribute in EPUB).
    - `.cfi`: base CFI string of the section. The part that goes before the `!` in CFIs.
    - `.id`: an identifier for the section, used for getting TOC item (see below). Can be anything, as long as they can be used as keys in a `Map`.
- `.dir`: a string representing the page progression direction of the book (`"rtl"` or `"ltr"`).
- `.toc`: an array representing the table of contents of the book. Each item has
    - `.label`: a string label for the item
    - `.href`: a string representing the destination of the item. Does not have to be a valid URL.
    - `.subitems`: a array that contains TOC items
- `.pageList`: same as the TOC, but for the [page list](https://www.w3.org/publishing/epub32/epub-packages.html#sec-nav-pagelist).
- `.metadata`: an object representing the metadata of the book.
- `.rendition`: an object that contains properties that correspond to the [rendition properties](https://www.w3.org/publishing/epub32/epub-packages.html#sec-package-metadata-rendering) in EPUB. If `.layout` is `"pre-paginated"`, the book is rendered with the fixed layout renderer.
- `.resolveHref(href)`: given an href string, returns an object representing the destination referenced by the href, which has the following properties:
    - `.index`: the index of the referenced section in the `.section` array
    - `.anchor(doc)`: given a `Document` object, returns the document fragment referred to by the href (can either be an `Element` or a `Range`), or `null`
- `.resolveCFI(cfi)`: same as above, but with a CFI string instead of href
- `.isExternal(href)`: returns a boolean. If `true`, the link should be opened externally.

The following methods are consumed by `progress.js`, for getting the correct TOC and page list item when navigating:
- `.splitTOCHref(href)`: given an href string (from the TOC), returns an array, the first element of which is the `id` of the section (see above), and the second element is the fragment identifier (can be any type; see below)
- `.getTOCFragment(doc, id)`: given a `Document` object and a fragment identifier (the one provided by `.splitTOCHref()`; see above), returns a `Node` representing the target linked by the TOC item

Almost all of the properties and methods are optional. At minimum it needs `.sections` and the `.load()` method for the sections, as otherwise there won't be anything to render.

### Compressed Data

Reading Zip-based formats requires a separate library. Both `epub.js` and `comic-book.js` expect a `loader` object that implements the following interface:

- `.entries`: an array, each element of which has a `filename` property, which is a string containing the filename (the full path) (only used by `comic-book.js`)
- `.loadText(filename)`: given the path, returns content of the file as string
- `.loadBlob(filename)`: give the path, returns the file as a blob
- `.getSize(filename)`: returns the file size in bytes

In the demo, this is implemented using [Zip.js](https://github.com/gildas-lormeau/zip.js), which is highly recommended because it seems to be the only library that supports random access for `File` objects (as well as HTTP range requests).

Also note that KF8 files can contain fonts that are zlib-compressed. The demo uses [fflate](https://github.com/101arrowz/fflate) to decompress them.

### The Renderers

The paginator uses the same pagination strategy as [Epub.js](https://github.com/futurepress/epub.js): it uses CSS multi-column. As such it shares much of the same limitations (it's slow, some CSS styles do not work as expected, and other bugs). There are a few differences:
- It is a totally standalone module. You can use it to paginate any content.
- It is much simpler, but currently there's no support for continuous scrolling.
- To simplify things, it always spans the whole viewport. One can always put everything in an iframe if desired.
- It has no concept of CFIs and operates on `Range` objects directly. 
- It uses bisecting to find the current visible range, which is more accurate than what Epub.js does.
- It has an internal `#anchor` property, which can be a `Range`, `Element`, or a fraction that represents the current location. The view is *anchored* to it no matter how you resize the window.
- It supports more than two columns.
- It supports switching between scrolled and paginated mode without reloading (I can't figure out how to do this in Epub.js).

To simplify things, it has a totally separate renderer for fixed layout books. As such there's no support for mixed layout books.

### Supported Browsers

The main use of the library is for use in [Foliate](https://github.com/johnfactotum/foliate), which uses WebKitGTK. As such it's the only engine that has been tested extensively. But it should also work in Chromium and Firefox. Currently, one severe bug is that vertical writing is broken on Firefox.

## License

MIT.

Vendored libraries for the demo:
- Zip.js is licensed under the BSD-3-Clause license.
- fflate is MIT licensed.
