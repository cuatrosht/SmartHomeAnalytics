import React, { useState, useEffect } from 'react'
import { ref, get, onValue, off, set, update } from 'firebase/database'
import { realtimeDb } from '../firebase/config'
import { logScheduleActivity } from '../utils/deviceLogging'
import './Schedule.css'

// Function to calculate total monthly energy for combined limit group
const calculateCombinedMonthlyEnergy = (devicesData: any, selectedOutlets: string[]): number => {
  try {
    // Get current month and year
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    let totalCombinedMonthlyEnergy = 0
    
    // Use a Set to track processed outlets and avoid duplicates
    const processedOutlets = new Set<string>()
    
    console.log('🔍 MONTHLY ENERGY CALCULATION:', {
      currentYear,
      currentMonth,
      daysInMonth,
      selectedOutlets: [...new Set(selectedOutlets)], // Remove duplicates
      totalOutlets: selectedOutlets.length,
      uniqueOutlets: [...new Set(selectedOutlets)].length
    })
    
    // Process each outlet in the combined limit group
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
        let daysWithData = 0
        
        // Sum up energy for all days in the current month
        for (let day = 1; day <= daysInMonth; day++) {
          const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
          const dayData = outlet.daily_logs[dateKey]
          
          if (dayData && dayData.total_energy && dayData.total_energy > 0) {
            // total_energy is in kW, convert to watts
            const dayEnergyWatts = dayData.total_energy * 1000
            outletMonthlyEnergy += dayEnergyWatts
            daysWithData++
            console.log(`📊 ${outletKey} Day ${day}: ${dayData.total_energy} kW = ${dayEnergyWatts} W`)
          }
        }
        
        totalCombinedMonthlyEnergy += outletMonthlyEnergy
        console.log(`📊 ${outletKey} MONTHLY TOTAL: ${outletMonthlyEnergy} W (${daysWithData} days with data)`)
      } else {
        console.log(`❌ ${outletKey}: device not found or no daily_logs`)
        if (outlet) {
          console.log(`🔍 Available fields:`, Object.keys(outlet))
        }
      }
    })
    
    console.log(`📊 FINAL COMBINED MONTHLY ENERGY: ${totalCombinedMonthlyEnergy} W`)
    console.log(`📊 Processed ${processedOutlets.size} unique outlets`)
    
    return totalCombinedMonthlyEnergy
  } catch (error) {
    console.error('❌ Error calculating combined monthly energy:', error)
    return 0
  }
}

// Auto-turnoff functions for non-idle devices (currently unused)
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


