import './App.css'
import { useMemo, useState, useEffect } from 'react'
import { signOut, onAuthStateChanged } from 'firebase/auth'
import { ref, onValue, off, get, update } from 'firebase/database'
import { auth, realtimeDb } from './firebase/config'
import LogIn from './components/LogIn'
import SignUp from './components/SignUp'
import SideBar from './components/SideBar'
import Dashboard from './components/Dashboard'
import SetUp from './components/SetUp'
import Schedule from './components/Schedule'
import Reports from './components/Reports'
import UserManagment from './components/UserManagment'
// Logs view removed
import ActiveDevice from './components/ActiveDevice'

function App() {
  const [isAuthed, setIsAuthed] = useState(false)
  const [userName, setUserName] = useState('User')
  const [userRole, setUserRole] = useState<'faculty' | 'admin'>('faculty')
  const [authView, setAuthView] = useState<'login' | 'signup'>('login')
  const [activeView, setActiveView] = useState<'dashboard' | 'setup' | 'schedule' | 'activeDevice' | 'reports' | 'users' | 'userLogs' | 'deviceLogs'>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [showNotificationModal, setShowNotificationModal] = useState(false)
  const [notifications, setNotifications] = useState<Array<{
    id: string
    type: 'power_limit' | 'schedule_conflict' | 'device_off' | 'device_on'
    title: string
    message: string
    outletName: string
    timestamp: Date
    isRead: boolean
    navigateTo?: 'setup' | 'schedule'
    deviceId?: string
  }>>([])
  
  // Handle sidebar state based on screen size
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 768
      setIsMobile(mobile)
      // On desktop, always show sidebar. On mobile, hide by default
      if (!mobile) {
        setSidebarOpen(true)
      } else {
        setSidebarOpen(false)
      }
    }

    // Set initial state
    handleResize()
    
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Helper function to check if notification should be created
  const shouldCreateNotification = (outletName: string, title: string) => {
    const now = Date.now()
    const tenMinutesAgo = now - (10 * 60 * 1000) // Increased to 10 minutes
    
    // Check if we've created this notification recently
    const recentNotifications = notifications.filter(n => 
      n.outletName === outletName && 
      n.title === title && 
      n.timestamp.getTime() > tenMinutesAgo
    )
    
    const shouldCreate = recentNotifications.length === 0
    console.log(`🔍 Should create notification for ${outletName} - ${title}: ${shouldCreate} (recent count: ${recentNotifications.length})`)
    
    return shouldCreate
  }

  // Global monthly limit monitoring functions
  const calculateCombinedMonthlyEnergy = (devicesData: any, selectedOutlets: string[]): number => {
    try {
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
      let totalCombinedMonthlyEnergy = 0
      
      // Sum up energy for all devices in the combined limit group
      selectedOutlets.forEach(outletKey => {
        const outlet = devicesData[outletKey]
        if (outlet && outlet.daily_logs) {
          for (let day = 1; day <= daysInMonth; day++) {
            const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
            const dayData = outlet.daily_logs[dateKey]
            if (dayData && dayData.total_energy) {
              totalCombinedMonthlyEnergy += dayData.total_energy // Already in kW from database
            }
          }
        }
      })
      
      // Return in watts
      return totalCombinedMonthlyEnergy * 1000
    } catch (error) {
      console.error('Error calculating combined monthly energy:', error)
      return 0
    }
  }

  const checkCombinedMonthlyLimit = async (devicesData: any, combinedLimitInfo: any) => {
    try {
      if (!combinedLimitInfo.enabled || combinedLimitInfo.selectedOutlets.length === 0) {
        return
      }
      
      const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
      const combinedLimitWatts = combinedLimitInfo.combinedLimit
      
      console.log('Global monthly limit check:', {
        totalMonthlyEnergy,
        combinedLimitWatts,
        selectedOutlets: combinedLimitInfo.selectedOutlets
      })
      
      // If monthly energy exceeds or equals the combined limit, follow the hierarchy:
      // 1. First attempt to remove devices from the combined group
      // 2. Only turn off devices if removal fails or is not possible
      if (totalMonthlyEnergy >= combinedLimitWatts) {
        console.log('Global combined monthly limit exceeded! Following hierarchy: remove from group first.')
        
        // HIERARCHY: First attempt to remove devices from combined group
        // This allows individual daily limits to take over
        try {
          const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
          const currentSettings = await get(combinedLimitRef)
          
          if (currentSettings.exists()) {
            const updatedSelectedOutlets: string[] = []
            
            // Remove each device from the combined group
            for (const outletKey of combinedLimitInfo.selectedOutlets) {
              const outletDisplayName = outletKey.replace('_', ' ')
              console.log(`Global: Attempting to remove ${outletDisplayName} from combined group due to monthly limit exceeded`)
              
              // Don't add to updatedSelectedOutlets (effectively removing it)
              // Individual daily limits will now control this device
            }
            
            // Update the combined limit settings to remove all devices
            await update(combinedLimitRef, {
              selected_outlets: updatedSelectedOutlets,
              enabled: updatedSelectedOutlets.length > 0 // Disable if no devices left
            })
            
            console.log('Global: Successfully removed all devices from combined group. Individual daily limits now control these devices.')
            
            // Now turn off devices that exceed their individual daily limits
            for (const outletKey of combinedLimitInfo.selectedOutlets) {
              const deviceData = devicesData[outletKey]
              if (deviceData) {
                const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
                
                if (powerLimit > 0) {
                  // Get today's energy consumption
                  const today = new Date()
                  const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                  const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                  const todayTotalEnergy = todayLogs?.total_energy || 0
                  
                  // Only turn off if individual daily limit is also exceeded
                  if (todayTotalEnergy >= powerLimit) {
                    try {
                      const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
                      await update(controlRef, { device: 'off' })
                      console.log(`Global: Turned off device ${outletKey} due to BOTH monthly and individual daily limits exceeded`)
                    } catch (error) {
                      console.error(`Error turning off device ${outletKey}:`, error)
                    }
                  } else {
                    console.log(`Global: Device ${outletKey} monthly limit exceeded but individual daily limit OK - keeping device on`)
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error('Error removing devices from combined group:', error)
          
          // Fallback: If removal fails, turn off all devices (original behavior)
          console.log('Global: Fallback - turning off all devices in combined group')
          for (const outletKey of combinedLimitInfo.selectedOutlets) {
            try {
              const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
              await update(controlRef, { device: 'off' })
              console.log(`Global: Turned off device ${outletKey} due to combined monthly limit (fallback)`)
            } catch (error) {
              console.error(`Error turning off device ${outletKey}:`, error)
            }
          }
        }
      }
    } catch (error) {
      console.error('Error checking combined monthly limit:', error)
    }
  }
  
  // Debug notification state changes
  useEffect(() => {
    console.log('🔔 Notification state updated:', {
      count: notifications.length,
      unread: notifications.filter(n => !n.isRead).length,
      notifications: notifications.map(n => ({ id: n.id, title: n.title, isRead: n.isRead }))
    })
  }, [notifications])

  // Handle notification click navigation
  const handleNotificationClick = (notification: typeof notifications[0]) => {
    console.log('🔔 Notification clicked:', notification)
    console.log('🔔 NavigateTo:', notification.navigateTo)
    
    if (notification.navigateTo) {
      // Navigate immediately to the page where issue can be resolved
      setActiveView(notification.navigateTo)
      
      // Close notification modal
      setShowNotificationModal(false)
      
      console.log(`🔔 Navigated to ${notification.navigateTo} for notification:`, notification.title)
      console.log('🔔 Notification will auto-disappear when issue is resolved')
    } else {
      console.log('🔔 No navigation data for notification:', notification.title)
    }
  }

  // Auto-resolve notifications when issues are fixed
  const checkAndResolveNotifications = async () => {
    try {
      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot: any = await get(devicesRef)
      
      if (!snapshot.exists()) return
      
      const devicesData = snapshot.val()
      
      // First, create new notifications for current device states
      const newNotifications: Array<{
        id: string
        type: 'power_limit' | 'schedule_conflict' | 'device_off' | 'device_on'
        title: string
        message: string
        outletName: string
        timestamp: Date
        isRead: boolean
        navigateTo?: 'setup' | 'schedule'
        deviceId?: string
      }> = []
      
      // Check all devices for current state and create notifications
      console.log(`🔍 Checking ${Object.keys(devicesData).length} devices for notifications...`)
      
      Object.keys(devicesData).forEach((outletKey) => {
        const outlet = devicesData[outletKey]
        const outletName = outletKey.replace('_', ' ')
        const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
        
        console.log(`🔍 Device ${outletName}: state=${controlState}, hasSchedule=${!!outlet.schedule}`)
        
        // Check for devices that are off and have schedules
        if (controlState === 'off' && outlet.schedule && outlet.schedule.timeRange && outlet.schedule.timeRange !== 'No schedule') {
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          
          console.log(`📅 Checking schedule for ${outletName}: ${outlet.schedule.timeRange}`)
          
          // Parse schedule time
          const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
          const convertTo24Hour = (time12: string) => {
            const [time, period] = time12.split(' ')
            const [hours, minutes] = time.split(':').map(Number)
            return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                   period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
          }
          
          const startTime = convertTo24Hour(startTimeStr)
          const endTime = convertTo24Hour(endTimeStr)
          
          console.log(`⏰ Time check for ${outletName}: current=${Math.floor(currentTime/60)}:${String(currentTime%60).padStart(2,'0')}, schedule=${startTimeStr}-${endTimeStr}`)
          
          // Check if device is outside scheduled time
          const isOutsideSchedule = currentTime < startTime || currentTime > endTime
          
          console.log(`📊 ${outletName}: isOutsideSchedule=${isOutsideSchedule}, shouldCreate=${shouldCreateNotification(outletName, 'Device Turned Off (Time Limit)')}`)
          
          if (isOutsideSchedule && shouldCreateNotification(outletName, 'Device Turned Off (Time Limit)')) {
            console.log(`🔔 Creating real-time notification for ${outletName} (off, outside schedule)`)
            newNotifications.push({
              id: `realtime_off_${outletKey}_${Date.now()}`,
              type: 'device_off',
              title: 'Device Turned Off (Time Limit)',
              message: `${outletName} was turned off because it's outside its scheduled time (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
              outletName,
              timestamp: new Date(),
              isRead: false,
              navigateTo: 'schedule',
              deviceId: outletKey
            })
          }
        }
        
        // Also check for power limit violations
        if (outlet.relay_control?.auto_cutoff?.power_limit) {
          const powerLimit = outlet.relay_control.auto_cutoff.power_limit
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = outlet?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0
          
          console.log(`⚡ Power check for ${outletName}: limit=${powerLimit}kW, current=${todayTotalEnergy}kW`)
          
          if (todayTotalEnergy >= powerLimit && shouldCreateNotification(outletName, 'Device Auto-Turned Off (Power Limit)')) {
            console.log(`🔔 Creating power limit notification for ${outletName}`)
            newNotifications.push({
              id: `power_limit_${outletKey}_${Date.now()}`,
              type: 'device_off',
              title: 'Device Auto-Turned Off (Power Limit)',
              message: `${outletName} was automatically turned off because today's energy consumption (${todayTotalEnergy.toFixed(3)}kW) exceeded the power limit (${powerLimit}kW)`,
              outletName,
              timestamp: new Date(),
              isRead: false,
              navigateTo: 'setup',
              deviceId: outletKey
            })
          }
        }
      })
      
      console.log(`📊 Found ${newNotifications.length} new notifications to create`)
      
      // Update notifications with new ones and resolve old ones
      setNotifications(prev => {
        // Add new notifications with better deduplication
        const existingNotifications = prev
        const finalNotifications = [...existingNotifications]
        
        newNotifications.forEach(newNotification => {
          // Check if similar notification already exists
          const similarExists = existingNotifications.some(existing => 
            existing.outletName === newNotification.outletName && 
            existing.title === newNotification.title &&
            Math.abs(existing.timestamp.getTime() - newNotification.timestamp.getTime()) < (5 * 60 * 1000) // Within 5 minutes
          )
          
          if (!similarExists) {
            console.log(`✅ Adding new notification: ${newNotification.title} for ${newNotification.outletName}`)
            finalNotifications.push(newNotification)
          } else {
            console.log(`⚠️ Skipping duplicate notification: ${newNotification.title} for ${newNotification.outletName}`)
          }
        })
        
        // Filter out resolved notifications with enhanced auto-resolution
        return finalNotifications.filter(notification => {
          // Keep notifications that don't have auto-resolve logic
          if (!notification.navigateTo || !notification.deviceId) return true
          
          const deviceData = devicesData[notification.deviceId]
          if (!deviceData) return true // Keep notification if device not found
          
          const controlState = (deviceData.control?.device || 'off').toString().trim().toLowerCase()
          const schedule = deviceData.schedule
          const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
          
          // Get today's energy consumption
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0
          
          // Enhanced auto-resolution logic
          if (notification.title === 'Device Turned Off (Time Limit)' || 
              (notification.type === 'device_off' && notification.navigateTo === 'schedule')) {
            
            // Resolved if: schedule removed, device is now within schedule, or device is back on
            let isResolved = false
            let resolutionReason = ''
            
            if (!schedule || schedule.timeRange === 'No schedule') {
              isResolved = true
              resolutionReason = 'Schedule has been removed'
            } else if (controlState === 'on') {
              isResolved = true
              resolutionReason = 'Device is now ON'
            } else {
              // Check if device is now within schedule
              const now = new Date()
              const currentTime = now.getHours() * 60 + now.getMinutes()
              
              console.log(`🔍 Checking schedule resolution for ${notification.outletName}:`)
              console.log(`   Current time: ${now.toLocaleTimeString()} (${currentTime} minutes)`)
              console.log(`   Schedule: ${schedule.timeRange}`)
              console.log(`   Control state: ${controlState}`)
              
              const [startTimeStr, endTimeStr] = schedule.timeRange.split(' - ')
              const convertTo24Hour = (time12: string) => {
                const [time, period] = time12.split(' ')
                const [hours, minutes] = time.split(':').map(Number)
                return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                       period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
              }
              
              const startTime = convertTo24Hour(startTimeStr)
              const endTime = convertTo24Hour(endTimeStr)
              
              console.log(`   Start time: ${startTimeStr} (${startTime} minutes)`)
              console.log(`   End time: ${endTimeStr} (${endTime} minutes)`)
              
              // Handle case where schedule spans midnight (end time is before start time)
              let isWithinSchedule = false
              if (endTime >= startTime) {
                // Normal case: schedule within same day
                isWithinSchedule = currentTime >= startTime && currentTime <= endTime
                console.log(`   Normal schedule: ${isWithinSchedule}`)
              } else {
                // Schedule spans midnight: check if current time is after start OR before end
                isWithinSchedule = currentTime >= startTime || currentTime <= endTime
                console.log(`   Midnight span schedule: ${isWithinSchedule}`)
              }
              
              if (isWithinSchedule) {
                isResolved = true
                resolutionReason = 'Device is now within scheduled time'
                console.log(`✅ Schedule resolution detected: ${resolutionReason}`)
              } else {
                console.log(`❌ Still outside schedule: current=${currentTime}, start=${startTime}, end=${endTime}`)
              }
            }
            
            if (isResolved) {
              console.log(`✅ Auto-resolved schedule notification for ${notification.outletName}: ${resolutionReason}`)
            }
            return !isResolved
          }
          
          if (notification.title === 'Device Auto-Turned Off (Power Limit)' || 
              (notification.type === 'device_off' && notification.navigateTo === 'setup')) {
            
            // Resolved if: power limit removed, energy consumption below threshold, or device is back on
            let isResolved = false
            let resolutionReason = ''
            
            if (powerLimit === 0) {
              isResolved = true
              resolutionReason = 'Power limit has been removed'
            } else if (controlState === 'on') {
              isResolved = true
              resolutionReason = 'Device is now ON'
            } else if (todayTotalEnergy < (powerLimit * 0.8)) {
              isResolved = true
              resolutionReason = `Energy consumption (${todayTotalEnergy.toFixed(3)}kW) is now below 80% of limit (${powerLimit}kW)`
            }
            
            if (isResolved) {
              console.log(`✅ Auto-resolved power limit notification for ${notification.outletName}: ${resolutionReason}`)
            }
            return !isResolved
          }
          
          // For power limit notifications
          if (notification.type === 'power_limit') {
            const isResolved = powerLimit === 0 || todayTotalEnergy < (powerLimit * 0.8)
            if (isResolved) {
              console.log(`✅ Auto-resolved power limit notification for ${notification.outletName}`)
            }
            return !isResolved
          }
          
          // For schedule conflict notifications
          if (notification.type === 'schedule_conflict') {
            const isResolved = controlState === 'off' || !schedule || schedule.timeRange === 'No schedule'
            if (isResolved) {
              console.log(`✅ Auto-resolved schedule conflict notification for ${notification.outletName}`)
            }
            return !isResolved
          }
          
          return true
        })
      })
    } catch (error) {
      console.error('Error checking notification resolution:', error)
    }
  }
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false)
  const [lastUpdateTime, setLastUpdateTime] = useState<Date | null>(null)
  const [previousDeviceStates, setPreviousDeviceStates] = useState<Record<string, string>>({})
  
  // Notification system is ready - no test notification needed

  const today = useMemo(() => {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const yyyy = d.getFullYear()
    return `${mm}/${dd}/${yyyy}`
  }, [isAuthed])

  // Handle responsive behavior
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768
      setIsMobile(mobile)
      if (!mobile) {
        setSidebarOpen(false)
      }
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Firebase authentication state listener
  useEffect(() => {
    console.log('Setting up Firebase auth state listener...')
    
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      console.log('Firebase auth state changed:', user ? 'User logged in' : 'User logged out')
      console.log('User details:', user ? {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName
      } : 'No user')
      
      // If user is null and we think we're authenticated, there's a mismatch
      if (!user && isAuthed) {
        console.log('⚠️ Firebase says user is logged out but local state says authenticated - syncing...')
        setIsAuthed(false)
        setAuthView('login')
        setUserName('User')
        setUserRole('faculty')
        setActiveView('dashboard')
      }
    })

    return () => {
      console.log('Cleaning up Firebase auth state listener...')
      unsubscribe()
    }
  }, [isAuthed])

  // Real-time notification listener with enhanced monitoring
  useEffect(() => {
    if (!isAuthed) return

    console.log('🔔 Setting up real-time notification listener...')
    const devicesRef = ref(realtimeDb, 'devices')
    
    // Test Firebase connection
    console.log('🔥 Testing Firebase connection...')
    console.log('🔥 Firebase config:', realtimeDb.app.options)
    
    // Initialize previous device states on first load
    let isFirstLoad = true
    
    // Add periodic notification check to ensure real-time detection
    const notificationCheckInterval = setInterval(() => {
      console.log('⏰ Periodic notification check...')
      checkAndResolveNotifications()
    }, 10000) // Check every 10 seconds for faster auto-resolution
    
    const unsubscribe = onValue(devicesRef, async (snapshot) => {
      console.log('📡 Firebase data updated, checking for notifications...')
      setIsRealtimeConnected(true)
      setLastUpdateTime(new Date())
      
      // Add connection test
      console.log('🔗 Firebase connection status: CONNECTED')
      console.log('⏰ Last update time:', new Date().toLocaleTimeString())
      
      // Force immediate notification check on every Firebase update
      console.log('🔄 Forcing immediate notification check...')
      setTimeout(() => {
        checkAndResolveNotifications()
      }, 100) // Small delay to ensure state is updated
      
      // Check combined monthly limits
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (combinedLimitSnapshot.exists()) {
          const combinedLimitData = combinedLimitSnapshot.val()
          const combinedLimitInfo = {
            enabled: combinedLimitData.enabled || false,
            selectedOutlets: combinedLimitData.selectedOutlets || [],
            combinedLimit: combinedLimitData.combinedLimit || 0
          }
          
          if (combinedLimitInfo.enabled && combinedLimitInfo.selectedOutlets.length > 0) {
            const data = snapshot.val()
            if (data) {
              console.log('🌙 Global monthly limit check triggered by Firebase data change')
              await checkCombinedMonthlyLimit(data, combinedLimitInfo)
            }
          }
        }
      } catch (error) {
        console.error('Error checking combined monthly limits:', error)
      }
      
      const data = snapshot.val()
      if (!data) {
        console.log('⚠️ No data received from Firebase')
        return
      }

      // On first load, initialize previous states and check for existing auto-turn-offs
      if (isFirstLoad) {
        console.log('🔄 First load - initializing device states and checking for auto-turn-offs')
        const initialStates: Record<string, string> = {}
        Object.keys(data).forEach((outletKey) => {
          const outlet = data[outletKey]
          const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
          initialStates[outletKey] = controlState
        })
        setPreviousDeviceStates(initialStates)
        isFirstLoad = false
        console.log('🔄 Initial states set:', initialStates)
        
        // Check for existing auto-turn-offs on first load
        console.log('🔍 Checking for existing auto-turn-offs on first load...')
        // This will be handled in the main loop below
      }

      const newNotifications: Array<{
        id: string
        type: 'power_limit' | 'schedule_conflict' | 'device_off' | 'device_on'
        title: string
        message: string
        outletName: string
        timestamp: Date
        isRead: boolean
        navigateTo?: 'setup' | 'schedule'
        deviceId?: string
      }> = []

      console.log(`🔍 Checking ${Object.keys(data).length} outlets for notifications...`)
      console.log('📊 Raw Firebase data:', data)
      console.log('📊 Previous device states:', previousDeviceStates)

      Object.keys(data).forEach((outletKey) => {
        const outlet = data[outletKey]
        const outletName = outletKey.replace('_', ' ')
        
        console.log(`🔌 Processing ${outletName}:`, outlet)
        
        // Enhanced data extraction with better error handling
        const powerLimit = outlet.relay_control?.auto_cutoff?.power_limit || 0
        const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
        const mainStatus = outlet.relay_control?.main_status || 'ON'
        
        // Get today's energy consumption from daily_logs
        const today = new Date()
        const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
        const todayLogs = outlet.daily_logs?.[todayDateKey]
        const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
        
        console.log(`🔌 ${outletName}: Today's Energy=${todayTotalEnergy.toFixed(3)}kW, Limit=${powerLimit}kW, Control=${controlState}, Main=${mainStatus}`)

        // Power limit detection - continuously monitor for power limit violations
        if (powerLimit > 0) {
          const isExceeded = todayTotalEnergy >= powerLimit
          const isNearLimit = todayTotalEnergy >= (powerLimit * 0.8) && todayTotalEnergy < powerLimit
          
          console.log(`⚠️ Power limit check for ${outletName}:`, {
            powerLimit: `${powerLimit}kW`,
            todayTotalEnergy: `${todayTotalEnergy}kW`,
            controlState: controlState,
            mainStatus: mainStatus,
            isExceeded: isExceeded,
            isNearLimit: isNearLimit
          })
          
          // Always check for power limit violations and generate notifications
          if (isExceeded && shouldCreateNotification(outletName, 'Device Auto-Turned Off (Power Limit)')) {
            console.log(`🔌 Device ${outletName} power limit exceeded - generating notification`)
            
            newNotifications.push({
              id: `power_exceeded_${outletKey}`,
              type: 'device_off',
              title: 'Device Auto-Turned Off (Power Limit)',
              message: `${outletName} was automatically turned off because today's energy consumption (${todayTotalEnergy.toFixed(3)}kW) exceeded the power limit (${powerLimit}kW)`,
              outletName,
              timestamp: new Date(),
              isRead: false,
              navigateTo: 'setup',
              deviceId: outletKey
            })
          }
          // Check if device is currently ON and approaching limit
          else if (controlState === 'on' && isNearLimit && shouldCreateNotification(outletName, 'Power Limit Warning')) {
            console.log(`⚠️ Device ${outletName} is ON and approaching power limit`)
            
            newNotifications.push({
              id: `power_warning_${outletKey}`,
              type: 'power_limit',
              title: 'Power Limit Warning',
              message: `${outletName} is approaching its daily power limit of ${powerLimit}kW. Today's consumption: ${todayTotalEnergy.toFixed(3)}kW`,
              outletName,
              timestamp: new Date(),
              isRead: false,
              navigateTo: 'setup',
              deviceId: outletKey
            })
          }
        }

        // Schedule monitoring - check all devices with schedules regardless of enable_power_scheduling flag
        if (outlet.schedule) {
          const schedule = outlet.schedule
          if (schedule.timeRange && schedule.timeRange !== 'No schedule') {
            const now = new Date()
            const currentTime = now.getHours() * 60 + now.getMinutes()
            const currentDay = now.getDay()
            
            // Parse schedule time
            const [startTimeStr, endTimeStr] = schedule.timeRange.split(' - ')
            const convertTo24Hour = (time12: string) => {
              const [time, period] = time12.split(' ')
              const [hours, minutes] = time.split(':').map(Number)
              return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                     period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
            }
            
            const startTime = convertTo24Hour(startTimeStr)
            const endTime = convertTo24Hour(endTimeStr)
            const isWithinTimeRange = currentTime >= startTime && currentTime <= endTime
            
            // Check if current day is in schedule (same logic as Schedule.tsx)
            const frequency = schedule.frequency?.toLowerCase() || ''
            let isCorrectDay = false

            if (frequency === 'daily') {
              isCorrectDay = true
            } else if (frequency === 'weekdays') {
              isCorrectDay = currentDay >= 1 && currentDay <= 5 // Monday to Friday
            } else if (frequency === 'weekends') {
              isCorrectDay = currentDay === 0 || currentDay === 6 // Sunday or Saturday
            } else if (frequency.includes(',')) {
              // Custom days (e.g., "MONDAY, WEDNESDAY, FRIDAY")
              const dayMap: { [key: string]: number } = {
                'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
                'friday': 5, 'saturday': 6, 'sunday': 0
              }
              const scheduledDays = frequency.split(',').map((day: string) => dayMap[day.trim().toLowerCase()])
              isCorrectDay = scheduledDays.includes(currentDay)
            }
            
            const shouldBeActive = isWithinTimeRange && isCorrectDay
            const isOutsideSchedule = !shouldBeActive
            
            console.log(`📅 Schedule monitoring for ${outletName}:`, {
              currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
              startTime: `${Math.floor(startTime / 60)}:${String(startTime % 60).padStart(2, '0')}`,
              endTime: `${Math.floor(endTime / 60)}:${String(endTime % 60).padStart(2, '0')}`,
              scheduleTimeRange: schedule.timeRange,
              frequency: frequency,
              currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
              isCorrectDay: isCorrectDay,
              isWithinTimeRange: isWithinTimeRange,
              shouldBeActive: shouldBeActive,
              controlState: controlState,
              previousState: previousDeviceStates[outletKey]
            })
            
            // Continuously check for schedule violations and generate notifications
            if (isOutsideSchedule) {
              console.log(`📅 Schedule violation detected for ${outletName}: Outside ${schedule.timeRange} (Current: ${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')})`)
              
              if (controlState === 'on' && shouldCreateNotification(outletName, 'Schedule Conflict')) {
                // Device is ON but outside schedule - conflict warning
                newNotifications.push({
                  id: `schedule_conflict_${outletKey}`,
                  type: 'schedule_conflict',
                  title: 'Schedule Conflict',
                  message: `${outletName} is running outside its scheduled time (${schedule.timeRange}). Consider turning it off.`,
                  outletName,
                  timestamp: new Date(),
                  isRead: false,
                  navigateTo: 'schedule',
                  deviceId: outletKey
                })
              } else if (shouldCreateNotification(outletName, 'Device Auto-Turned Off (Time Limit)')) {
                // Device is OFF and outside schedule - was turned off due to schedule
                newNotifications.push({
                  id: `schedule_auto_off_${outletKey}`,
                  type: 'device_off',
                  title: 'Device Auto-Turned Off (Time Limit)',
                  message: `${outletName} was automatically turned off because it's outside its scheduled time (${schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
                  outletName,
                  timestamp: new Date(),
                  isRead: false,
                  navigateTo: 'schedule',
                  deviceId: outletKey
                })
              }
            }
            // Proactive detection: If device was on and is now off, and we're outside schedule, it was likely auto-turned off
            else {
              const previousState = previousDeviceStates[outletKey]
              if (previousState === 'on' && controlState === 'off' && isOutsideSchedule) {
                console.log(`🔌 Proactive schedule turn-off detection: ${outletName} was likely turned off due to schedule violation`)
                
                newNotifications.push({
                  id: `schedule_off_${outletKey}_${Date.now()}`,
                  type: 'device_off',
                  title: 'Device Auto-Turned Off (Schedule)',
                  message: `${outletName} was automatically turned off because it's outside its scheduled time (${schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
                  outletName,
                  timestamp: new Date(),
                  isRead: false,
                  navigateTo: 'schedule',
                  deviceId: outletKey
                })
              }
            }
          }
        }

        // Additional time limit detection - check for devices that should be off due to time limits
        // This catches devices that might have been turned off by the scheduler even without enable_power_scheduling flag
        if (outlet.schedule && outlet.schedule.timeRange && outlet.schedule.timeRange !== 'No schedule') {
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay()
          
          // Parse schedule time
          const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
          const convertTo24Hour = (time12: string) => {
            const [time, period] = time12.split(' ')
            const [hours, minutes] = time.split(':').map(Number)
            return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                   period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
          }
          
          const startTime = convertTo24Hour(startTimeStr)
          const endTime = convertTo24Hour(endTimeStr)
          const isWithinTimeRange = currentTime >= startTime && currentTime <= endTime
          
          // Check if current day is in schedule
          const frequency = outlet.schedule.frequency?.toLowerCase() || ''
          let isCorrectDay = false

          if (frequency === 'daily') {
            isCorrectDay = true
          } else if (frequency === 'weekdays') {
            isCorrectDay = currentDay >= 1 && currentDay <= 5
          } else if (frequency === 'weekends') {
            isCorrectDay = currentDay === 0 || currentDay === 6
          } else if (frequency.includes(',')) {
            const dayMap: { [key: string]: number } = {
              'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
              'friday': 5, 'saturday': 6, 'sunday': 0
            }
            const scheduledDays = frequency.split(',').map((day: string) => dayMap[day.trim().toLowerCase()])
            isCorrectDay = scheduledDays.includes(currentDay)
          }
          
          const shouldBeActive = isWithinTimeRange && isCorrectDay
          const isOutsideSchedule = !shouldBeActive
          
          // Continuously check for time limit violations
          if (isOutsideSchedule) {
            console.log(`🔌 Device ${outletName} time limit violation detected (outside schedule)`)
            
            if (controlState === 'off') {
              // Device is OFF due to time limit
              newNotifications.push({
                id: `time_limit_off_${outletKey}`,
                type: 'device_off',
                title: 'Device Turned Off (Time Limit)',
                message: `${outletName} was turned off because it's outside its scheduled time (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
                outletName,
                timestamp: new Date(),
                isRead: false,
                navigateTo: 'schedule',
                deviceId: outletKey
              })
            } else if (controlState === 'on') {
              // Device is ON but should be OFF due to time limit
              newNotifications.push({
                id: `time_limit_conflict_${outletKey}`,
                type: 'schedule_conflict',
                title: 'Time Limit Conflict',
                message: `${outletName} is running outside its scheduled time (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
                outletName,
                timestamp: new Date(),
                isRead: false,
                navigateTo: 'schedule',
                deviceId: outletKey
              })
            }
          }
        }

        // Enhanced time checker function to determine turn-off cause
        const checkTurnOffCause = (outlet: any, outletName: string) => {
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay()
          
          // Check power limit cause
          if (powerLimit > 0 && todayTotalEnergy >= powerLimit) {
            return {
              cause: 'power_limit',
              title: 'Device Auto-Turned Off (Power Limit)',
              message: `${outletName} was automatically turned off because today's energy consumption (${todayTotalEnergy.toFixed(3)}kW) exceeded the power limit (${powerLimit}kW)`,
              details: {
                powerLimit: powerLimit,
                todayEnergy: todayTotalEnergy,
                exceeded: true
              }
            }
          }
          
          // Check schedule cause
          if (outlet.schedule && outlet.schedule.timeRange && outlet.schedule.timeRange !== 'No schedule') {
            const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
            const convertTo24Hour = (time12: string) => {
              const [time, period] = time12.split(' ')
              const [hours, minutes] = time.split(':').map(Number)
              return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                     period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
            }
            
            const startTime = convertTo24Hour(startTimeStr)
            const endTime = convertTo24Hour(endTimeStr)
            const isWithinTimeRange = currentTime >= startTime && currentTime <= endTime
            
            // Check day frequency
            const frequency = outlet.schedule.frequency?.toLowerCase() || ''
            let isCorrectDay = false

            if (frequency === 'daily') {
              isCorrectDay = true
            } else if (frequency === 'weekdays') {
              isCorrectDay = currentDay >= 1 && currentDay <= 5
            } else if (frequency === 'weekends') {
              isCorrectDay = currentDay === 0 || currentDay === 6
            } else if (frequency.includes(',')) {
              const dayMap: { [key: string]: number } = {
                'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
                'friday': 5, 'saturday': 6, 'sunday': 0
              }
              const scheduledDays = frequency.split(',').map((day: string) => dayMap[day.trim().toLowerCase()])
              isCorrectDay = scheduledDays.includes(currentDay)
            }
            
            const shouldBeActive = isWithinTimeRange && isCorrectDay
            const isOutsideSchedule = !shouldBeActive
            
            console.log(`🕐 Time checker for ${outletName}:`, {
              currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
              startTime: `${Math.floor(startTime / 60)}:${String(startTime % 60).padStart(2, '0')}`,
              endTime: `${Math.floor(endTime / 60)}:${String(endTime % 60).padStart(2, '0')}`,
              scheduleTimeRange: outlet.schedule.timeRange,
              frequency: frequency,
              currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
              isCorrectDay: isCorrectDay,
              isWithinTimeRange: isWithinTimeRange,
              shouldBeActive: shouldBeActive,
              isOutsideSchedule: isOutsideSchedule
            })
            
            if (isOutsideSchedule) {
              return {
                cause: 'schedule',
                title: 'Device Auto-Turned Off (Schedule)',
                message: `${outletName} was automatically turned off because it's outside its scheduled time (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
                details: {
                  scheduleTimeRange: outlet.schedule.timeRange,
                  frequency: frequency,
                  currentTime: now.toLocaleTimeString(),
                  isOutsideSchedule: true,
                  timeDetails: {
                    current: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
                    start: `${Math.floor(startTime / 60)}:${String(startTime % 60).padStart(2, '0')}`,
                    end: `${Math.floor(endTime / 60)}:${String(endTime % 60).padStart(2, '0')}`
                  }
                }
              }
            }
          }
          
          // Default cause
          return {
            cause: 'manual',
            title: 'Device Turned Off',
            message: `${outletName} has been turned off.`,
            details: {}
          }
        }

        // Device state change notifications - detect state changes and determine reason
        const previousState = previousDeviceStates[outletKey]
        
        // Always check for notifications on every update, not just state changes
        console.log(`🔍 Checking ${outletName}: previous=${previousState}, current=${controlState}`)
        
        // Device turned OFF notification
        if (previousState === 'on' && controlState === 'off') {
          console.log(`🔌 Device turned off: ${outletName} (was on, now off)`)
          
          // Use enhanced time checker to determine cause
          const turnOffAnalysis = checkTurnOffCause(outlet, outletName)
          
          console.log(`🔍 Turn-off analysis for ${outletName}:`, turnOffAnalysis)
          
          newNotifications.push({
            id: `off_${outletKey}_${Date.now()}`,
            type: 'device_off',
            title: turnOffAnalysis.title,
            message: turnOffAnalysis.message,
            outletName,
            timestamp: new Date(),
            isRead: false
          })
        }
        
        // Proactive notification for devices that are off but should be on due to schedule
        // This helps catch cases where the scheduler turns devices on
        if (outlet.schedule && outlet.schedule.timeRange && outlet.schedule.timeRange !== 'No schedule') {
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          
          // Parse schedule time
          const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
          const convertTo24Hour = (time12: string) => {
            const [time, period] = time12.split(' ')
            const [hours, minutes] = time.split(':').map(Number)
            return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                   period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
          }
          
          const startTime = convertTo24Hour(startTimeStr)
          const endTime = convertTo24Hour(endTimeStr)
          const isWithinSchedule = currentTime >= startTime && currentTime <= endTime
          
          // If device is off but should be on according to schedule, and it was previously off
          if (controlState === 'off' && isWithinSchedule && previousState === 'off') {
            console.log(`🔌 Proactive schedule turn-on detection: ${outletName} should be on according to schedule`)
            
            newNotifications.push({
              id: `schedule_on_${outletKey}_${Date.now()}`,
              type: 'device_on',
              title: 'Device Should Be On (Schedule)',
              message: `${outletName} should be turned on according to its schedule (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
              outletName,
              timestamp: new Date(),
              isRead: false
            })
          }
        }
        
        // Device turned ON notification (for schedule-based turn-ons)
        else if (previousState === 'off' && controlState === 'on') {
          console.log(`🔌 Device turned on: ${outletName} (was off, now on)`)
          
          // Check if it's due to schedule
          if (outlet.schedule && outlet.schedule.timeRange && outlet.schedule.timeRange !== 'No schedule') {
            const now = new Date()
            const currentTime = now.getHours() * 60 + now.getMinutes()
            
            // Parse schedule time
            const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
            const convertTo24Hour = (time12: string) => {
              const [time, period] = time12.split(' ')
              const [hours, minutes] = time.split(':').map(Number)
              return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                     period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
            }
            
            const startTime = convertTo24Hour(startTimeStr)
            const endTime = convertTo24Hour(endTimeStr)
            
            // Check if device is within scheduled time
            if (currentTime >= startTime && currentTime <= endTime) {
              console.log(`🔌 Auto turn-on due to schedule: ${outletName}`)
              
              newNotifications.push({
                id: `on_${outletKey}_${Date.now()}`,
                type: 'device_on',
                title: 'Device Auto-Turned On (Schedule)',
                message: `${outletName} was automatically turned on because it's within its scheduled time (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
                outletName,
                timestamp: new Date(),
                isRead: false
              })
            }
          }
        }
        
        // Additional check: Create notifications for devices that are currently off and have schedules
        // Only do this on first load or when there's a state change to prevent duplicates
        if ((isFirstLoad || previousState !== controlState) && controlState === 'off' && outlet.schedule && outlet.schedule.timeRange && outlet.schedule.timeRange !== 'No schedule') {
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          
          // Parse schedule time
          const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
          const convertTo24Hour = (time12: string) => {
            const [time, period] = time12.split(' ')
            const [hours, minutes] = time.split(':').map(Number)
            return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                   period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
          }
          
          const startTime = convertTo24Hour(startTimeStr)
          const endTime = convertTo24Hour(endTimeStr)
          
          // Check if device is outside scheduled time
          const isOutsideSchedule = currentTime < startTime || currentTime > endTime
          
          if (isOutsideSchedule) {
            console.log(`🔔 Creating notification for ${outletName} (currently off, outside schedule)`)
            newNotifications.push({
              id: `current_off_${outletKey}_${Date.now()}`,
              type: 'device_off',
              title: 'Device Turned Off (Time Limit)',
              message: `${outletName} was turned off because it's outside its scheduled time (${outlet.schedule.timeRange}). Current time: ${now.toLocaleTimeString()}`,
              outletName,
              timestamp: new Date(),
              isRead: false,
              navigateTo: 'schedule',
              deviceId: outletKey
            })
          }
        }
      })

      // Update notifications - add new ones and remove resolved ones
      setNotifications(prev => {
        console.log(`📊 Processing notifications: ${newNotifications.length} new, ${prev.length} existing`)
        
        // Get current notification IDs that should exist based on current state
        const currentNotificationIds = new Set(newNotifications.map(n => n.id))
        
        // Remove notifications that are no longer relevant
        const filteredPrev = prev.filter(notification => {
          // Keep notifications that are still relevant
          if (currentNotificationIds.has(notification.id)) {
            console.log(`✅ Keeping active notification: ${notification.title} for ${notification.outletName}`)
            return true
          }
          
          // Remove device_off notifications older than 5 minutes (shorter for better responsiveness)
          if (notification.type === 'device_off') {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
            const shouldKeep = notification.timestamp > fiveMinutesAgo
            if (!shouldKeep) {
              console.log(`🗑️ Removing old device_off notification: ${notification.outletName}`)
            }
            return shouldKeep
          }
          
          // Remove power_limit and schedule_conflict notifications that are no longer active
          console.log(`🗑️ Removing resolved notification: ${notification.title} for ${notification.outletName}`)
          return false
        })
        
        // Add new notifications (avoid duplicates with better logic)
        const existingIds = new Set(filteredPrev.map(n => n.id))
        const existingTitles = new Set(filteredPrev.map(n => `${n.outletName}_${n.title}`))
        
        const uniqueNewNotifications = newNotifications.filter(n => {
          // Check for exact ID duplicates
          if (existingIds.has(n.id)) {
            console.log(`⚠️ Duplicate ID prevented: ${n.title} for ${n.outletName}`)
            return false
          }
          
          // Check for content duplicates (same outlet + title)
          const contentKey = `${n.outletName}_${n.title}`
          if (existingTitles.has(contentKey)) {
            console.log(`⚠️ Duplicate content prevented: ${n.title} for ${n.outletName}`)
            return false
          }
          
          // Check for recent similar notifications (within last 2 minutes)
          const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)
          const hasRecentSimilar = filteredPrev.some(existing => 
            existing.outletName === n.outletName && 
            existing.title === n.title && 
            existing.timestamp > twoMinutesAgo
          )
          
          if (hasRecentSimilar) {
            console.log(`⚠️ Recent similar notification prevented: ${n.title} for ${n.outletName}`)
            return false
          }
          
          console.log(`➕ Adding new notification: ${n.title} for ${n.outletName}`)
          return true
        })
        
        const finalNotifications = [...uniqueNewNotifications, ...filteredPrev].slice(0, 50)
        console.log(`📋 Final notification count: ${finalNotifications.length} (${uniqueNewNotifications.length} new, ${filteredPrev.length} kept)`)
        
        // Force a re-render by logging the change
        if (finalNotifications.length !== prev.length) {
          console.log(`🔄 Notification count changed: ${prev.length} → ${finalNotifications.length}`)
        }
        
        return finalNotifications
      })

      // Update previous device states for next comparison
      const newPreviousStates: Record<string, string> = {}
      Object.keys(data).forEach((outletKey) => {
        const outlet = data[outletKey]
        const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
        newPreviousStates[outletKey] = controlState
      })
      setPreviousDeviceStates(newPreviousStates)
    })

    // Add manual test functions for debugging
    ;(window as any).testNotification = () => {
      console.log('🧪 Testing notification system...')
      setNotifications(prev => [...prev, {
        id: `test_${Date.now()}`,
        type: 'device_off',
        title: 'Test Notification',
        message: 'This is a test notification to verify the system is working.',
        outletName: 'Test Device',
        timestamp: new Date(),
        isRead: false
      }])
    }
    
    ;(window as any).testScheduleNotification = () => {
      console.log('🧪 Testing schedule notification...')
      setNotifications(prev => [...prev, {
        id: `test_schedule_${Date.now()}`,
        type: 'device_off',
        title: 'Device Auto-Turned Off (Schedule)',
        message: 'Outlet_1 was automatically turned off because it\'s outside its scheduled time (8:35 AM - 8:36 AM). Current time: 8:37 AM',
        outletName: 'Outlet 1',
        timestamp: new Date(),
        isRead: false,
        navigateTo: 'schedule',
        deviceId: 'test_device'
      }])
    }
    
    ;(window as any).testPowerNotification = () => {
      console.log('🧪 Testing power limit notification...')
      setNotifications(prev => [...prev, {
        id: `test_power_${Date.now()}`,
        type: 'device_off',
        title: 'Device Auto-Turned Off (Power Limit)',
        message: 'Outlet_1 was automatically turned off because today\'s energy consumption (2.500kW) exceeded the power limit (2.000kW)',
        outletName: 'Outlet 1',
        timestamp: new Date(),
        isRead: false,
        navigateTo: 'setup',
        deviceId: 'test_device'
      }])
    }
    
    ;(window as any).clearNotifications = () => {
      console.log('🗑️ Clearing all notifications...')
      setNotifications([])
    }
    
    ;(window as any).removeDuplicates = () => {
      console.log('🧹 Removing duplicate notifications...')
      setNotifications(prev => {
        const unique: typeof prev = []
        const seen = new Set()
        
        prev.forEach(notification => {
          const key = `${notification.outletName}_${notification.title}`
          if (!seen.has(key)) {
            seen.add(key)
            unique.push(notification)
          } else {
            console.log(`🗑️ Removing duplicate: ${notification.title} for ${notification.outletName}`)
          }
        })
        
        console.log(`📊 Removed ${prev.length - unique.length} duplicates, kept ${unique.length} unique notifications`)
        return unique
      })
    }
    
    ;(window as any).addTestNotification = () => {
      console.log('🧪 Adding test notification...')
      const testNotification = {
        id: `test_${Date.now()}`,
        type: 'device_off' as const,
        title: 'Test Notification',
        message: 'This is a test notification to verify the system is working',
        outletName: 'Test Outlet',
        timestamp: new Date(),
        isRead: false,
        navigateTo: 'setup' as const,
        deviceId: 'test_device'
      }
      
      setNotifications(prev => {
        console.log('📝 Adding notification:', testNotification)
        console.log('📝 Previous notifications:', prev.length)
        const updated = [...prev, testNotification]
        console.log('📝 Updated notifications:', updated.length)
        return updated
      })
    }
    
    ;(window as any).debugDeviceStates = () => {
      console.log('🔍 Current device states:', previousDeviceStates)
      console.log('🔍 Current notifications:', notifications)
    }
    
    ;(window as any).forceNotificationCheck = () => {
      console.log('🔄 Forcing notification check...')
      checkAndResolveNotifications()
    }
    
    ;(window as any).forceResolveCheck = () => {
      console.log('🔄 Forcing immediate notification resolution check...')
      checkAndResolveNotifications()
    }
    
    ;(window as any).forceRealtimeCheck = async () => {
      console.log('🔄 Forcing real-time check...')
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('📊 Current Firebase data:', data)
          
          // Force notification creation for any device that's off
          Object.keys(data).forEach((outletKey) => {
            const outlet = data[outletKey]
            const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
            const outletName = outletKey.replace('_', ' ')
            
            if (controlState === 'off' && outlet.schedule) {
              console.log(`🔔 Creating notification for ${outletName} (off with schedule)`)
              setNotifications(prev => [...prev, {
                id: `force_${outletKey}_${Date.now()}`,
                type: 'device_off',
                title: 'Device Turned Off (Schedule)',
                message: `${outletName} was turned off because it's outside its scheduled time.`,
                outletName,
                timestamp: new Date(),
                isRead: false,
                navigateTo: 'schedule',
                deviceId: outletKey
              }])
            }
          })
        }
      } catch (error) {
        console.error('❌ Error in force real-time check:', error)
      }
    }
    
    ;(window as any).testDeviceStateChange = () => {
      console.log('🧪 Testing device state change detection...')
      checkAndResolveNotifications()
    }
    
    ;(window as any).monitorNotifications = () => {
      console.log('👀 Starting notification monitoring...')
      setInterval(() => {
        console.log(`📊 Current notifications: ${notifications.length}`)
        notifications.forEach(n => {
          console.log(`  - ${n.title} for ${n.outletName} (${n.timestamp.toLocaleTimeString()})`)
        })
      }, 5000)
    }
    
    ;(window as any).checkAllDevices = async () => {
      console.log('🔍 Checking all devices in Firebase...')
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('📊 All devices in Firebase:', data)
          
          Object.keys(data).forEach((outletKey) => {
            const outlet = data[outletKey]
            const outletName = outletKey.replace('_', ' ')
            const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
            
            console.log(`\n🔍 Device: ${outletName}`)
            console.log(`  - State: ${controlState}`)
            console.log(`  - Schedule: ${outlet.schedule?.timeRange || 'None'}`)
            console.log(`  - Power Limit: ${outlet.relay_control?.auto_cutoff?.power_limit || 'None'}kW`)
            
            if (outlet.daily_logs) {
              const today = new Date()
              const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
              const todayLogs = outlet.daily_logs[todayDateKey]
              console.log(`  - Today's Energy: ${todayLogs?.total_energy || 0}kW`)
            }
          })
        } else {
          console.log('❌ No devices found in Firebase')
        }
      } catch (error) {
        console.error('❌ Error checking devices:', error)
      }
    }
    
    ;(window as any).forceNotification = () => {
      console.log('🔔 Forcing immediate notification...')
      setNotifications(prev => [...prev, {
        id: `force_${Date.now()}`,
        type: 'device_off',
        title: 'Immediate Test Notification',
        message: 'This notification was triggered immediately to test real-time functionality.',
        outletName: 'Test Device',
        timestamp: new Date(),
        isRead: false
      }])
    }
    
    ;(window as any).testTimeChecker = (outletKey = 'Outlet_1') => {
      console.log('🕐 Testing time checker for:', outletKey)
      
      // Get current device data
      const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
      get(deviceRef).then((snapshot) => {
        if (snapshot.exists()) {
          const outlet = snapshot.val()
          const outletName = outletKey.replace('_', ' ')
          
          // Get today's energy
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = outlet.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0
          const powerLimit = outlet.relay_control?.auto_cutoff?.power_limit || 0
          
          console.log('📊 Device data:', {
            outletName,
            controlState: outlet.control?.device,
            mainStatus: outlet.relay_control?.main_status,
            powerLimit: `${powerLimit}kW`,
            todayEnergy: `${todayTotalEnergy}kW`,
            schedule: outlet.schedule
          })
          
          // Test the time checker logic
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay()
          
          console.log('🕐 Current time analysis:', {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
            timestamp: now.toLocaleString()
          })
          
          if (outlet.schedule && outlet.schedule.timeRange) {
            const [startTimeStr, endTimeStr] = outlet.schedule.timeRange.split(' - ')
            const convertTo24Hour = (time12: string) => {
              const [time, period] = time12.split(' ')
              const [hours, minutes] = time.split(':').map(Number)
              return period === 'PM' && hours !== 12 ? (hours + 12) * 60 + minutes : 
                     period === 'AM' && hours === 12 ? minutes : hours * 60 + minutes
            }
            
            const startTime = convertTo24Hour(startTimeStr)
            const endTime = convertTo24Hour(endTimeStr)
            const isWithinTimeRange = currentTime >= startTime && currentTime <= endTime
            
            console.log('📅 Schedule analysis:', {
              scheduleTimeRange: outlet.schedule.timeRange,
              startTime: `${Math.floor(startTime / 60)}:${String(startTime % 60).padStart(2, '0')}`,
              endTime: `${Math.floor(endTime / 60)}:${String(endTime % 60).padStart(2, '0')}`,
              isWithinTimeRange: isWithinTimeRange,
              frequency: outlet.schedule.frequency
            })
          }
        } else {
          console.log('❌ Device not found:', outletKey)
        }
      }).catch(error => {
        console.error('❌ Error testing time checker:', error)
      })
    }

    // Auto-resolve notifications when issues are fixed
    checkAndResolveNotifications()

    return () => {
      off(devicesRef, 'value', unsubscribe)
      clearInterval(notificationCheckInterval)
    }
  }, [isAuthed])

  // Global monthly limit monitoring - runs independently of page navigation
  useEffect(() => {
    if (!isAuthed) return

    console.log('🌙 Setting up global monthly limit monitoring...')
    
    const checkMonthlyLimits = async () => {
      try {
        // Get combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (combinedLimitSnapshot.exists()) {
          const combinedLimitData = combinedLimitSnapshot.val()
          const combinedLimitInfo = {
            enabled: combinedLimitData.enabled || false,
            selectedOutlets: combinedLimitData.selectedOutlets || [],
            combinedLimit: combinedLimitData.combinedLimit || 0
          }
          
          if (combinedLimitInfo.enabled && combinedLimitInfo.selectedOutlets.length > 0) {
            // Get devices data
            const devicesRef = ref(realtimeDb, 'devices')
            const devicesSnapshot = await get(devicesRef)
            
            if (devicesSnapshot.exists()) {
              const devicesData = devicesSnapshot.val()
              console.log('🌙 Global monthly limit check (scheduled)')
              await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
            }
          }
        }
      } catch (error) {
        console.error('Error in global monthly limit check:', error)
      }
    }
    
    // Run immediately
    checkMonthlyLimits()
    
    // Set up interval to check every 5 minutes
    const monthlyLimitInterval = setInterval(checkMonthlyLimits, 300000) // 5 minutes
    
    // Add manual test function
    ;(window as any).testGlobalMonthlyLimits = checkMonthlyLimits
    
    console.log('🌙 Global monthly limit monitoring active')
    console.log('🌙 Manual test: window.testGlobalMonthlyLimits()')
    
    return () => {
      clearInterval(monthlyLimitInterval)
    }
  }, [isAuthed])

  if (!isAuthed) {
    if (authView === 'login') {
      return (
        <LogIn 
          onSuccess={(name, role) => { setUserName(name); setUserRole(role); setIsAuthed(true) }}
          onNavigateToSignUp={() => setAuthView('signup')}
        />
      )
    } else {
      return (
        <SignUp 
          onSuccess={(name, role) => { setUserName(name); setUserRole(role); setIsAuthed(true) }}
          onNavigateToLogin={() => setAuthView('login')}
        />
      )
    }
  }

  return (
    <div style={{display:'flex', minHeight:'100dvh'}}>
      <SideBar 
        onLogout={async () => { 
          try {
            console.log('Starting logout process...')
            console.log('Current auth state:', auth.currentUser)
            console.log('Current local auth state:', { isAuthed, userName, userRole })
            
            // Check if user is actually authenticated
            if (!auth.currentUser) {
              console.log('No authenticated user found, performing local logout only')
              setIsAuthed(false)
              setAuthView('login')
              setUserName('User')
              setUserRole('faculty')
              setActiveView('dashboard')
              return
            }
            
            // Sign out from Firebase
            console.log('Signing out from Firebase...')
            await signOut(auth)
            console.log('Firebase signOut completed successfully')
            
            // Verify logout
            console.log('Verifying logout - current user:', auth.currentUser)
            
            // Clear local state
            setIsAuthed(false)
            setAuthView('login')
            setUserName('User')
            setUserRole('faculty')
            setActiveView('dashboard')
            
            console.log('Logout completed successfully')
          } catch (error: any) {
            console.error('Logout error:', error)
            console.error('Error details:', {
              code: error?.code,
              message: error?.message,
              stack: error?.stack
            })
            
            // Still logout locally even if Firebase logout fails
            console.log('Performing local logout despite Firebase error')
            setIsAuthed(false)
            setAuthView('login')
            setUserName('User')
            setUserRole('faculty')
            setActiveView('dashboard')
          }
        }} 
        onNavigate={(k) => setActiveView(k)}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        activeView={activeView === 'userLogs' ? 'users' : activeView}
        userRole={userRole}
      />
      <main style={{
        flex:1, 
        padding:16, 
        position:'relative', 
        paddingTop:80, 
        marginLeft: isMobile ? 0 : '260px',
        transition: 'margin-left 0.3s ease'
      }}>
        {/* Mobile menu toggle button */}
        {isMobile && (
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            style={{
              position: 'absolute',
              top: 24,
              left: 24,
              zIndex: 1001,
              background: '#052f66',
              border: 'none',
              borderRadius: '8px',
              padding: '8px',
              color: 'white',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            aria-label="Toggle menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 12h18M3 6h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        )}
        
        <div style={{
          position:'absolute', 
          top:24, 
          right: isMobile ? 16 : 24, 
          display:'flex', 
          alignItems:'center', 
          gap: isMobile ? 12 : 16,
          marginLeft: isMobile ? 60 : 0,
          zIndex: 1000,
          flexWrap: 'nowrap'
        }}>
          {/* Notification Button */}
          <button
            style={{
              display: 'inline-grid',
              placeItems: 'center',
              width: isMobile ? 32 : 36,
              height: isMobile ? 32 : 36,
              background: '#0b3e86',
              color: '#ffffff',
              border: 'none',
              borderRadius: '50%',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              position: 'relative',
              flexShrink: 0
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#052f66'
              e.currentTarget.style.color = '#ffffff'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#0b3e86'
              e.currentTarget.style.color = '#ffffff'
            }}
            onClick={() => {
              setShowNotificationModal(true)
            }}
            onDoubleClick={() => {
              // Double-click to add test notification
              console.log('🧪 Adding manual test notification')
              setNotifications(prev => {
                const newNotification = {
                  id: `manual_test_${Date.now()}`,
                  type: 'device_off' as const,
                  title: 'Manual Test',
                  message: 'This is a manually triggered test notification.',
                  outletName: 'Test Device',
                  timestamp: new Date(),
                  isRead: false
                }
                console.log('🧪 Adding notification:', newNotification)
                console.log('🧪 Previous notifications count:', prev.length)
                const newNotifications = [...prev, newNotification]
                console.log('🧪 New notifications count:', newNotifications.length)
                return newNotifications
              })
            }}
            aria-label="Notifications"
            title="Notifications"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'translateX(-8px)' }}>
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {/* Notification Badge */}
            {notifications.filter(n => !n.isRead).length > 0 && (
              <span style={{
                position: 'absolute',
                top: '2px',
                right: '2px',
                width: '8px',
                height: '8px',
                background: '#ef4444',
                borderRadius: '50%',
                border: '2px solid white'
              }}></span>
            )}
          </button>
          
          {/* Admin Profile Icon */}
          <span style={{
            display:'inline-grid', 
            placeItems:'center', 
            width: isMobile ? 32 : 36, 
            height: isMobile ? 32 : 36, 
            background:'#0b3e86', 
            color:'#fff', 
            borderRadius:'50%',
            flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8"/>
              <path d="M4.5 20c1.8-3.5 5-5.3 7.5-5.3S17.7 16.5 19.5 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </span>
          <div style={{lineHeight:1}}>
            <div style={{fontWeight:800, color:'#0b3e86', fontSize:18}}>{userName || 'User'}</div>
            <div style={{fontSize:13, color:'#4b5563'}}>{today}</div>
          </div>
        </div>
        {activeView === 'dashboard' && <Dashboard onNavigate={(key) => setActiveView(key as any)} />}
        {activeView === 'setup' && <SetUp />}
        {activeView === 'schedule' && <Schedule />}
        {activeView === 'activeDevice' && <ActiveDevice />}
        {activeView === 'reports' && <Reports />}
        {(activeView === 'users' || activeView === 'userLogs' || activeView === 'deviceLogs') && <UserManagment onNavigate={(k) => setActiveView(k as any)} currentView={activeView} />}
        {/* Logs view removed */}
      </main>

      {/* Notification Modal */}
      {showNotificationModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-end',
            zIndex: 2000,
            padding: '80px 24px 24px 24px'
          }}
          onClick={() => setShowNotificationModal(false)}
        >
          <div 
            style={{
              background: 'white',
              borderRadius: '12px',
              boxShadow: '0 20px 25px rgba(0, 0, 0, 0.1)',
              width: '400px',
              maxHeight: '600px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{
              padding: '20px 24px 16px 24px',
              borderBottom: '1px solid #e5e7eb',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <h3 style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: '600',
                  color: '#1f2937'
                }}>
                  Notifications
                </h3>
                {/* Real-time Status Indicator */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  color: isRealtimeConnected ? '#10b981' : '#ef4444'
                }}>
                  <div style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: isRealtimeConnected ? '#10b981' : '#ef4444',
                    animation: isRealtimeConnected ? 'pulse 2s infinite' : 'none'
                  }}></div>
                  {isRealtimeConnected ? 'Live' : 'Disconnected'}
                </div>
              </div>
              <button
                onClick={() => setShowNotificationModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '20px',
                  cursor: 'pointer',
                  color: '#6b7280',
                  padding: '4px'
                }}
              >
                ×
              </button>
            </div>

            {/* Notifications List */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              maxHeight: '500px'
            }}>
              {notifications.length === 0 ? (
                <div style={{
                  padding: '40px 24px',
                  textAlign: 'center',
                  color: '#6b7280'
                }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ margin: '0 auto 16px auto', opacity: 0.5 }}>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <p style={{ margin: 0, fontSize: '14px' }}>No notifications yet</p>
                </div>
              ) : (
                notifications.map((notification) => (
                  <div
                    key={notification.id}
                    style={{
                      padding: '16px 24px',
                      borderBottom: '1px solid #f3f4f6',
                      cursor: notification.navigateTo ? 'pointer' : 'default',
                      backgroundColor: notification.isRead ? 'white' : '#f8fafc',
                      transition: 'background-color 0.2s ease',
                      opacity: notification.navigateTo ? 1 : 0.7
                    }}
                    onClick={() => {
                      if (notification.navigateTo) {
                        handleNotificationClick(notification)
                      }
                    }}
                    onMouseEnter={(e) => {
                      if (notification.navigateTo) {
                        e.currentTarget.style.backgroundColor = notification.isRead ? '#f3f4f6' : '#e5e7eb'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (notification.navigateTo) {
                        e.currentTarget.style.backgroundColor = notification.isRead ? 'white' : '#f8fafc'
                      }
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px'
                    }}>
                      {/* Notification Icon */}
                      <div style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        backgroundColor: notification.type === 'power_limit' ? '#fef2f2' : 
                                       notification.type === 'schedule_conflict' ? '#fef3c7' : 
                                       notification.type === 'device_on' ? '#f0fdf4' : '#f3f4f6'
                      }}>
                        {notification.type === 'power_limit' ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        ) : notification.type === 'schedule_conflict' ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="3" y="4" width="18" height="17" rx="2" stroke="#f59e0b" strokeWidth="2"/>
                            <path d="M8 2v4M16 2v4M3 9h18" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
                          </svg>
                        ) : notification.type === 'device_on' ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="10" stroke="#10b981" strokeWidth="2"/>
                            <path d="M9 12l2 2 4-4" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="10" stroke="#6b7280" strokeWidth="2"/>
                            <path d="M8 12h8" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                          </svg>
                        )}
                      </div>

                      {/* Notification Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          marginBottom: '4px'
                        }}>
                          <h4 style={{
                            margin: 0,
                            fontSize: '14px',
                            fontWeight: '600',
                            color: '#1f2937'
                          }}>
                            {notification.title}
                          </h4>
                          {!notification.isRead && (
                            <div style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              backgroundColor: '#3b82f6'
                            }}></div>
                          )}
                        </div>
                        <p style={{
                          margin: '0 0 8px 0',
                          fontSize: '13px',
                          color: '#6b7280',
                          lineHeight: '1.4'
                        }}>
                          {notification.message}
                        </p>
                        <div style={{
                          fontSize: '12px',
                          color: '#9ca3af',
                          marginTop: '8px'
                        }}>
                          {notification.timestamp.toLocaleTimeString()} • {notification.outletName}
                        </div>
                        
                        {notification.navigateTo && (
                          <div style={{
                            marginTop: '12px',
                            display: 'flex',
                            justifyContent: 'flex-end'
                          }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                console.log('🔔 Resolve button clicked for:', notification.title)
                                handleNotificationClick(notification)
                              }}
                              style={{
                                background: '#3b82f6',
                                color: 'white',
                                border: 'none',
                                borderRadius: '8px',
                                padding: '8px 16px',
                                fontSize: '12px',
                                fontWeight: '600',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                transition: 'all 0.2s ease',
                                boxShadow: '0 2px 4px rgba(59, 130, 246, 0.3)'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = '#2563eb'
                                e.currentTarget.style.transform = 'translateY(-2px)'
                                e.currentTarget.style.boxShadow = '0 4px 8px rgba(59, 130, 246, 0.4)'
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = '#3b82f6'
                                e.currentTarget.style.transform = 'translateY(0)'
                                e.currentTarget.style.boxShadow = '0 2px 4px rgba(59, 130, 246, 0.3)'
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                              <span>Check & Resolve</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Modal Footer */}
            {notifications.length > 0 && (
              <div style={{
                padding: '16px 24px',
                borderTop: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <button
                  onClick={() => {
                    setNotifications(prev => {
                      // Remove all device_off and device_on notifications and mark others as read
                      const filtered = prev.filter(n => n.type !== 'device_off' && n.type !== 'device_on')
                      return filtered.map(n => ({ ...n, isRead: true }))
                    })
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#3b82f6',
                    fontSize: '14px',
                    cursor: 'pointer',
                    fontWeight: '500'
                  }}
                >
                  Mark all as read
                </button>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <span style={{
                    fontSize: '12px',
                    color: '#9ca3af'
                  }}>
                    {notifications.filter(n => !n.isRead).length} unread
                  </span>
                  {lastUpdateTime && (
                    <span style={{
                      fontSize: '10px',
                      color: '#9ca3af',
                      marginTop: '2px'
                    }}>
                      Last update: {lastUpdateTime.toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
