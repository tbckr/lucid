import {
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyboardIcon,
  ListTodoIcon,
  LogOutIcon,
  MenuIcon,
  RefreshCwIcon,
  SettingsIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VIEWS, type ViewKind } from '@/lib/dates'
import { Logo } from '@/components/Logo'
import { type RefreshState } from '@/hooks/useRefresh'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { OfflineIndicator } from './OfflineIndicator'
import { LoadedAt, RefreshButton } from './RefreshButton'

export function TopBar({
  title,
  view,
  fetching,
  refresh,
  username,
  serverUrl,
  tasksOpen,
  onMenu,
  onToday,
  onStep,
  onView,
  onToggleTasks,
  onRefresh,
  onSettings,
  onShortcuts,
  onLogout,
}: {
  title: string
  view: ViewKind
  fetching: boolean
  refresh: RefreshState
  username: string | undefined
  serverUrl: string | undefined
  tasksOpen: boolean
  onMenu: () => void
  onToday: () => void
  onStep: (dir: 1 | -1) => void
  onView: (v: ViewKind) => void
  onToggleTasks: () => void
  onRefresh: () => void
  onSettings: () => void
  onShortcuts: () => void
  onLogout: () => void
}) {
  const { t } = useTranslation()
  const initial = (username ?? '?').slice(0, 1).toUpperCase()
  const reachable = useUi((s) => s.backendReachable)

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2 sm:h-16 sm:flex-nowrap sm:gap-2 sm:px-3 sm:py-0">
      <IconButton label={t('nav.toggleSidebar')} onClick={onMenu}>
        <MenuIcon aria-hidden />
      </IconButton>
      <div className="hidden items-center gap-2 pr-4 pl-1 md:flex">
        <Logo className="size-7" />
        <span className="font-display text-lg font-semibold tracking-tight">Lucid</span>
      </div>

      <Button variant="outline" size="sm" className="rounded-full px-4" onClick={onToday} aria-keyshortcuts="t">
        {t('nav.today')}
      </Button>
      <div className="flex">
        <IconButton label={t('nav.previous')} onClick={() => { onStep(-1) }} shortcut="k">
          <ChevronLeftIcon aria-hidden />
        </IconButton>
        <IconButton label={t('nav.next')} onClick={() => { onStep(1) }} shortcut="j">
          <ChevronRightIcon aria-hidden />
        </IconButton>
      </div>
      <h1
        className="min-w-0 truncate pl-1 font-display text-lg font-semibold tracking-tight max-sm:order-last max-sm:basis-full max-sm:px-2 max-sm:pt-1 sm:text-[1.375rem]"
        aria-live="polite"
      >
        {title}
      </h1>
      {fetching && (
        <Spinner
          // The refresh button spins instead, where there is room for it (FR-23).
          className={cn('ml-1 text-muted-foreground', refresh === 'running' && 'lg:hidden')}
          aria-label={t('common.loading')}
        />
      )}

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <OfflineIndicator />
        <RefreshButton state={refresh} onRefresh={onRefresh} className="hidden lg:inline-flex" />

        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => {
            if (v) onView(v as ViewKind)
          }}
          aria-label={t('views.label')}
          className="hidden md:inline-flex"
        >
          {VIEWS.map((v) => (
            <ToggleGroupItem key={v} value={v} aria-keyshortcuts={v[0]}>
              {t(`views.${v}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="md:hidden">
              {t(`views.${view}`)}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={view}
              onValueChange={(v) => {
                onView(v as ViewKind)
              }}
            >
              {VIEWS.map((v) => (
                <DropdownMenuRadioItem key={v} value={v}>
                  {t(`views.${v}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <IconButton label={t('tasks.toggle')} onClick={onToggleTasks} pressed={tasksOpen} shortcut="g">
          <ListTodoIcon aria-hidden />
        </IconButton>
        <IconButton label={t('settings.title')} onClick={onSettings}>
          <SettingsIcon aria-hidden />
        </IconButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('account.menu', { user: username ?? '' })}
              className="ml-1 flex size-8 items-center justify-center rounded-full bg-primary/15 font-display text-sm font-semibold text-primary outline-none hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {initial}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="grid gap-0.5">
              <span className="truncate text-sm font-semibold text-foreground">{username}</span>
              <span className="truncate">{serverUrl}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Below lg, the top bar has no room for the refresh button (FR-23). */}
            <DropdownMenuItem onSelect={onRefresh} disabled={!reachable} className="lg:hidden">
              <RefreshCwIcon aria-hidden />
              {t('refresh.label')}
              <LoadedAt className="ml-auto pl-4 text-xs text-muted-foreground" />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShortcuts}>
              <KeyboardIcon aria-hidden />
              {t('shortcuts.title')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onLogout}>
              <LogOutIcon aria-hidden />
              {t('account.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function IconButton({
  label,
  onClick,
  children,
  pressed,
  shortcut,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  pressed?: boolean
  shortcut?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={pressed}
          aria-keyshortcuts={shortcut}
          onClick={onClick}
          className={pressed ? 'bg-muted text-primary' : undefined}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 opacity-70">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