// Function to check and enforce combined monthly limits
const checkCombinedMonthlyLimit = async (devicesData: any, combinedLimitInfo: any) => {
  try {
    console.log('🔍 Monthly limit check - Input data:', {
      combinedLimitInfo,
      devicesDataKeys: Object.keys(devicesData || {}),
      enabled: combinedLimitInfo?.enabled,
      selectedOutlets: combinedLimitInfo?.selectedOutlets,
      combinedLimit: combinedLimitInfo?.combinedLimit
    })
    
    if (!combinedLimitInfo?.enabled || !combinedLimitInfo?.selectedOutlets || combinedLimitInfo.selectedOutlets.length === 0) {
      console.log('🚫 Monthly limit check skipped - not enabled or no outlets selected')
      return
    }
    
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const combinedLimitWatts = combinedLimitInfo.combinedLimit
    
    console.log('📊 Monthly limit check results:', {
      totalMonthlyEnergy: `${formatNumber(totalMonthlyEnergy)}W`,
      combinedLimitWatts: combinedLimitWatts === "No Limit" ? "No Limit" : `${combinedLimitWatts === "No Limit" ? "No Limit" : `${combinedLimitWatts}W`}`,
      selectedOutlets: combinedLimitInfo.selectedOutlets,
      exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts,
      percentage: (combinedLimitWatts !== "No Limit" && combinedLimitWatts > 0) ? `${((totalMonthlyEnergy / combinedLimitWatts) * 100).toFixed(1)}%` : 'N/A'
    })
    
    // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
    // Skip limit check if "No Limit" is set
    if (combinedLimitWatts === "No Limit") {
      console.log('📊 Combined limit is set to "No Limit" - skipping monthly limit check')
      return
    }
    
    if (totalMonthlyEnergy >= combinedLimitWatts) {
      console.log('🚨 MONTHLY LIMIT EXCEEDED!')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts === "No Limit" ? "No Limit" : `${combinedLimitWatts}W`}`)
      console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP...')
      
      // Turn off all devices in the combined limit group (respecting override/bypass mode)
      const turnOffPromises = combinedLimitInfo.selectedOutlets.map(async (outletKey: string) => {
        try {
          // Convert display format to Firebase format
          const firebaseKey = outletKey.replace(' ', '_')
          const deviceData = devicesData[firebaseKey]
          
          // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
          const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
          if (currentMainStatus === 'ON') {
            console.log(`⚠️ Schedule: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
            return { outletKey, success: true, skipped: true, reason: 'Bypass mode active' }
          }
          
          // Turn off device control
          const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
          await update(controlRef, { device: 'off' })
          
          // Turn off main status to prevent immediate re-activation
          const mainStatusRef = ref(realtimeDb, `devices/${firebaseKey}/relay_control`)
          await update(mainStatusRef, { main_status: 'OFF' })
          
          console.log(`✅ Schedule: TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
          
          // Note: Automatic monthly limit enforcement is not logged to avoid cluttering device logs
          
          return { outletKey, success: true }
        } catch (error) {
          console.error(`❌ Schedule: FAILED to turn off ${outletKey}:`, error)
          return { outletKey, success: false, error }
        }
      })
      
      // Wait for all turn-off operations to complete
      const results = await Promise.all(turnOffPromises)
      const successCount = results.filter(r => r.success && !r.skipped).length
      const skippedCount = results.filter(r => r.skipped).length
      const failCount = results.filter(r => !r.success && !r.skipped).length
      
      console.log(`🔒 Schedule: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
    } else {
      console.log('✅ Monthly limit not exceeded - devices can remain active')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts === "No Limit" ? "No Limit" : `${combinedLimitWatts}W`}`)
    }
  } catch (error) {
    console.error('❌ Error checking combined monthly limit:', error)
  }
}

// Function to check if turning ON a device would exceed the monthly limit
const checkMonthlyLimitBeforeTurnOn = async (outletKey: string, combinedLimitInfo: any): Promise<{
  canTurnOn: boolean;
  reason?: string;
  currentMonthlyEnergy?: number;
  combinedLimit?: number;
}> => {
  try {
    if (!combinedLimitInfo?.enabled || !combinedLimitInfo?.selectedOutlets || combinedLimitInfo.selectedOutlets.length === 0) {
      return { canTurnOn: true }
    }
    
    // Check if this device is part of the combined limit group
    if (!combinedLimitInfo.selectedOutlets.includes(outletKey)) {
      return { canTurnOn: true }
    }
    
    // Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const devicesSnapshot = await get(devicesRef)
    
    if (!devicesSnapshot.exists()) {
      return { canTurnOn: true }
    }
    
    const devicesData = devicesSnapshot.val()
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const combinedLimitWatts = combinedLimitInfo.combinedLimit
    
    console.log('Monthly limit check before turn ON:', {
      outletKey,
      totalMonthlyEnergy,
      combinedLimitWatts,
      selectedOutlets: combinedLimitInfo.selectedOutlets,
      wouldExceed: totalMonthlyEnergy >= combinedLimitWatts
    })
    
    // Check if turning ON this device would exceed the monthly limit
    // Skip limit check if "No Limit" is set
    if (combinedLimitWatts === "No Limit") {
      console.log('📊 Combined limit is set to "No Limit" - allowing device to turn on')
      return {
        canTurnOn: true,
        reason: 'No monthly limit set',
        currentMonthlyEnergy: totalMonthlyEnergy,
        combinedLimit: combinedLimitWatts
      }
    }
    
    if (totalMonthlyEnergy >= combinedLimitWatts) {
      return {
        canTurnOn: false,
        reason: `Monthly limit exceeded. Current monthly energy: ${(totalMonthlyEnergy / 1000).toFixed(3)} kW, Limit: ${(combinedLimitWatts / 1000).toFixed(3)} kW`,
        currentMonthlyEnergy: totalMonthlyEnergy,
        combinedLimit: combinedLimitWatts
      }
    }
    
    return { canTurnOn: true }
  } catch (error) {
    console.error('Error checking monthly limit before turn ON:', error)
    return { canTurnOn: true } // Allow turn ON if there's an error
  }
}

interface DeviceData {
  id: string
  outletName: string
  appliances: string
  officeRoom: string
  powerUsage: string
  currentAmpere: string
  status: 'Active' | 'Inactive' | 'Blocked' | 'Idle' | 'UNPLUG'
  todaysUsage: string
  limit: string
  schedule: {
    timeRange: string
    frequency: string
    startTime?: string
    endTime?: string
    combinedScheduleId?: string
    isCombinedSchedule?: boolean
    selectedOutlets?: string[]
    disabled_by_unplug?: boolean
    basis?: number
  }
  controlState: string
  mainStatus: string
  enablePowerScheduling: boolean
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
      power_limit: number | string
    }
    status: string
    main_status?: string // Added main status field
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
    combinedScheduleId?: string
    isCombinedSchedule?: boolean
    selectedOutlets?: string[]
    disabled_by_unplug?: boolean
    basis?: number
  }
}

interface EditScheduleModalProps {
  isOpen: boolean
  onClose: () => void
  device: DeviceData | null
  onSave: (deviceId: string, updatedSchedule: {
    timeRange: string
    frequency: string
  }) => void
  onLimitExceeded: (deviceName: string, limitType: 'individual' | 'combined', currentUsage: number, limitValue: number, scheduleTime: string) => void
}




// Helper function to get today's date in the format used in your database
const getTodayDateKey = (): string => {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `day_${year}_${month}_${day}`
}

// Helper function to format numbers with commas
const formatNumber = (num: number, decimals: number = 3): string => {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}


// Helper function to check if device should be active based on schedule
// Copied from ActiveDevice.tsx - working version
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
  
  // Log exact time checking for debugging
  if (schedule.timeRange || (schedule.startTime && schedule.endTime)) {
    const currentTimeStr = `${Math.floor(currentTime / 60).toString().padStart(2, '0')}:${(currentTime % 60).toString().padStart(2, '0')}`
    const endTimeStr = `${Math.floor(endTime / 60).toString().padStart(2, '0')}:${(endTime % 60).toString().padStart(2, '0')}`
    
    if (currentTime >= endTime) {
      console.log(`⏰ END TIME REACHED: Device should be OFF (current: ${currentTimeStr}, end: ${endTimeStr})`)
    } else if (currentTime === endTime - 1) {
      console.log(`⏰ ONE MINUTE TO END: Device will turn OFF at ${endTimeStr} (current: ${currentTimeStr})`)
    }
  }

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
  
  // Handle specific cases
  if (formatted.toLowerCase().includes('computer lab')) {
    return formatted.replace(/computer lab/i, 'Computer Laboratory')
  }
  
  if (formatted.toLowerCase().includes('deans office')) {
    return formatted.replace(/deans office/i, "Dean's Office")
  }
  
  return formatted
}

// Helper function to format frequency display
const formatFrequencyDisplay = (frequency: string): string => {
  if (!frequency) return ''
  
  const freq = frequency.toLowerCase()
  if (freq === 'weekdays') return 'Weekdays'
  if (freq === 'weekends') return 'Weekends'
  
  // Handle custom days format: M,T,W,TH,SAT,SUN
  const dayMap: { [key: string]: string } = {
    'monday': 'M',
    'tuesday': 'T',
    'wednesday': 'W',
    'thursday': 'TH',
    'friday': 'F',
    'saturday': 'SAT',
    'sunday': 'SUN'
  }
  
  const days = frequency.split(', ').map(day => dayMap[day.toLowerCase()] || day)
  return days.join(',')
}



// Limit Exceeded Modal Component
function LimitExceededModal({ 
  isOpen, 
  onClose, 
  deviceName,
  limitType,
  currentUsage,
  limitValue,
  scheduleTime
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  deviceName: string;
  limitType: 'individual' | 'combined';
  currentUsage: number;
  limitValue: number;
  scheduleTime: string;
}) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content limit-exceeded-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>⚠️ Limit Exceeded</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="warning-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          
            <div className="warning-content">
              <h4>Cannot Save Schedule</h4>
              <p>
                The following outlet(s) would exceed the {limitType} power limit:
              </p>
              
              <div className="exceeding-outlets">
                <strong>{deviceName}</strong>
              </div>
              
              <div className="limit-details">
                <div className="detail-row">
                  <span className="label">Schedule Time:</span>
                  <span className="value">{scheduleTime}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Current Usage:</span>
                  <span className="value">{currentUsage.toFixed(3)} Wh</span>
                </div>
                <div className="detail-row">
                  <span className="label">{limitType === 'individual' ? 'Individual' : 'Combined'} Limit:</span>
                  <span className="value">{limitValue.toFixed(3)} Wh</span>
                </div>
                <div className="detail-row">
                  <span className="label">Excess:</span>
                  <span className="value excess">{((currentUsage - limitValue)).toFixed(3)} Wh</span>
                </div>
              </div>
              
              <div className="warning-message">
                <p>
                  {limitType === 'individual' 
                    ? 'Please adjust the schedule time or increase the individual power limit for the exceeding outlet(s) before saving.'
                    : 'Please adjust the schedule time or increase the power limit for the exceeding outlet(s) before saving.'
                  }
                </p>
              </div>
            </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// Edit Schedule Modal Component
function EditScheduleModal({ isOpen, onClose, device, onSave, onLimitExceeded }: EditScheduleModalProps) {
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [selectedDays, setSelectedDays] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const daysOfWeek = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']

  // Populate form with existing schedule data when device changes
  useEffect(() => {
    if (device && device.schedule) {
      const schedule = device.schedule
      
      // Set start and end times from timeRange or startTime/endTime
      if (schedule.timeRange) {
        // Parse timeRange format (e.g., "7:05 AM - 7:10 AM")
        const [startTimeStr, endTimeStr] = schedule.timeRange.split(' - ')
        setStartTime(convertTo24Hour(startTimeStr))
        setEndTime(convertTo24Hour(endTimeStr))
      } else if (schedule.startTime && schedule.endTime) {
        // Use startTime and endTime directly if available (24-hour format)
        setStartTime(schedule.startTime)
        setEndTime(schedule.endTime)
      }
      
      // Set selected days from frequency
      if (schedule.frequency) {
        // Parse frequency format (e.g., "M,T,W" or "MONDAY,TUESDAY,WEDNESDAY")
        const frequency = schedule.frequency
        if (frequency.includes(',')) {
          const dayMap: { [key: string]: string } = {
            'SUN': 'SUNDAY', 'SUNDAY': 'SUNDAY',
            'MON': 'MONDAY', 'MONDAY': 'MONDAY', 'M': 'MONDAY',
            'TUE': 'TUESDAY', 'TUESDAY': 'TUESDAY', 'T': 'TUESDAY',
            'WED': 'WEDNESDAY', 'WEDNESDAY': 'WEDNESDAY', 'W': 'WEDNESDAY',
            'THU': 'THURSDAY', 'THURSDAY': 'THURSDAY', 'TH': 'THURSDAY',
            'FRI': 'FRIDAY', 'FRIDAY': 'FRIDAY', 'F': 'FRIDAY',
            'SAT': 'SATURDAY', 'SATURDAY': 'SATURDAY'
          }
          
          const days = frequency.split(',').map(day => {
            const trimmedDay = day.trim().toUpperCase()
            return dayMap[trimmedDay] || trimmedDay
          }).filter(day => daysOfWeek.includes(day))
          
          setSelectedDays(days)
        } else if (frequency.toLowerCase() === 'weekdays') {
          setSelectedDays(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'])
        } else if (frequency.toLowerCase() === 'weekends') {
          setSelectedDays(['SATURDAY', 'SUNDAY'])
        } else if (frequency.toLowerCase() === 'daily') {
          setSelectedDays(daysOfWeek)
        } else {
          // Handle single day or other formats
          const dayMap: { [key: string]: string } = {
            'SUN': 'SUNDAY', 'SUNDAY': 'SUNDAY',
            'MON': 'MONDAY', 'MONDAY': 'MONDAY', 'M': 'MONDAY',
            'TUE': 'TUESDAY', 'TUESDAY': 'TUESDAY', 'T': 'TUESDAY',
            'WED': 'WEDNESDAY', 'WEDNESDAY': 'WEDNESDAY', 'W': 'WEDNESDAY',
            'THU': 'THURSDAY', 'THURSDAY': 'THURSDAY', 'TH': 'THURSDAY',
            'FRI': 'FRIDAY', 'FRIDAY': 'FRIDAY', 'F': 'FRIDAY',
            'SAT': 'SATURDAY', 'SATURDAY': 'SATURDAY'
          }
          const mappedDay = dayMap[frequency.toUpperCase()] || frequency.toUpperCase()
          if (daysOfWeek.includes(mappedDay)) {
            setSelectedDays([mappedDay])
          } else {
            setSelectedDays([])
          }
        }
      } else {
        setSelectedDays([])
      }
    } else {
      // Reset form when no device
      setStartTime('')
      setEndTime('')
      setSelectedDays([])
    }
    setErrors({})
  }, [device])

  // Get timezone abbreviation
  const getTimezoneAbbr = () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const date = new Date()
    const timeZoneAbbr = date.toLocaleTimeString('en-US', { 
      timeZoneName: 'short',
      timeZone 
    }).split(' ').pop()
    return timeZoneAbbr || 'UTC'
  }

  // Convert 12-hour time to 24-hour for input
  const convertTo24Hour = (time12h: string) => {
    if (!time12h) return ''
    const [time, modifier] = time12h.split(' ')
    let [hours, minutes] = time.split(':')
    
    if (hours === '12') {
      hours = '00'
    }
    
    if (modifier === 'PM') {
      hours = String(parseInt(hours, 10) + 12)
    }
    
    return `${hours.padStart(2, '0')}:${minutes}`
  }

  // Convert 24-hour time to 12-hour for display
  const convertTo12Hour = (time24h: string) => {
    if (!time24h) return ''
    const [hours, minutes] = time24h.split(':')
    const hour = parseInt(hours, 10)
    const ampm = hour >= 12 ? 'PM' : 'AM'
    const hour12 = hour % 12 || 12
    return `${hour12}:${minutes} ${ampm}`
  }




  const handleDayToggle = (day: string) => {
    setSelectedDays(prev => 
      prev.includes(day) 
        ? prev.filter(d => d !== day)
        : [...prev, day]
    )
    // Clear error when user makes changes
    if (errors.days) {
      setErrors(prev => ({ ...prev, days: '' }))
    }
  }

  const handleTimeChange = (field: 'start' | 'end', value: string) => {
    if (field === 'start') {
      setStartTime(value)
    } else {
      setEndTime(value)
    }
    // Clear errors when user makes changes
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const validateForm = () => {
    const newErrors: Record<string, string> = {}
    
    if (!startTime) newErrors.start = 'Start time is required'
    if (!endTime) newErrors.end = 'End time is required'
    if (selectedDays.length === 0) newErrors.days = 'Please select at least one day'
    
    if (startTime && endTime) {
      const start = new Date(`2000-01-01T${startTime}`)
      const end = new Date(`2000-01-01T${endTime}`)
      if (start >= end) {
        newErrors.end = 'End time must be after start time'
      }
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (validateForm() && device) {
      // Convert 24-hour format back to 12-hour for display
      const timeRange = `${convertTo12Hour(startTime)} - ${convertTo12Hour(endTime)}`
      
      // Determine frequency based on selected days
      let frequency = selectedDays.join(', ')
      if (selectedDays.length === 7) {
        frequency = 'Daily'
      } else if (selectedDays.length === 5 && 
                 selectedDays.includes('MONDAY') && 
                 selectedDays.includes('TUESDAY') && 
                 selectedDays.includes('WEDNESDAY') && 
                 selectedDays.includes('THURSDAY') && 
                 selectedDays.includes('FRIDAY')) {
        frequency = 'Weekdays'
      } else if (selectedDays.length === 2 && 
                 selectedDays.includes('SATURDAY') && 
                 selectedDays.includes('SUNDAY')) {
        frequency = 'Weekends'
      }
      
      // Check limit before saving
      try {
        const outletKey = device.outletName.replace(' ', '_')
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        
        if (deviceSnapshot.exists()) {
          const deviceData = deviceSnapshot.val()
          
          // Get today's energy consumption
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
          const todayTotalEnergyWh = todayTotalEnergy * 1000 // Convert to Wh
          
          // Check if device is part of combined limit group
          const deviceOutletName = device.outletName || ''
          const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
          
          // Get combined limit info from parent component
          const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
          const combinedLimitSnapshot = await get(combinedLimitRef)
          const combinedLimitData = combinedLimitSnapshot.exists() ? combinedLimitSnapshot.val() : null
          
          const combinedLimitWh = combinedLimitData?.combinedLimit || 0
          const hasValidCombinedLimit = combinedLimitData?.enabled && combinedLimitWh > 0
          const isInCombinedGroup = hasValidCombinedLimit && 
            (combinedLimitData?.selectedOutlets?.includes(deviceOutletName) || 
             combinedLimitData?.selectedOutlets?.includes(deviceOutletNameWithSpace))
          
          if (isInCombinedGroup) {
            // Check combined limit
            if (todayTotalEnergyWh >= combinedLimitWh) {
              onLimitExceeded(
                device.outletName,
                'combined',
                todayTotalEnergyWh,
                combinedLimitWh,
                timeRange
              )
              return
            }
          } else {
            // Check individual limit
            const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
            const powerLimitWh = powerLimit * 1000 // Convert from kW to Wh
            
            if (powerLimitWh > 0 && todayTotalEnergyWh >= powerLimitWh) {
              onLimitExceeded(
                device.outletName,
                'individual',
                todayTotalEnergyWh,
                powerLimitWh,
                timeRange
              )
              return
            }
          }
        }
      } catch (error) {
        console.error('Error checking limit validation:', error)
        // Continue with save if limit check fails
      }
      
      onSave(device.id, {
        timeRange,
        frequency
      })
    }
  }

  const handleClose = () => {
    setErrors({})
    onClose()
  }

  // Get selected days display text
  const getSelectedDaysText = () => {
    if (selectedDays.length === 0) return 'No days selected'
    if (selectedDays.length === 7) return 'All days'
    if (selectedDays.length === 5 && 
        selectedDays.includes('MONDAY') && 
        selectedDays.includes('TUESDAY') && 
        selectedDays.includes('WEDNESDAY') && 
        selectedDays.includes('THURSDAY') && 
        selectedDays.includes('FRIDAY')) {
      return 'Weekdays'
    }
    if (selectedDays.length === 2 && 
        selectedDays.includes('SATURDAY') && 
        selectedDays.includes('SUNDAY')) {
      return 'Weekends'
    }
    return selectedDays.join(', ')
  }

  if (!isOpen || !device) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content edit-schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Edit Schedule</h3>
          <button
            type="button"
            className="modal-close"
            onClick={handleClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Device Info */}
            <div className="device-info">
              <div className="device-name">{device.outletName}</div>
              <div className="device-details">
                <span className="appliance-type">{device.appliances}</span>
                <span className="separator">•</span>
                <span className="office-room">{device.officeRoom}</span>
              </div>
            </div>

            {/* Time Selection */}
            <div className="time-section">
              <div className={`time-input-group ${errors.start ? 'error' : ''}`}>
                <label htmlFor="startTime">Start Time</label>
                <div className="time-input-wrapper">
                  <input
                    type="time"
                    id="startTime"
                    value={startTime}
                    onChange={(e) => handleTimeChange('start', e.target.value)}
                    className="time-input"
                    required
                  />
                </div>
                <div className="timezone-info">{getTimezoneAbbr()}</div>
                {errors.start && <span className="error-message">{errors.start}</span>}
              </div>

              <div className={`time-input-group ${errors.end ? 'error' : ''}`}>
                <label htmlFor="endTime">End Time</label>
                <div className="time-input-wrapper">
                  <input
                    type="time"
                    id="endTime"
                    value={endTime}
                    onChange={(e) => handleTimeChange('end', e.target.value)}
                    className="time-input"
                    required
                  />

                </div>
                <div className="timezone-info">{getTimezoneAbbr()}</div>
                {errors.end && <span className="error-message">{errors.end}</span>}
              </div>
            </div>

            {/* Divider */}
            <div className="form-divider"></div>

            {/* Day Selection */}
            <div className={`day-selection ${errors.days ? 'error' : ''}`}>
              <label>Day's Applied:</label>
              <div className="days-grid">
                {daysOfWeek.map((day) => (
                  <div
                    key={day}
                    className={`day-option ${selectedDays.includes(day) ? 'selected' : ''}`}
                    onClick={() => handleDayToggle(day)}
                  >
                    <div className="day-checkbox">
                      {selectedDays.includes(day) && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <polyline points="20,6 9,17 4,12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <span className="day-label">{day}</span>
                  </div>
                ))}
              </div>
              {errors.days && <span className="error-message">{errors.days}</span>}
            </div>

            {/* Selected Days Summary */}
            <div className="selected-days-summary">
              <div className="summary-label">Selected Schedule:</div>
              <div className="summary-content">
                <div className="summary-time">
                  {startTime && endTime ? `${convertTo12Hour(startTime)} - ${convertTo12Hour(endTime)}` : 'No time set'}
                </div>
                <div className="summary-days">
                  {getSelectedDaysText()}
                </div>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!startTime || !endTime || selectedDays.length === 0}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Delete Confirmation Modal Component
function DeleteConfirmModal({ 
  isOpen, 
  onClose, 
  onConfirm, 
  deviceName 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  onConfirm: () => void; 
  deviceName: string;
}) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="warning-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
              <path d="M12 8v4M12 16h.01" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <h3>Delete Schedule</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p>Are you sure you want to delete the schedule for <strong>"{deviceName}"</strong>?</p>
          <p className="warning-text">This action cannot be undone.</p>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={onConfirm}
          >
            Delete Schedule
          </button>
        </div>
      </div>
    </div>
  )
}

// Power Scheduling Not Allowed Modal Component
function PowerSchedulingNotAllowedModal({ 
  isOpen, 
  onClose, 
  deviceName 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  deviceName: string;
}) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay warning-overlay" onClick={onClose}>
      <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
        <div className="warning-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
            <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
          </svg>
        </div>
        <h3>Power Scheduling Not Allowed</h3>
        <p><strong>"{deviceName}"</strong> does not have power scheduling enabled.</p>
        <div className="warning-details">
          <div className="warning-stat">
            <span className="label">Device:</span>
            <span className="value">{deviceName}</span>
          </div>
          <div className="warning-stat">
            <span className="label">Status:</span>
            <span className="value">Power Scheduling Disabled</span>
          </div>
        </div>
        <p className="warning-message">To enable scheduling for this device, please go to the Setup section and enable "Power Scheduling" when adding or editing the device.</p>
        <button className="btn-warning" onClick={onClose}>
          Understood
        </button>
      </div>
    </div>
  )
}

// Combined Schedule Warning Modal Component
function CombinedScheduleWarningModal({ 
  isOpen, 
  onClose, 
  deviceName,
  combinedOutlets
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  deviceName: string;
  combinedOutlets: string[];
}) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay warning-overlay" onClick={onClose}>
      <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
        <div className="warning-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
            <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" fill="#f59e0b"/>
          </svg>
        </div>
        <h3>Multiple Schedule Active</h3>
        <p><strong>"{deviceName}"</strong> is currently part of a combined schedule and cannot have an individual schedule.</p>
        <div className="warning-details">
          <div className="warning-stat">
            <span className="label">Device:</span>
            <span className="value">{deviceName}</span>
          </div>
          <div className="warning-stat">
            <span className="label">Combined Outlets:</span>
            <span className="value">{combinedOutlets.length} outlets</span>
          </div>
          <div className="warning-stat">
            <span className="label">Combined With:</span>
            <span className="value">{combinedOutlets.map(outlet => outlet.replace('_', ' ')).join(', ')}</span>
          </div>
        </div>
        <p className="warning-message">
          To edit the schedule for this device, please use the "Edit Multiple Schedule" button to modify the combined schedule, or remove this device from the combined schedule first.
        </p>
        <button className="btn-warning" onClick={onClose}>
          Understood
        </button>
      </div>
    </div>
  )
}

// Success Modal Component
function SuccessModal({ 
  isOpen, 
  onClose, 
  deviceName 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  deviceName: string;
}) {
  if (!isOpen) return null

  const isDeleteMessage = deviceName.includes('schedule deleted')
  const displayName = isDeleteMessage ? deviceName.replace(' schedule deleted', '') : deviceName

  return (
    <div className="modal-overlay success-overlay" onClick={onClose}>
      <div className="schedule-success-modal" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-success-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#10b981" stroke="#10b981" strokeWidth="2"/>
            <path d="M9 12l2 2 4-4" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h3>{isDeleteMessage ? 'Schedule Deleted Successfully!' : 'Schedule Updated Successfully!'}</h3>
        <p>
          {isDeleteMessage 
            ? `The schedule for "${displayName}" has been deleted.`
            : `The schedule for "${displayName}" has been updated and saved.`
          }
        </p>
        <button className="btn-primary" onClick={onClose}>
          Continue
        </button>
      </div>
    </div>
  )
}

// Outlet Selection Modal Component
function OutletSelectionModal({ 
  isOpen, 
  onClose, 
  onSave,
  isEditMode,
  existingCombinedSchedule,
  onLimitExceeded,
  onSuccess
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  onSave: (selectedOutlets: string[], scheduleData: any) => void;
  isEditMode: boolean;
  existingCombinedSchedule: {
    combinedScheduleId: string;
    selectedOutlets: string[];
    scheduleData: any;
  } | null;
  onLimitExceeded: (deviceName: string, limitType: 'individual' | 'combined', currentUsage: number, limitValue: number, scheduleTime: string) => void;
  onSuccess: (message: string) => void;
}) {
  const [availableOutlets, setAvailableOutlets] = useState<any[]>([])
  const [selectedOutlets, setSelectedOutlets] = useState<string[]>([])
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [selectedDays, setSelectedDays] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const daysOfWeek = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']

  // Fetch available outlets when modal opens
  useEffect(() => {
    if (isOpen) {
      const fetchAvailableOutlets = async () => {
        try {
          setLoading(true)
          const devicesRef = ref(realtimeDb, 'devices')
          const snapshot = await get(devicesRef)
          
          if (snapshot.exists()) {
            const devicesData = snapshot.val()
            const outlets: any[] = []
            
            Object.keys(devicesData).forEach((outletKey) => {
              const outletData = devicesData[outletKey]
              const officeInfo = outletData.office_info
              
              // Only include outlets with enable_power_scheduling = true
              if (officeInfo?.enable_power_scheduling === true) {
                outlets.push({
                  key: outletKey,
                  name: outletKey.replace('_', ' '),
                  appliance: officeInfo.appliance || 'Unassigned',
                  office: formatOfficeName(officeInfo.office || 'Unassigned'),
                  assignedDate: officeInfo.assigned_date
                })
              }
            })
            
            setAvailableOutlets(outlets)
          }
        } catch (error) {
          console.error('Error fetching available outlets:', error)
        } finally {
          setLoading(false)
        }
      }
      
      fetchAvailableOutlets()
    }
  }, [isOpen])

  // Load existing combined schedule data when in edit mode
  useEffect(() => {
    if (isOpen && isEditMode && existingCombinedSchedule) {
      console.log('Loading existing combined schedule data:', existingCombinedSchedule)
      
      // Set selected outlets
      setSelectedOutlets(existingCombinedSchedule.selectedOutlets)
      
      // Set time data
      if (existingCombinedSchedule.scheduleData.startTime && existingCombinedSchedule.scheduleData.endTime) {
        setStartTime(existingCombinedSchedule.scheduleData.startTime)
        setEndTime(existingCombinedSchedule.scheduleData.endTime)
      }
      
      // Set selected days based on frequency
      const frequency = existingCombinedSchedule.scheduleData.frequency
      if (frequency) {
        if (frequency.toLowerCase() === 'daily') {
          setSelectedDays(daysOfWeek)
        } else if (frequency.toLowerCase() === 'weekdays') {
          setSelectedDays(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'])
        } else if (frequency.toLowerCase() === 'weekends') {
          setSelectedDays(['SATURDAY', 'SUNDAY'])
        } else if (frequency.includes(',')) {
          // Handle custom days format
          const dayMap: { [key: string]: string } = {
            'SUN': 'SUNDAY', 'SUNDAY': 'SUNDAY',
            'MON': 'MONDAY', 'MONDAY': 'MONDAY', 'M': 'MONDAY',
            'TUE': 'TUESDAY', 'TUESDAY': 'TUESDAY', 'T': 'TUESDAY',
            'WED': 'WEDNESDAY', 'WEDNESDAY': 'WEDNESDAY', 'W': 'WEDNESDAY',
            'THU': 'THURSDAY', 'THURSDAY': 'THURSDAY', 'TH': 'THURSDAY',
            'FRI': 'FRIDAY', 'FRIDAY': 'FRIDAY', 'F': 'FRIDAY',
            'SAT': 'SATURDAY', 'SATURDAY': 'SATURDAY'
          }
          
          const days = frequency.split(',').map((day: string) => {
            const trimmedDay = day.trim().toUpperCase()
            return dayMap[trimmedDay] || trimmedDay
          }).filter((day: string) => daysOfWeek.includes(day))
          
          setSelectedDays(days)
        } else {
          // Handle single day
          const dayMap: { [key: string]: string } = {
            'SUN': 'SUNDAY', 'SUNDAY': 'SUNDAY',
            'MON': 'MONDAY', 'MONDAY': 'MONDAY', 'M': 'MONDAY',
            'TUE': 'TUESDAY', 'TUESDAY': 'TUESDAY', 'T': 'TUESDAY',
            'WED': 'WEDNESDAY', 'WEDNESDAY': 'WEDNESDAY', 'W': 'WEDNESDAY',
            'THU': 'THURSDAY', 'THURSDAY': 'THURSDAY', 'TH': 'THURSDAY',
            'FRI': 'FRIDAY', 'FRIDAY': 'FRIDAY', 'F': 'FRIDAY',
            'SAT': 'SATURDAY', 'SATURDAY': 'SATURDAY'
          }
          const mappedDay = dayMap[frequency.toUpperCase()] || frequency.toUpperCase()
          if (daysOfWeek.includes(mappedDay)) {
            setSelectedDays([mappedDay])
          }
        }
      }
    }
  }, [isOpen, isEditMode, existingCombinedSchedule])

  const handleOutletToggle = (outletKey: string) => {
    setSelectedOutlets(prev => 
      prev.includes(outletKey) 
        ? prev.filter(key => key !== outletKey)
        : [...prev, outletKey]
    )
  }

  const handleDayToggle = (day: string) => {
    setSelectedDays(prev => 
      prev.includes(day) 
        ? prev.filter(d => d !== day)
        : [...prev, day]
    )
    if (errors.days) {
      setErrors(prev => ({ ...prev, days: '' }))
    }
  }

  const handleTimeChange = (field: 'start' | 'end', value: string) => {
    if (field === 'start') {
      setStartTime(value)
    } else {
      setEndTime(value)
    }
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const validateForm = () => {
    const newErrors: Record<string, string> = {}
    
    // If no outlets are selected, allow saving (this removes all outlets from schedule)
    if (selectedOutlets.length === 0) {
      // Clear time and day selections when no outlets are selected
      setStartTime('')
      setEndTime('')
      setSelectedDays([])
      // No validation errors when removing all outlets
      setErrors({})
      return true
    }
    
    // Only validate time and days when outlets are selected
    if (!startTime) newErrors.start = 'Start time is required'
    if (!endTime) newErrors.end = 'End time is required'
    if (selectedDays.length === 0) newErrors.days = 'Please select at least one day'
    
    if (startTime && endTime) {
      const start = new Date(`2000-01-01T${startTime}`)
      const end = new Date(`2000-01-01T${endTime}`)
      if (start >= end) {
        newErrors.end = 'End time must be after start time'
      }
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const saveNonExceedingOutlets = async (outletsToSave: string[], exceedingOutletsNames: string[]) => {
    try {
      // Convert 24-hour format to 12-hour for display
      const convertTo12Hour = (time24h: string) => {
        if (!time24h) return ''
        const [hours, minutes] = time24h.split(':')
        const hour = parseInt(hours, 10)
        const ampm = hour >= 12 ? 'PM' : 'AM'
        const hour12 = hour % 12 || 12
        return `${hour12}:${minutes} ${ampm}`
      }
      
      const timeRange = `${convertTo12Hour(startTime)} - ${convertTo12Hour(endTime)}`
      
      // Determine frequency based on selected days
      let frequency = selectedDays.join(', ')
      if (selectedDays.length === 7) {
        frequency = 'Daily'
      } else if (selectedDays.length === 5 && 
                 selectedDays.includes('MONDAY') && 
                 selectedDays.includes('TUESDAY') && 
                 selectedDays.includes('WEDNESDAY') && 
                 selectedDays.includes('THURSDAY') && 
                 selectedDays.includes('FRIDAY')) {
        frequency = 'Weekdays'
      } else if (selectedDays.length === 2 && 
                 selectedDays.includes('SATURDAY') && 
                 selectedDays.includes('SUNDAY')) {
        frequency = 'Weekends'
      }

      // Create basis timestamp for unplug detection
      const basis = Date.now()
      
      const scheduleData = {
        timeRange,
        frequency,
        startTime,
        endTime,
        selectedDays,
        isCombined: true,
        combinedScheduleId: `combined_${Date.now()}`,
        basis: basis,
        disabled_by_unplug: false
      }

      // Save schedule for each non-exceeding outlet
      for (const outletKey of outletsToSave) {
        const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
        await set(scheduleRef, scheduleData)
      }

      // Show success message for saved outlets
      const savedOutletsNames = outletsToSave.map(key => key.replace('_', ' '))
      const successMessage = `Schedule saved successfully for: ${savedOutletsNames.join(', ')}`
      
      if (exceedingOutletsNames.length > 0) {
        const excludedMessage = `\n\nNote: ${exceedingOutletsNames.join(', ')} were excluded due to power limit restrictions.`
        onSuccess(successMessage + excludedMessage)
      } else {
        onSuccess(successMessage)
      }

      onClose()
    } catch (error) {
      console.error('Error saving non-exceeding outlets:', error)
      alert('Error saving schedule. Please try again.')
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (validateForm()) {
      // Convert 24-hour format to 12-hour for display
      const convertTo12Hour = (time24h: string) => {
        if (!time24h) return ''
        const [hours, minutes] = time24h.split(':')
        const hour = parseInt(hours, 10)
        const ampm = hour >= 12 ? 'PM' : 'AM'
        const hour12 = hour % 12 || 12
        return `${hour12}:${minutes} ${ampm}`
      }
      
      const timeRange = `${convertTo12Hour(startTime)} - ${convertTo12Hour(endTime)}`
      
      // Determine frequency based on selected days
      let frequency = selectedDays.join(', ')
      if (selectedDays.length === 7) {
        frequency = 'Daily'
      } else if (selectedDays.length === 5 && 
                 selectedDays.includes('MONDAY') && 
                 selectedDays.includes('TUESDAY') && 
                 selectedDays.includes('WEDNESDAY') && 
                 selectedDays.includes('THURSDAY') && 
                 selectedDays.includes('FRIDAY')) {
        frequency = 'Weekdays'
      } else if (selectedDays.length === 2 && 
                 selectedDays.includes('SATURDAY') && 
                 selectedDays.includes('SUNDAY')) {
        frequency = 'Weekends'
      }
      
      // Check combined limit before saving - check each outlet individually
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        const combinedLimitData = combinedLimitSnapshot.exists() ? combinedLimitSnapshot.val() : null
        
        if (selectedOutlets.length > 0) {
          const devicesRef = ref(realtimeDb, 'devices')
          const devicesSnapshot = await get(devicesRef)
          
          if (devicesSnapshot.exists()) {
            const devicesData = devicesSnapshot.val()
            const today = new Date()
            const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
            
            const exceedingOutlets: string[] = []
            let totalEnergyWh = 0
            
            // Check if combined limit is enabled and has a valid value
            const combinedLimitWh = combinedLimitData?.combinedLimit || 0
            const hasValidCombinedLimit = combinedLimitData?.enabled && combinedLimitWh > 0
            
            for (const outletKey of selectedOutlets) {
              const deviceData = devicesData[outletKey]
              if (deviceData) {
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                const outletEnergyWh = todayTotalEnergy * 1000 // Convert to Wh
                totalEnergyWh += outletEnergyWh
                
                let outletExceedsLimit = false
                
                // Check if this outlet is part of the combined group
                const outletName = outletKey.replace('_', ' ')
                const isOutletInCombinedGroup = hasValidCombinedLimit && 
                  (combinedLimitData?.selectedOutlets?.includes(outletKey) || 
                   combinedLimitData?.selectedOutlets?.includes(outletName))
                
                if (isOutletInCombinedGroup) {
                  // Use combined limit if outlet is part of combined group
                  outletExceedsLimit = outletEnergyWh >= combinedLimitWh
                } else {
                  // Fallback to individual limit if not in combined group or no combined limit
                  const individualPowerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
                  const individualPowerLimitWh = individualPowerLimit * 1000 // Convert from kW to Wh
                  
                  if (individualPowerLimitWh > 0) {
                    outletExceedsLimit = outletEnergyWh >= individualPowerLimitWh
                  }
                  // If no individual limit is set either, allow the outlet
                }
                
                if (outletExceedsLimit) {
                  exceedingOutlets.push(outletKey)
                }
              }
            }
            
            // If any outlets exceed the limit, show warning for those specific outlets
            if (exceedingOutlets.length > 0) {
              const exceedingOutletsNames = exceedingOutlets.map(key => key.replace('_', ' '))
              
              // Determine limit type based on which outlets exceeded - check if any exceeding outlet is in combined group
              let limitType: 'individual' | 'combined' = 'individual'
              let limitValue = 0
              
              // Check the first exceeding outlet to determine limit type (assuming all exceeding outlets have same limit type)
              if (exceedingOutlets.length > 0) {
                const firstExceedingOutlet = exceedingOutlets[0]
                const outletName = firstExceedingOutlet.replace('_', ' ')
                const isOutletInCombinedGroup = hasValidCombinedLimit && 
                  (combinedLimitData?.selectedOutlets?.includes(firstExceedingOutlet) || 
                   combinedLimitData?.selectedOutlets?.includes(outletName))
                
                if (isOutletInCombinedGroup) {
                  limitType = 'combined'
                  limitValue = combinedLimitWh
                } else {
                  limitType = 'individual'
                  // Get individual limit for display
                  const firstOutletData = devicesData[firstExceedingOutlet]
                  if (firstOutletData) {
                    const individualPowerLimit = firstOutletData.relay_control?.auto_cutoff?.power_limit || 0
                    limitValue = individualPowerLimit * 1000 // Convert from kW to Wh
                  }
                }
              }
              
              // Filter out exceeding outlets from selectedOutlets
              const outletsToSave = selectedOutlets.filter(outlet => !exceedingOutlets.includes(outlet))
              
              // Get the energy for the first exceeding outlet for display
              const firstExceedingOutletData = devicesData[exceedingOutlets[0]]
              const firstExceedingOutletEnergy = firstExceedingOutletData ? 
                (firstExceedingOutletData?.daily_logs?.[todayDateKey]?.total_energy || 0) * 1000 : 0
              
              // Show limit exceeded modal
              onLimitExceeded(
                `${exceedingOutletsNames.join(', ')}`,
                limitType,
                firstExceedingOutletEnergy,
                limitValue,
                timeRange
              )
              
              // If there are outlets that don't exceed the limit, save them
              if (outletsToSave.length > 0) {
                // Continue with saving the non-exceeding outlets
                await saveNonExceedingOutlets(outletsToSave, exceedingOutletsNames)
              }
              return
            }
          }
        }
      } catch (error) {
        console.error('Error checking combined limit validation:', error)
        // Continue with save if limit check fails
      }
      
      const scheduleData = {
        timeRange,
        frequency,
        startTime,
        endTime,
        selectedDays
      }
      
      // Allow saving even with no outlets selected
      onSave(selectedOutlets, scheduleData)
    }
  }

  // Clear time and day selections when no outlets are selected
  useEffect(() => {
    if (selectedOutlets.length === 0) {
      setStartTime('')
      setEndTime('')
      setSelectedDays([])
    }
  }, [selectedOutlets])

  const handleClose = () => {
    setSelectedOutlets([])
    setStartTime('')
    setEndTime('')
    setSelectedDays([])
    setErrors({})
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content outlet-selection-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isEditMode ? 'Edit Multiple Schedule' : 'Add Outlets to Combined Schedule'}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={handleClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate={selectedOutlets.length === 0}>
          <div className="modal-body">
            {/* Available Outlets Selection */}
            <div className={`outlet-selection ${errors.outlets ? 'error' : ''}`}>
              <label>Select Outlets:</label>
              <div className="outlets-grid">
                {loading ? (
                  <div className="loading-outlets">Loading available outlets...</div>
                ) : availableOutlets.length === 0 ? (
                  <div className="no-outlets">No outlets with power scheduling enabled found.</div>
                ) : (
                  availableOutlets.map((outlet) => (
                    <div
                      key={outlet.key}
                      className={`outlet-option ${selectedOutlets.includes(outlet.key) ? 'selected' : ''}`}
                      onClick={() => handleOutletToggle(outlet.key)}
                    >
                      <div className="outlet-checkbox">
                        {selectedOutlets.includes(outlet.key) && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <polyline points="20,6 9,17 4,12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      <div className="outlet-info">
                        <div className="outlet-name">{outlet.name}</div>
                        <div className="outlet-details">
                          <span className="appliance">{outlet.appliance}</span>
                          <span className="separator">•</span>
                          <span className="office">{outlet.office}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {errors.outlets && <span className="error-message">{errors.outlets}</span>}
            </div>

            {/* Time Selection */}
            <div className="time-section">
              <div className={`time-input-group ${errors.start ? 'error' : ''}`}>
                <label htmlFor="startTime">Start Time</label>
                <div className="time-input-wrapper">
                  <input
                    type="time"
                    id="startTime"
                    value={startTime}
                    onChange={(e) => handleTimeChange('start', e.target.value)}
                    className="time-input"
                    required
                  />
                </div>
                {errors.start && <span className="error-message">{errors.start}</span>}
              </div>

              <div className={`time-input-group ${errors.end ? 'error' : ''}`}>
                <label htmlFor="endTime">End Time</label>
                <div className="time-input-wrapper">
                  <input
                    type="time"
                    id="endTime"
                    value={endTime}
                    onChange={(e) => handleTimeChange('end', e.target.value)}
                    className="time-input"
                    required
                  />
                </div>
                {errors.end && <span className="error-message">{errors.end}</span>}
              </div>
            </div>

            {/* Day Selection */}
            <div className={`day-selection ${errors.days ? 'error' : ''}`}>
              <label>Day's Applied:</label>
              <div className="days-grid">
                {daysOfWeek.map((day) => (
                  <div
                    key={day}
                    className={`day-option ${selectedDays.includes(day) ? 'selected' : ''}`}
                    onClick={() => handleDayToggle(day)}
                  >
                    <div className="day-checkbox">
                      {selectedDays.includes(day) && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <polyline points="20,6 9,17 4,12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <span className="day-label">{day}</span>
                  </div>
                ))}
              </div>
              {errors.days && <span className="error-message">{errors.days}</span>}
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={selectedOutlets.length > 0 && (!startTime || !endTime || selectedDays.length === 0)}
            >
              {isEditMode ? 'Update Multiple Schedule' : 'Create Combined Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Schedule() {
  const [searchQuery, setSearchQuery] = useState('')
  const [deviceSchedules, setDeviceSchedules] = useState<DeviceData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editModal, setEditModal] = useState<{
    isOpen: boolean;
    device: DeviceData | null;
  }>({
    isOpen: false,
    device: null
  })

  const [successModal, setSuccessModal] = useState<{
    isOpen: boolean;
    deviceName: string;
  }>({
    isOpen: false,
    deviceName: ''
  })
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{
    isOpen: boolean;
    deviceId: string;
    deviceName: string;
  }>({
    isOpen: false,
    deviceId: '',
    deviceName: ''
  })
  const [powerSchedulingNotAllowedModal, setPowerSchedulingNotAllowedModal] = useState<{
    isOpen: boolean;
    deviceName: string;
  }>({
    isOpen: false,
    deviceName: ''
  })
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
  }>>({})

  // Unplug detection state - track timestamps for each device
  const [deviceTimestamps, setDeviceTimestamps] = useState<Record<string, {
    lastTimestamp: string;
    lastTimestampTime: number;
    basis: number;
    lastChecked: number;
  }>>({})

  // Auto-turnoff timer state for non-idle devices
  const [autoTurnoffTimers, setAutoTurnoffTimers] = useState<Record<string, NodeJS.Timeout | null>>({})
  
  const [combinedScheduleWarningModal, setCombinedScheduleWarningModal] = useState<{
    isOpen: boolean;
    deviceName: string;
    combinedOutlets: string[];
  }>({
    isOpen: false,
    deviceName: '',
    combinedOutlets: []
  })
  const [outletSelectionModal, setOutletSelectionModal] = useState<{
    isOpen: boolean;
    isEditMode: boolean;
    existingCombinedSchedule: {
      combinedScheduleId: string;
      selectedOutlets: string[];
      scheduleData: any;
    } | null;
  }>({
    isOpen: false,
    isEditMode: false,
    existingCombinedSchedule: null
  })

  const [limitExceededModal, setLimitExceededModal] = useState<{
    isOpen: boolean;
    deviceName: string;
    limitType: 'individual' | 'combined';
    currentUsage: number;
    limitValue: number;
    scheduleTime: string;
  }>({
    isOpen: false,
    deviceName: '',
    limitType: 'individual',
    currentUsage: 0,
    limitValue: 0,
    scheduleTime: ''
  })

  // Function to detect existing combined schedules
  const detectExistingCombinedSchedule = () => {
    // Find the first device with a combined schedule
    const deviceWithCombinedSchedule = deviceSchedules.find(device => 
      device.schedule.isCombinedSchedule && 
      device.schedule.combinedScheduleId && 
      device.schedule.selectedOutlets
    )
    
    if (deviceWithCombinedSchedule) {
      return {
        combinedScheduleId: deviceWithCombinedSchedule.schedule.combinedScheduleId!,
        selectedOutlets: deviceWithCombinedSchedule.schedule.selectedOutlets!,
        scheduleData: {
          timeRange: deviceWithCombinedSchedule.schedule.timeRange,
          frequency: deviceWithCombinedSchedule.schedule.frequency,
          startTime: deviceWithCombinedSchedule.schedule.startTime,
          endTime: deviceWithCombinedSchedule.schedule.endTime
        }
      }
    }
    
    return null
  }


  // Fetch devices data from Firebase
  useEffect(() => {
    const devicesRef = ref(realtimeDb, 'devices')
    
    const fetchDevices = async () => {
      try {
        setLoading(true)
        setError(null)
        
        const snapshot = await get(devicesRef)
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          const todayDateKey = getTodayDateKey()
          
          const processedDevices: DeviceData[] = []
          
        Object.keys(devicesData).forEach((outletKey, index) => {
          const outletData: FirebaseDeviceData = devicesData[outletKey]
          const officeInfo = outletData.office_info
          const relayControl = outletData.relay_control
          
          // Get current power usage from lifetime_energy (display in watts)
          const lifetimeEnergyWatts = outletData.lifetime_energy || 0
          const powerUsageDisplay = `${formatNumber(lifetimeEnergyWatts * 1000)} Wh`
          
          // Get power limit and relay status
          const powerLimitRaw = relayControl?.auto_cutoff?.power_limit || 0
          const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
          const powerLimitDisplay = powerLimit === "No Limit" ? "No Limit" : `${(Number(powerLimit) * 1000).toFixed(2)} Wh`
          
          const controlState = (outletData.control?.device || 'off').toString().trim().toLowerCase()
          const mainStatus = relayControl?.main_status || 'ON'
          
          // Get today's energy consumption from total_energy (display in watts)
          const todayLogs = outletData.daily_logs?.[todayDateKey]
          const todayEnergyWatts = todayLogs?.total_energy || 0
          const todayEnergyDisplay = `${formatNumber(todayEnergyWatts * 1000)} Wh`
            
            // Helper function to convert 24-hour time to 12-hour for display
            const convertTo12Hour = (time24h: string) => {
              if (!time24h) return ''
              const [hours, minutes] = time24h.split(':')
              const hour = parseInt(hours, 10)
              const ampm = hour >= 12 ? 'PM' : 'AM'
              const hour12 = hour % 12 || 12
              return `${hour12}:${minutes} ${ampm}`
            }

            // Construct timeRange from startTime and endTime if timeRange doesn't exist
            let timeRange = outletData.schedule?.timeRange || ''
            if (!timeRange && outletData.schedule?.startTime && outletData.schedule?.endTime) {
              const startTime12 = convertTo12Hour(outletData.schedule.startTime)
              const endTime12 = convertTo12Hour(outletData.schedule.endTime)
              
              // Only set timeRange if both times are valid and not default values
              if (startTime12 && endTime12 && 
                  !(outletData.schedule.startTime === '00:00' && outletData.schedule.endTime === '00:00') &&
                  !(outletData.schedule.startTime === '00:00' && outletData.schedule.endTime === '23:59')) {
                timeRange = `${startTime12} - ${endTime12}`
              }
            }

            // Check for idle status from root level
            const sensorStatus = outletData.status
            const isIdleFromSensor = sensorStatus === 'idle' || sensorStatus === 'Idle'
            
            // Idle detection logic
            const currentTime = Date.now()
            const currentTotalEnergy = todayLogs?.total_energy || 0
            
            // Get or initialize device activity tracking
            const activity = deviceActivity[outletKey] || {
              lastEnergyUpdate: currentTime,
              lastControlUpdate: currentTime,
              lastTotalEnergy: currentTotalEnergy,
              lastControlState: controlState,
 // Initialize with 0, will be updated after currentAmpere is declared
            }
            
            // Check for energy updates (total_energy changed)
            const energyChanged = Math.abs(currentTotalEnergy - activity.lastTotalEnergy) > 0.0001
            if (energyChanged) {
              setDeviceActivity(prev => ({
                ...prev,
                [outletKey]: {
                  ...activity,
                  lastEnergyUpdate: currentTime,
                  lastTotalEnergy: currentTotalEnergy
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
            
            // Determine final status - CHECK FOR UNPLUG FIRST (HIGHEST PRIORITY)
            // UNPLUG status takes precedence over Active/Inactive - if device is unplugged, always show UNPLUG
            let deviceStatus: 'Active' | 'Inactive' | 'Blocked' | 'Idle' | 'UNPLUG'
            
            // PRIORITY 1: UNPLUG - Check if device is unplugged (from root status or disabled_by_unplug flag)
            // This MUST be checked first - UNPLUG takes precedence over Active/Inactive
            if (sensorStatus === 'UNPLUG' || sensorStatus === 'unplug' || outletData.schedule?.disabled_by_unplug === true) {
              deviceStatus = 'UNPLUG'
            } else if ((isIdleFromSensor || isIdleFromLogic) && controlState === 'on') {
              // PRIORITY 2: Show Idle if sensor reports idle OR if device is supposed to be ON but not responding
              deviceStatus = 'Idle'
            } else {
              // PRIORITY 3: Active/Inactive based on control state (only if NOT unplugged)
              deviceStatus = controlState === 'on' ? 'Active' : 'Inactive'
            }

            // Auto-turnoff logic disabled to prevent interference with data uploads
            // Clear any existing auto-turnoff timers to prevent interference
            clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)

            // Auto-turnoff functionality disabled to prevent interference with data uploads
            // Reset auto-turnoff function when outlet turns on again
            // const controlChangedForAutoTurnoff = controlState !== activity.lastControlState
            // if (controlChangedForAutoTurnoff && controlState === 'on') {
            //   resetAutoTurnoffFunction(outletKey, setAutoTurnoffTimers)
            // }

            // Get current (ampere) from sensor_data - with 2 decimal places
            const currentAmpere = outletData.sensor_data?.current || 0
            const currentAmpereDisplay = `${currentAmpere.toFixed(2)}A`
            
            // Create device object
            const device: DeviceData = {
              id: String(index + 1).padStart(3, '0'),
              outletName: outletKey.replace('_', ' '),
              appliances: officeInfo?.appliance || 'Unassigned',
              officeRoom: formatOfficeName(officeInfo?.office || 'Unassigned'),
              powerUsage: powerUsageDisplay,
              currentAmpere: currentAmpereDisplay,
              limit: powerLimitDisplay,
              status: deviceStatus,
              todaysUsage: todayEnergyDisplay,
              schedule: {
                timeRange: timeRange,
                frequency: outletData.schedule?.frequency || '',
                startTime: outletData.schedule?.startTime,
                endTime: outletData.schedule?.endTime,
                combinedScheduleId: outletData.schedule?.combinedScheduleId,
                isCombinedSchedule: outletData.schedule?.isCombinedSchedule || false,
                selectedOutlets: outletData.schedule?.selectedOutlets
              },
              controlState: controlState,
              mainStatus: mainStatus,
              enablePowerScheduling: officeInfo?.enable_power_scheduling || false
            }
            
            
            processedDevices.push(device)
          })
          
          setDeviceSchedules(processedDevices)
        } else {
          setDeviceSchedules([])
        }
      } catch (err) {
        console.error('Error fetching devices:', err)
        setError('Failed to load devices. Please try again.')
        setDeviceSchedules([])
      } finally {
        setLoading(false)
      }
    }
    
    fetchDevices()
    
    // Set up real-time listener for updates
    onValue(devicesRef, (snapshot) => {
      if (snapshot.exists()) {
        const devicesData = snapshot.val()
        const todayDateKey = getTodayDateKey()
        
        const processedDevices: DeviceData[] = []
        
        Object.keys(devicesData).forEach((outletKey, index) => {
          const outletData: FirebaseDeviceData = devicesData[outletKey]
          const officeInfo = outletData.office_info
          const relayControl = outletData.relay_control
          
          // Get current power usage from lifetime_energy (display in watts)
          const lifetimeEnergyWatts = outletData.lifetime_energy || 0
          const powerUsageDisplay = `${formatNumber(lifetimeEnergyWatts * 1000)} Wh`
          
          // Get power limit and relay status
          const powerLimitRaw = relayControl?.auto_cutoff?.power_limit || 0
          const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
          const powerLimitDisplay = powerLimit === "No Limit" ? "No Limit" : `${(Number(powerLimit) * 1000).toFixed(2)} Wh`
          const controlState = (outletData.control?.device || 'off').toString().trim().toLowerCase()
          const mainStatus = relayControl?.main_status || 'ON'
          
          // Get today's energy consumption from total_energy (display in watts)
          const todayLogs = outletData.daily_logs?.[todayDateKey]
          const todayEnergyWatts = todayLogs?.total_energy || 0
          const todayEnergyDisplay = `${formatNumber(todayEnergyWatts * 1000)} Wh`
          
          // Helper function to convert 24-hour time to 12-hour for display
          const convertTo12Hour = (time24h: string) => {
            if (!time24h) return ''
            const [hours, minutes] = time24h.split(':')
            const hour = parseInt(hours, 10)
            const ampm = hour >= 12 ? 'PM' : 'AM'
            const hour12 = hour % 12 || 12
            return `${hour12}:${minutes} ${ampm}`
          }

          // Construct timeRange from startTime and endTime if timeRange doesn't exist
          let timeRange = outletData.schedule?.timeRange || ''
          if (!timeRange && outletData.schedule?.startTime && outletData.schedule?.endTime) {
            const startTime12 = convertTo12Hour(outletData.schedule.startTime)
            const endTime12 = convertTo12Hour(outletData.schedule.endTime)
            
            // Only set timeRange if both times are valid and not default values
            if (startTime12 && endTime12 && 
                !(outletData.schedule.startTime === '00:00' && outletData.schedule.endTime === '00:00') &&
                !(outletData.schedule.startTime === '00:00' && outletData.schedule.endTime === '23:59')) {
              timeRange = `${startTime12} - ${endTime12}`
            }
          }

          // Check for idle status from root level
          const sensorStatus = outletData.status
          const isIdleFromSensor = sensorStatus === 'idle' || sensorStatus === 'Idle'
          
          // Idle detection logic
          const currentTime = Date.now()
          const currentTotalEnergy = todayLogs?.total_energy || 0
          
          // Get or initialize device activity tracking
          const activity = deviceActivity[outletKey] || {
            lastEnergyUpdate: currentTime,
            lastControlUpdate: currentTime,
            lastTotalEnergy: currentTotalEnergy,
            lastControlState: controlState
          }
          
          // Check for energy updates (total_energy changed)
          const energyChanged = Math.abs(currentTotalEnergy - activity.lastTotalEnergy) > 0.0001
          if (energyChanged) {
            setDeviceActivity(prev => ({
              ...prev,
              [outletKey]: {
                ...activity,
                lastEnergyUpdate: currentTime,
                lastTotalEnergy: currentTotalEnergy
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
          
          // Determine final status - CHECK FOR UNPLUG FIRST (HIGHEST PRIORITY)
          // UNPLUG status takes precedence over Active/Inactive - if device is unplugged, always show UNPLUG
          let deviceStatus: 'Active' | 'Inactive' | 'Blocked' | 'Idle' | 'UNPLUG'
          
          // PRIORITY 1: UNPLUG - Check if device is unplugged (from root status or disabled_by_unplug flag)
          // This MUST be checked first - UNPLUG takes precedence over Active/Inactive
          if (sensorStatus === 'UNPLUG' || sensorStatus === 'unplug' || outletData.schedule?.disabled_by_unplug === true) {
            deviceStatus = 'UNPLUG'
          } else if ((isIdleFromSensor || isIdleFromLogic) && controlState === 'on') {
            // PRIORITY 2: Show Idle if sensor reports idle OR if device is supposed to be ON but not responding
            deviceStatus = 'Idle'
          } else {
            // PRIORITY 3: Active/Inactive based on control state (only if NOT unplugged)
            deviceStatus = controlState === 'on' ? 'Active' : 'Inactive'
          }

          // Auto-turnoff logic disabled to prevent interference with data uploads
          // Clear any existing auto-turnoff timers to prevent interference
          clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)

          // Auto-turnoff functionality disabled to prevent interference with data uploads
          // Reset auto-turnoff function when outlet turns on again
          // if (controlChanged && controlState === 'on') {
          //   resetAutoTurnoffFunction(outletKey, setAutoTurnoffTimers)
          // }

          // Get current (ampere) from sensor_data - with 2 decimal places
          const currentAmpere = outletData.sensor_data?.current || 0
          const currentAmpereDisplay = `${currentAmpere.toFixed(2)}A`

          // Create device object
          const device: DeviceData = {
            id: String(index + 1).padStart(3, '0'),
            outletName: outletKey.replace('_', ' '),
            appliances: officeInfo?.appliance || 'Unassigned',
            officeRoom: formatOfficeName(officeInfo?.office || 'Unassigned'),
            powerUsage: powerUsageDisplay,
            currentAmpere: currentAmpereDisplay,
            limit: powerLimitDisplay,
            status: deviceStatus,
            todaysUsage: todayEnergyDisplay,
            schedule: {
              timeRange: timeRange,
              frequency: outletData.schedule?.frequency || '',
              startTime: outletData.schedule?.startTime,
              endTime: outletData.schedule?.endTime,
              combinedScheduleId: outletData.schedule?.combinedScheduleId,
              isCombinedSchedule: outletData.schedule?.isCombinedSchedule || false,
              selectedOutlets: outletData.schedule?.selectedOutlets
            },
            controlState: controlState,
            mainStatus: mainStatus,
            enablePowerScheduling: officeInfo?.enable_power_scheduling || false
          }
          
          processedDevices.push(device)
        })
        
        setDeviceSchedules(processedDevices)
      }
    })
    
    // Cleanup listener on unmount
    return () => {
      off(devicesRef, 'value')
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
    }
  }, [])

  // Fetch combined limit info
  useEffect(() => {
    const fetchCombinedLimitInfo = async () => {
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const snapshot = await get(combinedLimitRef)
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('Schedule: Fetched combined limit data:', data)
          setCombinedLimitInfo({
            enabled: data.enabled || false,
            selectedOutlets: data.selected_outlets || [],
            combinedLimit: data.combined_limit_watts || 0
          })
        } else {
          console.log('Schedule: No combined limit settings found')
          setCombinedLimitInfo({
            enabled: false,
            selectedOutlets: [],
            combinedLimit: 0
          })
        }
      } catch (error) {
        console.error('Schedule: Error fetching combined limit info:', error)
        setCombinedLimitInfo({
          enabled: false,
          selectedOutlets: [],
          combinedLimit: 0
        })
      }
    }
    
    fetchCombinedLimitInfo()
  }, [])

  // Monthly limit check - runs independently and more frequently
  useEffect(() => {
    const checkMonthlyLimits = async () => {
      try {
        console.log('🔍 Schedule: Running independent monthly limit check...')
        
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
        }
      } catch (error) {
        console.error('Schedule: Error in monthly limit check:', error)
      }
    }
    
    // Run monthly limit check immediately
    checkMonthlyLimits()
    
    // DISABLED: Monthly limit check interval to prevent conflicts with schedule logic
    // const monthlyLimitInterval = setInterval(checkMonthlyLimits, 5000)
    
    // Cleanup interval on unmount
    return () => {
      // clearInterval(monthlyLimitInterval) // Disabled
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
    }
  }, [combinedLimitInfo])

  // Real-time scheduler with monthly limit checking
  useEffect(() => {
    const checkDailyLimit = (deviceData: any): boolean => {
      try {
        const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
        if (powerLimit <= 0) return false
        
        const today = new Date()
        const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
        const todayLogs = deviceData?.daily_logs?.[todayDateKey]
        const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
        
        return todayTotalEnergy >= powerLimit
      } catch (error) {
        console.error('Schedule: Error checking daily limit:', error)
        return false
      }
    }

    const checkScheduleAndUpdateDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          console.log(`Schedule: Real-time scheduler check at ${new Date().toLocaleTimeString()}`)

          
          
          // HIERARCHY: Check monthly limit FIRST (highest priority) - AUTO TURN OFF
          // This automatically turns off all devices if monthly limit is exceeded
          console.log('🔍 Schedule: Running monthly limit check FIRST...')
          await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
          
          // Check monthly limit status for combined group
          let monthlyLimitExceeded = false
          if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
            const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
            const combinedLimitWatts = combinedLimitInfo.combinedLimit
            
            // Skip limit check if "No Limit" is set
            if (String(combinedLimitWatts) === "No Limit") {
              console.log(`📊 Schedule: Combined limit is set to "No Limit" - proceeding with normal schedule processing`)
              monthlyLimitExceeded = false
            } else if (totalMonthlyEnergy >= combinedLimitWatts) {
              monthlyLimitExceeded = true
              console.log(`🚨 Schedule: MONTHLY LIMIT EXCEEDED for combined group`)
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
              console.log(`🔍 Schedule: Will check individual device limits within combined group`)
            } else {
              console.log(`✅ Schedule: Monthly limit OK - proceeding with normal schedule processing`)
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
            }
          }
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules
            if (deviceData.schedule && 
                (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
              
              const currentControlState = deviceData.control?.device || 'off'
              const currentMainStatus = deviceData.relay_control?.main_status || 'ON'

              // PRIMARY CHECK: RESPECT disabled_by_unplug from schedule - this is the BASIS for automatically turning devices off
              // NOTE: disabled_by_unplug in schedule is the basis for unplug detection, NOT daily logs
              // Daily logs are ONLY used for power limit checks, never for unplug detection
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`Schedule: Device ${outletKey} is disabled by unplug (based on schedule.disabled_by_unplug) - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`Schedule: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
                }
                
                // Ensure device stays off and main_status is OFF to prevent any reactivation
                if (currentControlState !== 'off') {
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                }
                if (currentMainStatus !== 'OFF') {
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  console.log(`Schedule: Set main_status to OFF for unplugged device ${outletKey}`)
                }
                continue
              }

              // RESPECT bypass mode - if main_status is ON, don't override it (device is in bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`Schedule: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
                continue
              }
              
              
              
              // CRITICAL: Check if device is past schedule end time BEFORE any other logic
              if (deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
                const now = new Date()
                const currentTime = now.getHours() * 60 + now.getMinutes()
                let endTime: number = 0
                
                if (deviceData.schedule.startTime && deviceData.schedule.endTime) {
                  const [endHours, endMinutes] = deviceData.schedule.endTime.split(':').map(Number)
                  endTime = endHours * 60 + endMinutes
                } else if (deviceData.schedule.timeRange) {
                  const [, endTimeStr] = deviceData.schedule.timeRange.split(' - ')
                  const convertTo24Hour = (time12h: string): number => {
                    const [time, modifier] = time12h.split(' ')
                    let [hours, minutes] = time.split(':').map(Number)
                    if (hours === 12) hours = 0
                    if (modifier === 'PM') hours += 12
                    return hours * 60 + minutes
                  }
                  endTime = convertTo24Hour(endTimeStr)
                }
                
                // If device is past schedule end time, FORCE it OFF and set main_status to OFF
                if (endTime > 0 && currentTime >= endTime) {
                  console.log(`🔒 Schedule: Device ${outletKey} is past schedule end time - FORCING OFF and locking main_status`)
                  
                  // Force device OFF
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Lock main_status to OFF to prevent any re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`🔒 Schedule: Device ${outletKey} LOCKED OFF - past schedule end time (current: ${Math.floor(currentTime / 60)}:${(currentTime % 60).toString().padStart(2, '0')}, end: ${Math.floor(endTime / 60)}:${(endTime % 60).toString().padStart(2, '0')})`)
                  continue
                }
              }
              
              
              // Check if device is in combined group
              const outletDisplayName = outletKey.replace('_', ' ')
              const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                       combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
              
              // HIERARCHY: Only check schedule if monthly and daily limits allow (THIRD priority)
              // Check if device should be active based on current time and schedule
              // Skip individual limit check if device is in combined group (combined limit takes precedence)
              const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInCombinedGroup)
              let newControlState = shouldBeActive ? 'on' : 'off'
              
              
              // AUTOMATIC STATUS UPDATE: Apply limit restrictions to the schedule result
              if (isInCombinedGroup && monthlyLimitExceeded) {
                // For devices in combined group when monthly limit is exceeded:
                // Only allow ON if individual daily limit is OK
                const isDailyLimitExceeded = checkDailyLimit(deviceData)
                if (isDailyLimitExceeded) {
                  newControlState = 'off' // Force OFF if daily limit exceeded
                  console.log(`🔒 Schedule: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (monthly limit also exceeded)`)
                } else if (shouldBeActive) {
                  newControlState = 'on' // Allow ON if schedule says ON and daily limit OK
                  console.log(`✅ Schedule: AUTOMATIC UPDATE - Allowing ${outletKey} ON (schedule says ON, individual daily limit OK despite monthly limit exceeded)`)
                }
              } else if (isInCombinedGroup && !monthlyLimitExceeded) {
                // For devices in combined group when monthly limit is OK:
                // ONLY check monthly limit - DO NOT check individual daily limit
                // The combined monthly limit takes precedence over individual limits
                const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, combinedLimitInfo)
                if (!monthlyLimitCheck.canTurnOn) {
                  newControlState = 'off' // Force OFF if monthly limit exceeded
                  console.log(`🔒 Schedule: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to monthly limit exceeded`)
                } else if (shouldBeActive) {
                  newControlState = 'on' // Allow ON if schedule says ON and monthly limit OK
                  console.log(`✅ Schedule: AUTOMATIC UPDATE - Allowing ${outletKey} ON (schedule says ON, monthly limit OK - individual daily limit ignored for combined group)`)
                }
              } else {
                // For devices NOT in combined group:
                // Only check individual daily limit
                const isDailyLimitExceeded = checkDailyLimit(deviceData)
                if (isDailyLimitExceeded) {
                  newControlState = 'off' // Force OFF if daily limit exceeded
                  console.log(`🔒 Schedule: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to daily limit exceeded`)
                } else if (shouldBeActive) {
                  newControlState = 'on' // Allow ON if schedule says ON and daily limit OK
                  console.log(`✅ Schedule: AUTOMATIC UPDATE - Allowing ${outletKey} ON (schedule says ON, daily limit OK)`)
                }
              }
              
              

              console.log(`Schedule: Final status determination for ${outletKey}:`, {
                scheduleSays: shouldBeActive ? 'ON' : 'OFF',
                finalDecision: newControlState,
                currentState: currentControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup: isInCombinedGroup,
                monthlyLimitExceeded: monthlyLimitExceeded
              })
              
              // Log exact time turn-off events
              if (!shouldBeActive && deviceData.schedule && (deviceData.schedule.timeRange || (deviceData.schedule.startTime && deviceData.schedule.endTime))) {
                const now = new Date()
                const currentTime = now.getHours() * 60 + now.getMinutes()
                let endTime: number = 0
                
                if (deviceData.schedule.startTime && deviceData.schedule.endTime) {
                  const [endHours, endMinutes] = deviceData.schedule.endTime.split(':').map(Number)
                  endTime = endHours * 60 + endMinutes
                } else if (deviceData.schedule.timeRange) {
                  const [, endTimeStr] = deviceData.schedule.timeRange.split(' - ')
                  const convertTo24Hour = (time12h: string): number => {
                    const [time, modifier] = time12h.split(' ')
                    let [hours, minutes] = time.split(':').map(Number)
                    if (hours === 12) hours = 0
                    if (modifier === 'PM') hours += 12
                    return hours * 60 + minutes
                  }
                  endTime = convertTo24Hour(endTimeStr)
                }
                
                if (endTime > 0 && currentTime >= endTime) {
                  const endTimeStr = `${Math.floor(endTime / 60).toString().padStart(2, '0')}:${(endTime % 60).toString().padStart(2, '0')}`
                  const currentTimeStr = `${Math.floor(currentTime / 60).toString().padStart(2, '0')}:${(currentTime % 60).toString().padStart(2, '0')}`
                  console.log(`⏰ SCHEDULE TURN-OFF: ${outletKey} turned OFF at exact time ${endTimeStr} (current: ${currentTimeStr})`)
                }
              }
              
              // AUTOMATIC STATUS UPDATE: Update device status based on final decision
              if (currentControlState !== newControlState) {
                console.log(`Schedule: AUTOMATIC UPDATE - ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
                
                // CRITICAL: When turning OFF due to schedule expiration, set main_status to 'OFF' to prevent re-activation
                if (newControlState === 'off') {
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  console.log(`🔒 Schedule: Set main_status to 'OFF' for ${outletKey} to prevent re-activation after schedule expiration`)
                } else {
                  console.log(`✅ Schedule: Device ${outletKey} turned ON by schedule - main_status unchanged`)
                }
                
                console.log(`✅ Schedule: AUTOMATIC UPDATE COMPLETE - ${outletKey} updated to ${newControlState}`)
                
                // Note: Automatic system activities are not logged to avoid cluttering device logs
              } else {
                console.log(`Schedule: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('Schedule: Error in real-time scheduler:', error)
      }
    }
    
    // Run scheduler immediately
    checkScheduleAndUpdateDevices()
    
    // Set up interval
    const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds
    
    // Cleanup interval on unmount
    return () => {
      clearInterval(scheduleInterval)
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
      
    }
  }, [combinedLimitInfo])

  // Unplug detection: Monitor timestamp changes and detect unplugged devices
  useEffect(() => {
    const checkUnpluggedDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (!snapshot.exists()) return
        
        const devicesData = snapshot.val()
        const currentTime = Date.now()
        
        // Check all devices for unplug detection (even without schedule)
        for (const [outletKey, outletData] of Object.entries(devicesData)) {
          const deviceData = outletData as FirebaseDeviceData
          
          // Get current timestamp from sensor_data
          const sensorTimestamp = deviceData.sensor_data?.timestamp || ''
          
          // Get basis from schedule if it exists (preserved from deleted schedule), or initialize if needed
          let basis = deviceData.schedule?.basis || 0
          const disabledByUnplug = deviceData.schedule?.disabled_by_unplug || false
          
          // If schedule doesn't exist but device should be monitored, or if basis doesn't exist, initialize it
          if (!deviceData.schedule || (!deviceData.schedule.timeRange && !deviceData.schedule.startTime)) {
            // Device has no active schedule but may have preserved basis/disabled_by_unplug from deleted schedule
            if (!basis && disabledByUnplug) {
              // If disabled_by_unplug exists but no basis, skip (inconsistent state)
              continue
            }
            if (!basis) {
              // No schedule and no basis - initialize basis and schedule for unplug detection
              basis = Date.now()
              try {
                const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
                await update(scheduleRef, {
                  basis: basis,
                  disabled_by_unplug: false
                })
                console.log(`Schedule: Initialized basis for unplug detection on ${outletKey} (no schedule)`)
              } catch (error) {
                console.error(`Schedule: Error initializing basis for ${outletKey}:`, error)
                continue
              }
            }
          } else {
            // Device has schedule - ensure basis exists
            if (!basis) {
              // Schedule exists but no basis - initialize it
              basis = Date.now()
              try {
                const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
                await update(scheduleRef, {
                  basis: basis
                })
                console.log(`Schedule: Initialized basis for unplug detection on ${outletKey} (with schedule)`)
              } catch (error) {
                console.error(`Schedule: Error initializing basis for ${outletKey}:`, error)
                continue
              }
            }
          }
          
          // Convert timestamp to milliseconds if it's in epoch seconds format
          let timestampMs = 0
          if (sensorTimestamp) {
            // Check if timestamp is in seconds (10 digits) or milliseconds (13 digits)
            const timestampNum = parseInt(sensorTimestamp, 10)
            if (timestampNum.toString().length === 10) {
              timestampMs = timestampNum * 1000 // Convert seconds to milliseconds
            } else {
              timestampMs = timestampNum
            }
          }
          
          // CHECK FIRST: If device is already disabled by unplug, check if timestamp changed (device plugged back in)
          // This must be checked BEFORE setState using functional update to get current state
          if (disabledByUnplug === true) {
            // Check timestamp change using functional setState to get current state
            setDeviceTimestamps(prev => {
              const existing = prev[outletKey]
              
              // Device is marked as unplugged - check if timestamp has changed (device plugged back in)
              if (existing && existing.lastTimestamp && sensorTimestamp && existing.lastTimestamp !== sensorTimestamp) {
                // Timestamp changed - device was plugged back in after being unplugged
                console.log(`🔌 Schedule: PLUG DETECTED: ${outletKey} - timestamp changed from "${existing.lastTimestamp}" to "${sensorTimestamp}", resetting unplug state`)
                
                // Reset unplug state ASYNCHRONOUSLY (outside of setState callback)
                setTimeout(() => {
                  const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
                  update(scheduleRef, {
                    disabled_by_unplug: false
                  }).then(() => {
                    // Reset root status from UNPLUG to normal status (based on control state)
                    const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
                    return get(controlRef).then(controlSnapshot => {
                      const controlData = controlSnapshot.val()
                      const controlState = controlData?.device || 'off'
                      
                      return update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: controlState === 'on' ? 'ON' : 'OFF'
                      })
                    })
                  }).then(() => {
                    console.log(`✅ Schedule: RESET UNPLUG STATE: ${outletKey} - device plugged back in, disabled_by_unplug set to false, status reset to normal`)
                  }).catch(err => {
                    console.error(`❌ Error resetting unplug state for ${outletKey}:`, err)
                  })
                }, 0)
                
                // Update timestamp tracking with new timestamp immediately
                return {
                  ...prev,
                  [outletKey]: {
                    lastTimestamp: sensorTimestamp, // Store new timestamp
                    lastTimestampTime: currentTime, // Reset time to track new timestamp
                    basis: basis,
                    lastChecked: currentTime
                  }
                }
              }
              
              // Device is unplugged but timestamp hasn't changed - update lastChecked time only
              if (existing) {
                return {
                  ...prev,
                  [outletKey]: {
                    ...existing,
                    lastChecked: currentTime
                  }
                }
              }
              
              // No existing tracking for unplugged device - initialize it with current timestamp
              // This is important: store the timestamp so we can detect when it changes
              return {
                ...prev,
                [outletKey]: {
                  lastTimestamp: sensorTimestamp || '', // Store current timestamp
                  lastTimestampTime: currentTime,
                  basis: basis,
                  lastChecked: currentTime
                }
              }
            })
            
            // Continue to next device after handling unplugged state
            continue
          }
          
          // Initialize or update device timestamp tracking for non-unplugged devices
          setDeviceTimestamps(prev => {
            const existing = prev[outletKey]
            
            // Device is NOT disabled by unplug - continue with normal unplug detection
            // If timestamp hasn't changed, check if it's been 30 seconds since we first saw this timestamp
            if (existing && existing.lastTimestamp === sensorTimestamp && sensorTimestamp) {
              // Calculate time since we first detected this timestamp value
              const timeSinceLastUpdate = currentTime - existing.lastTimestampTime
              
              // If 30 seconds have passed since timestamp last changed
              if (timeSinceLastUpdate >= 30000) {
                // Mark device as unplugged
                const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
                // Get or create schedule object for basis/disabled_by_unplug
                get(scheduleRef).then(scheduleSnapshot => {
                  const currentSchedule = scheduleSnapshot.val() || {}
                  return update(scheduleRef, {
                    basis: currentSchedule.basis || basis || Date.now(),
                    disabled_by_unplug: true
                  })
                }).then(() => {
                  // Turn off the device
                  update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  }).then(() => {
                    // Disable schedule by turning off main_status
                    update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    }).then(() => {
                      // Set root status to UNPLUG for display in Schedule.tsx table
                      return update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'UNPLUG'
                      })
                    }).then(() => {
                      console.log(`🔌 Schedule: UNPLUG DETECTED: ${outletKey} - timestamp unchanged for 30+ seconds. Device turned OFF, schedule disabled, and root status set to UNPLUG.`)
                    }).catch(err => {
                      console.error(`Error disabling schedule or setting UNPLUG status for ${outletKey}:`, err)
                    })
                  }).catch(err => {
                    console.error(`Error turning off device ${outletKey}:`, err)
                  })
                }).catch(err => {
                  console.error(`Error marking ${outletKey} as unplugged:`, err)
                })
                
                // Update state to track this timestamp (when device was marked unplugged)
                // This timestamp will be used to detect when it changes (device plugged back in)
                return {
                  ...prev,
                  [outletKey]: {
                    lastTimestamp: sensorTimestamp, // Store the timestamp when device was marked unplugged
                    lastTimestampTime: existing.lastTimestampTime, // Keep original time when we first saw this timestamp
                    basis: basis,
                    lastChecked: currentTime
                  }
                }
              }
              
              // Timestamp hasn't changed but it hasn't been 30 seconds yet
              return prev
            }
            
            // If timestamp changed or is new, update tracking with current time
            if (!existing || existing.lastTimestamp !== sensorTimestamp) {
              return {
                ...prev,
                [outletKey]: {
                  lastTimestamp: sensorTimestamp || '',
                  lastTimestampTime: currentTime, // Track when we first saw this timestamp value
                  basis: basis,
                  lastChecked: currentTime
                }
              }
            }
            
            return prev
          })
        }
      } catch (error) {
        console.error('Error checking unplugged devices:', error)
      }
    }
    
    // Run check immediately
    checkUnpluggedDevices()
    
    // Set up interval to check every 5 seconds
    const unplugCheckInterval = setInterval(checkUnpluggedDevices, 5000)
    
    // Cleanup interval on unmount
    return () => {
      clearInterval(unplugCheckInterval)
    }
  }, []) // Empty dependency array - only run once on mount, don't reset when deviceSchedules changes

  const filteredDevices = deviceSchedules.filter(device =>
    device.outletName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    device.appliances.toLowerCase().includes(searchQuery.toLowerCase()) ||
    device.officeRoom.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleEditSchedule = (deviceId: string) => {
    const deviceToEdit = deviceSchedules.find(device => device.id === deviceId)
    if (deviceToEdit) {
      // Check if device is part of a combined schedule
      if (deviceToEdit.schedule.isCombinedSchedule) {
        // Show modal that individual schedule editing is not allowed for combined schedules
        setCombinedScheduleWarningModal({
          isOpen: true,
          deviceName: deviceToEdit.outletName,
          combinedOutlets: deviceToEdit.schedule.selectedOutlets || []
        })
        return
      }
      
      // Check if power scheduling is enabled for this device
      if (!deviceToEdit.enablePowerScheduling) {
        // Show modal that power scheduling is not allowed
        setPowerSchedulingNotAllowedModal({
          isOpen: true,
          deviceName: deviceToEdit.outletName
        })
        return
      }
      
      // If power scheduling is enabled, open the edit modal
      setEditModal({
        isOpen: true,
        device: deviceToEdit
      })
    }
  }

  const handleSaveSchedule = async (deviceId: string, updatedSchedule: {
    timeRange: string
    frequency: string
  }) => {
    try {
      // Find the device to get the outlet key
      const device = deviceSchedules.find(d => d.id === deviceId)
      if (!device) return
      
      // Convert outlet name back to Firebase key format
      const outletKey = device.outletName.replace(' ', '_')
      
      // Helper function to convert 12-hour time to 24-hour
      const convertTo24Hour = (time12h: string) => {
        if (!time12h) return ''
        const [time, modifier] = time12h.split(' ')
        let [hours, minutes] = time.split(':')
        
        if (hours === '12') {
          hours = '00'
        }
        
        if (modifier === 'PM') {
          hours = String(parseInt(hours, 10) + 12)
        }
        
        return `${hours.padStart(2, '0')}:${minutes}`
      }
      
      // Save schedule to Firebase
      const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
      const startTime24 = convertTo24Hour(updatedSchedule.timeRange.split(' - ')[0])
      const endTime24 = convertTo24Hour(updatedSchedule.timeRange.split(' - ')[1])
      
      // Create basis timestamp for unplug detection
      const basis = Date.now()
      
      await set(scheduleRef, {
        timeRange: updatedSchedule.timeRange,
        frequency: updatedSchedule.frequency,
        startTime: startTime24,
        endTime: endTime24,
        selectedDays: updatedSchedule.frequency.toLowerCase() === 'daily' ? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] :
                     updatedSchedule.frequency.toLowerCase() === 'weekdays' ? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] :
                     updatedSchedule.frequency.toLowerCase() === 'weekends' ? ['SATURDAY', 'SUNDAY'] :
                     updatedSchedule.frequency.split(', ').map(day => day.trim()),
        basis: basis,
        disabled_by_unplug: false
      })

      
      
      console.log(`Saved schedule for ${outletKey}:`, {
        timeRange: updatedSchedule.timeRange,
        frequency: updatedSchedule.frequency,
        startTime: startTime24,
        endTime: endTime24
      })
      
      // Get current device data to check power limits
      const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
      const deviceSnapshot = await get(deviceRef)
      const currentDeviceData = deviceSnapshot.val()
      
      // Immediately update relay status and main status based on new schedule
      const shouldBeActive = isDeviceActiveBySchedule({
        timeRange: updatedSchedule.timeRange,
        frequency: updatedSchedule.frequency,
        startTime: startTime24,
        endTime: endTime24
      }, 'on', currentDeviceData) // Pass device data to check power limits
      
      const latestDeviceSnap = await get(ref(realtimeDb, `devices/${outletKey}`))
      const latestDevice = latestDeviceSnap.val() || {}
      const newControlState = shouldBeActive ? 'on' : 'off'
      console.log(`Setting ${outletKey} control state to ${newControlState} based on new schedule`)
      console.log(`Note: Main status ON will override schedule restrictions for manual control`)

      const currControl = latestDevice.control?.device || 'off'
      if (currControl !== newControlState) {
        await update(ref(realtimeDb, `devices/${outletKey}/control`), {
          device: newControlState
        })
      }
      
      console.log(`✅ Updated control state to ${newControlState} for ${outletKey} based on new schedule`)
      
      // Log the schedule activity
      const scheduleDetails = `${updatedSchedule.timeRange} (${updatedSchedule.frequency})`
      await logScheduleActivity(
        'Edit schedule',
        device.outletName,
        scheduleDetails,
        device.officeRoom || 'Unknown',
        device.appliances || 'Unknown',
        undefined // Let the logging function get the current user from Firebase Auth
      )
      
      // Reset unplug detection state for this device when schedule is saved
      setDeviceTimestamps(prev => {
        const newState = { ...prev }
        delete newState[outletKey]
        return newState
      })
      
      // Reset root status from UNPLUG to normal status when schedule is saved
      const deviceStatusRef = ref(realtimeDb, `devices/${outletKey}`)
      const deviceStatusSnapshot = await get(deviceStatusRef)
      const deviceStatusData = deviceStatusSnapshot.val()
      if (deviceStatusData?.status === 'UNPLUG' || deviceStatusData?.status === 'unplug') {
        const currentControlState = deviceStatusData?.control?.device || 'off'
        await update(deviceStatusRef, {
          status: currentControlState === 'on' ? 'ON' : 'OFF'
        })
        console.log(`Schedule: Reset status from UNPLUG to ${currentControlState === 'on' ? 'ON' : 'OFF'} for ${outletKey} after saving schedule`)
      }
      
      const deviceName = device.outletName
      setEditModal({ isOpen: false, device: null })
      setSuccessModal({ isOpen: true, deviceName })
    } catch (error) {
      console.error('Error saving schedule:', error)
      // You could add error handling here, like showing an error message
    }
  }

  const handleDeleteSchedule = (deviceId: string) => {
    // Find the device to get the outlet name
    const device = deviceSchedules.find(d => d.id === deviceId)
    if (!device) return
    
    // Show confirmation modal
    setDeleteConfirmModal({
      isOpen: true,
      deviceId: deviceId,
      deviceName: device.outletName
    })
  }

  const handleConfirmDeleteSchedule = async () => {
    try {
      // Find the device to get the outlet key
      const device = deviceSchedules.find(d => d.id === deleteConfirmModal.deviceId)
      if (!device) return
      
      // Convert outlet name back to Firebase key format
      const outletKey = device.outletName.replace(' ', '_')
      
      // Get current schedule data to preserve basis and disabled_by_unplug
      const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
      const scheduleSnapshot = await get(scheduleRef)
      const existingSchedule = scheduleSnapshot.val() || {}
      
      // Preserve basis and disabled_by_unplug for unplug detection (used in SetUp.tsx)
      const preservedBasis = existingSchedule.basis || null
      const preservedDisabledByUnplug = existingSchedule.disabled_by_unplug !== undefined ? existingSchedule.disabled_by_unplug : false
      
      // Remove schedule from Firebase but preserve basis and disabled_by_unplug
      if (preservedBasis !== null) {
        // Preserve basis and disabled_by_unplug while deleting other schedule fields
        await update(scheduleRef, {
          timeRange: null,
          startTime: null,
          endTime: null,
          frequency: null,
          selectedDays: null,
          combinedScheduleId: null,
          isCombinedSchedule: null,
          selectedOutlets: null,
          enabled: null,
          basis: preservedBasis,
          disabled_by_unplug: preservedDisabledByUnplug
        })
      } else {
        // If no basis exists, delete everything
        await set(scheduleRef, null)
      }
      
      // Turn off relay and main status when schedule is deleted
      console.log(`Turning off ${outletKey} relay and main status after schedule deletion`)
      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
        status: 'OFF',
        main_status: 'OFF'
      })
      
      // Log the schedule deletion activity
      await logScheduleActivity(
        'Remove schedule',
        device.outletName,
        'Schedule deleted',
        device.officeRoom || 'Unknown',
        device.appliances || 'Unknown',
        undefined // Let the logging function get the current user from Firebase Auth
      )
      
      // Close confirmation modal
      setDeleteConfirmModal({ isOpen: false, deviceId: '', deviceName: '' })
      
      // Show success message
      const deviceName = device.outletName
      setSuccessModal({ isOpen: true, deviceName: `${deviceName} schedule deleted` })
    } catch (error) {
      console.error('Error deleting schedule:', error)
      // You could add error handling here, like showing an error message
    }
  }

  const handleSaveCombinedSchedule = async (selectedOutlets: string[], scheduleData: any) => {
    try {
      const isEditMode = outletSelectionModal.isEditMode
      const existingSchedule = outletSelectionModal.existingCombinedSchedule
      
      console.log('Saving combined schedule for outlets:', selectedOutlets)
      console.log('Schedule data:', scheduleData)
      console.log('Edit mode:', isEditMode)
      
      // Check which outlets exceed limits before saving
      const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
      const combinedLimitSnapshot = await get(combinedLimitRef)
      const combinedLimitData = combinedLimitSnapshot.exists() ? combinedLimitSnapshot.val() : null
      
      let outletsToSave = selectedOutlets
      
      if (selectedOutlets.length > 0) {
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        
        if (devicesSnapshot.exists()) {
          const devicesData = devicesSnapshot.val()
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          
          // Check if combined limit is enabled and has a valid value
          const combinedLimitWh = combinedLimitData?.combinedLimit || 0
          const hasValidCombinedLimit = combinedLimitData?.enabled && combinedLimitWh > 0
          
          // Filter out outlets that exceed limits
          outletsToSave = selectedOutlets.filter(outletKey => {
            const deviceData = devicesData[outletKey]
            if (deviceData) {
              const todayLogs = deviceData?.daily_logs?.[todayDateKey]
              const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
              const outletEnergyWh = todayTotalEnergy * 1000 // Convert to Wh
              
              let outletExceedsLimit = false
              
              // Check if this outlet is part of the combined group
              const outletName = outletKey.replace('_', ' ')
              const isOutletInCombinedGroup = hasValidCombinedLimit && 
                (combinedLimitData?.selectedOutlets?.includes(outletKey) || 
                 combinedLimitData?.selectedOutlets?.includes(outletName))
              
              if (isOutletInCombinedGroup) {
                // Use combined limit if outlet is part of combined group
                outletExceedsLimit = outletEnergyWh >= combinedLimitWh
              } else {
                // Fallback to individual limit if not in combined group or no combined limit
                const individualPowerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
                const individualPowerLimitWh = individualPowerLimit * 1000 // Convert from kW to Wh
                
                if (individualPowerLimitWh > 0) {
                  outletExceedsLimit = outletEnergyWh >= individualPowerLimitWh
                }
                // If no individual limit is set either, allow the outlet
              }
              
              // Only include outlets that are within limits
              return !outletExceedsLimit
            }
            return true // Include if no data found
          })
          
          console.log(`Filtered outlets: ${outletsToSave.length} out of ${selectedOutlets.length} outlets will be saved`)
        }
      }
      
      // Use existing combined schedule ID if editing, otherwise generate new one
      const combinedScheduleId = isEditMode && existingSchedule 
        ? existingSchedule.combinedScheduleId 
        : `combined_${Date.now()}`
      
      // If editing, first remove the old combined schedule from outlets that are no longer selected
      if (isEditMode && existingSchedule) {
        const outletsToRemove = existingSchedule.selectedOutlets.filter(
          outlet => !outletsToSave.includes(outlet)
        )
        
        for (const outletKey of outletsToRemove) {
          const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
          await set(scheduleRef, null)
          console.log(`Removed combined schedule from ${outletKey}`)
        }
      }
      
      // Create basis timestamp for unplug detection
      const basis = Date.now()
      
      // Save the combined schedule only to outlets that are within limits
      for (const outletKey of outletsToSave) {
        const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
        
        await set(scheduleRef, {
          ...scheduleData,
          combinedScheduleId,
          isCombinedSchedule: true,
          selectedOutlets: outletsToSave,
          basis: basis,
          disabled_by_unplug: false
        })

        
        
        console.log(`Saved combined schedule to ${outletKey} with basis: ${basis}`)
      }
      
      // Log the combined schedule activity
      const activity = isEditMode ? 'Edit schedule' : 'Set schedule'
      const scheduleDetails = `${scheduleData.timeRange} (${scheduleData.frequency})`
      // Create proper outlet list
      let outletList = '';
      if (outletsToSave.length === 1) {
        outletList = outletsToSave[0].replace('Outlet ', 'Outlet');
      } else if (outletsToSave.length > 1) {
        // Extract numbers and create range
        const numbers = outletsToSave.map(outlet => {
          // Handle different outlet name formats
          const match = outlet.match(/Outlet[_\s]*(\d+)/);
          return match ? match[1] : outlet.replace(/Outlet[_\s]*/, '');
        }).sort((a, b) => parseInt(a) - parseInt(b));
        outletList = `Outlet${numbers[0]} to ${numbers[numbers.length - 1]}`;
      }
      
      await logScheduleActivity(
        activity === 'Edit schedule' ? 'Edit schedule' : 'Set schedule',
        outletList,
        scheduleDetails,
        'Multiple Outlets',
        'Combined Group',
        undefined // Let the logging function get the current user from Firebase Auth
      )
      
      // Close the modal
      setOutletSelectionModal({ isOpen: false, isEditMode: false, existingCombinedSchedule: null })
      
      // Show success message with information about filtered outlets
        // Reset unplug detection state for all saved outlets when combined schedule is saved
        setDeviceTimestamps(prev => {
          const newState = { ...prev }
          outletsToSave.forEach(outletKey => {
            delete newState[outletKey]
          })
          return newState
        })
        
        // Reset root status from UNPLUG to normal status when combined schedule is saved
        for (const outletKey of outletsToSave) {
          const statusCheckRef = ref(realtimeDb, `devices/${outletKey}`)
          const statusCheckSnapshot = await get(statusCheckRef)
          const statusCheckData = statusCheckSnapshot.val()
          if (statusCheckData?.status === 'UNPLUG' || statusCheckData?.status === 'unplug') {
            const statusControlState = statusCheckData?.control?.device || 'off'
            await update(statusCheckRef, {
              status: statusControlState === 'on' ? 'ON' : 'OFF'
            })
            console.log(`Schedule: Reset status from UNPLUG to ${statusControlState === 'on' ? 'ON' : 'OFF'} for ${outletKey} after saving combined schedule`)
          }
        }
        
        const filteredCount = selectedOutlets.length - outletsToSave.length
      let successMessage = `Combined schedule ${isEditMode ? 'updated' : 'created'} for ${outletsToSave.length} outlets`
      
      if (filteredCount > 0) {
        successMessage += ` (${filteredCount} outlet(s) excluded due to limit restrictions)`
      }
      
      setSuccessModal({ 
        isOpen: true, 
        deviceName: successMessage
      })
      
    } catch (error) {
      console.error('Error saving combined schedule:', error)
    }
  }

  const handleLimitExceeded = (deviceName: string, limitType: 'individual' | 'combined', currentUsage: number, limitValue: number, scheduleTime: string) => {
    setLimitExceededModal({
      isOpen: true,
      deviceName,
      limitType,
      currentUsage,
      limitValue,
      scheduleTime
    })
  }

  const handleSuccess = (message: string) => {
    setSuccessModal({
      isOpen: true,
      deviceName: message
    })
  }

  // Get status badge styling (updated to match Dashboard.tsx)
  const getStatusBadge = (status: string) => {
    const statusClasses: { [key: string]: string } = {
      'Active': 'status-active',
      'Inactive': 'status-inactive',
      'Blocked': 'status-blocked',
      'Idle': 'status-idle',
      'UNPLUG': 'status-unplug'
    }
    
    return (
      <span className={`status-badge ${statusClasses[status] || 'status-inactive'}`}>
        <span className={`status-dot ${statusClasses[status] || 'status-inactive'}`}></span>
        {status}
      </span>
    )
  }

  return (
    <div className="schedule-container">
      {/* Header Section */}
      <div className="schedule-header">
        <div className="header-left">
          <div className="header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="1.6"/>
              <path d="M8 2v4M16 2v4M3 9h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </div>
          <h1 className="header-title">Schedule Devices</h1>
        </div>
        <div className="header-search">
          <div className="search-container">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
              <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Search device"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
          </div>
          <button
            className="add-outlets-btn"
            onClick={() => {
              const existingSchedule = detectExistingCombinedSchedule()
              if (existingSchedule) {
                setOutletSelectionModal({ 
                  isOpen: true, 
                  isEditMode: true, 
                  existingCombinedSchedule: existingSchedule 
                })
              } else {
                setOutletSelectionModal({ 
                  isOpen: true, 
                  isEditMode: false, 
                  existingCombinedSchedule: null 
                })
              }
            }}
            title={detectExistingCombinedSchedule() ? "Edit Multiple Schedule" : "Add Outlets to Schedule"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {detectExistingCombinedSchedule() ? 'Edit Multiple Schedule' : 'Multiple Schedule'}
          </button>
        </div>
      </div>

      {/* Table Section */}
      <div className="schedule-table-container">
        {loading ? (
          <div className="loading-container">
            <div className="loading-spinner"></div>
            <p>Loading devices...</p>
          </div>
        ) : error ? (
          <div className="error-container">
            <div className="error-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" stroke="#ef4444" strokeWidth="2"/>
                <path d="M15 9l-6 6M9 9l6 6" stroke="#ef4444" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="error-message">{error}</p>
            <button 
              className="btn-primary"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        ) : deviceSchedules.length === 0 ? (
          <div className="empty-container">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 12l2 2 4-4" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="#6b7280" strokeWidth="2"/>
              </svg>
            </div>
            <p>No devices found</p>
            <p className="empty-subtitle">Devices will appear here once they are connected to the system.</p>
          </div>
        ) : (
          <table className="schedule-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>OUTLET NAME</th>
                <th>APPLIANCES</th>
                <th>OFFICE/ ROOM</th>
                <th>LIMIT</th>
                <th>POWER USAGE</th>
                <th>CURRENT (A)</th>
                <th>STATUS</th>
                <th>TODAY'S USAGE</th>
                <th>SCHEDULE</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => (
                <tr key={device.id}>
                  <td className="device-id">{device.id}</td>
                  <td className="outlet-name">{device.outletName}</td>
                  <td className="appliances">{device.appliances}</td>
                  <td className="office-room">{device.officeRoom}</td>
                  <td className="limit">
                    {(() => {
                      // Check if device is using combined limit (handle both "Outlet_1" and "Outlet 1" formats)
                      const deviceOutletName = device.outletName
                      const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
                      const isUsingCombinedLimit = combinedLimitInfo.enabled && 
                        (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
                         combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
                      
                      console.log(`Schedule: Checking device ${device.outletName}:`, {
                        enabled: combinedLimitInfo.enabled,
                        selectedOutlets: combinedLimitInfo.selectedOutlets,
                        deviceOutletName,
                        deviceOutletNameWithSpace,
                        isUsingCombinedLimit,
                        combinedLimit: combinedLimitInfo.combinedLimit
                      })
                      
                      if (isUsingCombinedLimit) {
                        return (
                            <div className="combined-limit-display">
                              <div className="combined-limit-indicator">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                                <span>{String(combinedLimitInfo.combinedLimit) === "No Limit" ? "No Limit" : `${combinedLimitInfo.combinedLimit}Wh`}</span>
                              </div>
                            </div>
                        )
                      } else {
                        // Ensure proper Wh unit formatting without creating Whh
                        return device.limit.includes('Wh') ? device.limit : device.limit.replace(' W', ' Wh')
                      }
                    })()}
                  </td>
                  <td className="power-usage">{device.powerUsage}</td>
                  <td className="current-ampere">{device.currentAmpere}</td>
                  <td>
                    <div className="status-container">
                      {getStatusBadge(device.status)}
                      {device.schedule.timeRange && (
                        <div 
                                          className={`schedule-indicator ${device.status === 'Active' ? 'active' : 'inactive'}`}
                title={`Schedule: ${device.schedule.timeRange} (${device.schedule.frequency}) - Currently ${device.status === 'Active' ? 'ACTIVE' : device.status === 'UNPLUG' ? 'UNPLUGGED' : 'INACTIVE'}`}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                            <polyline points="12,6 12,12 16,14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="todays-usage">{device.todaysUsage}</td>
                  <td>
                    {device.schedule.timeRange ? (
                      <div className="schedule-info">
                        <div className="schedule-time">
                          {device.schedule.timeRange}
                          {device.status === 'Active' && (
                            <span className="schedule-active-indicator" title="Currently active">
                              ●
                            </span>
                          )}
                          {device.schedule.isCombinedSchedule && (
                            <span className="combined-schedule-indicator" title={`Combined schedule with ${device.schedule.selectedOutlets?.length || 0} outlets`}>
                              🔗
                            </span>
                          )}
                        </div>
                        <span className={`schedule-frequency ${device.schedule.frequency.toLowerCase() === 'daily' || device.schedule.frequency.toLowerCase() === 'weekdays' || device.schedule.frequency.toLowerCase() === 'weekends' ? device.schedule.frequency.toLowerCase() : 'custom'}`}>
                          {formatFrequencyDisplay(device.schedule.frequency)}
                          {device.schedule.isCombinedSchedule && (
                            <span className="combined-label" title={`Combined with: ${device.schedule.selectedOutlets?.map(outlet => outlet.replace('_', ' ')).join(', ')}`}>
                              (Combined - {device.schedule.selectedOutlets?.length || 0} outlets)
                            </span>
                          )}
                        </span>
                      </div>
                    ) : (
                      <div className="no-schedule">
                        <span className="no-schedule-text">No schedule set</span>
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="action-buttons">
                      <div className="more-options">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <circle cx="12" cy="12" r="1" fill="currentColor"/>
                          <circle cx="12" cy="6" r="1" fill="currentColor"/>
                          <circle cx="12" cy="18" r="1" fill="currentColor"/>
                        </svg>
                      </div>
                      <button
                        className="edit-btn"
                        onClick={() => handleEditSchedule(device.id)}
                        title="Edit Schedule"
                      >
                        {device.schedule.timeRange ? 'Edit Schedule' : 'Set Schedule'}
                      </button>
                      <button
                        className="action-btn delete-btn"
                        onClick={() => handleDeleteSchedule(device.id)}
                        title="Delete Schedule"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                          <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit Schedule Modal */}
      <EditScheduleModal
        isOpen={editModal.isOpen}
        onClose={() => setEditModal({ isOpen: false, device: null })}
        device={editModal.device}
        onSave={handleSaveSchedule}
        onLimitExceeded={handleLimitExceeded}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={deleteConfirmModal.isOpen}
        onClose={() => setDeleteConfirmModal({ isOpen: false, deviceId: '', deviceName: '' })}
        onConfirm={handleConfirmDeleteSchedule}
        deviceName={deleteConfirmModal.deviceName}
      />

      {/* Success Modal */}
      <SuccessModal
        isOpen={successModal.isOpen}
        onClose={() => setSuccessModal({ isOpen: false, deviceName: '' })}
        deviceName={successModal.deviceName}
      />

      {/* Power Scheduling Not Allowed Modal */}
      <PowerSchedulingNotAllowedModal
        isOpen={powerSchedulingNotAllowedModal.isOpen}
        onClose={() => setPowerSchedulingNotAllowedModal({ isOpen: false, deviceName: '' })}
        deviceName={powerSchedulingNotAllowedModal.deviceName}
      />

      {/* Combined Schedule Warning Modal */}
      <CombinedScheduleWarningModal
        isOpen={combinedScheduleWarningModal.isOpen}
        onClose={() => setCombinedScheduleWarningModal({ isOpen: false, deviceName: '', combinedOutlets: [] })}
        deviceName={combinedScheduleWarningModal.deviceName}
        combinedOutlets={combinedScheduleWarningModal.combinedOutlets}
      />

      {/* Outlet Selection Modal */}
      <OutletSelectionModal
        isOpen={outletSelectionModal.isOpen}
        onClose={() => setOutletSelectionModal({ isOpen: false, isEditMode: false, existingCombinedSchedule: null })}
        onSave={handleSaveCombinedSchedule}
        isEditMode={outletSelectionModal.isEditMode}
        existingCombinedSchedule={outletSelectionModal.existingCombinedSchedule}
        onLimitExceeded={handleLimitExceeded}
        onSuccess={handleSuccess}
      />

      {/* Limit Exceeded Modal */}
      <LimitExceededModal
        isOpen={limitExceededModal.isOpen}
        onClose={() => setLimitExceededModal({ 
          isOpen: false, 
          deviceName: '', 
          limitType: 'individual', 
          currentUsage: 0, 
          limitValue: 0, 
          scheduleTime: '' 
        })}
        deviceName={limitExceededModal.deviceName}
        limitType={limitExceededModal.limitType}
        currentUsage={limitExceededModal.currentUsage}
        limitValue={limitExceededModal.limitValue}
        scheduleTime={limitExceededModal.scheduleTime}
      />
    </div>
  )
}

// Add comprehensive test function for Schedule monthly limit checking
;(window as any).testScheduleMonthlyLimit = async () => {
  console.log('🧪 SCHEDULE - TESTING MONTHLY LIMIT CHECKING...')
  try {
    // 1. Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    console.log('📊 SCHEDULE - Devices data loaded:', Object.keys(devicesData))
    
    // 2. Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    console.log('📊 SCHEDULE - Combined limit settings:', limitData)
    
    // 3. Test monthly limit check for each device
    const selectedOutlets = limitData.selected_outlets || []
    const combinedLimit = limitData.combined_limit_watts || 0
    
    console.log('🧪 SCHEDULE - Testing monthly limit checks for outlets:', selectedOutlets)
    
    for (const outletKey of selectedOutlets) {
      console.log(`\n🔍 SCHEDULE - Testing ${outletKey}...`)
      
      const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
        enabled: limitData.enabled,
        selectedOutlets: selectedOutlets,
        combinedLimit: combinedLimit
      })
      
      console.log(`📊 SCHEDULE - ${outletKey} result:`, {
        canTurnOn: monthlyLimitCheck.canTurnOn,
        reason: monthlyLimitCheck.reason,
        currentEnergy: monthlyLimitCheck.currentMonthlyEnergy,
        limit: monthlyLimitCheck.combinedLimit
      })
    }
    
    // 4. Test the scheduler function directly
    console.log('\n🧪 SCHEDULE - Testing scheduler function...')
    // Note: This would need to be called from within the component context
    console.log('📊 SCHEDULE - Scheduler test completed (function would need component context)')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error testing monthly limit checking:', error)
  }
}

// Add comprehensive test function for Schedule hierarchy
;(window as any).testScheduleHierarchy = async () => {
  console.log('🧪 SCHEDULE - TESTING HIERARCHY ENFORCEMENT...')
  try {
    // 1. Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    console.log('📊 SCHEDULE - Devices data loaded:', Object.keys(devicesData))
    
    // 2. Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    console.log('📊 SCHEDULE - Combined limit settings:', limitData)
    
    // 3. Test hierarchy for each device with schedule
    const selectedOutlets = limitData.selected_outlets || []
    const combinedLimit = limitData.combined_limit_watts || 0
    
    console.log('🧪 SCHEDULE - Testing hierarchy for devices with schedules...')
    
    for (const [outletKey, outletData] of Object.entries(devicesData)) {
      const deviceData = outletData as any
      
      // Only test devices with schedules
      if (deviceData.schedule && 
          (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
        
        console.log(`\n🔍 SCHEDULE - Testing hierarchy for ${outletKey}...`)
        
        // Test 1: Monthly limit check
        const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
          enabled: limitData.enabled,
          selectedOutlets: selectedOutlets,
          combinedLimit: combinedLimit
        })
        
        console.log(`📊 SCHEDULE - ${outletKey} monthly limit check:`, {
          canTurnOn: monthlyLimitCheck.canTurnOn,
          reason: monthlyLimitCheck.reason,
          currentEnergy: monthlyLimitCheck.currentMonthlyEnergy,
          limit: monthlyLimitCheck.combinedLimit
        })
        
        // Test 2: Daily limit check
        const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
        const today = new Date()
        const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
        const todayLogs = deviceData?.daily_logs?.[todayDateKey]
        const todayTotalEnergy = todayLogs?.total_energy || 0
        
        const isDailyLimitExceeded = powerLimit !== "No Limit" && powerLimit > 0 && todayTotalEnergy >= powerLimit
        
        console.log(`📊 SCHEDULE - ${outletKey} daily limit check:`, {
          powerLimit: powerLimit === "No Limit" ? "No Limit" : `${(powerLimit * 1000)}W`,
          todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
          isExceeded: isDailyLimitExceeded
        })
        
        // Test 3: Schedule check
        const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData)
        
        console.log(`📊 SCHEDULE - ${outletKey} schedule check:`, {
          shouldBeActive: shouldBeActive,
          schedule: deviceData.schedule
        })
        
        // Test 4: Final hierarchy result
        let finalResult = 'OFF'
        if (monthlyLimitCheck.canTurnOn && !isDailyLimitExceeded && shouldBeActive) {
          finalResult = 'ON'
        }
        
        console.log(`📊 SCHEDULE - ${outletKey} FINAL HIERARCHY RESULT: ${finalResult}`)
        console.log(`📊 SCHEDULE - ${outletKey} hierarchy: Monthly=${monthlyLimitCheck.canTurnOn ? 'OK' : 'BLOCKED'}, Daily=${!isDailyLimitExceeded ? 'OK' : 'BLOCKED'}, Schedule=${shouldBeActive ? 'ON' : 'OFF'}`)
      }
    }
    
    console.log('\n🧪 SCHEDULE - HIERARCHY TEST COMPLETE')
    console.log('📊 HIERARCHY ORDER: 1. Monthly Limit, 2. Daily Limit, 3. Schedule')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error testing hierarchy:', error)
  }
}

// Add function to check current time and schedule status
;(window as any).checkCurrentScheduleStatus = () => {
  console.log('🕐 SCHEDULE - CHECKING CURRENT TIME AND SCHEDULE STATUS...')
  
  const now = new Date()
  const currentTime = now.getHours() * 60 + now.getMinutes()
  const currentTimeStr = now.toLocaleTimeString()
  const currentDateStr = now.toLocaleDateString()
  
  console.log('📊 Current Time Info:', {
    currentTime: currentTimeStr,
    currentDate: currentDateStr,
    currentTimeMinutes: currentTime,
    dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()]
  })
  
  // Check if current time is within the scheduled window (1:17 PM - 1:23 PM)
  const scheduleStart = 13 * 60 + 17 // 1:17 PM = 13:17 = 797 minutes
  const scheduleEnd = 13 * 60 + 23   // 1:23 PM = 13:23 = 803 minutes
  
  console.log('📊 Schedule Window Check:', {
    scheduleStart: '1:17 PM (797 minutes)',
    scheduleEnd: '1:23 PM (803 minutes)',
    currentTimeMinutes: currentTime,
    isWithinSchedule: currentTime >= scheduleStart && currentTime <= scheduleEnd,
    timeUntilStart: scheduleStart - currentTime,
    timeUntilEnd: scheduleEnd - currentTime
  })
  
  if (currentTime >= scheduleStart && currentTime <= scheduleEnd) {
    console.log('✅ CURRENT TIME IS WITHIN SCHEDULED WINDOW - All outlets should be ACTIVE')
    console.log('📊 This explains why outlets 1, 2, 4, and 5 are all showing as ACTIVE')
  } else if (currentTime < scheduleStart) {
    console.log('⏰ CURRENT TIME IS BEFORE SCHEDULED WINDOW - All outlets should be INACTIVE')
    console.log(`📊 Schedule starts in ${scheduleStart - currentTime} minutes`)
  } else {
    console.log('⏰ CURRENT TIME IS AFTER SCHEDULED WINDOW - All outlets should be INACTIVE')
    console.log(`📊 Schedule ended ${currentTime - scheduleEnd} minutes ago`)
  }
  
  console.log('\n📊 Expected Behavior:')
  console.log('- If current time is 1:17 PM - 1:23 PM: All outlets should be ACTIVE')
  console.log('- If current time is outside this window: All outlets should be INACTIVE')
  console.log('- Outlet 3 has no schedule, so it should remain INACTIVE')
}

// Add function to force monthly limit check immediately
;(window as any).forceScheduleMonthlyLimitCheck = async () => {
  console.log('🚨 SCHEDULE - FORCING MONTHLY LIMIT CHECK IMMEDIATELY...')
  try {
    // Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    
    // Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    const combinedLimitInfo = {
      enabled: limitData.enabled || false,
      selectedOutlets: limitData.selected_outlets || [],
      combinedLimit: limitData.combined_limit_watts || 0
    }
    
    console.log('📊 SCHEDULE - Combined limit settings:', combinedLimitInfo)
    
    // Force monthly limit check for all devices
    await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
    
    console.log('✅ SCHEDULE - Monthly limit check completed')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error forcing monthly limit check:', error)
  }
}

// Add function to check current combined limit settings
;(window as any).checkScheduleCombinedLimitSettings = async () => {
  console.log('🔍 SCHEDULE - CHECKING COMBINED LIMIT SETTINGS...')
  try {
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const snapshot = await get(combinedLimitRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const data = snapshot.val()
    console.log('📊 SCHEDULE - Combined limit settings:', data)
    
    if (data.enabled) {
      console.log('✅ SCHEDULE - Combined limit is ENABLED')
      console.log(`📊 Selected outlets: ${data.selected_outlets?.join(', ') || 'None'}`)
      console.log(`📊 Combined limit: ${data.combined_limit_watts || 0}W`)
    } else {
      console.log('❌ SCHEDULE - Combined limit is DISABLED')
      console.log('📊 This means monthly limit checks will be skipped!')
    }
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error checking combined limit settings:', error)
  }
}

// Add function to manually trigger monthly limit check
;(window as any).triggerScheduleMonthlyLimitCheck = async () => {
  console.log('🚨 SCHEDULE - MANUALLY TRIGGERING MONTHLY LIMIT CHECK...')
  try {
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    
    // Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    const combinedLimitInfo = {
      enabled: limitData.enabled || false,
      selectedOutlets: limitData.selected_outlets || [],
      combinedLimit: limitData.combined_limit_watts || 0
    }
    
    console.log('📊 SCHEDULE - Triggering monthly limit check with settings:', combinedLimitInfo)
    
    // This will automatically turn off devices if limit is exceeded
    await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
    
    console.log('✅ SCHEDULE - Monthly limit check triggered')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error triggering monthly limit check:', error)
  }
}

// Add function to test monthly limit blocking
;(window as any).testScheduleMonthlyLimitBlocking = async () => {
  console.log('🧪 SCHEDULE - TESTING MONTHLY LIMIT BLOCKING...')
  try {
    // 1. Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    
    // 2. Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    const combinedLimitInfo = {
      enabled: limitData.enabled || false,
      selectedOutlets: limitData.selected_outlets || [],
      combinedLimit: limitData.combined_limit_watts || 0
    }
    
    console.log('📊 SCHEDULE - Combined limit settings:', combinedLimitInfo)
    
    if (!combinedLimitInfo.enabled) {
      console.log('❌ SCHEDULE - Monthly limit is DISABLED - schedule will run normally')
      return
    }
    
    // 3. Calculate current monthly energy
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const combinedLimitWatts = combinedLimitInfo.combinedLimit
    
    console.log('📊 SCHEDULE - Monthly energy calculation:', {
      totalMonthlyEnergy: `${formatNumber(totalMonthlyEnergy)}W`,
      combinedLimitWatts: `${combinedLimitWatts === "No Limit" ? "No Limit" : `${combinedLimitWatts}W`}`,
      exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts,
      percentage: (combinedLimitWatts !== "No Limit" && combinedLimitWatts > 0) ? `${((totalMonthlyEnergy / combinedLimitWatts) * 100).toFixed(1)}%` : 'N/A'
    })
    
    // Skip limit check if "No Limit" is set
    if (combinedLimitWatts === "No Limit") {
      console.log('📊 SCHEDULE - Combined limit is set to "No Limit" - proceeding with normal schedule processing')
      return { monthlyLimitExceeded: false }
    }
    
    if (totalMonthlyEnergy >= combinedLimitWatts) {
      console.log('🚨 SCHEDULE - MONTHLY LIMIT EXCEEDED!')
      console.log('📊 This means ALL schedule processing will be BLOCKED')
      console.log('📊 Devices will NOT turn on even if they are in their scheduled time')
      console.log('📊 This is the CORRECT behavior - monthly limit takes precedence over schedule')
    } else {
      console.log('✅ SCHEDULE - Monthly limit OK')
      console.log('📊 Schedule processing will proceed normally')
      console.log('📊 Devices can turn on based on their schedule')
    }
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error testing monthly limit blocking:', error)
  }
}

