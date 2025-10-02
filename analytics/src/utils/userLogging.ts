import { ref, push, set } from 'firebase/database'
import { realtimeDb } from '../firebase/config'

// Function to log user actions to user_logs table
export const logUserActionToUserLogs = async (
  action: string,
  outletName: string,
  details: string,
  type: 'info' | 'warning' | 'error' | 'success',
  user: string = 'System',
  userId: string = 'system',
  authProvider: 'google' | 'email' | 'system' = 'system'
) => {
  try {
    const userLogsRef = ref(realtimeDb, 'user_logs')
    const newUserLogRef = push(userLogsRef)
    
    const userLogData = {
      timestamp: new Date().toISOString(),
      outletName,
      action,
      details,
      type,
      user,
      userId,
      authProvider
    }
    
    await set(newUserLogRef, userLogData)
    console.log('✅ User action logged to user_logs table:', userLogData)
    return true
  } catch (error) {
    console.error('❌ Error logging user action to user_logs:', error)
    return false
  }
}

// Function to log user actions to main logs table
export const logUserAction = async (
  action: string,
  outletName: string,
  details: string,
  type: 'info' | 'warning' | 'error' | 'success',
  user: string = 'System',
  userId: string = 'system',
  authProvider: 'google' | 'email' | 'system' = 'system'
) => {
  try {
    // Log to main logs collection
    const logsRef = ref(realtimeDb, 'logs')
    const newLogRef = push(logsRef)
    
    const logData = {
      timestamp: new Date().toISOString(),
      outletName,
      action,
      details,
      type,
      user,
      userId,
      authProvider
    }
    
    await set(newLogRef, logData)
    
    // Also log to user_logs table
    await logUserActionToUserLogs(action, outletName, details, type, user, userId, authProvider)
    
    console.log('✅ User action logged to database:', logData)
    return true
  } catch (error) {
    console.error('❌ Error logging user action:', error)
    return false
  }
}

// Function to log authentication events
export const logAuthEvent = async (
  action: 'login' | 'logout' | 'timeout' | 'google_login' | 'google_logout',
  userName: string,
  userId: string,
  ipAddress?: string,
  additionalDetails?: string,
  authProvider?: 'google' | 'email' | 'system'
) => {
  try {
    // Determine action display name and type
    let actionDisplay = ''
    let logType = 'info'
    
    switch (action) {
      case 'login':
        actionDisplay = 'User Login'
        logType = 'success'
        break
      case 'logout':
        actionDisplay = 'User Logout'
        logType = 'info'
        break
      case 'timeout':
        actionDisplay = 'Session Timeout'
        logType = 'warning'
        break
      case 'google_login':
        actionDisplay = 'Google Login'
        logType = 'success'
        break
      case 'google_logout':
        actionDisplay = 'Google Logout'
        logType = 'info'
        break
    }
    
    // Log to main logs collection
    const logsRef = ref(realtimeDb, 'logs')
    const newLogRef = push(logsRef)
    
    const logData = {
      timestamp: new Date().toISOString(),
      outletName: 'System',
      action: actionDisplay,
      details: action === 'google_login' 
        ? `User ${userName} logged in via Google from ${ipAddress || 'unknown location'}${additionalDetails ? ` - ${additionalDetails}` : ''}`
        : action === 'google_logout'
        ? `User ${userName} logged out from Google account${additionalDetails ? ` - ${additionalDetails}` : ''}`
        : action === 'login' 
        ? `User ${userName} logged in successfully from ${ipAddress || 'unknown location'}${additionalDetails ? ` - ${additionalDetails}` : ''}`
        : action === 'logout'
        ? `User ${userName} logged out successfully${additionalDetails ? ` - ${additionalDetails}` : ''}`
        : `User ${userName} session expired due to inactivity${additionalDetails ? ` - ${additionalDetails}` : ''}`,
      type: logType,
      user: userName,
      userId,
      authProvider: authProvider || 'email'
    }
    
    await set(newLogRef, logData)
    
    // Also log to auth_logs collection for authentication tracking
    const authRef = ref(realtimeDb, 'auth_logs')
    const newAuthRef = push(authRef)
    
    const authData = {
      timestamp: new Date().toISOString(),
      action,
      userName,
      userId,
      ipAddress: ipAddress || 'unknown',
      authProvider: authProvider || 'email',
      additionalDetails: additionalDetails || ''
    }
    
    await set(newAuthRef, authData)
    
    // Also log to user_logs table
    await logUserActionToUserLogs(
      actionDisplay,
      'System',
      logData.details,
      logType as 'info' | 'warning' | 'error' | 'success',
      userName,
      userId,
      authProvider || 'email'
    )
    
    console.log('✅ Authentication event logged to database:', authData)
    return true
  } catch (error) {
    console.error('❌ Error logging authentication event:', error)
    return false
  }
}
