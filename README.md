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

## Demo

The repo includes a demo viewer that can be used to open local files. To use it, serve the files with a server, and navigate to `reader.html`. Or visit the [online demo](https://johnfactotum.github.io/foliate-js/reader.html) hosted on GitHub. Note that it is very incomplete at the moment, and lacks many basic features such as keyboard shortcuts.

Also note that deobfuscating fonts with the IDPF algorithm requires a SHA-1 function. By default it uses Web Crypto, which is only available in secure contexts. Without HTTPS, you will need to modify `reader.js` and pass your own SHA-1 implementation.

## Current Status

It's far from complete or stable yet, though it should have near feature parity with [Epub.js](https://github.com/futurepress/epub.js). There's no support for continuous scrolling, however.

Among other things, the fixed-layout renderer is notably unfinished at the moment.

## Documentation

### Overview

This project uses native ES modules. There's no build step, and you can import them directly.

There are mainly three kinds of modules:

- Modules that parse and load books, implementing the "book" interface
    - `comic-book.js`, for comic book archives (CBZ)
    - `epub.js` and `epubcfi.js`, for EPUB
    - `fb2.js`, for FictionBook 2
    - `mobi.js`, for both Mobipocket files and KF8 (commonly known as AZW3) files
- Modules that handle pagination, implementing the "renderer" interface
    - `fixed-layout.js`, for fixed layout books
    - `paginator.js`, for reflowable books
- Auxiliary modules used to add additional functionalities
    - `overlayer.js`, for rendering annotations
    - `progress.js`, for getting reading progress
    - `search.js`, for searching

The modules are designed to be modular. In general, they don't directly depend on each other. Instead they depend on certain interfaces, detailed below. The exception is `view.js`. It is the higher level renderer that strings most of the things together, and you can think of it as the main entry point of the library. Its basic usage is as follows:

- The `View` constructor takes two arguments: `book`, an object that implements the "book" interface, and `emit`, which is a callback that you can use to handle various events. Note that for simplicity, unlike Epub.js or other libraries, there's no event or pub/sub system.
- To render the book, you must first call `.display()`, which is an async function that returns an Element, which you must then append to the DOM yourself, e.g. `document.body.append(await view.display())`.
- To actually display the page, you must then either call `.next()`, which will display the first linear page of the book, or use `.goTo()` to go to a specific location.

The repo also includes a still higher level reader, though strictly speaking, `reader.html` (along with `reader.js` and its associated files in `ui/` and `vendor/`) is not considered part of the library itself. It's akin to [Epub.js Reader](https://github.com/futurepress/epubjs-reader). You are expected to modify it or replace it with your own code.

### The Main Interface for Books

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

### Archived Files

Reading Zip-based formats will require adapting an external library. Both `epub.js` and `comic-book.js` expect a `loader` object that implements the following interface:

- `.entries`: (only used by `comic-book.js`) an array, each element of which has a `filename` property, which is a string containing the filename (the full path).
- `.loadText(filename)`: given the path, returns the contents of the file as string.  May be async.
- `.loadBlob(filename)`: given the path, returns the file as a `Blob` object. May be async.
- `.getSize(filename)`: returns the file size in bytes. Used to set the `.size` property for `.sections` (see above).

In the demo, this is implemented using [Zip.js](https://github.com/gildas-lormeau/zip.js), which is highly recommended because it seems to be the only library that supports random access for `File` objects (as well as HTTP range requests).

One advantage of having such an interface is that one can easily use it for reading unarchived files as well. For example, the demo has a loader that allows you to open unpacked EPUBs as directories.

### Mobipocket and Kindle Files

It can read both MOBI and KF8 (.azw3, and combo .mobi files) from a `File` (or `Blob`) object. For MOBI files, it decompresses all text at once and splits the raw markup into sections at every `<mbp:pagebreak>`, instead of outputing one long page for the whole book, which drastically improves rendering performance. For KF8 files, it tries to decompress as little text as possible when loading a section, but it can still be quite slow due to the slowness of the current HUFF/CDIC decompressor implementation. In all cases, images and other resources are not loaded until they are needed.

Note that KF8 files can contain fonts that are zlib-compressed. They need to be decompressed with an external library. The demo uses [fflate](https://github.com/101arrowz/fflate) to decompress them.

### The Renderers

It has two renderers, one for paginating reflowable books, and one for fixed-layout. The constructor of a renderer takes a single object with the following properties:
- `.book`: the book object that will be rendered.
- `.onLoad(doc, index)`: callback when a section is loaded. Takes a `Document` object and the index of the section.
- `.onRelocated(range, index, fraction)`: callback when locations changes. `range` is a `Range` object containing the current visible area. `fraction` is a number between 0 and 1, representing the reading progress within the section.
- `createOverlayer(doc, index)`: callback for adding an overlay to the page. It should return an overlayer object (see the description for `overlayer.js` below).

A renderer's interface is currently mainly:
- `.element`: the DOM element of the renderer. It needs to be manually appended to the document by the consumer of the renderer.
- `.goTo({ index, anchor })`: navigate to a destination. The argument has the same type as the one returned by `.resolveHref()` in the book object.
- `.prev()`: go to previous page.
- `.next()`: go to next page.

The paginator uses the same pagination strategy as [Epub.js](https://github.com/futurepress/epub.js): it uses CSS multi-column. As such it shares much of the same limitations (it's slow, some CSS styles do not work as expected, and other bugs). There are a few differences:
- It is a totally standalone module. You can use it to paginate any content.
- It is much simpler, but currently there's no support for continuous scrolling.
- It has no concept of CFIs and operates on `Range` objects directly. 
- It uses bisecting to find the current visible range, which is more accurate than what Epub.js does.
- It has an internal `#anchor` property, which can be a `Range`, `Element`, or a fraction that represents the current location. The view is *anchored* to it no matter how you resize the window.
- It supports more than two columns.
- It supports switching between scrolled and paginated mode without reloading (I can't figure out how to do this in Epub.js).

To simplify things, it has a totally separate renderer for fixed layout books. As such there's no support for mixed layout books.

### EPUB CFI

Parsed CFIs are represented as a plain array or object. The basic type is called a "part", which is an object with the following structure: `{ index, id, offset, temporal, spatial, text, side }`, corresponding to a step + offset in the CFI.

A collapsed, non-range CFI is represented as an array whose elements are arrays of parts, each corresponding to a full path. That is, `/6/4!/4` is turned into

```json
[
    [
        { "index": 6 },
        { "index": 4 }
    ],
    [
        { "index": 4 }
    ]
]
```

A range CFI is an object `{ parent, start, end }`, each property being the same type as a collapsed CFI. For example, `/6/4!/2,/2,/4` is represented as

```json
{
    "parent": [
        [
            { "index": 6 },
            { "index": 4 }
        ],
        [
            { "index": 2 }
        ]
    ],
    "start": [
        [
            { "index": 2 }
        ]
    ],
    "end": [
        [
            { "index": 4 }
        ]
    ]
}
```

The parser uses a state machine rather than regex, and should handle assertions that contain escaped characters correctly (see tests for examples of this).

It can parse and stringify spatial and temporal offsets, as well as text location assertions and side bias, but there's no support for employing them when rendering yet. It's also missing the ability to ignore certain nodes (which is needed if you want to inject your own nodes into the document).

### Highlighting Text

There is a generic module for overlaying arbitrary SVG elements, `overlayer.js`. It can be used to implement highlighting text for annotations. It's the same technique used by [marks-pane](https://github.com/fchasen/marks), used by Epub.js, but it's designed to be easily extensible. You can return any SVG element in the `draw` function, making it possible to add custom styles such as squiggly lines or even free hand drawings.

The overlay has no event listeners by default. It only provides a `.hitTest(event)` method, that can be used to do hit tests. Currently it does this with the client rects of `Range`s, not the element returned by `draw()`.

An overlayer object implements the following interface for the consumption of renderers:
- `.element`: the DOM element of the overlayer. This element will be inserted, resized, and positioned automatically by the renderer on top of the page.
- `.redraw()`: called by the renderer when the overlay needs to be redrawn.

### Searching

It provides a search module, which can in fact be used as a standalone module for searching across any array of strings. There's no limit on the number of strings a match is allowed to span. It's based on `Intl.Collator` and `Intl.Segmenter`, to support ignoring diacritics and matching whole words only. It's extrenely slow, and you'd probably want to load results incrementally.

### Supported Browsers

The main use of the library is for use in [Foliate](https://github.com/johnfactotum/foliate), which uses WebKitGTK. As such it's the only engine that has been tested extensively. But it should also work in Chromium and Firefox.

Apart from the renderers, using the modules outside browsers is also possible. Most features depend on having the global objects `Blob`, `TextDecoder`, `TextEncoder`, `DOMParser`, `XMLSerializer`, and `URL`, and should work if you polyfill them. Note that `epubcfi.js` can be used as is in any envirnoment if you only need to parse or sort CFIs.

## License

MIT.

Vendored libraries for the demo:
- Zip.js is licensed under the BSD-3-Clause license. Copyright © 2022 Gildas Lormeau.
- fflate is MIT licensed. Copyright © 2020 Arjun Barrett.
