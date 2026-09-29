import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addDays, format, nextMonday } from 'date-fns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Todo } from '@/lib/api/schemas'
import { dayKey, zonedToUtc } from '@/lib/dates'
import { defaultSettings, useSettings } from '@/stores/settings'
import { todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { DuePicker } from './DuePicker'

const TZ = 'Europe/Berlin'
/** `time` on the day `days` from today, on the wire. */
const at = (days: number, time: string) => zonedToUtc(dayKey(addDays(new Date(), days)), time, TZ).toISOString()
const allDay = (day: Date) => `${dayKey(day)}T00:00:00.000Z`

async function open(t: Todo) {
  const onChange = vi.fn()
  const user = userEvent.setup()
  renderWithProviders(<DuePicker todo={t} onChange={onChange} />)
  await user.click(screen.getByRole('button', { name: `Change due date: ${t.title}` }))
  return { user, onChange, dialog: screen.getByRole('dialog', { name: 'Due date' }) }
}

describe('DuePicker', () => {
  afterEach(() => {
    useSettings.setState(defaultSettings)
  })

  it('offers today, tomorrow and the next Monday with their dates', async () => {
    const { dialog } = await open(todo())
    const picks = within(dialog)
      .getAllByRole('button', { name: /^(Today|Tomorrow|Next week) / })
      .map((b) => b.textContent)
    expect(picks).toHaveLength(3)
    expect(picks[2]).toMatch(/^Next week Mon, /)
  })

  it('moves the due date to tomorrow at its time and closes', async () => {
    const { user, onChange, dialog } = await open(todo({ title: 'Call', due: at(-1, '09:00') }))
    await user.click(within(dialog).getByRole('button', { name: /^Tomorrow / }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '09:00'), dueAllDay: false }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('keeps an all-day due date all-day', async () => {
    const { user, onChange } = await open(todo({ due: allDay(addDays(new Date(), -1)), dueAllDay: true }))
    await user.click(screen.getByRole('button', { name: /^Next week / }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: allDay(nextMonday(new Date())), dueAllDay: true }))
  })

  it('stays open on a time already past today and focuses the time', async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(-1, '00:00') }))
    await user.click(within(dialog).getByRole('button', { name: /^Today / }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(0, '00:00') }))
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Due time' })).toHaveFocus()
  })

  it('changes the time and stays open', async () => {
    useSettings.setState({ timeFormat: '24h' })
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Due time' }))
    await user.click(screen.getByRole('option', { name: '17:00' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: at(1, '17:00'), dueAllDay: false }))
    expect(dialog).toBeInTheDocument()
  })

  it('picks a day in the month', async () => {
    const { user, onChange } = await open(todo())
    await user.click(screen.getByRole('button', { name: format(new Date(), 'PPPP') }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: allDay(new Date()), dueAllDay: true }))
  })

  it('removes the due date', async () => {
    const { user, onChange, dialog } = await open(todo({ due: at(1, '09:00') }))
    await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ due: null }))
    expect(dialog).not.toBeInTheDocument()
  })

  it('offers neither a time nor a removal without a due date', async () => {
    const { dialog } = await open(todo())
    expect(within(dialog).queryByRole('combobox', { name: 'Due time' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Remove due date' })).toBeNull()
  })
})
