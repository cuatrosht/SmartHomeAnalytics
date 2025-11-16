import { useState, useRef, useEffect } from 'react'
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword } from 'firebase/auth'
import { ref, get, update, onValue } from 'firebase/database'
import { auth, realtimeDb } from '../firebase/config'
import { logAuthEvent, logUserActionToUserLogs } from '../utils/userLogging'
import './LogIn.css'

// Helper function to get department-specific combined limit path
const getDepartmentCombinedLimitPath = (department: string) => {
  if (!department) return 'combined_limit_settings'
  return `combined_limit_settings/${department}`
}

// Function to calculate total monthly energy for combined limit group
const calculateCombinedMonthlyEnergy = (devicesData: any, selectedOutlets: string[]): number => {
  try {
    // Get current month and year
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1 // getMonth() returns 0-11, so add 1
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    
    console.log('📊 Monthly energy calculation:', {
      currentYear,
      currentMonth,
      daysInMonth,
      selectedOutlets: [...new Set(selectedOutlets)], // Remove duplicates
      totalOutlets: selectedOutlets.length,
      uniqueOutlets: [...new Set(selectedOutlets)].length
    })
    
    // Process each outlet in the combined limit group
    const processedOutlets = new Set()
    let totalMonthlyEnergy = 0
    
    selectedOutlets.forEach((outletKey, index) => {
      // Skip if already processed (avoid duplicates)
      if (processedOutlets.has(outletKey)) {
        console.log(`⚠️ DUPLICATE SKIPPED: ${outletKey} (already processed)`)
        return
      }
      
      // Mark as processed
      processedOutlets.add(outletKey)
      
      // Convert display format to Firebase format - replace ALL spaces/special chars
      const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
      const outlet = devicesData[firebaseKey]
      
      console.log(`🔍 Processing outlet ${index + 1}/${selectedOutlets.length}: ${outletKey} -> ${firebaseKey}`)
      
      if (outlet && outlet.daily_logs) {
        let outletMonthlyEnergy = 0
        
        // Sum up all daily energy for the current month
        for (let day = 1; day <= daysInMonth; day++) {
          const dayKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
          const dayData = outlet.daily_logs[dayKey]
          
          if (dayData && dayData.total_energy) {
            outletMonthlyEnergy += dayData.total_energy // This is in kW
          }
        }
        
        console.log(`📊 ${outletKey}: ${outletMonthlyEnergy.toFixed(3)}kW for month ${currentMonth}/${currentYear}`)
        totalMonthlyEnergy += outletMonthlyEnergy
      } else {
        console.log(`⚠️ ${outletKey}: No data found or no daily_logs`)
      }
    })
    
    console.log(`📊 TOTAL MONTHLY ENERGY: ${totalMonthlyEnergy.toFixed(3)}kW (${(totalMonthlyEnergy * 1000).toFixed(3)}W)`)
    return totalMonthlyEnergy * 1000 // Convert to watts for consistency
  } catch (error) {
    console.error('❌ Error calculating combined monthly energy:', error)
    return 0
  }
}

