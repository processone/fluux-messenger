import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StrangerMessageItem } from './StrangerMessageItem'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const messages = [{ id: 'm1', from: 'x@example.com', body: 'hello there', timestamp: new Date() }]

function setup() {
  const onSelect = vi.fn()
  const onAccept = vi.fn()
  const onIgnore = vi.fn()
  const onBlock = vi.fn()
  render(
    <StrangerMessageItem
      jid="x@example.com"
      messages={messages}
      onSelect={onSelect}
      onAccept={onAccept}
      onIgnore={onIgnore}
      onBlock={onBlock}
    />
  )
  return { onSelect, onAccept, onIgnore, onBlock }
}

describe('StrangerMessageItem', () => {
  it('opens the preview when the info row is clicked', () => {
    const { onSelect, onAccept } = setup()
    fireEvent.click(screen.getByText('x'))
    expect(onSelect).toHaveBeenCalledWith('x@example.com')
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('acts on the buttons without opening the preview', () => {
    const { onSelect, onAccept, onBlock } = setup()
    fireEvent.click(screen.getByText('common.accept'))
    expect(onAccept).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('common.block'))
    expect(onBlock).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
