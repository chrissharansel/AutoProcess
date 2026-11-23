import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './platform.css'
import App from './App.tsx'
import { ToastProvider, ConfirmProvider, applyStoredTheme } from './lib/ui'

applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
)