// Function to remove a device from combined group when monthly limit is exceeded
const removeDeviceFromCombinedGroup = async (outletKey: string): Promise<{
  success: boolean;
  reason?: string;
}> => {
  try {
    console.log(`🔧 Attempting to remove ${outletKey} from combined group due to monthly limit exceeded`)
    
    // Get current combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const combinedLimitSnapshot = await get(combinedLimitRef)
    
    if (!combinedLimitSnapshot.exists()) {
      return { success: false, reason: 'No combined limit settings found' }
    }
    
    const combinedLimitData = combinedLimitSnapshot.val()
    const currentSelectedOutlets = combinedLimitData.selected_outlets || []
    
    // Check if device is actually in the combined group
    if (!currentSelectedOutlets.includes(outletKey)) {
      return { success: false, reason: 'Device is not in combined group' }
    }
    
    // Remove the device from the combined group
    const updatedSelectedOutlets = currentSelectedOutlets.filter((outlet: string) => outlet !== outletKey)
    
    // Update the combined limit settings
    await update(combinedLimitRef, {
      ...combinedLimitData,
      selected_outlets: updatedSelectedOutlets
    })
    
    console.log(`✅ Successfully removed ${outletKey} from combined group. Remaining outlets: ${updatedSelectedOutlets.length}`)
    
    return { success: true, reason: `Device removed from combined group. Remaining outlets: ${updatedSelectedOutlets.length}` }
  } catch (error) {
    console.error('❌ Error removing device from combined group:', error)
    return { success: false, reason: 'Failed to remove device from combined group' }
  }
}

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
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    device_control?: string;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0,
    device_control: 'on'
  })
  // Track all department combined limits
  const [allDepartmentCombinedLimits, setAllDepartmentCombinedLimits] = useState<Record<string, {
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    device_control?: string;
    department?: string;
  }>>({})
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

  // Function to check if device should be active based on schedule
  const isDeviceActiveBySchedule = (schedule: any, controlState: string, deviceData?: any, skipIndividualLimitCheck?: boolean): boolean => {
    // If no schedule exists, use control state
    if (!schedule || (!schedule.timeRange && !schedule.startTime)) {
      return controlState === 'on'
    }

    // If control is off, device is inactive regardless of schedule
    if (controlState !== 'on') {
      return false
    }

    const now = new Date()
    const currentTime = now.getHours() * 60 + now.getMinutes() // Convert to minutes
    const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.

    // Parse schedule time range
    let startTime: number, endTime: number
    
    if (schedule.startTime && schedule.endTime && 
        typeof schedule.startTime === 'string' && typeof schedule.endTime === 'string') {
      try {
        // Use startTime and endTime from database (24-hour format)
        const [startHours, startMinutes] = schedule.startTime.split(':').map(Number)
        const [endHours, endMinutes] = schedule.endTime.split(':').map(Number)
        
        // Validate parsed values
        if (isNaN(startHours) || isNaN(startMinutes) || isNaN(endHours) || isNaN(endMinutes)) {
          return controlState === 'on'
        }
        
        startTime = startHours * 60 + startMinutes
        endTime = endHours * 60 + endMinutes
      } catch (error) {
        // If parsing fails, return current control state
        return controlState === 'on'
      }
    } else if (schedule.timeRange && typeof schedule.timeRange === 'string') {
      try {
        // Parse timeRange format (e.g., "8:36 PM - 8:40 PM")
        const timeRange = schedule.timeRange
        if (!timeRange.includes(' - ')) {
          return controlState === 'on'
        }
        
        const [startTimeStr, endTimeStr] = timeRange.split(' - ')
        
        // Validate split results
        if (!startTimeStr || !endTimeStr) {
          return controlState === 'on'
        }
        
        // Convert 12-hour format to 24-hour format
        const convertTo24Hour = (time12h: string): number => {
          if (!time12h || typeof time12h !== 'string') {
            throw new Error('Invalid time format')
          }
          
          const parts = time12h.split(' ')
          if (parts.length < 2) {
            throw new Error('Invalid time format - missing AM/PM')
          }
          
          const [time, modifier] = parts
          if (!time || !modifier) {
            throw new Error('Invalid time format')
          }
          
          const timeParts = time.split(':')
          if (timeParts.length < 2) {
            throw new Error('Invalid time format - missing minutes')
          }
          
          let [hours, minutes] = timeParts.map(Number)
          
          if (isNaN(hours) || isNaN(minutes)) {
            throw new Error('Invalid time format - non-numeric values')
          }
          
          if (hours === 12) {
            hours = 0
          }
          if (modifier === 'PM') {
            hours += 12
          }
          
          return hours * 60 + minutes
        }
        
        startTime = convertTo24Hour(startTimeStr)
        endTime = convertTo24Hour(endTimeStr)
      } catch (error) {
        // If parsing fails, return current control state
        return controlState === 'on'
      }
    } else {
      return controlState === 'on'
    }

    // Check if current time is within the scheduled time range
    // Turn off exactly at end time - device is active only when current time is less than end time
    const isWithinTimeRange = currentTime >= startTime && currentTime < endTime

    // Check if current day matches the schedule frequency
    const frequency = schedule.frequency || ''
    let isCorrectDay = false

    if (!frequency || typeof frequency !== 'string') {
      // If no frequency or invalid type, assume daily (always active)
      isCorrectDay = true
    } else if (frequency.toLowerCase() === 'daily') {
      isCorrectDay = true
    } else if (frequency.toLowerCase() === 'weekdays') {
      isCorrectDay = currentDay >= 1 && currentDay <= 5 // Monday to Friday
    } else if (frequency.toLowerCase() === 'weekends') {
      isCorrectDay = currentDay === 0 || currentDay === 6 // Sunday or Saturday
    } else if (frequency && typeof frequency === 'string' && frequency.includes(',')) {
      try {
        // Handle comma-separated days (e.g., "M,T,W,TH,F,SAT" or "MONDAY, WEDNESDAY, FRIDAY")
        const dayMap: { [key: string]: number } = {
          'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
          'friday': 5, 'saturday': 6, 'sunday': 0,
          'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 
          'fri': 5, 'sat': 6, 'sun': 0,
          'm': 1, 't': 2, 'w': 3, 'th': 4, 
          'f': 5, 's': 6
        }
        
        const scheduledDays = frequency.split(',').map((day: string) => {
          if (!day || typeof day !== 'string') return undefined
          const trimmedDay = day.trim().toLowerCase()
          return dayMap[trimmedDay]
        }).filter((day: number | undefined) => day !== undefined)
        
        isCorrectDay = scheduledDays.includes(currentDay)
      } catch (error) {
        // If frequency parsing fails, return current control state
        return controlState === 'on'
      }
    } else if (frequency && typeof frequency === 'string') {
      // Handle single day or other formats
      const dayMap: { [key: string]: number } = {
        'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
        'friday': 5, 'saturday': 6, 'sunday': 0,
        'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 
        'fri': 5, 'sat': 6, 'sun': 0,
        'm': 1, 't': 2, 'w': 3, 'th': 4, 
        'f': 5, 's': 6
      }
      
      const dayNumber = dayMap[frequency.toLowerCase()]
      if (dayNumber !== undefined) {
        isCorrectDay = dayNumber === currentDay
      }
    }

    // Check power limit validation if device data is provided and not skipping individual limit check
    if (deviceData && !skipIndividualLimitCheck) {
      const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0 // Power limit in kW
      
      // Get monthly total energy consumption from daily_logs
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
      let totalMonthlyEnergy = 0
      
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
        const dayData = deviceData.daily_logs?.[dateKey]
        if (dayData && dayData.total_energy) {
          totalMonthlyEnergy += dayData.total_energy
        }
      }
      
      // If device has a power limit and monthly energy exceeds it, don't activate
      if (powerLimit > 0 && totalMonthlyEnergy >= powerLimit) {
        console.log(`LogIn: Schedule check - Device monthly power limit exceeded:`, {
          totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(3)}W`,
          powerLimit: `${(powerLimit * 1000)}W`,
          currentMonth: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
          scheduleResult: false,
          reason: 'Monthly energy consumption exceeded power limit'
        })
        return false
      }
    }

    // Device is active if it's within time range and on correct day
    return isWithinTimeRange && isCorrectDay
  }

  // Real-time listener for combined limit info - listens to all departments
  useEffect(() => {
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    
    // Set up real-time listener for all departments
    const unsubscribe = onValue(combinedLimitRef, (snapshot) => {
      if (snapshot.exists()) {
        const allDepartmentsData = snapshot.val()
        console.log('LogIn: Real-time update - all departments combined limit data:', allDepartmentsData)
        
        // Store all department combined limits
        const departmentLimitsMap: Record<string, {
          enabled: boolean;
          selectedOutlets: string[];
          combinedLimit: number;
          device_control?: string;
          department?: string;
        }> = {}
        
        const departmentKeys = Object.keys(allDepartmentsData)
        for (const deptKey of departmentKeys) {
          const deptData = allDepartmentsData[deptKey]
          if (deptData) {
            departmentLimitsMap[deptKey] = {
              enabled: deptData.enabled || false,
              selectedOutlets: deptData.selected_outlets || [],
              combinedLimit: deptData.combined_limit_watts || 0,
              device_control: deptData.device_control || 'on',
              department: deptKey
            }
          }
        }
        
        setAllDepartmentCombinedLimits(departmentLimitsMap)
        
        // Find the first enabled department for backward compatibility
        let foundData = null
        for (const deptKey of departmentKeys) {
          const deptData = allDepartmentsData[deptKey]
          if (deptData && deptData.enabled) {
            foundData = { ...deptData, department: deptKey }
            break
          }
        }
        
        if (foundData) {
          setCombinedLimitInfo({
            enabled: foundData.enabled || false,
            selectedOutlets: foundData.selected_outlets || [],
            combinedLimit: foundData.combined_limit_watts !== undefined ? foundData.combined_limit_watts : 0,
            device_control: foundData.device_control || 'on'
          })
        } else {
          setCombinedLimitInfo({
            enabled: false,
            selectedOutlets: [],
            combinedLimit: 0,
            device_control: 'on'
          })
        }
      } else {
        console.log('LogIn: No combined limit settings found')
        setAllDepartmentCombinedLimits({})
        setCombinedLimitInfo({
          enabled: false,
          selectedOutlets: [],
          combinedLimit: 0,
          device_control: 'on'
        })
      }
    }, (error) => {
      console.error('LogIn: Error listening to combined limit info:', error)
      setAllDepartmentCombinedLimits({})
      setCombinedLimitInfo({
        enabled: false,
        selectedOutlets: [],
        combinedLimit: 0,
        device_control: 'on'
      })
    })
    
    // Cleanup listener on unmount
    return () => unsubscribe()
  }, [])

  // Real-time scheduler that checks every minute and updates control.device
  useEffect(() => {
    const checkScheduleAndUpdateDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          // CRITICAL: Check monthly limit FIRST, then re-fetch fresh data
          await checkMonthlyLimitAndTurnOffDevices()
          
          // CRITICAL: Re-fetch device data AFTER monthly limit check
          // The monthly limit function may have set status='OFF' in Firebase
          // We need fresh data to respect those changes
          const freshSnapshot = await get(devicesRef)
          if (!freshSnapshot.exists()) {
            console.log('LogIn: No device data after initial fetch')
            return
          }
          const freshDevicesData = freshSnapshot.val()
          console.log('🔄 LogIn: Re-fetched device data to ensure fresh status')
          
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.
          
          console.log(`LogIn: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(freshDevicesData)) {
            const deviceData = outletData as any
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`LogIn: Checking device ${outletKey}:`, {
              hasSchedule: !!(deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)),
              enablePowerScheduling: deviceData.office_info?.enable_power_scheduling,
              schedule: deviceData.schedule
            })
            
            if (deviceData.schedule && 
                (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
              
              // Read the device's root status field (set by monthly limit enforcement)
              const currentStatus = deviceData.status || 'ON'
              const currentControlState = deviceData.control?.device || 'off'
              const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
              
              // CRITICAL: Skip device if manually disabled or turned off by monthly limits
              // This prevents the scheduler from re-activating devices that were just turned off
              if (currentStatus === 'OFF') {
                console.log(`⚠️ LogIn: Skipping ${outletKey} - status='OFF' (manually disabled or monthly limit exceeded)`)
                continue
              }
              
              // RESPECT disabled_by_unplug - if schedule is disabled by unplug, don't enable it
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`LogIn: Device ${outletKey} is disabled by unplug - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`LogIn: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
                }
                
                // Ensure device stays off
                if (currentControlState !== 'off') {
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                }
                continue
              }
              
              // RESPECT bypass mode - if main_status is ON, don't override it (device is in bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`LogIn: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
                continue
              }
              
              // Check if device is in any department's combined group (normalize outlet names for comparison)
              const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
              
              // Find which department this device belongs to and if it's in that department's combined limit
              let deviceDepartmentLimit: { department: string; limitInfo: any; device_control?: string } | null = null
              
              // First, get the device's department (from office_info, which may have department field)
              const deviceDept = (deviceData.office_info as any)?.department
              const deviceDeptKey = deviceDept ? deviceDept.toLowerCase().replace(/\s+/g, '-') : null
              
              // Check if device's department has combined limits and if device is included
              if (deviceDeptKey && allDepartmentCombinedLimits[deviceDeptKey]) {
                const deptLimitInfo = allDepartmentCombinedLimits[deviceDeptKey]
                if (deptLimitInfo.enabled && deptLimitInfo.selectedOutlets) {
                  const isInDeptLimit = deptLimitInfo.selectedOutlets.some((selectedOutlet: string) => {
                    const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                    return normalizedSelected === normalizedOutletKey || 
                           selectedOutlet === outletKey ||
                           selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                  })
                  
                  if (isInDeptLimit) {
                    // Get the department's device_control from database
                    const deptPath = getDepartmentCombinedLimitPath(deviceDeptKey)
                    const deptRef = ref(realtimeDb, deptPath)
                    const deptSnapshot = await get(deptRef)
                    const deptDeviceControl = deptSnapshot.exists() ? deptSnapshot.val()?.device_control : 'on'
                    
                    deviceDepartmentLimit = {
                      department: deviceDeptKey,
                      limitInfo: deptLimitInfo,
                      device_control: deptDeviceControl
                    }
                  }
                }
              }
              
              // Fallback: Check all departments if device department not found (backward compatibility)
              if (!deviceDepartmentLimit) {
                for (const [deptKey, deptLimitInfo] of Object.entries(allDepartmentCombinedLimits)) {
                  const typedDeptLimitInfo = deptLimitInfo as {
                    enabled: boolean;
                    selectedOutlets: string[];
                    combinedLimit: number;
                    device_control?: string;
                    department?: string;
                  }
                  
                  if (typedDeptLimitInfo.enabled && typedDeptLimitInfo.selectedOutlets) {
                    const isInDeptLimit = typedDeptLimitInfo.selectedOutlets.some((selectedOutlet: string) => {
                      const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                      return normalizedSelected === normalizedOutletKey || 
                             selectedOutlet === outletKey ||
                             selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                    })
                    
                    if (isInDeptLimit) {
                      // Get the department's device_control from database
                      const deptPath = getDepartmentCombinedLimitPath(deptKey)
                      const deptRef = ref(realtimeDb, deptPath)
                      const deptSnapshot = await get(deptRef)
                      const deptDeviceControl = deptSnapshot.exists() ? deptSnapshot.val()?.device_control : 'on'
                      
                      deviceDepartmentLimit = {
                        department: deptKey,
                        limitInfo: typedDeptLimitInfo,
                        device_control: deptDeviceControl
                      }
                      break
                    }
                  }
                }
              }
              
              // Check if device is in old combined limit structure (backward compatibility)
              const outletDisplayName = outletKey.replace('_', ' ')
              const isInOldCombinedGroup = combinedLimitInfo?.enabled && 
                                         combinedLimitInfo?.selectedOutlets?.some((selectedOutlet: string) => {
                                           const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                                           return normalizedSelected === normalizedOutletKey || 
                                                  selectedOutlet === outletKey ||
                                                  selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                                         })
              
              const isInCombinedGroup = !!deviceDepartmentLimit || isInOldCombinedGroup
              
              // CRITICAL: Check limits FIRST before any schedule logic
              // PRIORITY #1: Monthly limit check (for combined group devices)
              // PRIORITY #2: Combined monthly limit check (for combined group devices)
              // PRIORITY #3: Individual monthly limit check (for non-combined group devices)
              
              // CRITICAL: Initialize newControlState to current state from database, not 'off'
              // This prevents devices from being turned off by default before schedule/limit checks
              // If a device is idle (control='on'), it should stay 'on' unless schedule/limits say otherwise
              let newControlState = currentControlState // Start with current state from database
              let limitsExceeded = false
              
              if (isInCombinedGroup && deviceDepartmentLimit) {
                // For devices in department-based combined group: Check monthly limit FIRST
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(freshDevicesData, deviceDepartmentLimit.limitInfo.selectedOutlets)
                const combinedLimitWatts = deviceDepartmentLimit.limitInfo.combinedLimit
                const combinedLimitkW = combinedLimitWatts / 1000 // Convert to kW
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  // CRITICAL: If monthly limit exceeded, FORCE OFF and skip schedule check entirely
                  limitsExceeded = true
                  newControlState = 'off'
                  console.log(`🔒 LogIn: FORCING ${outletKey} OFF - MONTHLY LIMIT EXCEEDED for department ${deviceDepartmentLimit.department} - SKIPPING SCHEDULE CHECK`)
                  
                  // CRITICAL: Always update device control to 'off' when monthly limit is exceeded
                  // This ensures devices are automatically turned off even if they're already on
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  console.log(`🔒 LogIn: Enforced device_control='off' for ${outletKey} due to monthly limit exceeded in department ${deviceDepartmentLimit.department}`)
                }
              } else if (isInOldCombinedGroup && combinedLimitInfo?.enabled) {
                // For devices in old combined limit structure (backward compatibility): Check old combined limits
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(freshDevicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitWatts = combinedLimitInfo.combinedLimit
                const combinedLimitkW = combinedLimitWatts / 1000 // Convert to kW
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  limitsExceeded = true
                  newControlState = 'off'
                  console.log(`🔒 LogIn: FORCING ${outletKey} OFF - OLD COMBINED MONTHLY LIMIT EXCEEDED - SKIPPING SCHEDULE CHECK`)
                }
              } else if (!isInCombinedGroup) {
                // CRITICAL: Only check individual monthly limit if device is NOT in any combined group
                // This ensures devices in department-based or old combined limits skip individual limit checks
                const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
                if (powerLimit > 0) {
                  const now = new Date()
                  const currentYear = now.getFullYear()
                  const currentMonth = now.getMonth() + 1
                  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
                  let totalMonthlyEnergy = 0
                  
                  for (let day = 1; day <= daysInMonth; day++) {
                    const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
                    const dayData = deviceData.daily_logs?.[dateKey]
                    if (dayData && dayData.total_energy) {
                      totalMonthlyEnergy += dayData.total_energy
                    }
                  }
                  
                  if (totalMonthlyEnergy >= powerLimit) {
                    limitsExceeded = true
                    newControlState = 'off' // Force OFF if monthly limit exceeded
                    console.log(`🔒 LogIn: FORCING ${outletKey} OFF - INDIVIDUAL MONTHLY LIMIT EXCEEDED - SKIPPING SCHEDULE CHECK`)
                  }
                }
              } else {
                // Device is in combined group but detection failed - log warning and skip individual check
                console.log(`⚠️ LogIn: Device ${outletKey} detection issue - isInCombinedGroup=${isInCombinedGroup}, deviceDepartmentLimit=${!!deviceDepartmentLimit}, isInOldCombinedGroup=${isInOldCombinedGroup} - SKIPPING INDIVIDUAL LIMIT CHECK`)
              }
              
              // ONLY check schedule if limits are NOT exceeded
              // IMPORTANT: Each device is processed independently - unplugged devices don't block others
              if (!limitsExceeded) {
                // CRITICAL: Pass currentControlState instead of 'on' so that isDeviceActiveBySchedule
                // can use it as fallback if schedule parsing fails, preserving current state
                const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, currentControlState, deviceData, isInCombinedGroup)
                // Only update newControlState if schedule check determines a change is needed
                // If schedule says it should be active, set to 'on', otherwise set to 'off'
                newControlState = shouldBeActive ? 'on' : 'off'
                console.log(`✅ LogIn: Limits OK for ${outletKey} - Current state: ${currentControlState}, Schedule says: ${shouldBeActive ? 'ON' : 'OFF'}, New state: ${newControlState}`)
              }
              
              console.log(`LogIn: Final status determination for ${outletKey}:`, {
                limitsExceeded: limitsExceeded,
                finalDecision: newControlState,
                currentState: currentControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup: isInCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                console.log(`LogIn: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
              } else {
                console.log(`LogIn: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('LogIn: Error in real-time scheduler:', error)
      }
    }
    
    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`LogIn: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as any
            const currentControlState = deviceData.control?.device || 'off'
            const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
            
            // Skip if device is already off
            if (currentControlState === 'off') {
              continue
            }
            
            // Check if main_status is 'ON' - if so, skip automatic power limit enforcement (device is in bypass mode)
            if (currentMainStatus === 'ON') {
              console.log(`LogIn: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual monthly limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`LogIn: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Calculate monthly total energy consumption from daily_logs
                const now = new Date()
                const currentYear = now.getFullYear()
                const currentMonth = now.getMonth() + 1
                const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
                let totalMonthlyEnergy = 0
                
                for (let day = 1; day <= daysInMonth; day++) {
                  const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
                  const dayData = deviceData.daily_logs?.[dateKey]
                  if (dayData && dayData.total_energy) {
                    totalMonthlyEnergy += dayData.total_energy
                  }
                }
                
                console.log(`LogIn: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000)}W`,
                  currentMonth: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
                  exceedsLimit: totalMonthlyEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If monthly energy exceeds power limit, turn off the device
                if (totalMonthlyEnergy >= powerLimit) {
                  console.log(`LogIn: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(totalMonthlyEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`LogIn: Device ${outletKey} turned OFF due to power limit exceeded`)
                }
              }
            } else {
              console.log(`LogIn: Device ${outletKey} is in combined group - checking combined group power limits`)
              
              // For devices in combined groups, check combined monthly limit
              if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitkW = combinedLimitInfo.combinedLimit / 1000 // Convert to kW
                
                console.log(`LogIn: Combined group limit check for ${outletKey}:`, {
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(0)}W`,
                  combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
                  exceedsLimit: totalMonthlyEnergy >= combinedLimitkW
                })
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  console.log(`LogIn: Combined monthly limit exceeded - turning off ${outletKey}`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`LogIn: Device ${outletKey} turned OFF due to combined monthly limit exceeded`)
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('LogIn: Error in power limit monitor:', error)
      }
    }
    
    // Monthly limit check for combined groups
    const checkMonthlyLimitAndTurnOffDevices = async () => {
      try {
        if (!combinedLimitInfo?.enabled || combinedLimitInfo?.selectedOutlets?.length === 0) {
          return
        }

        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          // Calculate total monthly energy for combined group
          const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
          const combinedLimitWatts = combinedLimitInfo.combinedLimit
          const combinedLimitkW = combinedLimitWatts / 1000 // Convert to kW
          
          console.log(`LogIn: Monthly limit check - Total: ${(totalMonthlyEnergy * 1000).toFixed(0)}W / Limit: ${combinedLimitWatts}W`)
          
          if (totalMonthlyEnergy >= combinedLimitkW) {
            console.log(`LogIn: Monthly limit exceeded! Turning off all devices in combined group.`)
            
            // Turn off all devices in the combined group (respecting override/bypass mode)
            let successCount = 0
            let skippedCount = 0
            let failCount = 0
            
            for (const outletKey of combinedLimitInfo.selectedOutlets) {
              const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
              const deviceData = devicesData[firebaseKey]
              
              try {
                // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
                const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
                if (currentMainStatus === 'ON') {
                  console.log(`⚠️ LogIn: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
                  skippedCount++
                  continue
                }
                
                // Turn off device control
                const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
                await update(controlRef, { device: 'off' })
                
                // Turn off main status to prevent immediate re-activation
                const mainStatusRef = ref(realtimeDb, `devices/${firebaseKey}/relay_control`)
                await update(mainStatusRef, { main_status: 'OFF' })
                
                console.log(`✅ LogIn: TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
                successCount++
              } catch (error) {
                console.error(`❌ LogIn: FAILED to turn off ${outletKey}:`, error)
                failCount++
              }
            }
            
            // CRITICAL: Set combined_limit_settings/device_control to "off" to prevent devices from turning back ON
            const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
            const currentSettings = await get(combinedLimitRef)
            const currentDeviceControl = currentSettings.val()?.device_control
            
            // Only update if device_control is not already 'off' (avoid unnecessary writes)
            if (currentDeviceControl !== 'off') {
              await update(combinedLimitRef, {
                device_control: 'off',
                last_enforcement: new Date().toISOString(),
                enforcement_reason: 'Monthly limit exceeded'
              })
              console.log(`🔒 LogIn: Set combined_limit_settings/device_control='off' to prevent re-activation`)
            }
            
            console.log(`🔒 LogIn: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
          } else {
            console.log('✅ LogIn: Monthly limit not exceeded - devices can remain active')
            
            // Set combined_limit_settings/device_control to "on" to allow devices to turn ON
            const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
            const currentSettings = await get(combinedLimitRef)
            const currentDeviceControl = currentSettings.val()?.device_control
            const currentEnforcementReason = currentSettings.val()?.enforcement_reason
            
            // Only update if device_control is not already 'on' or enforcement_reason is not empty (avoid unnecessary writes)
            if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
              await update(combinedLimitRef, {
                device_control: 'on',
                enforcement_reason: ''
              })
              console.log(`✅ LogIn: Set combined_limit_settings/device_control='on' (limit not exceeded)`)
            }
          }
        }
      } catch (error) {
        console.error('LogIn: Error in monthly limit check:', error)
      }
    }

    // CRITICAL: Add a small delay before first run to ensure database state is fully loaded
    // This prevents devices from being incorrectly turned off when navigating to LogIn.tsx
    const initialDelay = setTimeout(() => {
      checkScheduleAndUpdateDevices()
      checkPowerLimitsAndTurnOffDevices()
      checkMonthlyLimitAndTurnOffDevices()
    }, 500) // 500ms delay to ensure database state is ready
    
    // Add manual test function for debugging
    ;(window as any).testLogInSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testLogInPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).checkLogInCurrentTime = () => {
      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()
      const currentDay = now.getDay()
      console.log('LogIn current time debug:', {
        time: now.toLocaleTimeString(),
        minutes: currentTime,
        day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
        date: now.toLocaleDateString()
      })
    }
    
    // Set up intervals for automatic checking
    const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds (more frequent for short schedules)
    const powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 12000) // 12 seconds (more frequent for power limits)
    const monthlyLimitInterval = setInterval(checkMonthlyLimitAndTurnOffDevices, 10000) // 10 seconds for monthly limit check
    
    // Cleanup intervals and initial delay on unmount
    return () => {
      clearTimeout(initialDelay)
      clearInterval(scheduleInterval)
      clearInterval(powerLimitInterval)
      clearInterval(monthlyLimitInterval)
    }
  }, [allDepartmentCombinedLimits]);

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

