import { Paginator, pageTurnAnimationDuration } from '../paginator.js'

for (const [input, expected] of [
    [null, 300], ['', 300], ['  ', 300], ['0', 0], ['180', 180],
    ['-4', 0], ['2000', 1000], ['bad', 300], ['Infinity', 300],
]) console.assert(pageTurnAnimationDuration(input) === expected,
    `duration ${JSON.stringify(input)} should resolve to ${expected}`)

// Exercise the actual scroll and page-turn paths, not just attribute parsing.
const paginator = new Paginator()
paginator.style.cssText = 'display:block;width:360px;height:500px'
paginator.setAttribute('max-column-count', '1')
paginator.setAttribute('animated', '')
paginator.setAttribute('animation-duration', '0')
document.body.append(paginator)
const url = URL.createObjectURL(new Blob([
    '<!DOCTYPE html><html><body>' + '<p>A paragraph with enough words to fill several pages.</p>'.repeat(100)
    + '</body></html>',
], { type: 'text/html' }))
try {
    paginator.open({ sections: [{ load: async () => url, size: 10000 }] })
    await paginator.goTo({ index: 0, anchor: () => 0 })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const before = paginator.page
    let animationFrames = 0
    const originalRAF = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = callback => {
        animationFrames++
        return originalRAF(callback)
    }
    try {
        let settled = false
        const turn = paginator.next().then(() => { settled = true })
        // An instant within-section turn settles without a frame or cooldown timer.
        for (let i = 0; i < 20 && !settled; i++) await Promise.resolve()
        console.assert(settled, 'zero-duration page turn must settle without a timer')
        await turn
        console.assert(paginator.page === before + 1, 'instant turn advances one page')
        console.assert(animationFrames === 0, 'zero duration must not schedule animation frames')
    } finally {
        globalThis.requestAnimationFrame = originalRAF
    }
} finally {
    paginator.destroy()
    paginator.remove()
    URL.revokeObjectURL(url)
}
