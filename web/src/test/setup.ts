import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@/i18n'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// jsdom lacks these browser APIs used by Radix and the views.
class ResizeObserverStub {
  observe(): void {
    // no layout in jsdom
  }
  unobserve(): void {
    // no layout in jsdom
  }
  disconnect(): void {
    // no layout in jsdom
  }
}
globalThis.ResizeObserver = ResizeObserverStub

window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList

// No real pointers in jsdom: capture is a no-op, tests send the moves to the pressed element.
Element.prototype.setPointerCapture = () => undefined
Element.prototype.releasePointerCapture = () => undefined
Element.prototype.hasPointerCapture = () => false

// Radix Select scrolls the selected option into view when it opens.
Element.prototype.scrollIntoView = () => undefined
