/**
 * The tile of the event or task `key` in the views, to give the focus back to (NFR-27): an event's tile is its button;
 * a task's holds its checkbox and its title, which opens and drags it. Where no tile shows it, such as after a drop
 * into a full day, the bundle or "N more" that now holds it (FR-07); null where nothing does.
 */
export function tileOf(key: string): HTMLElement | null {
  const tile = Array.from(document.querySelectorAll<HTMLElement>('[data-event-key], [data-task-key]')).find(
    (el) => (el.dataset.eventKey ?? el.dataset.taskKey) === key,
  )
  if (tile) return tile.dataset.taskKey === undefined ? tile : tile.querySelector<HTMLElement>('button:not([role="checkbox"])')
  return document.querySelector<HTMLElement>(`[data-holds~="${CSS.escape(key)}"]`)
}
