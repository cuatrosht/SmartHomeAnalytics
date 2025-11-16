import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
// Initialize Firebase
import './firebase/config.ts'

// DISABLE ALL CONSOLE LOGS FOR BETTER PERFORMANCE
// This prevents console buffer from filling up and causing performance issues
// Set ENABLE_CONSOLE_LOGS to true below if you need to debug

const ENABLE_CONSOLE_LOGS = false

// Store original console.error before disabling (for ErrorBoundary)
const originalConsoleError = console.error

if (!ENABLE_CONSOLE_LOGS) {
  // Override all console methods with no-op functions
  console.log = () => {}
  console.debug = () => {}
  console.info = () => {}
  console.warn = () => {}
  console.error = () => {} // Errors also disabled - uncomment to keep errors visible
  console.trace = () => {}
  console.table = () => {}
  console.group = () => {}
  console.groupEnd = () => {}
  console.groupCollapsed = () => {}
  console.time = () => {}
  console.timeEnd = () => {}
  console.count = () => {}
  console.clear = () => {}
}

// Make original error available for ErrorBoundary
;(console as any).__originalError = originalConsoleError

// Global error handlers to prevent white screens
window.addEventListener('error', (event) => {
  // Prevent default error handling that causes white screen
  event.preventDefault()
  // You can add custom error reporting here if needed
})

window.addEventListener('unhandledrejection', (event) => {
  // Prevent unhandled promise rejections from causing white screen
  event.preventDefault()
  // You can add custom error reporting here if needed
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
