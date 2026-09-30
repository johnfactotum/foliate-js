import { Paginator } from '../paginator.js'

const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
const touch = (target, type, x) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const point = { screenX: x, screenY: 50 }
    Object.defineProperties(event, {
        changedTouches: { value: [point] }, touches: { value: type === 'touchend' ? [] : [point] },
    })
    target.dispatchEvent(event)
    return event
}

const paginator = new Paginator()
document.body.append(paginator)
let scrolls = 0, snaps = 0
paginator.scrollBy = () => { scrolls++ }
paginator.snap = () => { snaps++ }
try {
    paginator.setAttribute('swipe-disabled', '')
    touch(paginator, 'touchstart', 100)
    console.assert(!touch(paginator, 'touchmove', 50).defaultPrevented,
        'disabled swipes must leave the touch move to the embedder or browser')
    touch(paginator, 'touchend', 50)
    await frame()
    console.assert(scrolls === 0 && snaps === 0, 'disabled swipes do not scroll or snap')

    paginator.removeAttribute('swipe-disabled')
    touch(paginator, 'touchstart', 100)
    console.assert(touch(paginator, 'touchmove', 50).defaultPrevented,
        'enabled swipes retain their existing touch cancellation')
    touch(paginator, 'touchend', 50)
    await frame()
    console.assert(scrolls === 1 && snaps === 1, 'enabled swipes still scroll and snap')

    touch(paginator, 'touchstart', 100)
    paginator.setAttribute('swipe-disabled', '')
    console.assert(!touch(paginator, 'touchmove', 50).defaultPrevented,
        'disabling mid-gesture must immediately yield the touch move')
    touch(paginator, 'touchend', 50)
    paginator.removeAttribute('swipe-disabled')
    await frame()
    console.assert(scrolls === 1 && snaps === 1, 'a cancelled gesture is not revived by re-enabling')

    touch(paginator, 'touchstart', 100)
    touch(paginator, 'touchmove', 50)
    touch(paginator, 'touchend', 50)
    paginator.setAttribute('swipe-disabled', '')
    await frame()
    console.assert(scrolls === 2 && snaps === 1, 'disabling before the queued frame cancels the snap')
} finally {
    paginator.remove()
}
