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
})
