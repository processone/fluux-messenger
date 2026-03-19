import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { StorageSettings } from './StorageSettings'

// Mock mediaCache
const mockGetMediaCacheSize = vi.fn()
const mockClearMediaCache = vi.fn()
vi.mock('@/utils/mediaCache', () => ({
  getMediaCacheSize: () => mockGetMediaCacheSize(),
  clearMediaCache: () => mockClearMediaCache(),
}))

// Mock formatBytes
vi.mock('@/hooks', () => ({
  formatBytes: (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  },
}))

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'settings.storage.mediaCache': 'Media Cache',
        'settings.storage.mediaCacheDescription': 'Downloaded images and media are cached locally.',
        'settings.storage.cacheSize': 'Cache size',
        'settings.storage.clearCache': 'Clear Cache',
        'settings.storage.cacheCleared': 'Cache cleared',
        'settings.storage.calculating': 'Calculating...',
      }
      return translations[key] || key
    },
  }),
}))

describe('StorageSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMediaCacheSize.mockResolvedValue(0)
    mockClearMediaCache.mockResolvedValue(undefined)
  })

  it('should show calculating state while loading cache size', () => {
    // Never-resolving promise to keep loading state
    mockGetMediaCacheSize.mockReturnValue(new Promise(() => {}))

    render(<StorageSettings />)

    expect(screen.getByText('Calculating...')).toBeInTheDocument()
  })

  it('should display cache size after loading', async () => {
    mockGetMediaCacheSize.mockResolvedValue(5 * 1024 * 1024) // 5 MB

    render(<StorageSettings />)

    await waitFor(() => {
      expect(screen.getByText('5 MB')).toBeInTheDocument()
    })
  })

  it('should display 0 B for empty cache', async () => {
    mockGetMediaCacheSize.mockResolvedValue(0)

    render(<StorageSettings />)

    await waitFor(() => {
      expect(screen.getByText('0 B')).toBeInTheDocument()
    })
  })

  it('should disable clear button when cache is empty', async () => {
    mockGetMediaCacheSize.mockResolvedValue(0)

    render(<StorageSettings />)

    await waitFor(() => {
      expect(screen.getByText('0 B')).toBeInTheDocument()
    })

    const clearButton = screen.getByRole('button', { name: /clear cache/i })
    expect(clearButton).toBeDisabled()
  })

  it('should enable clear button when cache has data', async () => {
    mockGetMediaCacheSize.mockResolvedValue(1024)

    render(<StorageSettings />)

    await waitFor(() => {
      const clearButton = screen.getByRole('button', { name: /clear cache/i })
      expect(clearButton).not.toBeDisabled()
    })
  })

  it('should clear cache and show feedback on click', async () => {
    mockGetMediaCacheSize.mockResolvedValue(10000)

    render(<StorageSettings />)

    await waitFor(() => {
      expect(screen.getByText('9.8 KB')).toBeInTheDocument()
    })

    const clearButton = screen.getByRole('button', { name: /clear cache/i })
    fireEvent.click(clearButton)

    await waitFor(() => {
      expect(mockClearMediaCache).toHaveBeenCalledTimes(1)
    })

    // After clearing, size should be 0 and "Cache cleared" shown
    await waitFor(() => {
      expect(screen.getByText('0 B')).toBeInTheDocument()
      expect(screen.getByText('Cache cleared')).toBeInTheDocument()
    })
  })

  it('should show section header and description', async () => {
    render(<StorageSettings />)

    expect(screen.getByText('Media Cache')).toBeInTheDocument()
    expect(screen.getByText('Downloaded images and media are cached locally.')).toBeInTheDocument()
    expect(screen.getByText('Cache size')).toBeInTheDocument()
  })
})