// Add function to test status updates
;(window as any).testScheduleStatusUpdates = async () => {
  console.log('🧪 SCHEDULE - TESTING STATUS UPDATES...')
  try {
    // 1. Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    
    // 2. Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    const combinedLimitInfo = {
      enabled: limitData.enabled || false,
      selectedOutlets: limitData.selected_outlets || [],
      combinedLimit: limitData.combined_limit_watts || 0
    }
    
    console.log('📊 SCHEDULE - Testing status updates for devices with schedules...')
    
    for (const [outletKey, outletData] of Object.entries(devicesData)) {
      const deviceData = outletData as any
      
      // Only test devices with schedules
      if (deviceData.schedule && 
          (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
        
        console.log(`\n🔍 SCHEDULE - Testing status update for ${outletKey}...`)
        
        const currentControlState = deviceData.control?.device || 'off'
        const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
        
        console.log(`📊 Current status: control=${currentControlState}, main_status=${currentMainStatus}`)
        
        // Test 1: Monthly limit check
        const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, combinedLimitInfo)
        console.log(`📊 Monthly limit check: canTurnOn=${monthlyLimitCheck.canTurnOn}`)
        
        // Test 2: Daily limit check
        const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
        const today = new Date()
        const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
        const todayLogs = deviceData?.daily_logs?.[todayDateKey]
        const todayTotalEnergy = todayLogs?.total_energy || 0
        
        const isDailyLimitExceeded = powerLimit !== "No Limit" && powerLimit > 0 && todayTotalEnergy >= powerLimit
        console.log(`📊 Daily limit check: isExceeded=${isDailyLimitExceeded}`)
        
        // Test 3: Schedule check
        const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData)
        console.log(`📊 Schedule check: shouldBeActive=${shouldBeActive}`)
        
        // Test 4: Final status determination
        let finalControlState = 'off'
        let finalMainStatus = 'OFF'
        
        if (monthlyLimitCheck.canTurnOn && !isDailyLimitExceeded && shouldBeActive) {
          finalControlState = 'on'
          finalMainStatus = 'ON'
        }
        
        console.log(`📊 FINAL STATUS DETERMINATION:`)
        console.log(`📊 Expected: control=${finalControlState}, main_status=${finalMainStatus}`)
        console.log(`📊 Current: control=${currentControlState}, main_status=${currentMainStatus}`)
        console.log(`📊 Needs update: control=${currentControlState !== finalControlState}, main_status=${currentMainStatus !== finalMainStatus}`)
        
        if (currentControlState !== finalControlState || currentMainStatus !== finalMainStatus) {
          console.log(`🔄 SCHEDULE: ${outletKey} needs status update!`)
        } else {
          console.log(`✅ SCHEDULE: ${outletKey} status is correct`)
        }
      }
    }
    
    console.log('\n🧪 SCHEDULE - STATUS UPDATE TEST COMPLETE')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error testing status updates:', error)
  }
}

