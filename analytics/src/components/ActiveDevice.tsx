import { useState, useEffect, useMemo } from 'react'
import { ref, onValue, off, update, get } from 'firebase/database'
import { realtimeDb } from '../firebase/config'
import { logDeviceControlActivity, logSystemActivity } from '../utils/deviceLogging'
import './ActiveDevice.css'

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

// Auto-turnoff functions disabled to prevent interference with data uploads
// const startAutoTurnoffTimer = (outletKey: string, setAutoTurnoffTimers: React.Dispatch<React.SetStateAction<Record<string, NodeJS.Timeout | null>>>) => {
//   // Function disabled to prevent auto-turnoff spam
// }

const clearAutoTurnoffTimer = (outletKey: string, setAutoTurnoffTimers: React.Dispatch<React.SetStateAction<Record<string, NodeJS.Timeout | null>>>) => {
  setAutoTurnoffTimers(prev => {
    if (prev[outletKey]) {
      clearTimeout(prev[outletKey]!)
      console.log(`🔄 Auto-turnoff: Cleared timer for ${outletKey} - device is now idle or turned off`)
    }
    return {
      ...prev,
      [outletKey]: null
    }
  })
}

// const resetAutoTurnoffFunction = (outletKey: string, setAutoTurnoffTimers: React.Dispatch<React.SetStateAction<Record<string, NodeJS.Timeout | null>>>) => {
//   // Function disabled to prevent auto-turnoff spam
// }

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

// TypeScript interfaces for type safety
interface Device {
  id: string
  outletName: string
  appliances: string
  officeRoom: string
  powerUsage: string
  status: 'Active' | 'Inactive' | 'Idle'
  todayUsage: string
  schedule: {
    time: string
    days: string
  }
  controlState: string
  mainStatus: string
  todayTotalEnergy?: number
  powerLimit?: number
  currentDate?: string
  currentTime?: string
}

interface FirebaseDeviceData {
  status?: string // Add status property
  lifetime_energy?: number // Add lifetime_energy at the root level
  daily_logs?: {
    [date: string]: {
      avg_power: number
      peak_power: number
      total_energy: number
      lifetime_energy: number
    }
  }
  office_info?: {
    assigned_date: string
    office: string
    appliance?: string
    enable_power_scheduling?: boolean
  }
  control?: {
    device: string
  }
  relay_control?: {
    auto_cutoff: {
      enabled: boolean
      power_limit: number
    }
    status: string
    main_status?: string // New main status field
  }
  sensor_data?: {
    current: number
    energy: number
    frequency: number
    power: number
    power_factor: number
    timestamp: string
    voltage: number
  }
  schedule?: {
    timeRange: string
    frequency: string
    startTime: string
    endTime: string
    selectedDays: string[]
  }
}

interface ActiveDeviceProps {
  onNavigate?: (key: string) => void
}

