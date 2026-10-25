import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { eventColors } from '@/lib/color'
import { occurrenceTask, toCalTask, type CalTask } from '@/lib/calendarTasks'
import { useUi } from '@/stores/ui'
import { occurrence, todo } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { TaskBundle } from './TaskBundle'

const thursday = new Date(2026, 2, 12)
const orange = eventColors('#f97316', false)
const blue = eventColors('#3b82f6', false)
const colorsOf = (calendarId: string) => (calendarId === 'blue' ? blue : orange)

function task(id: string, p: Parameters<typeof todo>[0] = {}): CalTask {
  const t = toCalTask(todo({ id, due: '2026-03-12T00:00:00Z', dueAllDay: true, ...p }))
  if (!t) throw new Error('a task with a due date has a place')
  return t
}

const six = ['1', '2', '3', '4', '5', '6'].map((id) => task(id))

function renderBundle(p: Partial<Parameters<typeof TaskBundle>[0]> = {}) {
  return renderWithProviders(
    <TaskBundle
      id="bundle:thu"
      day={thursday}
      tasks={six}
      drag="event"
      home={() => null}
      colorsOf={colorsOf}
      variant="tile"
      label="6 tasks at 9:00 AM, Thursday, March 12"
      {...p}
    />,
  )
}

afterEach(async () => {
  useUi.getState().openOverflow(null)
  await i18n.changeLanguage('en')
})

describe('TaskBundle', () => {
  it('shows rings and the count', () => {
    renderBundle()
    const button = screen.getByRole('button', { name: '6 tasks at 9:00 AM, Thursday, March 12' })
    expect(button).toHaveTextContent('6 tasks')
    expect(button.querySelectorAll('[data-ring]')).toHaveLength(3)
    expect(button).toHaveAttribute('data-bundle-count', '6')
    expect(button).toHaveAttribute('data-holds', 'task:1 task:2 task:3 task:4 task:5 task:6')
    // The rings are decoration: the label says it all.
    expect(button.querySelector('[data-ring]')?.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('shows as many rings as tasks up to the limit', () => {
    renderBundle({ tasks: six.slice(0, 2) })
    expect(screen.getByRole('button').querySelectorAll('[data-ring]')).toHaveLength(2)
  })

  it('colors the rings by calendar, the most frequent first', () => {
    const tasks = [task('1', { calendarId: 'blue' }), task('2'), task('3'), task('4')]
    renderBundle({ tasks })
    const [first, second, third] = Array.from(screen.getByRole('button').querySelectorAll<HTMLElement>('[data-ring]'))
    expect(first).toHaveStyle({ borderColor: orange.solid })
    expect(second).toHaveStyle({ borderColor: blue.solid })
    expect(third).toHaveStyle({ borderColor: orange.solid })
  })

  it('compact shows two rings and the number', () => {
    renderBundle({ compact: true })
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent(/^6$/)
    expect(button.querySelectorAll('[data-ring]')).toHaveLength(2)
  })

  it('chip has no surface', () => {
    const { unmount } = renderBundle({ variant: 'chip' })
    expect(screen.getByRole('button')).not.toHaveClass('bg-muted')
    unmount()
    renderBundle({ variant: 'tile' })
    expect(screen.getByRole('button')).toHaveClass('bg-muted')
  })

  it('dims when every task is done', () => {
    const done = (id: string) => task(id, { status: 'COMPLETED' })
    const doneRepeat = occurrenceTask(occurrence({ state: 'done' }), todo({ recurring: true }))
    if (!doneRepeat) throw new Error('an occurrence with a due date has a place')
    const { unmount } = renderBundle({ tasks: [task('1'), done('2'), done('3')] })
    expect(screen.getByRole('button')).not.toHaveClass('opacity-60')
    unmount()
    const planned = occurrenceTask(occurrence({ state: 'upcoming' }), todo({ recurring: true }))
    if (!planned) throw new Error('an occurrence with a due date has a place')
    const second = renderBundle({ tasks: [done('1'), planned] })
    expect(screen.getByRole('button')).not.toHaveClass('opacity-60')
    second.unmount()
    renderBundle({ tasks: [done('1'), doneRepeat, task('3', { status: 'CANCELLED' })] })
    expect(screen.getByRole('button')).toHaveClass('opacity-60')
  })

  it('opens the list with its tasks, and a second click closes it', async () => {
    const user = userEvent.setup()
    const box = new DOMRect(10, 20, 100, 20)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box)
    renderBundle()
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    await user.click(button)
    const { overflow } = useUi.getState()
    expect(overflow?.id).toBe('bundle:thu')
    expect(overflow?.day).toBe(thursday)
    expect(overflow?.items).toEqual(six)
    expect(overflow?.drag).toBe('event')
    expect(overflow?.anchor).toBe(button)
    // Without a cell or column of its own, the button stands in for it.
    expect(overflow?.home).toBe(button)
    expect(overflow?.rect).toBe(box)
    expect(button).toHaveAttribute('aria-expanded', 'true')

    await user.click(button)
    expect(useUi.getState().overflow).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the list at its cell and keeps the click from creating an entry there', async () => {
    const user = userEvent.setup()
    const onCellClick = vi.fn()
    renderWithProviders(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- stands for the day cell
      <div data-testid="cell" onClick={onCellClick}>
        <TaskBundle
          id="bundle:thu"
          day={thursday}
          tasks={six}
          drag="event"
          home={() => document.querySelector<HTMLElement>('[data-testid="cell"]')}
          colorsOf={colorsOf}
          variant="chip"
          label="6 tasks, Thursday, March 12"
        />
      </div>,
    )
    await user.click(screen.getByRole('button'))
    expect(useUi.getState().overflow?.home).toBe(screen.getByTestId('cell'))
    expect(onCellClick).not.toHaveBeenCalled()
  })

  it('counts in German', async () => {
    await i18n.changeLanguage('de')
    renderBundle()
    expect(screen.getByRole('button')).toHaveTextContent('6 Aufgaben')
  })

  it('says one task in the singular', () => {
    renderBundle({ tasks: six.slice(0, 1) })
    expect(screen.getByRole('button')).toHaveTextContent(/^1 task$/)
  })
})
