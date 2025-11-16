import { useState, useRef } from 'react'
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword } from 'firebase/auth'
import { ref, get, update } from 'firebase/database'
import { auth, realtimeDb } from '../firebase/config'
import { logAuthEvent, logUserActionToUserLogs } from '../utils/userLogging'
import './LogIn.css'

interface LogInProps {
  onSuccess?: (userName: string, userRole: 'Coordinator' | 'admin') => void
  onNavigateToSignUp?: () => void
}

export default function LogIn({ onSuccess, onNavigateToSignUp }: LogInProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)

  type ModalVariant = 'success' | 'error'
  const [modalOpen, setModalOpen] = useState(false)
  const [modalVariant, setModalVariant] = useState<ModalVariant>('success')
  const [modalTitle, setModalTitle] = useState('')
  const [modalMessage, setModalMessage] = useState('')
  const successTimer = useRef<number | null>(null)

  const openModal = (variant: ModalVariant, title: string, message: string) => {
    setModalVariant(variant)
    setModalTitle(title)
    setModalMessage(message)
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    if (successTimer.current) {
      window.clearTimeout(successTimer.current)
      successTimer.current = null
    }
  }

  const scheduleSuccessRedirect = (userName?: string, userRole?: 'Coordinator' | 'admin') => {
    if (onSuccess) {
      const displayName = userName || email?.trim() || 'User'
      const role = userRole || 'Coordinator' // Default to 'Coordinator' if role not found
      successTimer.current = window.setTimeout(() => {
        onSuccess(displayName, role)
      }, 3000)
    }
  }


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!email.trim() || !password) {
      openModal('error', 'Validation Error', 'Please enter both email and password.')
      return
    }

    setLoading(true)

    try {
      // Sign in with Firebase Authentication
      const userCredential = await signInWithEmailAndPassword(auth, email.trim(), password)
      const user = userCredential.user

      // Get additional user data from Realtime Database
      let displayName = user.displayName || email.trim()
      let userRole: 'Coordinator' | 'admin' = 'Coordinator' // Default role
      
      try {
        const userRef = ref(realtimeDb, `users/${user.uid}`)
        const userSnapshot = await get(userRef)
        
        if (userSnapshot.exists()) {
          const userData = userSnapshot.val()
          displayName = userData.displayName || userData.firstName || userData.email || displayName
          userRole = userData.role || 'Coordinator' // Get role from database
          
          console.log('User role from database:', userRole)
          
          // Update last login time
          await get(ref(realtimeDb, `users/${user.uid}/lastLogin`))
        } else {
          console.log('User not found in database, using default role')
        }
      } catch (dbError) {
        console.log('Could not fetch additional user data:', dbError)
        // Continue with basic user info if database access fails
      }

      // Log authentication event (this also logs to user_logs table)
      await logAuthEvent(
        'login',
        displayName,
        user.uid,
        'unknown',
        `User logged in with email: ${email.trim()}`,
        'email'
      )

      const roleDisplay = userRole === 'admin' ? 'GSO' : userRole
      openModal('success', 'Sign-in Successful', `Welcome back, ${displayName}! You have successfully signed in as ${roleDisplay}.`)
      scheduleSuccessRedirect(displayName, userRole)
      
    } catch (error: any) {
      console.error('Sign-in error:', error)
      
      let errorMessage = 'Sign-in failed. Please try again.'
      
      if (error.code === 'auth/user-not-found') {
        errorMessage = 'No account found with this email address. Please sign up instead.'
      } else if (error.code === 'auth/wrong-password') {
        errorMessage = 'Incorrect password. Please try again.'
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'Please enter a valid email address.'
      } else if (error.code === 'auth/user-disabled') {
        errorMessage = 'This account has been disabled. Please contact support.'
      } else if (error.code === 'auth/too-many-requests') {
        errorMessage = 'Too many failed attempts. Please try again later.'
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your connection and try again.'
      }
      
      // Log failed login attempt
      await logUserActionToUserLogs(
        'User Login',
        'System',
        `Failed login attempt with email: ${email.trim()} - ${errorMessage}`,
        'error',
        email.trim(),
        'unknown',
        'email'
      )
      
      openModal('error', 'Authentication Failed', errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleGoogle = async () => {
    setLoading(true)
    
    try {
      const provider = new GoogleAuthProvider()
      const result = await signInWithPopup(auth, provider)
      const user = result.user
      
      // Get user role from database
      let userRole: 'Coordinator' | 'admin' = 'Coordinator' // Default role
      
      try {
        const userRef = ref(realtimeDb, `users/${user.uid}`)
        const userSnapshot = await get(userRef)
        
        if (userSnapshot.exists()) {
          const userData = userSnapshot.val()
          userRole = userData.role || 'Coordinator' // Get role from database
          
          console.log('Google user role from database:', userRole)
          
          // Update last login time
          await get(ref(realtimeDb, `users/${user.uid}/lastLogin`))
        } else {
          // First time Google sign-in: create a Coordinator account record
          const nowIso = new Date().toISOString()
          await update(ref(realtimeDb, `users/${user.uid}`), {
            uid: user.uid,
            email: user.email || '',
            displayName: user.displayName || 'User',
            role: 'Coordinator',
            createdAt: nowIso,
            lastLogin: nowIso,
            authProvider: 'google'
          })
          userRole = 'Coordinator'
          console.log('Created new Coordinator account for Google user in database')
        }
      } catch (dbError) {
        console.log('Could not fetch user data:', dbError)
        // Continue with sign-in even if database access fails
      }
      
      // Log authentication event (this also logs to user_logs table)
      await logAuthEvent(
        'google_login',
        user.displayName || 'User',
        user.uid,
        'unknown',
        `User logged in with Google: ${user.email}`,
        'google'
      )

      const roleDisplay = userRole === 'admin' ? 'GSO' : userRole
      openModal('success', 'Signed in with Google', `Welcome back, ${user.displayName || 'User'}! Your Google account has been authenticated as ${roleDisplay}.`)
      scheduleSuccessRedirect(user.displayName || undefined, userRole)
    } catch (error: any) {
      console.error('Google sign-in error:', error)
      console.error('Error code:', error.code)
      console.error('Error message:', error.message)
      
      let errorMessage = 'Google sign-in failed. Please try again.'
      
      if (error.code === 'auth/popup-closed-by-user') {
        errorMessage = 'Sign-in was cancelled. Please try again.'
      } else if (error.code === 'auth/popup-blocked') {
        errorMessage = 'Pop-up was blocked. Please allow pop-ups and try again.'
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your connection and try again.'
      } else if (error.code === 'auth/unauthorized-domain') {
        errorMessage = 'This domain is not authorized for Google sign-in. Please contact support.'
      } else if (error.code === 'auth/operation-not-allowed') {
        errorMessage = 'Google sign-in is not enabled. Please contact support.'
      }
      
      // Log failed Google login attempt
      await logUserActionToUserLogs(
        'Google Login',
        'System',
        `Failed Google login attempt - ${errorMessage}`,
        'error',
        'Unknown User',
        'unknown',
        'google'
      )
      
      openModal('error', 'Google Sign-in Failed', errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-grid" aria-hidden="true">
        {/* decorative dotted grid */}
        <div className="dots-layer" />
      </div>
      <main className="login-card" role="main">
        <header className="login-header">
          <div className="brand">
            <div className="brand-logo" aria-hidden="true">
              <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" className="brand-logo-svg">
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#4f8cff" />
                    <stop offset="100%" stopColor="#7b61ff" />
                  </linearGradient>
                </defs>
                <circle cx="24" cy="24" r="23" fill="url(#g1)" />
                <path d="M15 26l6-8 6 5 6-7" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 32h20" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            <div className="brand-text">
              <span className="brand-name">SMART</span>
              <span className="brand-sub">ANALYTICS</span>
            </div>
          </div>
          <h1 className="welcome">Welcome Back</h1>
          <p className="subtitle">Sign in to access your dashboard</p>
        </header>

        <form className="form" onSubmit={handleSubmit}>
          <label className="label" htmlFor="email">
            <span className="label-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            <span>Email Address</span>
          </label>
          <div className="input-wrapper">
            <span className="input-leading" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            <input id="email" name="email" type="text" autoComplete="username" placeholder="Enter your email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>

          <label className="label" htmlFor="password">
            <span className="label-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 11V8a4 4 0 118 0v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </span>
            <span>Password</span>
          </label>
          <div className="input-wrapper">
            <span className="input-leading" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 11V8a4 4 0 118 0v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </span>
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="button" className="input-trailing" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(v => !v)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                {showPassword ? (
                  <path d="M3 21L21 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                ) : (
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/>
                )}
              </svg>
            </button>
          </div>


          <button type="submit" className="primary-btn" disabled={loading}>
            {loading ? 'Signing In...' : 'Sign In'}
          </button>

          <div className="divider" role="separator" aria-label="or continue with">
            <span>or continue with</span>
          </div>

          <button type="button" className="oauth-btn" onClick={handleGoogle} disabled={loading}>
            <span className="google-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
                <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303C33.602 31.91 29.218 35 24 35c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.676 5.099 29.627 3 24 3 12.955 3 4 11.955 4 23s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.651-.389-3.917z"/>
                <path fill="#FF3D00" d="M6.306 14.691l6.571 4.814C14.297 16.108 18.789 13 24 13c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.676 5.099 29.627 3 24 3 16.318 3 9.656 7.337 6.306 14.691z"/>
                <path fill="#4CAF50" d="M24 43c5.137 0 9.773-1.967 13.285-5.178l-6.657-5.177C29.153 34.091 26.687 35 24 35c-5.196 0-9.571-3.061-11.292-7.436l-6.54 5.037C9.474 39.556 16.229 43 24 43z"/>
                <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-1.101 3.261-3.645 5.824-6.747 7.046l-6.129 5.177C36.293 41.466 44 36.5 44 23c0-1.341-.138-2.651-.389-3.917z"/>
              </svg>
            </span>
            <span>{loading ? 'Signing In...' : 'Continue with Google'}</span>
          </button>
        </form>

        <footer className="login-footer">
          <span>Don't have an account?</span>
          <button 
            type="button" 
            className="link" 
            onClick={onNavigateToSignUp}
            disabled={loading}
          >
            Sign Up
          </button>
        </footer>
      </main>

      {modalOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={closeModal}>
          <div className={`modal-card ${modalVariant}`} onClick={(e) => e.stopPropagation()}>
            {modalVariant !== 'success' && (
              <button className="modal-close" onClick={closeModal} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            <div className="modal-icon" aria-hidden="true">
              {modalVariant === 'success' ? (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="11" fill="url(#s)"/>
                  <path d="M7 12.5l2.8 2.8L17 9" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <defs>
                    <linearGradient id="s" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#22c55e"/>
                      <stop offset="100%" stopColor="#16a34a"/>
                    </linearGradient>
                  </defs>
                </svg>
              ) : (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="11" fill="url(#e)"/>
                  <path d="M8 8l8 8M16 8l-8 8" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/>
                  <defs>
                    <linearGradient id="e" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#ef4444"/>
                      <stop offset="100%" stopColor="#dc2626"/>
                    </linearGradient>
                  </defs>
                </svg>
              )}
            </div>
            <h2 className="modal-title">{modalTitle}</h2>
            <p className="modal-message">{modalMessage}</p>
            <div className="modal-actions"></div>
          </div>
        </div>
      )}
    </div>
  )
}

