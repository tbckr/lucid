import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster({ theme, ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme ?? 'system'}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: 'bg-surface! text-foreground! border-border! shadow-float! rounded-lg!',
          description: 'text-muted-foreground!',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
