import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToastContainer } from './ToastContainer'
import { useToastStore } from '@/stores/toastStore'

describe('ToastContainer', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
  })

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />)
    expect(container.innerHTML).toBe('')
  })

  it('renders a toast message', () => {
    useToastStore.getState().addToast('success', 'It worked', 0)

    render(<ToastContainer />)
    expect(screen.getByText('It worked')).toBeInTheDocument()
  })

  it('renders multiple toasts', () => {
    useToastStore.getState().addToast('success', 'First', 0)
    useToastStore.getState().addToast('error', 'Second', 0)

    render(<ToastContainer />)
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('removes a toast when dismiss button is clicked', () => {
    useToastStore.getState().addToast('info', 'Dismiss me', 0)

    render(<ToastContainer />)
    expect(screen.getByText('Dismiss me')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument()
  })

  it('renders toast with role="status" for accessibility', () => {
    useToastStore.getState().addToast('success', 'Accessible', 0)

    render(<ToastContainer />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
