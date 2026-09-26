import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import { App } from './App'
import { api } from './lib/api/client'
import { setupConnectivity } from './lib/connectivity'
import { createQueryClient } from './lib/queryClient'
import { useUi } from './stores/ui'

const queryClient = createQueryClient()

setupConnectivity({
  client: api,
  onChange: ({ browserOnline, backendReachable }) => {
    useUi.getState().setBackendReachable(browserOnline && backendReachable)
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} />
  </StrictMode>,
)
