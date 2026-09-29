import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { enUS } from 'date-fns/locale/en-US'
import { afterEach, describe, expect, it } from 'vitest'
import { toCalTask } from '@/lib/calendarTasks'
import { eventColors } from '@/lib/color'
import { toCalEvent } from '@/lib/events'
import { type FormatPrefs } from '@/lib/format'
import { useUi } from '@/stores/ui'
import { apiEvent, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { MoreEventsPopover } from './MoreEventsPopover'

const prefs: FormatPrefs = { tag: 'en-US', locale: enUS, hourCycle: '12h', weekStartsOn: 0 }
const colors = eventColors('#3b82f6', false)

describe('MoreEventsPopover', () => {
  afterEach(() => {
    useUi.getState().openDetail(null)
  })

  it('closes and opens the details of a task at its button', async () => {
    const rent = toCalTask(todo({ title: 'Pay rent', due: '2026-09-25T08:00:00Z' }))!
    const user = userEvent.setup()
    renderWithProviders(
      <MoreEventsPopover
        day={new Date(2026, 8, 25)}
        events={[toCalEvent(apiEvent({ title: 'Standup' })), rent]}
        hidden={2}
        prefs={prefs}
        colorsOf={() => colors}
        readOnly={() => false}
      />,
    )
    const more = screen.getByRole('button', { name: '2 more' })
    await user.click(more)
    await user.click(await screen.findByRole('button', { name: /Pay rent/ }))
    // The task's chip leaves with the list; the details stay at the button.
    expect(useUi.getState().detail).toEqual({ item: rent, anchor: more })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Pay rent/ })).not.toBeInTheDocument()
    })
  })
})
