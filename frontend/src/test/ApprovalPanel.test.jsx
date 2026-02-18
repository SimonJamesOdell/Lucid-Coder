import React from 'react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ApprovalPanel from '../components/ApprovalPanel'

describe('ApprovalPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('does not render when no decision is provided', () => {
    render(<ApprovalPanel decision={null} onClose={vi.fn()} />)
    expect(screen.queryByTestId('approval-modal')).not.toBeInTheDocument()
  })

  test('renders for suggest_router_with_approval and dispatches show-diff', async () => {
    const showDiffListener = vi.fn()
    window.addEventListener('lucidcoder:show-diff', showDiffListener)

    render(
      <ApprovalPanel
        decision={{
          decision: 'suggest_router_with_approval',
          recommendation: 'Use router',
          rationale: 'Medium confidence'
        }}
      />
    )

    expect(await screen.findByTestId('approval-modal')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('show-diff'))

    await waitFor(() => {
      expect(showDiffListener).toHaveBeenCalledTimes(1)
    })

    window.removeEventListener('lucidcoder:show-diff', showDiffListener)
  })

  test('approve dispatches apply event and closes modal', async () => {
    const applyListener = vi.fn()
    const onClose = vi.fn()
    window.addEventListener('lucidcoder:apply-recommendation', applyListener)

    render(
      <ApprovalPanel
        decision={{
          decision: 'suggest_router_with_approval',
          recommendation: 'Use router',
          rationale: 'Medium confidence'
        }}
        onClose={onClose}
      />
    )

    expect(await screen.findByTestId('approval-modal')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('approve-recommendation'))

    await waitFor(() => {
      expect(applyListener).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    expect(screen.queryByTestId('approval-modal')).not.toBeInTheDocument()

    window.removeEventListener('lucidcoder:apply-recommendation', applyListener)
  })

  test('dismiss button and backdrop close modal', async () => {
    const onClose = vi.fn()
    const view = render(
      <ApprovalPanel
        decision={{
          decision: 'suggest_router_with_approval',
          recommendation: 'Use router',
          rationale: 'Medium confidence'
        }}
        onClose={onClose}
      />
    )

    expect(await screen.findByTestId('approval-modal')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('dismiss-recommendation'))
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    view.rerender(
      <ApprovalPanel
        decision={{
          decision: 'suggest_router_with_approval',
          recommendation: 'Use router',
          rationale: 'Medium confidence'
        }}
        onClose={onClose}
      />
    )

    expect(await screen.findByTestId('approval-modal')).toBeInTheDocument()

    const backdrop = view.container.querySelector('.approval-modal__backdrop')
    expect(backdrop).toBeTruthy()
    backdrop.click()

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(2)
    })
  })

  test('does not open for other decision types', () => {
    render(
      <ApprovalPanel
        decision={{
          decision: 'auto_apply_router_api',
          recommendation: 'Auto',
          rationale: 'High confidence'
        }}
      />
    )

    expect(screen.queryByTestId('approval-modal')).not.toBeInTheDocument()
  })
})
