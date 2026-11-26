import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SearchSenderPicker } from './SearchSenderPicker'
import * as sdk from '@fluux/sdk'

const { translate } = vi.hoisted(() => ({ translate: (key: string) => key }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}))

const open = () => {
  fireEvent.click(screen.getByRole('button'))
  return screen.getByRole('combobox')
}

describe('approved sender picker review regressions', () => {
  it('equates Greek sigma forms only for matching', () => {
    render(<SearchSenderPicker value="" senders={[{ value: 'nikos@example.test', label: 'Νίκος' }]} onChange={vi.fn()} />)
    const picker = open()
    fireEvent.change(picker, { target: { value: 'Σ' } })
    expect(screen.getByRole('option', { name: 'Νίκος · nikos@example.test' })).toBeInTheDocument()
  })

  it('keeps malformed UTF-16 saved senders intact with stable, distinct row IDs', () => {
    const value = 'departed\ud800@example.test'
    const onChange = vi.fn()
    render(<SearchSenderPicker value={value} senders={[{ value: 'departed\ud801@example.test', label: 'Jo' }]} onChange={onChange} />)
    const picker = open()
    const rows = screen.getAllByRole('option')
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
    const savedId = rows[2].id
    fireEvent.change(picker, { target: { value: 'departed' } })
    expect(screen.getAllByRole('option')[2].id).toBe(savedId)
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    expect(picker).toHaveAttribute('aria-activedescendant', savedId)
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(value)
  })

  it('drops an absent highlight from selection and accessibility state', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SearchSenderPicker value="" senders={[{ value: 'jo@example.test', label: 'Jo' }]} onChange={onChange} />)
    const picker = open()
    fireEvent.keyDown(picker, { key: 'ArrowUp' })
    expect(picker).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Jo · jo@example.test' }).id)
    rerender(<SearchSenderPicker value="" senders={[]} onChange={onChange} />)
    expect(picker).not.toHaveAttribute('aria-activedescendant')
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(picker).toHaveFocus()
  })

  it('distinguishes equal room titles, reused nicknames and shortcut collisions in rows and the closed choice', () => {
    const onChange = vi.fn()
    const saved = 'room:team%40conference.example.test:CURRENT-id:Camille'
    render(<SearchSenderPicker value={saved} senders={[
      { value: 'room:team%40conference.example.test:current-id:Camille', label: 'Camille' },
      { value: 'room:help%40conference.example.test:help-id:Camille', label: 'Camille' },
      { value: 'room:team%40conference.example.test:other-id:search.panel.me', label: 'search.panel.me' },
    ]} onChange={onChange} />)
    expect(screen.getByRole('button')).toHaveTextContent('Camille · team@conference.example.test · common.saved')
    open()
    const names = screen.getAllByRole('option').map(row => row.textContent)
    expect(names).toEqual([
      'search.panel.anyone', 'search.panel.me',
      'Camille · team@conference.example.test · common.saved',
      'Camille · team@conference.example.test', 'Camille · help@conference.example.test',
      'search.panel.me · team@conference.example.test',
    ])
    fireEvent.click(screen.getByRole('option', { name: 'Camille · team@conference.example.test' }))
    expect(onChange).toHaveBeenCalledWith('room:team%40conference.example.test:current-id:Camille')
  })

  it('adds distinct room addresses when displayed room titles also collide', () => {
    render(<SearchSenderPicker value="" senders={[
      { value: 'room:team%40conference.example.test:camille-team:Camille', label: 'Camille · Équipe' },
      { value: 'room:help%40conference.example.test:camille-help:Camille', label: 'Camille · Équipe' },
    ]} onChange={vi.fn()} />)
    open()
    expect(screen.getByRole('option', { name: 'Camille · Équipe · team@conference.example.test' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Camille · Équipe · help@conference.example.test' })).toBeInTheDocument()
  })

  it('updates the existing polite announcement instead of mounting populated text', () => {
    render(<SearchSenderPicker value="" senders={[{ value: 'jo@example.test', label: 'Jo' }]} onChange={vi.fn()} />)
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()
    expect(status).toHaveAttribute('aria-live', 'polite')
    const picker = open()
    fireEvent.change(picker, { target: { value: 'nobody' } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('search.panel.noSenders')
    fireEvent.change(picker, { target: { value: 'jo' } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
  })

  it('reuses decoded choices when typing and moving the highlight', () => {
    const decode = vi.spyOn(sdk, 'parseRoomSender')
    const senders = [{ value: 'room:team%40conference.example.test:camille-team:Camille', label: 'Camille · Équipe' }]
    render(<SearchSenderPicker value="" senders={senders} onChange={vi.fn()} />)
    expect(decode).toHaveBeenCalledTimes(2)
    const picker = open()
    fireEvent.change(picker, { target: { value: 'cam' } })
    fireEvent.pointerMove(screen.getByRole('option', { name: 'Camille · Équipe' }))
    expect(picker).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Camille · Équipe' }).id)
    expect(decode).toHaveBeenCalledTimes(2)
    decode.mockRestore()
  })

  it('requests scrolling for arrows, not pointer hover', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    render(<SearchSenderPicker value="" senders={[{ value: 'jo@example.test', label: 'Jo' }]} onChange={vi.fn()} />)
    const picker = open()
    fireEvent.keyDown(picker, { key: 'ArrowUp' })
    expect(scroll).toHaveBeenCalledTimes(1)
    fireEvent.pointerMove(screen.getByRole('option', { name: 'search.panel.me' }))
    expect(picker).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'search.panel.me' }).id)
    expect(scroll).toHaveBeenCalledTimes(1)
    scroll.mockRestore()
  })
})
