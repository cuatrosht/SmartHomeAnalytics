import { useState, useRef, useEffect } from 'react'
import { createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, updateProfile } from 'firebase/auth'
import { ref, set, get, update } from 'firebase/database'
import { auth, realtimeDb } from '../firebase/config'
import { logUserActionToUserLogs } from '../utils/userLogging'
import './SignUp.css'

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
      
      // Convert display format to Firebase format
      const firebaseKey = outletKey.replace(' ', '_')
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

  type ModalVariant = 'success' | 'error'
  const [modalOpen, setModalOpen] = useState(false)
  const [modalVariant, setModalVariant] = useState<ModalVariant>('success')
  const [modalTitle, setModalTitle] = useState('')
  const [modalMessage, setModalMessage] = useState('')
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0
  })
  const successTimer = useRef<number | null>(null)

  // Function to check if there's an existing GSO
  const checkExistingGSO = async () => {
    try {
      const usersRef = ref(realtimeDb, 'users')
      const snapshot = await get(usersRef)

      if (snapshot.exists()) {
        const users = snapshot.val()
        const hasGSO = Object.values(users).some((user: any) => user.role === 'admin')
        setHasExistingGSO(hasGSO)
        console.log('Existing GSO check:', hasGSO)
      } else {
        setHasExistingGSO(false)
      }
    } catch (error) {
      console.error('Error checking for existing GSO:', error)
      setHasExistingGSO(false)
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
    
    if (schedule.startTime && schedule.endTime) {
      // Use startTime and endTime from database (24-hour format)
      const [startHours, startMinutes] = schedule.startTime.split(':').map(Number)
      const [endHours, endMinutes] = schedule.endTime.split(':').map(Number)
      startTime = startHours * 60 + startMinutes
      endTime = endHours * 60 + endMinutes
    } else if (schedule.timeRange) {
      // Parse timeRange format (e.g., "8:36 PM - 8:40 PM")
      const timeRange = schedule.timeRange
      const [startTimeStr, endTimeStr] = timeRange.split(' - ')
      
      // Convert 12-hour format to 24-hour format
      const convertTo24Hour = (time12h: string): number => {
        const [time, modifier] = time12h.split(' ')
        let [hours, minutes] = time.split(':').map(Number)
        
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
    } else {
      return controlState === 'on'
    }

    // Check if current time is within the scheduled time range
    // Turn off exactly at end time - device is active only when current time is less than end time
    const isWithinTimeRange = currentTime >= startTime && currentTime < endTime

    // Check if current day matches the schedule frequency
    const frequency = schedule.frequency || ''
    let isCorrectDay = false

    if (frequency.toLowerCase() === 'daily') {
      isCorrectDay = true
    } else if (frequency.toLowerCase() === 'weekdays') {
      isCorrectDay = currentDay >= 1 && currentDay <= 5 // Monday to Friday
    } else if (frequency.toLowerCase() === 'weekends') {
      isCorrectDay = currentDay === 0 || currentDay === 6 // Sunday or Saturday
    } else if (frequency.includes(',')) {
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
        const trimmedDay = day.trim().toLowerCase()
        return dayMap[trimmedDay]
      }).filter((day: number | undefined) => day !== undefined)
      
      isCorrectDay = scheduledDays.includes(currentDay)
    } else if (frequency) {
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
      
      // Get today's total energy consumption from daily_logs
      const today = new Date()
      const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
      const todayLogs = deviceData?.daily_logs?.[todayDateKey]
      const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
      
      // If device has a power limit and today's energy exceeds it, don't activate
      if (powerLimit > 0 && todayTotalEnergy >= powerLimit) {
        console.log(`SignUp: Schedule check - Device power limit exceeded:`, {
          todayTotalEnergy: `${(todayTotalEnergy * 1000).toFixed(3)}W`,
          powerLimit: `${(powerLimit * 1000)}W`,
          todayDateKey: todayDateKey,
          scheduleResult: false,
          reason: 'Today\'s energy consumption exceeded power limit'
        })
        return false
      }
    }

    // Device is active if it's within time range and on correct day
    return isWithinTimeRange && isCorrectDay
  }

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

  // Fetch combined limit info
  useEffect(() => {
    const fetchCombinedLimitInfo = async () => {
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const snapshot = await get(combinedLimitRef)
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          setCombinedLimitInfo({
            enabled: data.enabled || false,
            selectedOutlets: data.selected_outlets || [],
            combinedLimit: data.combined_limit_watts || 0
          })
        } else {
          setCombinedLimitInfo({
            enabled: false,
            selectedOutlets: [],
            combinedLimit: 0
          })
        }
      } catch (error) {
        console.error('SignUp: Error fetching combined limit info:', error)
      }
    }
    
    fetchCombinedLimitInfo()
  }, [])

  // Real-time scheduler that checks every minute and updates control.device
  useEffect(() => {
    const checkScheduleAndUpdateDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.
          
          console.log(`SignUp: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as any
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`SignUp: Checking device ${outletKey}:`, {
              hasSchedule: !!(deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)),
              enablePowerScheduling: deviceData.office_info?.enable_power_scheduling,
              schedule: deviceData.schedule
            })
            
            if (deviceData.schedule && 
                (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
              
              const currentControlState = deviceData.control?.device || 'off'
              const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
              
              // RESPECT bypass mode - if main_status is ON, don't override it (device is in bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`SignUp: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
                continue
              }
              
              // Check if device should be active based on current time and schedule
              // Skip individual limit check if device is in combined group (combined limit takes precedence)
              const outletDisplayName = outletKey.replace('_', ' ')
              const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                       combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
              const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInCombinedGroup)
              let newControlState = shouldBeActive ? 'on' : 'off'
              
              // Additional individual daily limit checking for devices NOT in combined groups
              if (!isInCombinedGroup && newControlState === 'on') {
                // Check individual daily limit for devices not in combined groups
                const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
                if (powerLimit > 0) {
                  const today = new Date()
                  const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                  const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                  const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                  
                  if (todayTotalEnergy >= powerLimit) {
                    newControlState = 'off' // Force OFF if daily limit exceeded
                    console.log(`🔒 SignUp: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  }
                }
              }
              
              console.log(`SignUp: Schedule check for ${outletKey}:`, {
                currentControlState,
                shouldBeActive,
                newControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                console.log(`SignUp: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
              } else {
                console.log(`SignUp: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('SignUp: Error in real-time scheduler:', error)
      }
    }
    
    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`SignUp: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
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
              console.log(`SignUp: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual daily limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`SignUp: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Get today's total energy consumption from daily_logs
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                
                console.log(`SignUp: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
                  todayDateKey: todayDateKey,
                  exceedsLimit: todayTotalEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If today's energy exceeds power limit, turn off the device
                if (todayTotalEnergy >= powerLimit) {
                  console.log(`SignUp: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`SignUp: Device ${outletKey} turned OFF due to power limit exceeded`)
                }
              }
            } else {
              console.log(`SignUp: Device ${outletKey} is in combined group - checking combined group power limits`)
              
              // For devices in combined groups, check combined monthly limit
              if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitkW = combinedLimitInfo.combinedLimit / 1000 // Convert to kW
                
                console.log(`SignUp: Combined group limit check for ${outletKey}:`, {
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(0)}W`,
                  combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
                  exceedsLimit: totalMonthlyEnergy >= combinedLimitkW
                })
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  console.log(`SignUp: Combined monthly limit exceeded - turning off ${outletKey}`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`SignUp: Device ${outletKey} turned OFF due to combined monthly limit exceeded`)
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('SignUp: Error in power limit monitor:', error)
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
          
          console.log(`SignUp: Monthly limit check - Total: ${(totalMonthlyEnergy * 1000).toFixed(0)}W / Limit: ${combinedLimitWatts}W`)
          
          if (totalMonthlyEnergy >= combinedLimitkW) {
            console.log(`SignUp: Monthly limit exceeded! Turning off all devices in combined group.`)
            
            // Turn off all devices in the combined group
            for (const outletKey of combinedLimitInfo.selectedOutlets) {
              const firebaseKey = outletKey.replace(' ', '_')
              
              try {
                // Turn off device control
                const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
                await update(controlRef, { device: 'off' })
                
                // Turn off main status to prevent immediate re-activation
                const mainStatusRef = ref(realtimeDb, `devices/${firebaseKey}/relay_control`)
                await update(mainStatusRef, { main_status: 'OFF' })
                
                console.log(`✅ TURNED OFF: ${outletKey} (${firebaseKey}) due to monthly limit`)
              } catch (error) {
                console.error(`❌ FAILED to turn off ${outletKey}:`, error)
              }
            }
          }
        }
      } catch (error) {
        console.error('SignUp: Error in monthly limit check:', error)
      }
    }

    // Re-enable schedule checking with bypass support
    checkScheduleAndUpdateDevices()
    
    // Run power limit check
    checkPowerLimitsAndTurnOffDevices()
    
    // Run monthly limit check
    checkMonthlyLimitAndTurnOffDevices()
    
    // Add manual test function for debugging
    ;(window as any).testSignUpSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testSignUpPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).checkSignUpCurrentTime = () => {
      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()
      const currentDay = now.getDay()
      console.log('SignUp current time debug:', {
        time: now.toLocaleTimeString(),
        minutes: currentTime,
        day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
        date: now.toLocaleDateString()
      })
    }
    
    // Set up intervals for automatic checking
    const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds (more frequent for short schedules)
    const powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 30000) // 30 seconds (more frequent for power limits)
    const monthlyLimitInterval = setInterval(checkMonthlyLimitAndTurnOffDevices, 60000) // 1 minute for monthly limit check
    
    // Cleanup intervals on unmount
    return () => {
      clearInterval(scheduleInterval)
      clearInterval(powerLimitInterval)
      clearInterval(monthlyLimitInterval)
    }
  }, []);

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
    if (!firstName.trim()) {
      openModal('error', 'Validation Error', 'First name is required.')
      return false
    }
    if (!lastName.trim()) {
      openModal('error', 'Validation Error', 'Last name is required.')
      return false
    }
    if (!email.trim()) {
      openModal('error', 'Validation Error', 'Email address is required.')
      return false
    }
    if (!password) {
      openModal('error', 'Validation Error', 'Password is required.')
      return false
    }
    if (password.length < 6) {
      openModal('error', 'Validation Error', 'Password must be at least 6 characters long.')
      return false
    }
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!validateForm()) return

    // Prevent GSO signup if GSO already exists
    if (userRole === 'admin' && hasExistingGSO) {
      openModal('error', 'GSO Account Exists', 'A GSO account already exists. Only one GSO is allowed per system.')
      return
    }

    setLoading(true)
    
    try {
      // Create user with email and password
      const userCredential = await createUserWithEmailAndPassword(auth, email, password)
      const user = userCredential.user

      // Update user profile with display name
      await updateProfile(user, {
        displayName: `${firstName} ${lastName}`.trim()
      })

      // Save additional user data to Realtime Database
      const userData = {
        uid: user.uid,
        email: user.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        displayName: `${firstName} ${lastName}`.trim(),
        role: userRole,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      }

      console.log('Saving user data with role:', userRole, userData)
      await set(ref(realtimeDb, `users/${user.uid}`), userData)

      // Log user signup to user_logs table
      await logUserActionToUserLogs(
        'User Signup',
        'System',
        `New user account created with email: ${email} (Role: ${userRole})`,
        'success',
        `${firstName} ${lastName}`.trim(),
        user.uid,
        'email'
      )

      openModal('success', 'Account Created Successfully', `Welcome ${firstName}! Your ${userRole} account has been created and you are now signed in.`)
      scheduleSuccessRedirect()
      
    } catch (error: any) {
      console.error('Signup error:', error)
      
      let errorMessage = 'Failed to create account. Please try again.'
      
      if (error.code === 'auth/email-already-in-use') {
        errorMessage = 'An account with this email already exists. Please sign in instead.'
      } else if (error.code === 'auth/invalid-email') {
        errorMessage = 'Please enter a valid email address.'
      } else if (error.code === 'auth/weak-password') {
        errorMessage = 'Password is too weak. Please choose a stronger password.'
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your connection and try again.'
      }
      
      // Log failed signup attempt
      await logUserActionToUserLogs(
        'User Signup',
        'System',
        `Failed signup attempt with email: ${email} - ${errorMessage}`,
        'error',
        `${firstName} ${lastName}`.trim(),
        'unknown',
        'email'
      )
      
      openModal('error', 'Account Creation Failed', errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleGoogle = async () => {
    // Show role selection modal first
    setShowRoleModal(true)
  }

  const handleGoogleWithRole = async (selectedRole: 'Coordinator' | 'admin') => {
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
      const user = result.user
      
      // Save additional user data to Realtime Database
      const userData = {
        uid: user.uid,
        email: user.email,
        firstName: user.displayName?.split(' ')[0] || 'User',
        lastName: user.displayName?.split(' ').slice(1).join(' ') || '',
        displayName: user.displayName || 'User',
        role: selectedRole,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        provider: 'google'
      }

      console.log('Saving Google user data with role:', selectedRole, userData)
      await set(ref(realtimeDb, `users/${user.uid}`), userData)
      
      // Log user signup to user_logs table
      await logUserActionToUserLogs(
        'Google Signup',
        'System',
        `New user account created with Google: ${user.email} (Role: ${selectedRole})`,
        'success',
        user.displayName || 'User',
        user.uid,
        'google'
      )
      
      openModal('success', 'Signed up with Google', `Welcome ${user.displayName || 'User'}! Your ${selectedRole} account has been created with Google authentication.`)
      scheduleSuccessRedirect(user.displayName || undefined, selectedRole)
      
    } catch (error: any) {
      console.error('Google signup error:', error)
      
      let errorMessage = 'Google signup failed. Please try again.'
      
      if (error.code === 'auth/popup-closed-by-user') {
        errorMessage = 'Signup was cancelled. Please try again.'
      } else if (error.code === 'auth/popup-blocked') {
        errorMessage = 'Pop-up was blocked. Please allow pop-ups and try again.'
      } else if (error.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your connection and try again.'
      } else if (error.code === 'auth/unauthorized-domain') {
        errorMessage = 'This domain is not authorized for Google signup. Please contact support.'
      } else if (error.code === 'auth/operation-not-allowed') {
        errorMessage = 'Google signup is not enabled. Please contact support.'
      }
      
      // Log failed Google signup attempt
      await logUserActionToUserLogs(
        'Google Signup',
        'System',
        `Failed Google signup attempt - ${errorMessage}`,
        'error',
        'Unknown User',
        'unknown',
        'google'
      )
      
      openModal('error', 'Google Signup Failed', errorMessage)
    } finally {
      setLoading(false)
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
