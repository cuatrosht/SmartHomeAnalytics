import React, { useState } from 'react'
import { auth } from '../firebase/config'
import { logAuthEvent } from '../utils/userLogging'
import './SideBar.css'

export type SidebarItemKey = 'dashboard' | 'setup' | 'schedule' | 'activeDevice' | 'reports' | 'users' | 'deviceLogs' | 'offices'

interface SideBarProps {
  onLogout?: () => void
  onNavigate?: (key: SidebarItemKey) => void
  isOpen?: boolean
  onToggle?: () => void
  activeView?: SidebarItemKey
  userRole?: 'Coordinator' | 'admin'
}

export default function SideBar({ onLogout, onNavigate, isOpen = true, onToggle, activeView = 'dashboard', userRole = 'Coordinator' }: SideBarProps) {
  const [showLogoutModal, setShowLogoutModal] = useState(false)



  const handleLogoutClick = () => {
    setShowLogoutModal(true)
  }

  const handleConfirmLogout = async () => {
    try {
      console.log('SideBar: Starting logout process...')
      
      // Get current user info before logout
      const currentUser = auth.currentUser
      console.log('SideBar: Current user:', currentUser)
      
      if (currentUser) {
        const userEmail = currentUser.email || 'Unknown'
        const displayName = currentUser.displayName || userEmail
        const userId = currentUser.uid
        
        console.log('SideBar: User details:', { userEmail, displayName, userId })
        
        // Determine auth provider
        let authProvider: 'email' | 'google' | 'system' = 'system'
        if (currentUser.providerData && currentUser.providerData.length > 0) {
          const providerId = currentUser.providerData[0].providerId
          console.log('SideBar: Provider ID:', providerId)
          if (providerId === 'google.com') {
            authProvider = 'google'
          } else if (providerId === 'password') {
            authProvider = 'email'
          }
        }
        
        console.log('SideBar: Auth provider:', authProvider)
        
        // Log logout event (this also logs to user_logs table)
        await logAuthEvent(
          authProvider === 'google' ? 'google_logout' : 'logout',
          displayName,
          userId,
          'unknown',
          `User logged out from ${authProvider === 'google' ? 'Google' : 'email'} account: ${userEmail}`,
          authProvider
        )
        
        console.log('SideBar: Logout event logged successfully')
      } else {
        console.log('SideBar: No current user found')
      }
    } catch (error) {
      console.error('SideBar: Error logging logout event:', error)
    }
    
    console.log('SideBar: Calling onLogout callback...')
    onLogout?.()
    setShowLogoutModal(false)
    if (window.innerWidth <= 768) {
      onToggle?.()
    }
    console.log('SideBar: Logout process completed')
  }

  const handleCancelLogout = () => {
    setShowLogoutModal(false)
  }

  const Item = ({ k, label, icon }: { k: SidebarItemKey, label: string, icon: React.ReactNode }) => (
    <button
      className={`sb-item ${activeView === k ? 'active' : ''}`}
      onClick={() => { 
        onNavigate?.(k);
        // Close sidebar on mobile after navigation
        if (window.innerWidth <= 768) {
          onToggle?.();
        }
      }}
      aria-current={activeView === k ? 'page' : undefined}
    >
      <span className="sb-icon" aria-hidden="true">{icon}</span>
      <span className="sb-label">{label}</span>
    </button>
  )

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && window.innerWidth <= 768 && (
        <div 
          className="sidebar-overlay" 
          onClick={onToggle}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 999
          }}
        />
      )}
      
      <aside className={`sidebar ${isOpen ? 'open' : ''}`} aria-label="Primary">
        <div className="sb-header">
          <span className="sb-brand-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 2h4v3h-4zM4 7h16v3H4zM5 12h14v10H5z" fill="#dbe7ff"/>
              <path d="M8 14h8v6H8z" fill="#a8b7ff"/>
            </svg>
          </span>
          <span className="sb-brand">EcoPlug</span>
        </div>

        <div className="sb-divider" />

        <nav className="sb-nav">
          {/* Dashboard - Available to all users */}
          <Item k="dashboard" label="Dashboard" icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor"/>
              <rect x="13" y="3" width="8" height="5" rx="2" fill="currentColor" opacity=".8"/>
              <rect x="3" y="13" width="5" height="8" rx="2" fill="currentColor" opacity=".8"/>
              <rect x="10" y="13" width="11" height="8" rx="2" fill="currentColor"/>
            </svg>
          }/>
          <div className="sb-rule" />
          
          {/* Active Device - Available to all users */}
          <Item k="activeDevice" label="Active Device" icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="currentColor" strokeWidth="1.6"/>
            </svg>
          }/>
          
          {/* GSO-only sections */}
          {userRole === 'admin' && (
            <>
              <div className="sb-rule" />
              <Item k="setup" label="Set up" icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 8a4 4 0 100 8 4 4 0 000-8z" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              }/>
              <div className="sb-rule" />
              <Item k="schedule" label="Schedule" icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="1.6"/>
                  <path d="M8 2v4M16 2v4M3 9h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              }/>
              <div className="sb-rule" />
              <Item k="reports" label="Reports" icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 4h10l6 6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.6"/>
                  <path d="M14 4v6h6" stroke="currentColor" strokeWidth="1.6"/>
                </svg>
              }/>
              <div className="sb-rule" />
              <Item k="users" label="User & Management" icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6"/>
                  <path d="M4.5 20c1.8-3.5 5-5.3 7.5-5.3S17.7 16.5 19.5 20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              }/>
            </>
          )}
        </nav>

        <div className="sb-spacer" />

        <nav className="sb-bottom">
          <button className="sb-item" onClick={handleLogoutClick}>
            <span className="sb-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" stroke="currentColor" strokeWidth="1.6"/>
                <path d="M14 16l4-4-4-4M18 12H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </span>
            <span className="sb-label">Logout</span>
          </button>
        </nav>
      </aside>

      {/* Logout Confirmation Modal */}
      {showLogoutModal && (
        <div className="logout-modal-overlay" onClick={handleCancelLogout}>
          <div className="logout-modal" onClick={(e) => e.stopPropagation()}>
            <div className="logout-modal-header">
              <h3>Confirm Logout</h3>
            </div>
            <div className="logout-modal-body">
              <p>Are you sure you want to logout? This will clear your session and you'll need to sign in again.</p>
            </div>
            <div className="logout-modal-actions">
              <button className="logout-modal-btn cancel" onClick={handleCancelLogout}>
                Cancel
              </button>
              <button className="logout-modal-btn confirm" onClick={handleConfirmLogout}>
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