// Add function to test combined group individual limit logic
;(window as any).testCombinedGroupIndividualLimits = async () => {
  console.log('🧪 SCHEDULE - TESTING COMBINED GROUP INDIVIDUAL LIMITS...')
  try {
    // 1. Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    
    // 2. Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    const combinedLimitInfo = {
      enabled: limitData.enabled || false,
      selectedOutlets: limitData.selected_outlets || [],
      combinedLimit: limitData.combined_limit_watts || 0
    }
    
    console.log('📊 SCHEDULE - Combined limit settings:', combinedLimitInfo)
    
    // 3. Check monthly limit status
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const monthlyLimitExceeded = totalMonthlyEnergy >= combinedLimitInfo.combinedLimit
    
    console.log(`📊 SCHEDULE - Monthly limit status:`, {
      totalMonthlyEnergy: `${formatNumber(totalMonthlyEnergy)}W`,
      combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
      exceeded: monthlyLimitExceeded
    })
    
    // 4. Test each device in combined group
    console.log('\n🔍 SCHEDULE - Testing individual device limits in combined group...')
    
    for (const outletKey of combinedLimitInfo.selectedOutlets) {
      const deviceData = devicesData[outletKey.replace(' ', '_')]
      
      if (!deviceData) {
        console.log(`❌ SCHEDULE - Device ${outletKey} not found`)
        continue
      }
      
      console.log(`\n🔍 SCHEDULE - Testing ${outletKey}...`)
      
      // Check individual daily limit
      const powerLimit = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
      const today = new Date()
      const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
      const todayLogs = deviceData?.daily_logs?.[todayDateKey]
      const todayTotalEnergy = todayLogs?.total_energy || 0
      
      const isDailyLimitExceeded = powerLimit > 0 && todayTotalEnergy >= powerLimit
      
      console.log(`📊 Individual daily limit:`, {
        powerLimit: powerLimit === "No Limit" ? "No Limit" : `${(powerLimit * 1000)}W`,
        todayEnergy: `${(todayTotalEnergy * 1000).toFixed(3)}W`,
        exceeded: isDailyLimitExceeded
      })
      
      // Determine if device can turn on
      let canTurnOn = false
      let reason = ''
      
      if (monthlyLimitExceeded) {
        if (isDailyLimitExceeded) {
          canTurnOn = false
          reason = 'Both monthly and daily limits exceeded'
        } else {
          canTurnOn = true
          reason = 'Monthly limit exceeded but individual daily limit OK'
        }
      } else {
        // NEW LOGIC: When monthly limit is NOT exceeded, ignore individual daily limit
        canTurnOn = true
        reason = 'Monthly limit OK - individual daily limit ignored for combined group'
      }
      
      console.log(`📊 FINAL RESULT for ${outletKey}:`, {
        canTurnOn: canTurnOn,
        reason: reason
      })
    }
    
    console.log('\n🧪 SCHEDULE - COMBINED GROUP INDIVIDUAL LIMITS TEST COMPLETE')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error testing combined group individual limits:', error)
  }
}