export default function ActiveDevice({ onNavigate }: ActiveDeviceProps) {
  // Helper function to format numbers with commas
  const formatNumber = (num: number, decimals: number = 3): string => {
    return num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    })
  }

  // Helper function to safely show modals with debouncing
  const showModalSafely = (modalType: 'scheduleConflict' | 'powerLimit' | 'noPowerLimit' | 'success' | 'error', data: any) => {
    const currentTime = Date.now()
    
    // Check if enough time has passed since last modal trigger
    if (currentTime - lastModalTrigger < MODAL_DEBOUNCE_MS) {
      console.log(`Modal ${modalType} blocked - too soon since last modal (${currentTime - lastModalTrigger}ms ago)`)
      return false
    }
    
    // Check if any modal is already open
    if (modalOpen) {
      console.log(`Modal ${modalType} blocked - another modal is already open`)
      return false
    }
    
    // Set modal open flag and update last trigger time
    setModalOpen(true)
    setLastModalTrigger(currentTime)
    
    // Show the appropriate modal
    switch (modalType) {
      case 'scheduleConflict':
        setScheduleConflictModal({
          isOpen: true,
          device: data.device,
          reason: data.reason
        })
        break
      case 'powerLimit':
        setPowerLimitModal({
          isOpen: true,
          device: data.device
        })
        break
      case 'noPowerLimit':
        setNoPowerLimitModal({
          isOpen: true,
          device: data.device
        })
        break
      case 'success':
        setSuccessModal({
          isOpen: true,
          deviceName: data.deviceName,
          action: data.action
        })
        break
      case 'error':
        setErrorModal({
          isOpen: true,
          message: data.message
        })
        break
    }
    
    return true
  }

  const [searchQuery, setSearchQuery] = useState('')
  const [activeDevices, setActiveDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [successModal, setSuccessModal] = useState<{
    isOpen: boolean;
    deviceName: string;
    action: string;
  }>({
    isOpen: false,
    deviceName: '',
    action: ''
  })
  const [errorModal, setErrorModal] = useState<{
    isOpen: boolean;
    message: string;
  }>({
    isOpen: false,
    message: ''
  })
  const [powerLimitModal, setPowerLimitModal] = useState<{
    isOpen: boolean;
    device: Device | null;
  }>({
    isOpen: false,
    device: null
  })
  const [historyModal, setHistoryModal] = useState<{
    isOpen: boolean;
    device: Device | null;
  }>({
    isOpen: false,
    device: null
  })
  const [timeSegment, setTimeSegment] = useState<'Day' | 'Week' | 'Month' | 'Year'>('Day')
  const [currentRate, setCurrentRate] = useState(9.3885) // Default CANORECO Residential rate (Aug 2025)
  const [lastRateUpdate, setLastRateUpdate] = useState<string>('')
  const [historyData, setHistoryData] = useState<{
    totalEnergy: number;
    totalCost: number;
    dailyData: Array<{
      date: string;
      energy: number;
      cost: number;
    }>;
  }>({
    totalEnergy: 0,
    totalCost: 0,
    dailyData: []
  })
  const [noPowerLimitModal, setNoPowerLimitModal] = useState<{
    isOpen: boolean;
    device: Device | null;
  }>({
    isOpen: false,
    device: null
  })
  const [scheduleConflictModal, setScheduleConflictModal] = useState<{
    isOpen: boolean;
    device: Device | null;
    reason: string;
  }>({
    isOpen: false,
    device: null,
    reason: ''
  })
  const [updatingDevices, setUpdatingDevices] = useState<Set<string>>(new Set())
  const [modalOpen, setModalOpen] = useState(false) // Prevent multiple modals from opening
  const [lastModalTrigger, setLastModalTrigger] = useState<number>(0) // Debounce modal triggers
  const [lastToggleTrigger, setLastToggleTrigger] = useState<number>(0) // Debounce toggle triggers
  const MODAL_DEBOUNCE_MS = 2000 // 2 seconds debounce to prevent rapid modal appearances
  const TOGGLE_DEBOUNCE_MS = 1000 // 1 second debounce to prevent rapid toggle calls
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0
  })

  // Idle detection state
  const [deviceActivity, setDeviceActivity] = useState<Record<string, {
    lastEnergyUpdate: number;
    lastControlUpdate: number;
    lastTotalEnergy: number;
    lastControlState: string;
    lastStateHash: string;
  }>>({})

  // Auto-turnoff timer state for non-idle devices (disabled to prevent spam)
  const [autoTurnoffTimers, setAutoTurnoffTimers] = useState<Record<string, NodeJS.Timeout | null>>({})
  
  // Clear all existing auto-turnoff timers on component mount to prevent spam
  useEffect(() => {
    // Clear any existing timers that might be running from previous sessions
    Object.values(autoTurnoffTimers).forEach(timer => {
      if (timer) {
        clearTimeout(timer)
      }
    })
    setAutoTurnoffTimers({})
  }, [])

  // Helper function to get today's date in the format used in your database
  const getTodayDateKey = (): string => {
    const today = new Date()
    const year = today.getFullYear()
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    const dateKey = `day_${year}_${month}_${day}`
    console.log(`Today's date key: ${dateKey}`)
    return dateKey
  }


  // Helper function to format office name
  const formatOfficeName = (office: string): string => {
    if (!office || office === 'Unassigned') {
      return 'Unassigned'
    }
    
    // Convert kebab-case or snake_case to proper title case
    const formatted = office
      .replace(/[-_]/g, ' ') // Replace hyphens and underscores with spaces
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
    
    // Handle specific cases - be more specific to avoid duplication
    if (formatted.toLowerCase().includes('computer lab') && !formatted.toLowerCase().includes('laboratory')) {
      return formatted.replace(/computer lab/i, 'Computer Laboratory')
    }
    
    if (formatted.toLowerCase().includes('deans office')) {
      return formatted.replace(/deans office/i, "Dean's Office")
    }
    
    return formatted
  }

  // Helper function to convert 24-hour time to 12-hour for display
  const convertTo12Hour = (time24h: string) => {
    if (!time24h) return ''
    const [hours, minutes] = time24h.split(':')
    const hour = parseInt(hours, 10)
    const ampm = hour >= 12 ? 'PM' : 'AM'
    const hour12 = hour % 12 || 12
    return `${hour12}:${minutes} ${ampm}`
  }


  // Function to automatically determine device status based on power usage and main status
  const getAutomaticStatus = (powerUsage: number, powerLimit: number, mainStatus: string, controlState: string): 'Active' | 'Inactive' => {
    // If main status is OFF, device is always Inactive
    if (mainStatus === 'OFF') {
      return 'Inactive'
    }

    // If main status is ON, device can be active regardless of schedule or power limits
    // Only check control state for safety
    if (controlState !== 'on') {
      return 'Inactive'
    }

    // Check if device is blocked by power limit (convert kW to watts for comparison)
    if (powerLimit > 0 && (powerUsage * 1000) >= (powerLimit * 1000)) {
      return 'Inactive' // Device is blocked by power limit
    }

    // If main status is ON and relay is ON, device can be Active
    return 'Active'
  }

  // Calculate cost for a specific outlet based on time segment
  const calculateOutletCost = async (outletKey: string, timeSegment: 'Day' | 'Week' | 'Month' | 'Year') => {
    try {
      const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
      const snapshot = await get(deviceRef)
      
      if (!snapshot.exists()) {
        return { totalEnergy: 0, totalCost: 0, dailyData: [] }
      }

      const deviceData = snapshot.val()
      const dailyLogs = deviceData.daily_logs || {}
      
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const currentDay = now.getDate()
      
      let filteredData: Array<{ date: string; energy: number; cost: number }> = []
      let totalEnergy = 0
      
      // Filter data based on time segment
      Object.keys(dailyLogs).forEach(dateKey => {
        const [_, year, month, day] = dateKey.split('_')
        const logYear = parseInt(year)
        const logMonth = parseInt(month)
        const logDay = parseInt(day)
        
        let includeData = false
        
        switch (timeSegment) {
          case 'Day':
            includeData = logYear === currentYear && logMonth === currentMonth && logDay === currentDay
            break
          case 'Week':
            // Last 7 days
            const logDate = new Date(logYear, logMonth - 1, logDay)
            const daysDiff = Math.floor((now.getTime() - logDate.getTime()) / (1000 * 60 * 60 * 24))
            includeData = daysDiff >= 0 && daysDiff < 7
            break
          case 'Month':
            includeData = logYear === currentYear && logMonth === currentMonth
            break
          case 'Year':
            includeData = logYear === currentYear
            break
        }
        
        if (includeData) {
          const dayData = dailyLogs[dateKey]
          const energy = dayData.total_energy || 0 // Energy in kW
          const cost = energy * currentRate
          
          filteredData.push({
            date: `${logYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
            energy,
            cost
          })
          
          totalEnergy += energy
        }
      })
      
      // Sort by date
      filteredData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      
      const totalCost = totalEnergy * currentRate
      
      return {
        totalEnergy,
        totalCost,
        dailyData: filteredData
      }
    } catch (error) {
      console.error('Error calculating outlet cost:', error)
      return { totalEnergy: 0, totalCost: 0, dailyData: [] }
    }
  }

  // Fetch history data when modal opens
  const fetchHistoryData = async (device: Device) => {
    const outletKey = device.outletName.replace(' ', '_')
    const data = await calculateOutletCost(outletKey, timeSegment)
    setHistoryData(data)
  }

  // Helper function to check if device should be active based on schedule
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
        console.log(`Schedule check: Device ${deviceData.outletName || 'Unknown'} power limit exceeded:`, {
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

  // Fetch devices data from Firebase with real-time listener
  useEffect(() => {
    const devicesRef = ref(realtimeDb, 'devices')
    
    const unsubscribe = onValue(devicesRef, (snapshot) => {
      const data = snapshot.val()
      console.log('ActiveDevice: Firebase data received:', data)
      
      if (data) {
        const devicesArray: Device[] = []
        let deviceId = 1

        Object.keys(data).forEach((outletKey) => {
          const outlet: FirebaseDeviceData = data[outletKey]
          
          // Get current power usage from lifetime_energy (display in watts)
          const todayDateKey = getTodayDateKey()
          const todayLogs = outlet.daily_logs?.[todayDateKey]
          const lifetimeEnergyWatts = outlet.lifetime_energy || 0
          const powerUsageDisplay = `${formatNumber(lifetimeEnergyWatts * 1000)} Wh`
          const powerUsage = lifetimeEnergyWatts // Already in kW
          
          console.log(`Outlet ${outletKey}: Using lifetime_energy = ${lifetimeEnergyWatts}W (${powerUsage}kW)`)
          
          const powerLimit = outlet.relay_control?.auto_cutoff?.power_limit || 0
          
          // Debug: Log the entire outlet object to see the structure
          console.log(`Outlet ${outletKey} full data:`, outlet)
          console.log(`Outlet ${outletKey} control object:`, outlet.control)
          console.log(`Outlet ${outletKey} control.device value:`, outlet.control?.device)
          
          const controlState = (outlet.control?.device || 'off').toString().trim().toLowerCase()
          const mainStatus = outlet.relay_control?.main_status || 'ON' // Default to ON if not set
          // Get today's energy consumption from total_energy (display in watts)
          const todayEnergyWatts = todayLogs?.total_energy || 0
          const todayEnergyDisplay = `${formatNumber(todayEnergyWatts * 1000)} Wh`
          const totalEnergy = todayEnergyWatts // Already in kW
          
          console.log(`Outlet ${outletKey}: Using total_energy = ${todayEnergyWatts}W (${totalEnergy}kW)`)
          
                    // Map office values to display names
          const officeNames: Record<string, string> = {
            'computer-lab-1': 'Computer Laboratory 1',
            'computer-lab-2': 'Computer Laboratory 2',
            'computer-lab-3': 'Computer Laboratory 3',
            'deans-office': "Dean's Office",
            'faculty-office': 'Faculty Office'
          }
          
          const officeValue = outlet.office_info?.office || ''
          const officeInfo = officeValue ? (officeNames[officeValue] || formatOfficeName(officeValue)) : '—'
          
          // Check for idle status from root level
          const sensorStatus = outlet.status
          const isIdleFromSensor = sensorStatus === 'idle'
          
          // Idle detection logic
          const currentTime = Date.now()
          const currentTotalEnergy = todayLogs?.total_energy || 0
          
          // Get current values for state hash
          const currentAvgPower = todayLogs?.avg_power || 0
          const currentPeakPower = todayLogs?.peak_power || 0
          const currentUsageTime = (todayLogs as any)?.usage_time_millis || 0
          const currentStateHash = `${currentTotalEnergy}_${currentAvgPower}_${currentPeakPower}_${currentUsageTime}`
          
          // Get or initialize device activity tracking
          const activity = deviceActivity[outletKey] || {
            lastEnergyUpdate: currentTime, // Initialize with current time
            lastControlUpdate: currentTime,
            lastTotalEnergy: currentTotalEnergy,
            lastControlState: controlState,
            lastStateHash: currentStateHash
          }
          
          // If this is the first time we're seeing this device with energy data, initialize the timestamp
          if (!deviceActivity[outletKey] && currentTotalEnergy > 0) {
            setDeviceActivity(prev => ({
              ...prev,
              [outletKey]: {
                lastEnergyUpdate: currentTime,
                lastControlUpdate: currentTime,
                lastTotalEnergy: currentTotalEnergy,
                lastControlState: controlState,
                lastStateHash: currentStateHash
              }
            }))
          }
          
          // Check if any of the daily_logs values have changed
          const lastStateHash = activity.lastStateHash || ''
          const energyChanged = currentStateHash !== lastStateHash
          
          if (energyChanged) {
            setDeviceActivity(prev => ({
              ...prev,
              [outletKey]: {
                ...activity,
                lastEnergyUpdate: currentTime,
                lastTotalEnergy: currentTotalEnergy,
                lastStateHash: currentStateHash
              }
            }))
          } else {
            // Always ensure deviceActivity is properly initialized, even if energy hasn't changed
            setDeviceActivity(prev => ({
              ...prev,
              [outletKey]: {
                ...activity,
                lastTotalEnergy: currentTotalEnergy,
                lastStateHash: currentStateHash
              }
            }))
          }
          
          // Check for control state changes
          const controlChanged = controlState !== activity.lastControlState
          if (controlChanged) {
            setDeviceActivity(prev => ({
              ...prev,
              [outletKey]: {
                ...activity,
                lastControlUpdate: currentTime,
                lastControlState: controlState
              }
            }))
          }
          
          // Determine if device is idle (15 seconds of no updates)
          const timeSinceEnergyUpdate = currentTime - activity.lastEnergyUpdate
          const timeSinceControlUpdate = currentTime - activity.lastControlUpdate
          const isIdleFromLogic = timeSinceEnergyUpdate > 15000 && timeSinceControlUpdate > 15000
          
          // Determine final status
          let deviceStatus: 'Active' | 'Inactive' | 'Idle'
          if ((isIdleFromSensor || isIdleFromLogic) && controlState === 'on') {
            // Show Idle if sensor reports idle OR if device is supposed to be ON but not responding
            deviceStatus = 'Idle'
          } else {
            deviceStatus = controlState === 'on' ? 'Active' : 'Inactive'
          }

          // Auto-turnoff logic - only for devices that are truly idle for extended periods
          // Disabled auto-turnoff to prevent interference with data uploads and normal device operation
          // if (controlState === 'on') {
          //   if (deviceStatus !== 'Idle') {
          //     // Device is not idle and control is on - start auto-turnoff timer
          //     startAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)
          //   } else {
          //     // Device is idle - clear any existing auto-turnoff timer
          //     clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)
          //   }
          // } else {
          //   // Device control is off - clear any existing auto-turnoff timer and reset function
          //   clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)
          // }
          
          // Clear any existing auto-turnoff timers to prevent interference
          clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)

          // Auto-turnoff functionality disabled to prevent interference with data uploads
          // Reset auto-turnoff function when outlet turns on again
          // const controlChangedForAutoTurnoff = controlState !== activity.lastControlState
          // if (controlChangedForAutoTurnoff && controlState === 'on') {
          //   resetAutoTurnoffFunction(outletKey, setAutoTurnoffTimers)
          // }
          
          // Debug: Check if schedule should be active
          if (outlet.schedule && (outlet.schedule.timeRange || outlet.schedule.startTime)) {
            const now = new Date()
            const currentTime = now.getHours() * 60 + now.getMinutes()
            const currentDay = now.getDay()
            console.log(`Outlet ${outletKey}: Schedule debug - Current time: ${now.toLocaleTimeString()} (${currentTime} min), Day: ${currentDay}`)
            console.log(`Outlet ${outletKey}: Schedule data:`, outlet.schedule)
            
            // Check if device should be active by schedule
            const shouldBeActiveBySchedule = isDeviceActiveBySchedule(outlet.schedule, 'on', outlet)
            console.log(`Outlet ${outletKey}: Should be active by schedule: ${shouldBeActiveBySchedule}`)
          }
          
          // Get appliance from database or show "Unassigned"
          const applianceType = outlet.office_info?.appliance || 'Unassigned'
          
          // Format schedule information
          let scheduleTime = 'No schedule'
          let scheduleDays = 'No schedule'
          
          if (outlet.schedule) {
            if (outlet.schedule.startTime && outlet.schedule.endTime) {
              const startTime12 = convertTo12Hour(outlet.schedule.startTime)
              const endTime12 = convertTo12Hour(outlet.schedule.endTime)
              scheduleTime = `${startTime12} - ${endTime12}`
            } else if (outlet.schedule.timeRange) {
              scheduleTime = outlet.schedule.timeRange
            }
            
            if (outlet.schedule.frequency) {
              scheduleDays = outlet.schedule.frequency
            }
          }

          const deviceData: Device = {
            id: String(deviceId).padStart(3, '0'),
            outletName: outletKey.replace('_', ' '),
            appliances: applianceType,
            officeRoom: officeInfo,
            powerUsage: powerUsageDisplay,
            status: deviceStatus,
            todayUsage: todayEnergyDisplay,
            schedule: {
              time: scheduleTime,
              days: scheduleDays
            },
            controlState: controlState,
            mainStatus: mainStatus
          }
          
          devicesArray.push(deviceData)
          deviceId++
        })

        console.log('ActiveDevice: Setting devices array:', devicesArray)
        setActiveDevices(devicesArray)
      } else {
        console.log('ActiveDevice: No data in Firebase - all devices deleted or database empty')
        setActiveDevices([])
      }
      
      setLoading(false)
    })

    return () => off(devicesRef, 'value', unsubscribe)
  }, [])

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
        console.error('ActiveDevice: Error fetching combined limit info:', error)
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
          
          console.log(`ActiveDevice: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`ActiveDevice: Checking device ${outletKey}:`, {
              hasSchedule: !!(deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)),
              enablePowerScheduling: deviceData.office_info?.enable_power_scheduling,
              schedule: deviceData.schedule
            })
            
            if (deviceData.schedule && 
                (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
              
              const currentControlState = deviceData.control?.device || 'off'
              const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
              
              // Always check schedule - main_status is just a manual override flag
              // The real control is through control.device which we will update based on schedule
              console.log(`ActiveDevice: Device ${outletKey} main status is ${currentMainStatus} - checking schedule anyway`)
              
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
                    console.log(`🔒 ActiveDevice: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  }
                }
              }
              
              console.log(`ActiveDevice: Schedule check for ${outletKey}:`, {
                currentControlState,
                shouldBeActive,
                newControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                // Check for recent database activity before turning off devices
                if (newControlState === 'off') {
                  const currentTime = Date.now()
                  const lastEnergyUpdate = deviceActivity[outletKey]?.lastEnergyUpdate || 0
                  const timeSinceLastUpdate = currentTime - lastEnergyUpdate
                  
                  // If there's been database activity in the last 2 minutes, don't turn off automatically
                  const hasRecentActivity = timeSinceLastUpdate < 120000 // 2 minutes
                  
                  if (hasRecentActivity) {
                    console.log(`ActiveDevice: Keeping ${outletKey} ON - recent database activity detected (${Math.round(timeSinceLastUpdate / 1000)}s ago) during schedule check`)
                    continue // Skip this device update
                  }
                }
                
                console.log(`ActiveDevice: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
              } else {
                console.log(`ActiveDevice: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('ActiveDevice: Error in real-time scheduler:', error)
      }
    }
    

    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`ActiveDevice: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            const currentControlState = deviceData.control?.device || 'off'
            const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
            
            // Skip if device is already off
            if (currentControlState === 'off') {
              continue
            }
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual daily limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`ActiveDevice: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Get today's total energy consumption from daily_logs
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                
                console.log(`ActiveDevice: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
                  todayDateKey: todayDateKey,
                  exceedsLimit: todayTotalEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If today's energy exceeds power limit, check for recent database activity before turning off
                if (todayTotalEnergy >= powerLimit) {
                  // Check for recent database activity to prevent turning off during data uploads
                  const currentTime = Date.now()
                  const lastEnergyUpdate = deviceActivity[outletKey]?.lastEnergyUpdate || 0
                  const timeSinceLastUpdate = currentTime - lastEnergyUpdate
                  
                  // If there's been database activity in the last 2 minutes, don't turn off automatically
                  const hasRecentActivity = timeSinceLastUpdate < 120000 // 2 minutes
                  
                  console.log(`ActiveDevice: POWER LIMIT EXCEEDED for ${outletKey}:`, {
                    todayTotalEnergy: `${(todayTotalEnergy * 1000).toFixed(3)}W`,
                    powerLimit: `${(powerLimit * 1000)}W`,
                    timeSinceLastUpdate: `${Math.round(timeSinceLastUpdate / 1000)}s`,
                    hasRecentActivity: hasRecentActivity,
                    willTurnOff: !hasRecentActivity
                  })
                  
                  if (!hasRecentActivity) {
                    // Only turn off if there's no recent database activity
                    console.log(`ActiveDevice: Turning OFF ${outletKey} - no recent database activity`)
                    
                    await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                      device: 'off'
                    })
                    
                    // Also turn off main status to prevent immediate re-activation
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                    
                    console.log(`ActiveDevice: Device ${outletKey} turned OFF due to power limit exceeded`)
                  } else {
                    console.log(`ActiveDevice: Keeping ${outletKey} ON - recent database activity detected (${Math.round(timeSinceLastUpdate / 1000)}s ago)`)
                  }
                  
                  // Note: Automatic power limit enforcement is not logged to avoid cluttering device logs
                }
              }
            } else {
              console.log(`ActiveDevice: Device ${outletKey} is in combined group - skipping individual daily limit check (monthly limit takes precedence)`)
            }
          }
        }
      } catch (error) {
        console.error('ActiveDevice: Error in power limit monitor:', error)
      }
    }
    
    // Run functions immediately
    checkScheduleAndUpdateDevices()
    checkPowerLimitsAndTurnOffDevices()
    
    // Add manual test function for debugging
    ;(window as any).testSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).checkCurrentTime = () => {
      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()
      const currentDay = now.getDay()
      console.log('Current time debug:', {
        time: now.toLocaleTimeString(),
        minutes: currentTime,
        day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
        dayNumber: currentDay
      })
    }
    
    // Set up intervals
    const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds (more frequent for short schedules)
    const powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 30000) // 30 seconds (more frequent for power limits)
    
    // Cleanup intervals on unmount
    return () => {
      clearInterval(scheduleInterval)
      clearInterval(powerLimitInterval)
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
    }
  }, [])

  // Subscribe to CANORECO electricity rate (Region V - Camarines Norte) from Firebase Realtime Database
  // Expected structure:
  // rates/canoreco: { rate: number, updatedAt: string | number }
  useEffect(() => {
    const rateRef = ref(realtimeDb, 'rates/canoreco')
    const unsubscribe = onValue(rateRef, (snapshot) => {
      const data = snapshot.val()
      if (!data) return
      const nextRate = Number(data.rate ?? data.value)
      if (!Number.isNaN(nextRate) && nextRate > 0) {
        setCurrentRate(nextRate)
      }
      const ts = data.updatedAt ?? Date.now()
      try {
        const dt = typeof ts === 'number' ? new Date(ts) : new Date(ts)
        setLastRateUpdate(dt.toLocaleString('en-PH'))
      } catch {
        setLastRateUpdate(new Date().toLocaleString('en-PH'))
      }
    })
    return () => off(rateRef, 'value', unsubscribe)
  }, [])

  // Filter devices based on search query
  const filteredDevices = useMemo(() => {
    return activeDevices.filter(device =>
      device.outletName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      device.appliances.toLowerCase().includes(searchQuery.toLowerCase()) ||
      device.officeRoom.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [activeDevices, searchQuery])

  // Toggle device status (ON/OFF) - updates both relay status and main status
  // Now respects power limits before allowing devices to turn ON
  const toggleDeviceStatus = async (deviceId: string) => {
    try {
      const currentTime = Date.now()
      
      // Check if enough time has passed since last toggle
      if (currentTime - lastToggleTrigger < TOGGLE_DEBOUNCE_MS) {
        console.log(`Toggle blocked - too soon since last toggle (${currentTime - lastToggleTrigger}ms ago)`)
        return
      }
      
      // Check if device is already being updated
      if (updatingDevices.has(deviceId)) {
        console.log(`Toggle blocked - device ${deviceId} is already being updated`)
        return
      }
      
      const device = activeDevices.find(d => d.id === deviceId)
      if (!device) return

      // Set loading state and update last toggle trigger
      setUpdatingDevices(prev => new Set(prev).add(deviceId))
      setLastToggleTrigger(currentTime)

      const outletKey = device.outletName.replace(' ', '_')
      const currentControlState = device.controlState
      const currentMainStatus = device.mainStatus
      
      // Determine new statuses
      let newControlState: string
      let newMainStatus: string
      
      // If device is currently ON, turn it OFF
      if (currentControlState === 'on') {
        console.log(`ActiveDevice: Turning OFF ${outletKey} - no validation needed`)
        newControlState = 'off'
        newMainStatus = 'OFF'
      } else {
        // Device is currently OFF, so we want to turn it ON - run validation checks
        console.log(`ActiveDevice: Turning ON ${outletKey} - running validation checks`)
        // Get device data from Firebase to check today's energy consumption
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        const deviceData = deviceSnapshot.val()
        
        // Check if device is in a combined group
        const outletDisplayName = outletKey.replace('_', ' ')
        const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                 combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
        
        // Only check individual daily limit if device is NOT in combined group
        if (!isInCombinedGroup) {
          const powerLimit = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
          
          // Check if device has no power limit set
          if (powerLimit <= 0) {
            showModalSafely('noPowerLimit', { device })
            // Clear loading state before returning
            setUpdatingDevices(prev => {
              const newSet = new Set(prev)
              newSet.delete(deviceId)
              return newSet
            })
            return
          }
          
          // Get today's total energy consumption from daily_logs
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
          
          console.log(`Power limit check for ${outletKey}:`, {
            powerLimit: `${(powerLimit * 1000)}W`,
            todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
            todayDateKey: todayDateKey,
            exceedsLimit: todayTotalEnergy >= powerLimit,
            isInCombinedGroup: isInCombinedGroup
          })
          
          // Check if today's total energy consumption exceeds the power limit
          if (todayTotalEnergy >= powerLimit) {
            const currentTime = new Date().toLocaleTimeString()
            const currentDate = new Date().toLocaleDateString()
            
            showModalSafely('powerLimit', {
              device: {
                ...device,
                // Add additional info for the modal
                todayTotalEnergy: todayTotalEnergy,
                powerLimit: powerLimit,
                currentDate: currentDate,
                currentTime: currentTime
              }
            })
            // Clear loading state before returning
            setUpdatingDevices(prev => {
              const newSet = new Set(prev)
              newSet.delete(deviceId)
              return newSet
            })
            return
          }
        } else {
          console.log(`ActiveDevice: Skipping individual daily limit check for ${outletKey} - device is in combined group (monthly limit takes precedence)`)
        }
        
        // Check if device is within its scheduled time
        if (deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
          const isWithinSchedule = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInCombinedGroup)
          if (!isWithinSchedule) {
            const now = new Date()
            const currentTime = now.getHours() * 60 + now.getMinutes()
            const schedule = deviceData.schedule
            
            let reason = 'Device is outside its scheduled time.'
            
            if (schedule.timeRange && schedule.timeRange !== 'No schedule') {
              reason = `Device is outside its scheduled time (${schedule.timeRange}). Current time: ${now.toLocaleTimeString()}.`
            } else if (schedule.startTime && schedule.endTime) {
              reason = `Device is outside its scheduled time (${schedule.startTime} - ${schedule.endTime}). Current time: ${now.toLocaleTimeString()}.`
            }
            
            showModalSafely('scheduleConflict', {
              device: device,
              reason: reason
            })
            // Clear loading state before returning
            setUpdatingDevices(prev => {
              const newSet = new Set(prev)
              newSet.delete(deviceId)
              return newSet
            })
            return
          }
        }
        
        // Turn ON: set both control and main status to ON
        newControlState = 'on'
        newMainStatus = 'ON'
      }
      
      console.log(`Toggling ${outletKey} from control:${currentControlState}/main:${currentMainStatus} to control:${newControlState}/main:${newMainStatus}`)
      
      // Update both control state and main status in Firebase
      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
        device: newControlState
      })
      
      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
        main_status: newMainStatus
      })
      
      console.log(`Successfully toggled ${outletKey} to control:${newControlState}/main:${newMainStatus}`)
      
      // Log the device control activity
      const action = newControlState === 'on' ? 'Turn on outlet' : 'Turn off outlet'
      await logDeviceControlActivity(
        action,
        device.outletName,
        device.officeRoom || 'Unknown',
        device.appliances || 'Unknown'
      )
      
      // Show success modal
      const actionText = newControlState === 'on' ? 'turned ON' : 'turned OFF'
      showModalSafely('success', {
        deviceName: device.outletName,
        action: actionText
      })
    } catch (error) {
      console.error('Error toggling device:', error)
      const deviceName = activeDevices.find(d => d.id === deviceId)?.outletName || 'Unknown Device'
      showModalSafely('error', {
        message: `Failed to update device "${deviceName}". Please try again.`
      })
    } finally {
      // Clear loading state
      setUpdatingDevices(prev => {
        const newSet = new Set(prev)
        newSet.delete(deviceId)
        return newSet
      })
    }
  }

  // Get status badge styling (updated to match Dashboard.tsx)
  const getStatusBadge = (status: string) => {
    const statusClasses: { [key: string]: string } = {
      'Active': 'status-active',
      'Inactive': 'status-inactive',
      'Warning': 'status-warning',
      'Idle': 'status-idle'
    }
    
    const statusClass = statusClasses[status] || 'status-inactive'
    
    return (
      <span className={`status-badge ${statusClass}`}>
        <span className={`status-dot ${statusClass}`}></span>
        {status}
      </span>
    )
  }

  // Get schedule badge styling
  const getScheduleBadge = (days: string) => {
    return (
      <span className="schedule-badge">
        {days}
      </span>
    )
  }

  // Get toggle switch styling based on device status
  const getToggleSwitchClass = (device: Device) => {
    if (device.status === 'Active') {
      return 'toggle-switch active'
    } else {
      return 'toggle-switch inactive'
    }
  }

  // Success Modal Component
  const SuccessModal = () => {
    if (!successModal.isOpen) return null

    return (
      <div className="modal-overlay success-overlay" onClick={() => {
        setModalOpen(false)
        setSuccessModal({ isOpen: false, deviceName: '', action: '' })
      }}>
        <div className="active-device-success-modal" onClick={(e) => e.stopPropagation()}>
          <div className="active-device-success-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="#10b981" stroke="#10b981" strokeWidth="2"/>
              <path d="M9 12l2 2 4-4" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h3>Device Updated Successfully!</h3>
          <p>
            The device <strong>"{successModal.deviceName}"</strong> has been {successModal.action}.
          </p>
          <button 
            className="btn-primary" 
            onClick={() => {
              setModalOpen(false)
              setSuccessModal({ isOpen: false, deviceName: '', action: '' })
            }}
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  // Error Modal Component
  const ErrorModal = () => {
    if (!errorModal.isOpen) return null

    return (
      <div className="modal-overlay" onClick={() => {
        setModalOpen(false)
        setErrorModal({ isOpen: false, message: '' })
      }}>
        <div className="error-modal" onClick={(e) => e.stopPropagation()}>
          <div className="error-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="#fef2f2" stroke="#dc2626" strokeWidth="2"/>
              <path d="M15 9l-6 6M9 9l6 6" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <h3>Update Failed</h3>
          <p>{errorModal.message}</p>
          <button 
            className="btn-primary" 
            onClick={() => {
              setModalOpen(false)
              setErrorModal({ isOpen: false, message: '' })
            }}
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  // No Power Limit Modal Component
  const NoPowerLimitModal = () => {
    if (!noPowerLimitModal.isOpen || !noPowerLimitModal.device) return null

    const device = noPowerLimitModal.device

    return (
      <div className="modal-overlay warning-overlay" onClick={() => {
        setModalOpen(false)
        setNoPowerLimitModal({ isOpen: false, device: null })
      }}>
        <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
          <div className="warning-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
              <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
            </svg>
          </div>
          <h3>No Power Limit Set!</h3>
          <p><strong>"{device.outletName}" cannot be turned ON because it doesn't have a power limit set.</strong></p>
          <div className="warning-details">
            <div className="warning-stat">
              <span className="label">Current Usage:</span>
              <span className="value">{device.powerUsage}</span>
            </div>
            <div className="warning-stat">
              <span className="label">Power Limit:</span>
              <span className="value">No Power Limit Set</span>
            </div>
            <div className="warning-stat">
              <span className="label">Required Action:</span>
              <span className="value">Set Power Limit</span>
            </div>
          </div>
          <p className="warning-message">
            For safety reasons, devices must have a power limit before they can be activated. Please set a power limit in the Setup section.
          </p>
          <div className="modal-footer">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setModalOpen(false)
                setNoPowerLimitModal({ isOpen: false, device: null })
              }}
            >
              Understood
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Schedule Conflict Modal Component
  const ScheduleConflictModal = () => {
    if (!scheduleConflictModal.isOpen || !scheduleConflictModal.device) return null

    const device = scheduleConflictModal.device

    return (
      <div className="modal-overlay warning-overlay" onClick={() => {
        setModalOpen(false)
        setScheduleConflictModal({ isOpen: false, device: null, reason: '' })
      }}>
        <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
          <div className="warning-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
              <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" fill="#f59e0b"/>
            </svg>
          </div>
          <h3>Schedule Conflict</h3>
          <p><strong>"{device.outletName}" cannot be turned ON at this time.</strong></p>
          <div className="warning-details">
            <div className="warning-stat">
              <span className="label">Current Time:</span>
              <span className="value">{new Date().toLocaleTimeString()}</span>
            </div>
            <div className="warning-stat">
              <span className="label">Schedule:</span>
              <span className="value">{device.schedule?.time || 'No schedule'}</span>
            </div>
            <div className="warning-stat">
              <span className="label">Reason:</span>
              <span className="value">Outside scheduled time</span>
            </div>
          </div>
          <p className="warning-message">
            {scheduleConflictModal.reason}
          </p>
          <div className="modal-footer">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setModalOpen(false)
                setScheduleConflictModal({ isOpen: false, device: null, reason: '' })
              }}
            >
              Understood
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="active-device-container">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Loading devices...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="active-device-container">
      {/* Header Section */}
      <section className="active-device-hero">
        <div className="hero-left">
          <div className="hero-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 12l2 2 4-4" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="#ffffff" strokeWidth="2"/>
            </svg>
          </div>
          <div className="hero-text">
            <h1>Active Devices</h1>
            <p>Monitor and manage your connected devices</p>
          </div>
        </div>
        <div className="search-container">
          <div className="search-input-wrapper">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="11" cy="11" r="8" stroke="#9ca3af" strokeWidth="2"/>
              <path d="m21 21-4.35-4.35" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Search device"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
          </div>
        </div>
      </section>

      {/* Main Content */}
      <section className="active-device-content">
        <div className="table-container">
          <table className="devices-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>OUTLET NAME</th>
                <th>APPLIANCES</th>
                <th>OFFICE/ ROOM</th>
                <th>POWER USAGE</th>
                <th>STATUS</th>
                <th>TODAY'S USAGE</th>
                <th>SCHEDULE</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => (
                <tr key={device.id} className="device-row">
                  <td className="device-id">{device.id}</td>
                  <td className="outlet-name">
                    <button 
                      className="outlet-name-btn"
                      onClick={() => {
                        if (!modalOpen) {
                          setModalOpen(true)
                          setHistoryModal({ isOpen: true, device })
                          fetchHistoryData(device)
                        }
                      }}
                      disabled={modalOpen}
                      title="View outlet history"
                    >
                      {device.outletName}
                    </button>
                  </td>
                  <td className="appliances">{device.appliances}</td>
                  <td className="office-room">{device.officeRoom}</td>
                  <td className="power-usage">{device.powerUsage}</td>
                  <td className="status-cell">
                    {getStatusBadge(device.status)}
                  </td>
                  <td className="today-usage">{device.todayUsage}</td>
                  <td className="schedule-cell">
                    <div className="schedule-info">
                      <span className="schedule-time">{device.schedule.time}</span>
                      {device.schedule.days !== 'No schedule' && (
                        getScheduleBadge(device.schedule.days)
                      )}
                    </div>
                  </td>
                  <td className="action-cell">
                    <label className={`${getToggleSwitchClass(device)} ${updatingDevices.has(device.id) ? 'loading' : ''}`}>
                      <input
                        type="checkbox"
                        checked={device.status === 'Active'}
                        onChange={() => toggleDeviceStatus(device.id)}
                        className="toggle-input"
                        disabled={updatingDevices.has(device.id) || modalOpen}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {filteredDevices.length === 0 && (
            <div className="no-devices">
              <div className="no-devices-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 12l2 2 4-4" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="#9ca3af" strokeWidth="2"/>
                </svg>
              </div>
              <h3>No devices found</h3>
              <p>No devices match your search criteria "{searchQuery}"</p>
            </div>
          )}
        </div>
      </section>

      {/* Success Modal */}
      <SuccessModal />
      
      {/* Error Modal */}
      <ErrorModal />

      {/* No Power Limit Modal */}
      <NoPowerLimitModal />

      {/* Schedule Conflict Modal */}
      <ScheduleConflictModal />

      {/* Power Limit Warning Modal */}
      {powerLimitModal.isOpen && (
        <div className="modal-overlay" onClick={() => {
          setModalOpen(false)
          setPowerLimitModal({ isOpen: false, device: null })
        }}>
          <div className="modal-content power-limit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-icon warning">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
                  <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
                </svg>
              </div>
              <h3>Power Limit Exceeded!</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setModalOpen(false)
                  setPowerLimitModal({ isOpen: false, device: null })
                }}
                aria-label="Close modal"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p>
                <strong>"{powerLimitModal.device?.outletName}"</strong> cannot be turned ON because today's energy consumption has exceeded the power limit.
              </p>
              <div className="power-limit-details">
                <div className="limit-stat">
                  <span className="label">Today's Energy:</span>
                  <span className="value">{formatNumber(((powerLimitModal.device as any)?.todayTotalEnergy * 1000) || 0)} Wh</span>
                </div>
                <div className="limit-stat">
                  <span className="label">Power Limit:</span>
                  <span className="value">{((powerLimitModal.device as any)?.powerLimit * 1000) || '0'} Wh</span>
                </div>
                <div className="limit-stat">
                  <span className="label">Date:</span>
                  <span className="value">{(powerLimitModal.device as any)?.currentDate || new Date().toLocaleDateString()}</span>
                </div>
                <div className="limit-stat">
                  <span className="label">Time:</span>
                  <span className="value">{(powerLimitModal.device as any)?.currentTime || new Date().toLocaleTimeString()}</span>
                </div>
              </div>
              <p className="warning-message">
                Today's total energy consumption has reached or exceeded the daily power limit. The device cannot be activated until tomorrow or the power limit is increased.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setModalOpen(false)
                  setPowerLimitModal({ isOpen: false, device: null })
                }}
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Outlet History Modal */}
      {historyModal.isOpen && historyModal.device && (
        <div className="modal-overlay" onClick={() => {
          setModalOpen(false)
          setHistoryModal({ isOpen: false, device: null })
        }}>
          <div className="modal-content history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-icon history">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" fill="#dbeafe" stroke="#3b82f6" strokeWidth="2"/>
                  <polyline points="12,6 12,12 16,14" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3>Outlet History</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setModalOpen(false)
                  setHistoryModal({ isOpen: false, device: null })
                }}
                aria-label="Close modal"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            
            <div className="modal-body">
              {/* Device Info */}
              <div className="device-info">
                <h4>{historyModal.device.outletName}</h4>
                <div className="device-details">
                  <span className="appliance-type">{historyModal.device.appliances}</span>
                  <span className="separator">•</span>
                  <span className="office-room">{historyModal.device.officeRoom}</span>
                </div>
              </div>

              {/* Time Segment Filter */}
              <div className="time-segment-filter">
                <label>Filter by:</label>
                <div className="time-segments">
                  <button 
                    className={`segment-btn ${timeSegment === 'Day' ? 'active' : ''}`} 
                    onClick={() => {
                      setTimeSegment('Day')
                      fetchHistoryData(historyModal.device!)
                    }}
                  >
                    Day
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Week' ? 'active' : ''}`} 
                    onClick={() => {
                      setTimeSegment('Week')
                      fetchHistoryData(historyModal.device!)
                    }}
                  >
                    Week
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Month' ? 'active' : ''}`} 
                    onClick={() => {
                      setTimeSegment('Month')
                      fetchHistoryData(historyModal.device!)
                    }}
                  >
                    Month
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Year' ? 'active' : ''}`} 
                    onClick={() => {
                      setTimeSegment('Year')
                      fetchHistoryData(historyModal.device!)
                    }}
                  >
                    Year
                  </button>
                </div>
              </div>

              {/* Summary Stats */}
              <div className="history-summary">
                <div className="summary-card">
                  <div className="summary-icon energy">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div className="summary-content">
                    <div className="summary-label">Total Energy</div>
                    <div className="summary-value">{formatNumber(historyData.totalEnergy * 1000)} Wh</div>
                  </div>
                </div>
                
                <div className="summary-card">
                  <div className="summary-icon cost">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <line x1="10" y1="9" x2="8" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div className="summary-content">
                    <div className="summary-label">Total Cost</div>
                    <div className="summary-value">₱{formatNumber(historyData.totalCost, 2)}</div>
                  </div>
                </div>
              </div>

              {/* History Table */}
              <div className="history-table-container">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Energy (Wh)</th>
                      <th>Cost (₱)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyData.dailyData.length > 0 ? (
                      historyData.dailyData.map((day, index) => (
                        <tr key={index}>
                          <td className="date-cell">
                            {new Date(day.date).toLocaleDateString('en-US', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            })}
                          </td>
                          <td className="energy-cell">{formatNumber(day.energy * 1000)}</td>
                          <td className="cost-cell">₱{formatNumber(day.cost, 2)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="no-data">
                          No data available for the selected time period
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Rate Information */}
              <div className="rate-info">
                <div className="rate-label">Electricity Rate:</div>
                <div className="rate-value">₱{formatNumber(currentRate, 2)} per kWh</div>
                {lastRateUpdate && (
                  <div className="rate-update" style={{ fontSize: '10px', marginTop: '4px', opacity: 0.7 }}>
                    Last updated: {lastRateUpdate}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setModalOpen(false)
                  setHistoryModal({ isOpen: false, device: null })
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

