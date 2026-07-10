import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RoomAvatar } from './RoomAvatar'

describe('RoomAvatar', () => {
  test('renders a rounded square, not a circle', () => {
    const { container } = render(<RoomAvatar identifier="team@conference.example.com" name="Team" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('rounded-[28%]')
    expect(root.className).not.toContain('rounded-full')
  })

  test('shows the Hash fallback when no avatarUrl is given', () => {
    const { container } = render(<RoomAvatar identifier="team@conference.example.com" name="Team" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  test('renders the image when avatarUrl is provided', () => {
    const { container } = render(
      <RoomAvatar identifier="team@conference.example.com" name="Team" avatarUrl="blob:room" />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('blob:room')
  })

  test('forwards an overlay', () => {
    const { getByTestId } = render(
      <RoomAvatar identifier="team@conference.example.com" name="Team" overlay={<span data-testid="ov" />} />
    )
    expect(getByTestId('ov')).toBeTruthy()
  })
})
