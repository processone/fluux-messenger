import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Image as ImageIcon } from 'lucide-react'
import { DeferredMediaPlaceholder } from './DeferredMediaPlaceholder'

describe('DeferredMediaPlaceholder', () => {
  it('renders label and size, fires onLoad on click', () => {
    const onLoad = vi.fn()
    render(
      <DeferredMediaPlaceholder variant="box" icon={ImageIcon} label="Load image" sizeLabel="1.2 MB" onLoad={onLoad} />,
    )
    expect(screen.getByText('Load image')).toBeInTheDocument()
    expect(screen.getByText('1.2 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('omits size when no sizeLabel given (card variant)', () => {
    render(<DeferredMediaPlaceholder variant="card" icon={ImageIcon} label="Load audio" onLoad={() => {}} />)
    expect(screen.getByText('Load audio')).toBeInTheDocument()
    expect(screen.queryByText(/MB/)).not.toBeInTheDocument()
  })

  it('insets the box variant so a long name never runs flush against the frame', () => {
    render(
      <DeferredMediaPlaceholder
        variant="box"
        icon={ImageIcon}
        label="Load image"
        name="zb2rhYRAjkYZ7qdWwhv7qdz6qVukFezQxwNSYgXHunKWCgaBc"
        onLoad={() => {}}
      />,
    )
    // The name truncates at the box width, so without horizontal padding the
    // ellipsised text starts on the border itself.
    expect(screen.getByRole('button').className).toMatch(/(^|\s)px-3(\s|$)/)
  })

  it('shows the file name as a hint, alongside the label and size, when name is given', () => {
    render(
      <DeferredMediaPlaceholder variant="box" icon={ImageIcon} label="Load image" name="screenshot.png" sizeLabel="12.7 KB" onLoad={() => {}} />,
    )
    expect(screen.getByText('screenshot.png')).toBeInTheDocument()
    expect(screen.getByText('Load image')).toBeInTheDocument()
    expect(screen.getByText('12.7 KB')).toBeInTheDocument()
  })
})
