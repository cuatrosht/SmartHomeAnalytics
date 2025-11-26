import { useState, useRef, useEffect } from 'react'
import { createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, updateProfile, signOut } from 'firebase/auth'
import { ref, set, get } from 'firebase/database'
import { auth, realtimeDb } from '../firebase/config'
import { logUserActionToUserLogs } from '../utils/userLogging'
import './SignUp.css'


interface SignUpProps {
  onSuccess?: (userName: string, userRole: 'Coordinator' | 'admin') => void
  onNavigateToLogin?: () => void
}

export default function SignUp({ onSuccess, onNavigateToLogin }: SignUpProps) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [userRole, setUserRole] = useState<'Coordinator' | 'admin'>('Coordinator')
  const [showRoleModal, setShowRoleModal] = useState(false)
  const [hasExistingGSO, setHasExistingGSO] = useState(false)
  const [isFirstUser, setIsFirstUser] = useState(false)

  type ModalVariant = 'success' | 'error'
  const [modalOpen, setModalOpen] = useState(false)
  const [modalVariant, setModalVariant] = useState<ModalVariant>('success')
  const [modalTitle, setModalTitle] = useState('')
  const [modalMessage, setModalMessage] = useState('')
  const successTimer = useRef<number | null>(null)

  // Function to check if there's an existing GSO and if it's the first user
  const checkExistingGSO = async () => {
    try {
      const usersRef = ref(realtimeDb, 'users')
      const snapshot = await get(usersRef)

      // If no users exist in database, GSO can be selected and it's the first user
      if (!snapshot.exists()) {
        setHasExistingGSO(false)
        setIsFirstUser(true)
        console.log('No users in database - GSO can be selected, first user will be auto-verified')
        return
      }

      // Check if any user has admin role
      const users = snapshot.val()
      if (users && typeof users === 'object') {
        const usersArray = Object.values(users) as any[]
        const hasGSO = usersArray.some((user: any) => user?.role === 'admin')
        setHasExistingGSO(hasGSO)
        setIsFirstUser(false)
        console.log('Existing GSO check:', hasGSO ? 'GSO exists - cannot select' : 'No GSO - can select')
      } else {
        // If users data is invalid, allow GSO selection (safer default)
        setHasExistingGSO(false)
        setIsFirstUser(false)
        console.log('Invalid users data - allowing GSO selection')
      }
    } catch (error) {
      console.error('Error checking for existing GSO:', error)
      // On error, allow GSO selection (safer default - user can still be prevented during signup)
      setHasExistingGSO(false)
      setIsFirstUser(false)
    }
  }

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

  // REMOVED: isDeviceActiveBySchedule function - no longer needed

  // Check for existing GSO on component mount
  useEffect(() => {
    checkExistingGSO()
  }, [])

  // Force userRole to 'Coordinator' if GSO already exists
  useEffect(() => {
    if (hasExistingGSO && userRole === 'admin') {
      setUserRole('Coordinator')
    }
  }, [hasExistingGSO, userRole])

  // REMOVED: Real-time listener for combined limit info - no longer needed
  // REMOVED: Real-time scheduler - no longer needed

  const scheduleSuccessRedirect = (userName?: string, role?: 'Coordinator' | 'admin') => {
    if (onSuccess) {
      const displayName = userName || `${firstName} ${lastName}`.trim() || 'User'
      const finalRole = role || userRole
      successTimer.current = window.setTimeout(() => {
        onSuccess(displayName, finalRole)
      }, 3000)
    }
  }

  const validateForm = () => {
    try {
      if (!firstName || typeof firstName !== 'string' || !firstName.trim()) {
        openModal('error', 'Validation Error', 'First name is required.')
        return false
      }
      if (!lastName || typeof lastName !== 'string' || !lastName.trim()) {
        openModal('error', 'Validation Error', 'Last name is required.')
        return false
      }
      if (!email || typeof email !== 'string' || !email.trim()) {
        openModal('error', 'Validation Error', 'Email address is required.')
        return false
      }
      if (!password || typeof password !== 'string' || !password) {
        openModal('error', 'Validation Error', 'Password is required.')
        return false
      }
      if (password.length < 6) {
        openModal('error', 'Validation Error', 'Password must be at least 6 characters long.')
        return false
      }
      return true
    } catch (validationError) {
      console.error('Error in form validation:', validationError)
      openModal('error', 'Validation Error', 'An error occurred during validation. Please check your inputs.')
      return false
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    try {
      if (!validateForm()) return

      // Prevent GSO signup if GSO already exists
      if (userRole === 'admin' && hasExistingGSO) {
        openModal('error', 'GSO Account Exists', 'A GSO account already exists. Only one GSO is allowed per system.')
        return
      }

      setLoading(true)
      
      try {
        // Create user with email and password
        const userCredential = await createUserWithEmailAndPassword(auth, email.trim(), password)
        const user = userCredential?.user

        if (!user || !user.uid) {
          throw new Error('User creation failed - no user returned')
        }

        // Safe name extraction
        let displayName = 'User'
        try {
          const firstNameTrimmed = firstName?.trim() || ''
          const lastNameTrimmed = lastName?.trim() || ''
          displayName = `${firstNameTrimmed} ${lastNameTrimmed}`.trim() || user.email || 'User'
        } catch (nameError) {
          console.error('Error creating display name:', nameError)
          displayName = user.email || 'User'
        }

        // Update user profile with display name
        try {
          await updateProfile(user, {
            displayName: displayName
          })
        } catch (profileError) {
          console.error('Error updating profile:', profileError)
          // Continue even if profile update fails
        }

        // Determine if user should be auto-verified (first user or GSO)
        const shouldAutoVerify = isFirstUser || userRole === 'admin'

        // Save additional user data to Realtime Database
        const userData = {
          uid: user.uid || '',
          email: user.email || email.trim() || '',
          firstName: firstName?.trim() || '',
          lastName: lastName?.trim() || '',
          displayName: displayName,
          role: userRole || 'Coordinator',
          verified: shouldAutoVerify, // First user or GSO is auto-verified
          verificationStatus: shouldAutoVerify ? 'verified' : 'pending', // Set verification status
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString()
        }

        console.log('Saving user data with role:', userRole, 'Auto-verified:', shouldAutoVerify, userData)
        
        try {
          await set(ref(realtimeDb, `users/${user.uid}`), userData)
        } catch (dbError) {
          console.error('Error saving user data:', dbError)
          throw new Error('Failed to save user data to database')
        }

        // Log user signup to user_logs table
        try {
          await logUserActionToUserLogs(
            'User Signup',
            'System',
            `New user account created with email: ${email.trim()} (Role: ${userRole})`,
            'success',
            displayName,
            user.uid,
            'email'
          )
        } catch (logError) {
          console.error('Error logging user action:', logError)
          // Continue even if logging fails
        }

        // Show success message based on verification status
        if (shouldAutoVerify) {
          const roleDisplay = userRole === 'admin' ? 'GSO' : userRole
          openModal('success', 'Account Created Successfully', `Welcome ${firstName?.trim() || 'User'}! Your ${roleDisplay} account has been created${isFirstUser ? ' as the first user' : ''} and you are now signed in.`)
          scheduleSuccessRedirect()
        } else {
          openModal('success', 'Account Created Successfully', `Welcome ${firstName?.trim() || 'User'}! Your ${userRole} account has been created. Please wait for verification before accessing the system.`)
        }
      } catch (error: any) {
        console.error('Signup error:', error)
        
        let errorMessage = 'Failed to create account. Please try again.'
        
        try {
          if (error?.code === 'auth/email-already-in-use') {
            errorMessage = 'An account with this email already exists. Please sign in instead.'
          } else if (error?.code === 'auth/invalid-email') {
            errorMessage = 'Please enter a valid email address.'
          } else if (error?.code === 'auth/weak-password') {
            errorMessage = 'Password is too weak. Please choose a stronger password.'
          } else if (error?.code === 'auth/network-request-failed') {
            errorMessage = 'Network error. Please check your connection and try again.'
          } else if (error?.message) {
            errorMessage = error.message
          }
        } catch (errorParseError) {
          console.error('Error parsing error message:', errorParseError)
        }
        
        // Log failed signup attempt (with error handling)
        try {
          await logUserActionToUserLogs(
            'User Signup',
            'System',
            `Failed signup attempt with email: ${email?.trim() || 'unknown'} - ${errorMessage}`,
            'error',
            `${firstName?.trim() || ''} ${lastName?.trim() || ''}`.trim() || 'Unknown',
            'unknown',
            'email'
          )
        } catch (logError) {
          console.error('Error logging failed signup:', logError)
        }
        
        openModal('error', 'Account Creation Failed', errorMessage)
      } finally {
        setLoading(false)
      }
    } catch (outerError: any) {
      console.error('Outer signup error:', outerError)
      setLoading(false)
      openModal('error', 'Account Creation Failed', 'An unexpected error occurred. Please try again.')
    }
  }

  const handleGoogle = async () => {
    // Show role selection modal first
    setShowRoleModal(true)
  }

  const handleGoogleWithRole = async (selectedRole: 'Coordinator' | 'admin') => {
    try {
      setShowRoleModal(false)
      
      // Prevent GSO signup if GSO already exists
      if (selectedRole === 'admin' && hasExistingGSO) {
        openModal('error', 'GSO Account Exists', 'A GSO account already exists. Only one GSO is allowed per system.')
        return
      }
      
      setLoading(true)
      
      try {
        const provider = new GoogleAuthProvider()
        const result = await signInWithPopup(auth, provider)
        const user = result?.user

        if (!user || !user.uid) {
          throw new Error('Google authentication failed - no user returned')
        }

        // IMPORTANT: Check if user already exists in database before creating account
        // Check both by UID (in case they signed up with Google before) and by email (in case they signed up with email/password)
        try {
          // Check by UID first
          const existingUserRef = ref(realtimeDb, `users/${user.uid}`)
          const existingUserSnapshot = await get(existingUserRef)
          
          if (existingUserSnapshot.exists()) {
            // User already exists - show error first, then sign out
            console.log('User already exists in database (by UID), preventing duplicate account creation')
            setLoading(false)
            // Show error modal immediately (synchronously)
            openModal('error', 'Account Already Exists', `An account with the email ${user.email || 'this email'} already exists. Please sign in instead of creating a new account.`)
            // Use requestAnimationFrame to ensure modal renders, then sign out after additional delay
            requestAnimationFrame(() => {
              setTimeout(async () => {
                try {
                  await signOut(auth)
                } catch (signOutError) {
                  console.error('Error signing out:', signOutError)
                }
              }, 500)
            })
            return
          }
          
          // Also check by email in case user signed up with email/password first
          if (user.email) {
            const usersRef = ref(realtimeDb, 'users')
            const allUsersSnapshot = await get(usersRef)
            
            if (allUsersSnapshot.exists()) {
              const allUsers = allUsersSnapshot.val()
              // Check if any user has this email
              const userWithEmail = Object.values(allUsers).find((u: any) => 
                u.email && u.email.toLowerCase() === user.email?.toLowerCase()
              )
              
              if (userWithEmail) {
                // User with this email already exists - show error first, then sign out
                console.log('User already exists in database (by email), preventing duplicate account creation')
                setLoading(false)
                // Show error modal immediately (synchronously)
                openModal('error', 'Account Already Exists', `An account with the email ${user.email || 'this email'} already exists. Please sign in instead of creating a new account.`)
                // Use requestAnimationFrame to ensure modal renders, then sign out after additional delay
                requestAnimationFrame(() => {
                  setTimeout(async () => {
                    try {
                      await signOut(auth)
                    } catch (signOutError) {
                      console.error('Error signing out:', signOutError)
                    }
                  }, 500)
                })
                return
              }
            }
          }
        } catch (checkError) {
          console.error('Error checking for existing user:', checkError)
          // If check fails, show error first, then sign out
          setLoading(false)
          // Show error modal immediately (synchronously)
          openModal('error', 'Account Check Failed', 'Unable to verify account status. Please try again or sign in if you already have an account.')
          // Use requestAnimationFrame to ensure modal renders, then sign out after additional delay
          requestAnimationFrame(() => {
            setTimeout(async () => {
              try {
                await signOut(auth)
              } catch (signOutError) {
                console.error('Error signing out:', signOutError)
              }
            }, 500)
          })
          return
        }

        // Safe display name extraction
        let displayName = 'Google User'
        let firstName = ''
        let lastName = ''
        try {
          displayName = user.displayName || user.email || 'Google User'
          if (user.displayName && typeof user.displayName === 'string' && user.displayName.includes(' ')) {
            const nameParts = user.displayName.split(' ')
            firstName = nameParts[0] || ''
            lastName = nameParts.slice(1).join(' ') || ''
          } else {
            firstName = displayName
          }
        } catch (nameError) {
          console.error('Error extracting display name:', nameError)
          displayName = user.email || 'Google User'
          firstName = displayName
        }

        // Determine if user should be auto-verified (first user or GSO)
        const shouldAutoVerify = isFirstUser || selectedRole === 'admin'

        // Save additional user data to Realtime Database
        const userData = {
          uid: user.uid || '',
          email: user.email || '',
          firstName: firstName,
          lastName: lastName,
          displayName: displayName,
          role: selectedRole || 'Coordinator',
          verified: shouldAutoVerify, // First user or GSO is auto-verified
          verificationStatus: shouldAutoVerify ? 'verified' : 'pending', // Set verification status
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          provider: 'google'
        }

        console.log('Saving Google user data with role:', selectedRole, 'Auto-verified:', shouldAutoVerify, userData)
        
        try {
          await set(ref(realtimeDb, `users/${user.uid}`), userData)
        } catch (dbError) {
          console.error('Error saving user data:', dbError)
          // Sign out if database save fails
          await signOut(auth)
          throw new Error('Failed to save user data to database')
        }
        
        // Log user signup to user_logs table
        try {
          await logUserActionToUserLogs(
            'Google Signup',
            'System',
            `New user account created with Google: ${user.email || 'unknown'} (Role: ${selectedRole})`,
            'success',
            displayName,
            user.uid,
            'google'
          )
        } catch (logError) {
          console.error('Error logging user action:', logError)
          // Continue even if logging fails
        }
        
        const roleDisplay = selectedRole === 'admin' ? 'GSO' : selectedRole
        if (shouldAutoVerify) {
          openModal('success', 'Signed up with Google', `Welcome ${displayName}! Your ${roleDisplay} account has been created${isFirstUser ? ' as the first user' : ''} with Google authentication.`)
          scheduleSuccessRedirect(displayName !== 'Google User' ? displayName : undefined, selectedRole)
        } else {
          openModal('success', 'Account Created', `Welcome ${displayName}! Your ${roleDisplay} account has been created. Please wait for verification before accessing the system.`)
        }
      } catch (error: any) {
        console.error('Google signup error:', error)
        
        let errorMessage = 'Google signup failed. Please try again.'
        
        try {
          if (error?.code === 'auth/popup-closed-by-user') {
            errorMessage = 'Signup was cancelled. Please try again.'
          } else if (error?.code === 'auth/popup-blocked') {
            errorMessage = 'Pop-up was blocked. Please allow pop-ups and try again.'
          } else if (error?.code === 'auth/network-request-failed') {
            errorMessage = 'Network error. Please check your connection and try again.'
          } else if (error?.code === 'auth/unauthorized-domain') {
            errorMessage = 'This domain is not authorized for Google signup. Please contact support.'
          } else if (error?.code === 'auth/operation-not-allowed') {
            errorMessage = 'Google signup is not enabled. Please contact support.'
          } else if (error?.message) {
            errorMessage = error.message
          }
        } catch (errorParseError) {
          console.error('Error parsing error message:', errorParseError)
        }
        
        // Log failed Google signup attempt (with error handling)
        try {
          await logUserActionToUserLogs(
            'Google Signup',
            'System',
            `Failed Google signup attempt - ${errorMessage}`,
            'error',
            'Unknown User',
            'unknown',
            'google'
          )
        } catch (logError) {
          console.error('Error logging failed Google signup:', logError)
        }
        
        openModal('error', 'Google Signup Failed', errorMessage)
      } finally {
        setLoading(false)
      }
    } catch (outerError: any) {
      console.error('Outer Google signup error:', outerError)
      setLoading(false)
      openModal('error', 'Google Sign-up Failed', 'An unexpected error occurred. Please try again.')
    }
  }

  return (
    <div className="signup-page">
      <div className="signup-grid" aria-hidden="true">
        {/* decorative dotted grid */}
        <div className="dots-layer" />
      </div>
      <main className="signup-card" role="main">
        <header className="signup-header">
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
          <h1 className="welcome">Create Account</h1>
          <p className="subtitle">Sign up to get started with your dashboard</p>
        </header>

        <form className="form" onSubmit={handleSubmit}>
          <div className="name-row">
            <div className="name-field">
              <label className="label" htmlFor="firstName">
                <span className="label-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="1.5"/>
                    <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                </span>
                <span>First Name</span>
              </label>
              <div className="input-wrapper">
                <span className="input-leading" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="1.5"/>
                    <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                </span>
                <input 
                  id="firstName" 
                  name="firstName" 
                  type="text" 
                  autoComplete="given-name" 
                  placeholder="Enter your first name" 
                  value={firstName} 
                  onChange={(e) => setFirstName(e.target.value)} 
                  required 
                />
              </div>
            </div>

            <div className="name-field">
              <label className="label" htmlFor="lastName">
                <span className="label-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="1.5"/>
                    <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                </span>
                <span>Last Name</span>
              </label>
              <div className="input-wrapper">
                <span className="input-leading" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="1.5"/>
                    <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                </span>
                <input 
                  id="lastName" 
                  name="lastName" 
                  type="text" 
                  autoComplete="family-name" 
                  placeholder="Enter your last name" 
                  value={lastName} 
                  onChange={(e) => setLastName(e.target.value)} 
                  required 
                />
              </div>
            </div>
          </div>

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
            <input 
              id="email" 
              name="email" 
              type="email" 
              autoComplete="email" 
              placeholder="Enter your email" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)} 
              required 
            />
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
            <input 
              id="password" 
              name="password" 
              type={showPassword ? 'text' : 'password'} 
              autoComplete="new-password" 
              placeholder="Create a password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              required 
            />
            <button 
              type="button" 
              className="input-trailing" 
              aria-label={showPassword ? 'Hide password' : 'Show password'} 
              onClick={() => setShowPassword(v => !v)}
            >
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


          <div className="role-selection">
            <label className="label">
              <span className="label-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              </span>
              <span>Account Type</span>
            </label>
            <div className="role-options">
              <label className="role-option">
                <input
                  type="radio"
                  name="userRole"
                  value="Coordinator"
                  checked={userRole === 'Coordinator'}
                  onChange={(e) => setUserRole(e.target.value as 'Coordinator' | 'admin')}
                />
                <span className="role-label">
                  <span className="role-icon">👨‍🏫</span>
                  <div>
                    <span className="role-title">Coordinator</span>
                    <span className="role-description">Standard access to dashboard features</span>
                  </div>
                </span>
              </label>
              <label className={`role-option ${hasExistingGSO ? 'disabled' : ''}`}>
                <input
                  type="radio"
                  name="userRole"
                  value="admin"
                  checked={userRole === 'admin'}
                  onChange={(e) => setUserRole(e.target.value as 'Coordinator' | 'admin')}
                  disabled={hasExistingGSO}
                />
                <span className="role-label">
                  <span className="role-icon">👑</span>
                  <div>
                    <span className="role-title">GSO</span>
                    <span className="role-description">
                      {hasExistingGSO 
                        ? 'GSO account already exists. Only one GSO is allowed.' 
                        : 'Full access to all features and user management'
                      }
                    </span>
                  </div>
                </span>
              </label>
            </div>
          </div>

          <button type="submit" className="primary-btn" disabled={loading}>
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>

          <div className="divider" role="separator" aria-label="or continue with">
            <span>or continue with</span>
          </div>

          <button type="button" className="oauth-btn" onClick={handleGoogle} disabled={loading}>
            <span className="google-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
                <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303C33.602 31.91 29.218 35 24 35c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.676 5.099 29.627 3 24 3 12.955 3 4 11.955 4 23s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.651-.389-3.917z"/>
                <path fill="#FF3D00" d="M6.306 14.691l6.571 4.814C14.297 16.108 18.789 13 24 13c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.676 5.099 29.627 3 24 3 16.318 3 9.656 7.337 6.306 14.691z"/>
                <path fill="#4CAF50" d="M24 43c5.137 0 9.773-1.967 13.285-5.178l-6.129-5.177C29.153 34.091 26.687 35 24 35c-5.196 0-9.571-3.061-11.292-7.436l-6.54 5.037C9.474 39.556 16.229 43 24 43z"/>
                <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-1.101 3.261-3.645 5.824-6.747 7.046l-6.129 5.177C36.293 41.466 44 36.5 44 23c0-1.341-.138-2.651-.389-3.917z"/>
              </svg>
            </span>
            <span>Continue with Google</span>
          </button>
        </form>

        <footer className="signup-footer">
          <span>Already have an account?</span>
          <button 
            type="button" 
            className="link" 
            onClick={onNavigateToLogin}
            disabled={loading}
          >
            Sign In
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

      {/* Role Selection Modal for Google Auth */}
      {showRoleModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setShowRoleModal(false)}>
          <div className="modal-card role-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon" aria-hidden="true">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="11" fill="url(#roleGradient)"/>
                <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 17l10 5 10-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 12l10 5 10-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <defs>
                  <linearGradient id="roleGradient" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#4f8cff"/>
                    <stop offset="100%" stopColor="#7b61ff"/>
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <h2 className="modal-title">Choose Your Account Type</h2>
            <p className="modal-message">Please select the type of account you want to create with Google.</p>
            
            <div className="role-modal-options">
              <button 
                className="role-modal-option"
                onClick={() => handleGoogleWithRole('Coordinator')}
              >
                <span className="role-icon">👨‍🏫</span>
                <div>
                  <span className="role-title">Coordinator Account</span>
                  <span className="role-description">Standard access to dashboard features</span>
                </div>
              </button>
              
              <button 
                className={`role-modal-option ${hasExistingGSO ? 'disabled' : ''}`}
                onClick={() => !hasExistingGSO && handleGoogleWithRole('admin')}
                disabled={hasExistingGSO}
              >
                <span className="role-icon">👑</span>
                <div>
                  <span className="role-title">GSO Account</span>
                  <span className="role-description">
                    {hasExistingGSO 
                      ? 'GSO account already exists. Only one GSO is allowed.' 
                      : 'Full access to all features and user management'
                    }
                  </span>
                </div>
              </button>
            </div>
            
            <button 
              className="modal-cancel-btn" 
              onClick={() => setShowRoleModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

