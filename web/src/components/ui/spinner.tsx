import { LoaderCircleIcon } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/lib/utils'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return <LoaderCircleIcon aria-hidden className={cn('size-4 animate-spin motion-reduce:animate-none', className)} {...props} />
}

export { Spinner }