// Add function to test automatic status updates
;(window as any).testAutomaticStatusUpdates = async () => {
  console.log('🧪 SCHEDULE - TESTING AUTOMATIC STATUS UPDATES...')
  try {
    // 1. Get current devices data
    const devicesRef = ref(realtimeDb, 'devices')
    const snapshot = await get(devicesRef)
    
    if (!snapshot.exists()) {
      console.log('❌ SCHEDULE - No devices data found')
      return
    }
    
    const devicesData = snapshot.val()
    
    // 2. Get combined limit settings
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    const limitSnapshot = await get(combinedLimitRef)
    
    if (!limitSnapshot.exists()) {
      console.log('❌ SCHEDULE - No combined limit settings found')
      return
    }
    
    const limitData = limitSnapshot.val()
    const combinedLimitInfo = {
      enabled: limitData.enabled || false,
      selectedOutlets: limitData.selected_outlets || [],
      combinedLimit: limitData.combined_limit_watts || 0
    }
    
    // 3. Check monthly limit status
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const monthlyLimitExceeded = totalMonthlyEnergy >= combinedLimitInfo.combinedLimit
    
    console.log(`📊 SCHEDULE - Monthly limit status:`, {
      totalMonthlyEnergy: `${formatNumber(totalMonthlyEnergy)}W`,
      combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
      exceeded: monthlyLimitExceeded
    })
    
    // 4. Test automatic status updates for each device
    console.log('\n🔍 SCHEDULE - Testing automatic status updates...')
    
    for (const [outletKey, outletData] of Object.entries(devicesData)) {
      const deviceData = outletData as any
      
      // Only test devices with schedules
      if (deviceData.schedule && 
          (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
        
        console.log(`\n🔍 SCHEDULE - Testing automatic status update for ${outletKey}...`)
        
        const currentControlState = deviceData.control?.device || 'off'
        const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
        
        // Check if device is in combined group
        const outletDisplayName = outletKey.replace('_', ' ')
        const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                 combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
        
        // Check schedule
        const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData)
        let newControlState = shouldBeActive ? 'on' : 'off'
        
        // Apply automatic status update logic
        if (isInCombinedGroup && monthlyLimitExceeded) {
          const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0
          const isDailyLimitExceeded = powerLimit !== "No Limit" && powerLimit > 0 && todayTotalEnergy >= powerLimit
          
          if (isDailyLimitExceeded) {
            newControlState = 'off'
            console.log(`🔒 AUTOMATIC UPDATE: Forcing ${outletKey} OFF due to individual daily limit exceeded`)
          } else if (shouldBeActive) {
            newControlState = 'on'
            console.log(`✅ AUTOMATIC UPDATE: Allowing ${outletKey} ON (individual daily limit OK despite monthly limit exceeded)`)
          }
        } else if (isInCombinedGroup && !monthlyLimitExceeded) {
          // Check monthly limit first, then daily limit
          const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, combinedLimitInfo)
          if (!monthlyLimitCheck.canTurnOn) {
            newControlState = 'off'
            console.log(`🔒 AUTOMATIC UPDATE: Forcing ${outletKey} OFF due to monthly limit exceeded`)
          } else {
            const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
            const today = new Date()
            const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
            const todayLogs = deviceData?.daily_logs?.[todayDateKey]
            const todayTotalEnergy = todayLogs?.total_energy || 0
            const isDailyLimitExceeded = powerLimit !== "No Limit" && powerLimit > 0 && todayTotalEnergy >= powerLimit
            
            if (isDailyLimitExceeded) {
              newControlState = 'off'
              console.log(`🔒 AUTOMATIC UPDATE: Forcing ${outletKey} OFF due to daily limit exceeded`)
            } else if (shouldBeActive) {
              newControlState = 'on'
              console.log(`✅ AUTOMATIC UPDATE: Allowing ${outletKey} ON (both limits OK)`)
            }
          }
        } else {
          // Not in combined group - check individual daily limit only
          const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0
          const isDailyLimitExceeded = powerLimit !== "No Limit" && powerLimit > 0 && todayTotalEnergy >= powerLimit
          
          if (isDailyLimitExceeded) {
            newControlState = 'off'
            console.log(`🔒 AUTOMATIC UPDATE: Forcing ${outletKey} OFF due to daily limit exceeded`)
          } else if (shouldBeActive) {
            newControlState = 'on'
            console.log(`✅ AUTOMATIC UPDATE: Allowing ${outletKey} ON (daily limit OK)`)
          }
        }
        
        const newMainStatus = newControlState === 'on' ? 'ON' : 'OFF'
        
        console.log(`📊 AUTOMATIC STATUS UPDATE RESULT for ${outletKey}:`, {
          currentState: `${currentControlState}/${currentMainStatus}`,
          scheduleSays: shouldBeActive ? 'ON' : 'OFF',
          finalDecision: `${newControlState}/${newMainStatus}`,
          needsUpdate: currentControlState !== newControlState,
          isInCombinedGroup: isInCombinedGroup,
          monthlyLimitExceeded: monthlyLimitExceeded
        })
        
        if (currentControlState !== newControlState) {
          console.log(`🔄 AUTOMATIC UPDATE NEEDED: ${outletKey} will be updated from ${currentControlState} to ${newControlState}`)
        } else {
          console.log(`✅ NO UPDATE NEEDED: ${outletKey} is already in correct state`)
        }
      }
    }
    
    console.log('\n🧪 SCHEDULE - AUTOMATIC STATUS UPDATES TEST COMPLETE')
    
  } catch (error) {
    console.error('❌ SCHEDULE - Error testing automatic status updates:', error)
  }
}

console.log('Schedule: Manual test functions available:')
console.log('- window.testScheduleMonthlyLimit() - Test Schedule monthly limit checking specifically')
console.log('- window.testScheduleHierarchy() - Test Schedule hierarchy enforcement (Monthly > Daily > Schedule)')
console.log('- window.checkCurrentScheduleStatus() - Check current time and schedule status')
console.log('- window.forceScheduleMonthlyLimitCheck() - Force monthly limit check immediately')
console.log('- window.checkScheduleCombinedLimitSettings() - Check current combined limit settings')
console.log('- window.triggerScheduleMonthlyLimitCheck() - Manually trigger monthly limit check (auto turn off)')
console.log('- window.testScheduleMonthlyLimitBlocking() - Test if monthly limit blocks schedule processing')
console.log('- window.testScheduleStatusUpdates() - Test if status updates are working correctly')
console.log('- window.testCombinedGroupIndividualLimits() - Test combined group individual limit logic')
console.log('- window.testAutomaticStatusUpdates() - Test automatic status updates with new logic')