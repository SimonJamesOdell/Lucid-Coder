import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'

const renderSpy = vi.fn()
const createRootSpy = vi.fn(() => ({ render: renderSpy }))

vi.mock('react-dom/client', () => ({
  default: { createRoot: createRootSpy },
  createRoot: createRootSpy
}))

const MockApp = () => null
vi.mock('../App.jsx', () => ({ default: MockApp }))

describe('main entrypoint', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    renderSpy.mockClear()
    createRootSpy.mockClear()
  })

  it('renders App inside React.StrictMode using the root element', async () => {
    await import('../main.jsx')

    expect(createRootSpy).toHaveBeenCalledWith(document.getElementById('root'))
    expect(renderSpy).toHaveBeenCalledTimes(1)

    const renderedTree = renderSpy.mock.calls[0][0]
    expect(renderedTree.type).toBe(React.StrictMode)
    expect(renderedTree.props.children.type).toBe(MockApp)
  })
})
