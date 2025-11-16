/**
 * Logger utility to control console output
 * ALL CONSOLE LOGS ARE DISABLED FOR BETTER PERFORMANCE
 * 
 * To re-enable logging, set ENABLE_LOGGING to true below
 */

// Set to true to enable logging (for debugging only)
const ENABLE_LOGGING = false

// Store original console methods (in case we need to restore them)
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug
}

// Create logger object - all methods are disabled by default
export const logger = {
  log: (...args: any[]) => {
    if (ENABLE_LOGGING) {
      originalConsole.log(...args)
    }
  },
  warn: (...args: any[]) => {
    if (ENABLE_LOGGING) {
      originalConsole.warn(...args)
    }
  },
  error: (...args: any[]) => {
    // Errors are also disabled - uncomment below to enable error logging
    // if (ENABLE_LOGGING) {
    //   originalConsole.error(...args)
    // }
  },
  info: (...args: any[]) => {
    if (ENABLE_LOGGING) {
      originalConsole.info(...args)
    }
  },
  debug: (...args: any[]) => {
    if (ENABLE_LOGGING) {
      originalConsole.debug(...args)
    }
  }
}

// Optional: Throttle frequent logs to prevent spam
const logThrottle = new Map<string, number>()
const THROTTLE_MS = 5000 // Only log same message once per 5 seconds

export const throttledLog = (key: string, ...args: any[]) => {
  const now = Date.now()
  const lastLog = logThrottle.get(key) || 0
  
  if (now - lastLog > THROTTLE_MS) {
    logThrottle.set(key, now)
    logger.log(...args)
  }
}

// Clean up throttle map periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, timestamp] of logThrottle.entries()) {
    if (now - timestamp > THROTTLE_MS * 2) {
      logThrottle.delete(key)
    }
  }
}, 60000) // Clean up every minute

