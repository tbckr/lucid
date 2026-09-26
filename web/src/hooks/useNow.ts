import { useEffect, useState } from 'react'

/** The current time, refreshed every `intervalMs` (aligned to the minute). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined
    const align = setTimeout(
      () => {
        setNow(new Date())
        interval = setInterval(() => {
          setNow(new Date())
        }, intervalMs)
      },
      intervalMs - (Date.now() % intervalMs),
    )
    return () => {
      clearTimeout(align)
      if (interval) clearInterval(interval)
    }
  }, [intervalMs])
  return now
}
