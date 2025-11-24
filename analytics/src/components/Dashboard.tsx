import { useEffect, useRef, useState } from 'react'
import { Line, Bar } from 'react-chartjs-2'
import jsPDF from 'jspdf'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js'
import { ref, onValue, off, get, update } from 'firebase/database'
import { realtimeDb } from '../firebase/config'
import headerImage from '../assets/image.png'
import footerImage from '../assets/image1.png'
import './Dashboard.css'

// Function to format numbers with commas and decimals
const formatNumber = (num: number, decimals: number = 3): string => {
  return num.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Function to calculate monthly energy for a device
const calculateMonthlyEnergy = (outlet: any): string => {
  try {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    
    // Get all days in the current month
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    let totalMonthlyEnergy = 0
    
    // Sum up energy for all days in the current month
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
      const dayData = outlet.daily_logs?.[dateKey]
      if (dayData && dayData.total_energy) {
        totalMonthlyEnergy += dayData.total_energy // Already in kW from database
      }
    }
    
    // Convert to watts and format
    return `${formatNumber(totalMonthlyEnergy * 1000)} W`
  } catch (error) {
    console.error('Error calculating monthly energy:', error)
    return '0.000 W'
  }
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

// Auto-turnoff functions for non-idle devices
const startAutoTurnoffTimer = (outletKey: string, setAutoTurnoffTimers: React.Dispatch<React.SetStateAction<Record<string, NodeJS.Timeout | null>>>) => {
  // Clear existing timer if any
  setAutoTurnoffTimers(prev => {
    if (prev[outletKey]) {
      clearTimeout(prev[outletKey]!)
    }
    return prev
  })

  // Start new 15-second timer
  const timer = setTimeout(async () => {
    try {
      console.log(`🔄 Auto-turnoff: Turning off ${outletKey} after 15 seconds of non-idle status`)
      
      // Turn off the device control
      const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
      await update(controlRef, {
        device: 'off'
      })
      
      console.log(`✅ Auto-turnoff: Successfully turned off ${outletKey}`)
    } catch (error) {
      console.error(`❌ Auto-turnoff: Error turning off ${outletKey}:`, error)
    }
  }, 15000) // 15 seconds

  // Store the timer
  setAutoTurnoffTimers(prev => ({
    ...prev,
    [outletKey]: timer
  }))
}

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

const resetAutoTurnoffFunction = (outletKey: string, setAutoTurnoffTimers: React.Dispatch<React.SetStateAction<Record<string, NodeJS.Timeout | null>>>) => {
  // Clear any existing timer
  clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)
  console.log(`🔄 Auto-turnoff: Reset function for ${outletKey} - outlet turned on again`)
}

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
)

interface DashboardProps {
  onNavigate?: (key: string) => void
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
    main_status?: string
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
    disabled_by_unplug?: boolean
    basis?: number
  }
}

interface DeviceData {
  outletId: string
  status: string
  power: number
  energy: number
  current: number
  voltage: number
  power_factor: number
  timestamp: string
  avg_power: number
  peak_power: number
  total_energy: number
  lifetime_energy: number
  monthUsage?: string // Add monthly usage
  officeRoom: string // Add office information
  appliances: string // Add appliance information
  office_info?: {
    assigned_date: string
    office: string
    department?: string
    appliance?: string
    enable_power_scheduling?: boolean
  }
  relay_control?: {
    status: string
    main_status?: string
    auto_cutoff?: {
      enabled: boolean
      power_limit: number
    }
  }
}

export default function Dashboard({ onNavigate }: DashboardProps) {
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

  // Function to check if device should be active based on schedule
  // This function determines if the SCHEDULE says the device should be active, regardless of current control state
  const isDeviceActiveBySchedule = (schedule: any, controlState: string, deviceData?: any, skipIndividualLimitCheck?: boolean): boolean => {
    // If no schedule exists, use control state
    if (!schedule || (!schedule.timeRange && !schedule.startTime)) {
      return controlState === 'on'
    }

    // CRITICAL: Don't check controlState here - we want to know if SCHEDULE says it should be active
    // The controlState parameter is only used as a fallback when there's no schedule

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
        console.log(`Dashboard: Schedule check - Device monthly power limit exceeded:`, {
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


  const [deptOpen, setDeptOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpen2, setFilterOpen2] = useState(false)
  const [filterOpen3, setFilterOpen3] = useState(false)
  const [selectedFilter1, setSelectedFilter1] = useState('Day')
  const [selectedFilter2, setSelectedFilter2] = useState('Day')
  const [selectedFilter3, setSelectedFilter3] = useState('Day')
  
  // Office Reports Modal States
  const [isOfficeReportsModalOpen, setIsOfficeReportsModalOpen] = useState(false)
  const [isReportTypeModalOpen, setIsReportTypeModalOpen] = useState(false)
  const [selectedReportDepartment, setSelectedReportDepartment] = useState('All Departments')
  const [selectedReportOffice, setSelectedReportOffice] = useState('All Offices')
  const [selectedReportType, setSelectedReportType] = useState('')
  
  // Date Range Modal States
  const [isDateRangeModalOpen, setIsDateRangeModalOpen] = useState(false)
  const [selectedStartDate, setSelectedStartDate] = useState('')
  const [selectedEndDate, setSelectedEndDate] = useState('')
  
  // PDF Preview Modal States
  const [isPdfPreviewModalOpen, setIsPdfPreviewModalOpen] = useState(false)
  const [previewData, setPreviewData] = useState<any>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [currentRate, setCurrentRate] = useState(9.3885) // Default fallback rate
  const [electricityRateData, setElectricityRateData] = useState<{
    rate: number;
    unit: string;
    updated_at: string;
    updated_by: string;
  } | null>(null)
  const [timeSegment, setTimeSegment] = useState('Week')
  const [department, setDepartment] = useState('All Departments')
  const [office, setOffice] = useState('All Offices')
  const [devices, setDevices] = useState<DeviceData[]>([])
  const [totalPower, setTotalPower] = useState(0)
  const [totalEnergy, setTotalEnergy] = useState(0)
  const [monthlyEnergy, setMonthlyEnergy] = useState(0)
  const [officesData, setOfficesData] = useState<any>({})
  const [offices, setOffices] = useState<string[]>([])
  const [officeOpen, setOfficeOpen] = useState(false)

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
  
  // Combined limit info state
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
  const [totalLifetimeEnergy, setTotalLifetimeEnergy] = useState(0)
  const [dailyAverage, setDailyAverage] = useState(0)
  const [todayTotalEnergy, setTodayTotalEnergy] = useState(0)
  const [lastRateUpdate, setLastRateUpdate] = useState<string>('')
  const [currentBill, setCurrentBill] = useState(0)
  const [monthlyBill, setMonthlyBill] = useState(0)
  const [filteredDevices, setFilteredDevices] = useState<DeviceData[]>([])
  const [filteredDevicesRank, setFilteredDevicesRank] = useState<DeviceData[]>([])
  const [overallConsumptionDevices, setOverallConsumptionDevices] = useState<DeviceData[]>([])
  const [officeRankingData, setOfficeRankingData] = useState<any[]>([])
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  
  // Real-time power consumption state
  const [realtimePowerData, setRealtimePowerData] = useState<{
    labels: string[];
    powerValues: number[];
  }>({
    labels: [],
    powerValues: []
  })
  const [realtimePowerLoading, setRealtimePowerLoading] = useState(true)
  const [realtimePowerError, setRealtimePowerError] = useState<string | null>(null)

  // Philippine electricity rate (per kWh) - automatically updated
  const PHILIPPINE_RATE_PER_KWH = currentRate


  // Calculate current bill based on actual total energy consumed so far this month
  const calculateCurrentBill = async (devices: DeviceData[]) => {
    let actualMonthlyEnergy = 0
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const monthPattern = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_`
    
    try {
      // Fetch all devices data to get daily_logs for the current month
      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (snapshot.exists()) {
        const devicesData = snapshot.val()
        
        // Sum all total_energy from daily_logs for current month with runtime verification (filtered devices only)
        devices.forEach((device) => {
          const outletKey = device.outletId
          const outlet = devicesData[outletKey]
          
          if (!outlet) return
          
          const dailyLogs = outlet.daily_logs || {}
          
          Object.keys(dailyLogs).forEach((dateKey) => {
            // Check if this date is in the current month
            if (dateKey.startsWith(monthPattern)) {
              const dayData = dailyLogs[dateKey]
              const measuredEnergy = dayData.total_energy || 0 // Energy in kWh from database
              const avgPower = dayData.avg_power || 0 // Average power in W
              const usageTimeHours = dayData.usage_time_hours || 0 // Usage time in hours
              
              // Calculate expected energy from runtime
              const expectedEnergy = (avgPower * usageTimeHours) / 1000 // Convert W*h to kWh
              
              // Use runtime verification to determine which energy value to use
              let finalEnergy = measuredEnergy
              
              if (usageTimeHours > 0 && avgPower > 0) {
                const energyDifference = Math.abs(measuredEnergy - expectedEnergy)
                const maxEnergy = Math.max(measuredEnergy, expectedEnergy)
                // Prevent division by zero - if both are 0, accuracy is 1.0 (perfect match)
                const accuracy = maxEnergy > 0 ? Math.min(measuredEnergy, expectedEnergy) / maxEnergy : 1.0
                
                // If accuracy is below 95%, use calculated energy (sensor might have errors)
                if (accuracy < 0.95 && energyDifference > 0.1) {
                  console.log(`Dashboard runtime verification: Using calculated energy for ${outletKey} on ${dateKey}. Measured: ${measuredEnergy}kWh, Calculated: ${expectedEnergy}kWh, Accuracy: ${(accuracy * 100).toFixed(1)}%`)
                  finalEnergy = expectedEnergy
                } else {
                  console.log(`Dashboard runtime verification: Using measured energy for ${outletKey} on ${dateKey}. Measured: ${measuredEnergy}kWh, Calculated: ${expectedEnergy}kWh, Accuracy: ${(accuracy * 100).toFixed(1)}%`)
                }
              }
              
              actualMonthlyEnergy += finalEnergy
            }
          })
        })
      }
    } catch (error) {
      console.error('Error fetching monthly data:', error)
      // Fallback: use current day's data and estimate
      const currentDayEnergy = devices.reduce((sum, device) => {
        return sum + (device.total_energy || 0)
      }, 0)
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
      actualMonthlyEnergy = currentDayEnergy * daysInMonth
    }
    
    console.log(`Dashboard current bill calculation: Actual monthly energy consumed = ${actualMonthlyEnergy} kWh, Rate = ${PHILIPPINE_RATE_PER_KWH}, Filtered devices count = ${devices.length}`)
    
    // Energy is already in kWh, multiply by current rate
    return actualMonthlyEnergy * PHILIPPINE_RATE_PER_KWH
  }

  // Calculate estimated monthly bill based on current month's consumption pattern
  // Gets data for current month (day 1 to today), calculates daily average, then projects to full month
  const calculateMonthlyBill = async (devices: DeviceData[]) => {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    const currentDay = now.getDate()
    
    console.log(`🔍 Estimated monthly bill calculation: Processing ${currentYear}-${String(currentMonth).padStart(2, '0')} with ${daysInMonth} days (current day: ${currentDay})`)
    console.log(`📅 Today is: ${now.toDateString()}`)
    
    let totalEnergySoFar = 0
    let daysWithData = 0
    
    try {
      // Fetch all devices data to get daily_logs for the current month
      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (!snapshot.exists()) {
        return 0
      }
      
      const devicesData = snapshot.val()
      
      console.log(`📊 Processing ${devices.length} filtered devices for estimated monthly bill calculation`)
      
      // Process each day from day 1 to current day (only actual data available so far this month)
      for (let day = 1; day <= currentDay; day++) {
        const dayStr = String(day).padStart(2, '0')
        const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${dayStr}`
        let dayEnergy = 0
        
        // Process each filtered device for this day
        devices.forEach((device) => {
          const outletKey = device.outletId
          const outlet = devicesData[outletKey]
          
          if (!outlet || !outlet.daily_logs) return
          
          const dayData = outlet.daily_logs[dateKey]
          
          if (dayData && dayData.total_energy) {
            dayEnergy += dayData.total_energy || 0 // Already in kWh
          }
        })
        
        if (dayEnergy > 0) {
          totalEnergySoFar += dayEnergy
          daysWithData++
          console.log(`📅 Day ${day}: Energy = ${dayEnergy.toFixed(6)} kWh`)
        } else {
          console.log(`📅 Day ${day}: No energy data`)
        }
      }
    } catch (error) {
      console.error('❌ Error calculating estimated monthly bill:', error)
      // Fallback: use current day's data
      totalEnergySoFar = devices.reduce((sum, device) => {
        return sum + (device.total_energy || 0)
      }, 0)
      daysWithData = currentDay > 0 ? 1 : 0
    }
    
    // Calculate daily average from actual consumption so far this month (day 1 to current day)
    // Only count days that have actual data
    const dailyAverageKwh = daysWithData > 0 ? totalEnergySoFar / daysWithData : 0
    
    // Estimate monthly bill: Project the daily average to full month
    // Example: If on November 5th, average is 0.0015 kWh/day → estimate for full November (30 days) = 0.045 kWh
    const estimatedMonthlyEnergy = dailyAverageKwh * daysInMonth
    const estimatedMonthlyBill = estimatedMonthlyEnergy * PHILIPPINE_RATE_PER_KWH
    
    console.log(`📊 Estimated monthly bill calculation results:`)
    console.log(`   Current month: ${currentMonth}/${currentYear}`)
    console.log(`   Days processed: Day 1 to Day ${currentDay} (${daysWithData} days with actual data)`)
    console.log(`   Total energy this month (so far): ${totalEnergySoFar.toFixed(6)} kWh`)
    console.log(`   Daily average (from current month's data): ${dailyAverageKwh.toFixed(6)} kWh/day (${(dailyAverageKwh * 1000).toFixed(3)} W/day)`)
    console.log(`   Days in full month: ${daysInMonth}`)
    console.log(`   Estimated monthly energy: ${estimatedMonthlyEnergy.toFixed(6)} kWh`)
    console.log(`   Rate: ₱${PHILIPPINE_RATE_PER_KWH} per kWh`)
    console.log(`   Estimated monthly bill: ₱${estimatedMonthlyBill.toFixed(2)}`)
    
    return estimatedMonthlyBill
  }

  // Get data based on selected time period from daily logs
  const getDataByPeriod = (device: DeviceData) => {
    // Return the current data since it's already from daily logs
    return {
      power: device.power,
      energy: device.energy,
      avg_power: device.avg_power,
      peak_power: device.peak_power,
      total_energy: device.total_energy
    }
  }

  // Calculate total energy from all daily logs
  const calculateTotalEnergy = async () => {
    try {
      // If no filtered devices, set to 0
      if (overallConsumptionDevices.length === 0) {
        setTotalLifetimeEnergy(0)
        return
      }

      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (!snapshot.exists()) {
        setTotalLifetimeEnergy(0)
        return
      }
      
      const devicesData = snapshot.val()
      let totalLifetimeEnergy = 0
      
      // Loop through filtered devices (respects department filter)
      for (const device of overallConsumptionDevices) {
        const outletKey = device.outletId
        const deviceData = devicesData[outletKey]
        
        if (!deviceData) continue
        
        // Use lifetime_energy directly from the root level (already in kW from database)
        if (deviceData.lifetime_energy !== undefined) {
          totalLifetimeEnergy += deviceData.lifetime_energy
        }
      }
      
      // Convert from kW to W and set state
      setTotalLifetimeEnergy(totalLifetimeEnergy * 1000)
      
      console.log('Total energy calculated:', {
        totalEnergy: `${(totalLifetimeEnergy * 1000).toFixed(3)} W`,
        totalEnergyKw: `${totalLifetimeEnergy.toFixed(3)} kW`,
        department: department,
        filteredDevicesCount: filteredDevices.length
      })
      
    } catch (error) {
      console.error('Error calculating total energy:', error)
      setTotalLifetimeEnergy(0)
    }
  }


  // Calculate today's total energy and daily average
  const calculateTodayEnergyAndAverage = async () => {
    try {
      // If no filtered devices, set to 0
      if (overallConsumptionDevices.length === 0) {
        setTodayTotalEnergy(0)
        setDailyAverage(0)
        return
      }

      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (!snapshot.exists()) {
        setTodayTotalEnergy(0)
        setDailyAverage(0)
        return
      }
      
      const devicesData = snapshot.val()
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const currentDay = now.getDate()
      
      // Helper function to get date key
      const getDateKey = (year: number, month: number, day: number) => {
        return `day_${year}_${String(month).padStart(2, '0')}_${String(day).padStart(2, '0')}`
      }
      
      const todayKey = getDateKey(currentYear, currentMonth, currentDay)
      let totalTodayEnergy = 0
      let totalHistoricalEnergy = 0
      const daysWithDataSet = new Set<string>() // Track unique days with data across all devices
      
      // Calculate today's energy and historical energy for daily average with runtime verification
      // Daily Average uses last 30 days of historical data (rolling window)
      for (const device of overallConsumptionDevices) {
        const outletKey = device.outletId
        const deviceData = devicesData[outletKey]
        
        if (!deviceData) continue
        
        // Today's energy with runtime verification
        const todayLogs = deviceData?.daily_logs?.[todayKey]
        if (todayLogs) {
          const measuredEnergy = todayLogs.total_energy || 0 // Energy in kWh
          const avgPower = todayLogs.avg_power || 0 // Average power in W
          const usageTimeHours = todayLogs.usage_time_hours || 0 // Usage time in hours
          
          // Calculate expected energy from runtime
          const expectedEnergy = (avgPower * usageTimeHours) / 1000
          
          // Use runtime verification
          let finalTodayEnergy = measuredEnergy
          if (usageTimeHours > 0 && avgPower > 0) {
            const energyDifference = Math.abs(measuredEnergy - expectedEnergy)
            const maxEnergy = Math.max(measuredEnergy, expectedEnergy)
            // Prevent division by zero - if both are 0, accuracy is 1.0 (perfect match)
            const accuracy = maxEnergy > 0 ? Math.min(measuredEnergy, expectedEnergy) / maxEnergy : 1.0
            
            if (accuracy < 0.95 && energyDifference > 0.001) {
              finalTodayEnergy = expectedEnergy
            }
          }
          
          totalTodayEnergy += finalTodayEnergy
        }
        
        // Daily average calculation: Use last 30 days of historical data (rolling window)
        // Loop through the last 30 days from today
        for (let daysBack = 0; daysBack < 30; daysBack++) {
          const date = new Date(now)
          date.setDate(date.getDate() - daysBack) // Go back N days from today
          
          const year = date.getFullYear()
          const month = date.getMonth() + 1
          const day = date.getDate()
          
          const dayKey = getDateKey(year, month, day)
          const dayLogs = deviceData?.daily_logs?.[dayKey]
          
          if (dayLogs) {
            const measuredEnergy = dayLogs.total_energy || 0
            const avgPower = dayLogs.avg_power || 0
            const usageTimeHours = dayLogs.usage_time_hours || 0
            
            // Calculate expected energy from runtime
            const expectedEnergy = (avgPower * usageTimeHours) / 1000
            
            // Use runtime verification
            let finalDayEnergy = measuredEnergy
            if (usageTimeHours > 0 && avgPower > 0) {
              const energyDifference = Math.abs(measuredEnergy - expectedEnergy)
              const maxEnergy = Math.max(measuredEnergy, expectedEnergy)
              // Prevent division by zero - if both are 0, accuracy is 1.0 (perfect match)
              const accuracy = maxEnergy > 0 ? Math.min(measuredEnergy, expectedEnergy) / maxEnergy : 1.0
              
              if (accuracy < 0.95 && energyDifference > 0.001) {
                finalDayEnergy = expectedEnergy
              }
            }
            
            if (finalDayEnergy > 0) {
              totalHistoricalEnergy += finalDayEnergy
              daysWithDataSet.add(dayKey) // Track unique days with data (count each day only once across all devices)
            }
          }
        }
      }
      
      const daysWithData = daysWithDataSet.size // Count unique days with data across all devices
      
      // Calculate daily average using the formula: Daily Average (W) = Total Historical Energy (last 30 days) (W) ÷ Number of active days
      // This represents the typical/expected energy consumption per day based on historical data
      const totalHistoricalEnergyWh = totalHistoricalEnergy * 1000 // Convert kWh to W
      const dailyAverageWh = daysWithData > 0 ? totalHistoricalEnergyWh / daysWithData : 0
      
      // Convert to Watts and set states
      setTodayTotalEnergy(totalTodayEnergy * 1000) // Convert kW to W
      setDailyAverage(dailyAverageWh) // Already in W
      
      console.log('Daily Average Calculation (Last 30 Days Historical Data):', {
        totalHistoricalEnergyKwh: `${totalHistoricalEnergy.toFixed(6)} kWh`,
        totalHistoricalEnergyWh: `${totalHistoricalEnergyWh.toFixed(3)} W`,
        activeDays: daysWithData,
        dailyAverageWh: `${dailyAverageWh.toFixed(3)} W`,
        formula: `Daily Average = ${totalHistoricalEnergyWh.toFixed(3)} W ÷ ${daysWithData} days = ${dailyAverageWh.toFixed(3)} W`,
        period: 'Last 30 days (rolling window)',
        description: 'Typical/expected energy consumption per day based on historical data',
        todayKey: todayKey,
        department: department,
        filteredDevicesCount: filteredDevices.length
      })
      
    } catch (error) {
      console.error('Error calculating today energy and daily average:', error)
      setTodayTotalEnergy(0)
      setDailyAverage(0)
    }
  }

  // Calculate current month's total energy from daily logs
  const calculateCurrentMonthEnergy = async () => {
    try {
      // If no filtered devices, set to 0
      if (overallConsumptionDevices.length === 0) {
        setMonthlyEnergy(0)
        return
      }

      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (!snapshot.exists()) {
        setMonthlyEnergy(0)
        return
      }
      
      const devicesData = snapshot.val()
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      
      let totalMonthlyEnergy = 0
      
      // Helper function to get date key for database
      const getDateKey = (date: Date) => {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `day_${year}_${month}_${day}`
      }
      
      // Get all days in current month
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
      
      // Loop through filtered devices (respects department filter)
      for (const device of overallConsumptionDevices) {
        const outletKey = device.outletId
        const deviceData = devicesData[outletKey]
        
        if (!deviceData) continue
        
        // Sum energy for all days in current month (only days with actual data)
        for (let day = 1; day <= daysInMonth; day++) {
          const date = new Date(currentYear, currentMonth - 1, day)
          const dateKey = getDateKey(date)
          const dayLogs = deviceData?.daily_logs?.[dateKey]
          const dayEnergy = dayLogs?.total_energy || 0 // Energy in kW
          
          // Only add energy if there's actual data for this day
          if (dayEnergy > 0) {
            totalMonthlyEnergy += dayEnergy
          }
        }
      }
      
      // Convert from kW to W and set state
      setMonthlyEnergy(totalMonthlyEnergy * 1000)
      
      console.log('Current month energy calculated:', {
        totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(3)} W`,
        currentMonth: currentMonth,
        currentYear: currentYear,
        daysInMonth: daysInMonth,
        department: department,
        filteredDevicesCount: filteredDevices.length
      })
      
    } catch (error) {
      console.error('Error calculating current month energy:', error)
      setMonthlyEnergy(0)
    }
  }

  // Get device data for specific time period (matching chart logic)
  const getDeviceDataForTimePeriod = async (device: DeviceData, period: string) => {
    try {
      const devicesRef = ref(realtimeDb, `devices/${device.outletId}`)
      const snapshot = await get(devicesRef)
      
      if (!snapshot.exists()) {
        return { total_energy: 0, peak_power: 0 }
      }
      
      const deviceData = snapshot.val()
      const now = new Date()
      
      // Helper function to get date key for database
      const getDateKey = (date: Date) => {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `day_${year}_${month}_${day}`
      }
      
      let totalEnergy = 0
      let maxPeakPower = 0
      
      switch (period) {
        case 'Day':
          // Today's data only
          const todayKey = getDateKey(now)
          const todayLogs = deviceData?.daily_logs?.[todayKey]
          totalEnergy = todayLogs?.total_energy || 0
          maxPeakPower = todayLogs?.peak_power || 0
          break
          
        case 'Week':
          // Last 7 days
          for (let i = 6; i >= 0; i--) {
            const date = new Date(now)
            date.setDate(date.getDate() - i)
            const dateKey = getDateKey(date)
            const dayLogs = deviceData?.daily_logs?.[dateKey]
            totalEnergy += dayLogs?.total_energy || 0
            maxPeakPower = Math.max(maxPeakPower, dayLogs?.peak_power || 0)
          }
          break
          
        case 'Month':
          // Last 30 days
          for (let i = 29; i >= 0; i--) {
            const date = new Date(now)
            date.setDate(date.getDate() - i)
            const dateKey = getDateKey(date)
            const dayLogs = deviceData?.daily_logs?.[dateKey]
            totalEnergy += dayLogs?.total_energy || 0
            maxPeakPower = Math.max(maxPeakPower, dayLogs?.peak_power || 0)
          }
          break
          
        case 'Year':
          // Last 12 months
          for (let i = 11; i >= 0; i--) {
            const date = new Date(now)
            date.setMonth(date.getMonth() - i)
            const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
            
            for (let day = 1; day <= daysInMonth; day++) {
              const dayDate = new Date(date.getFullYear(), date.getMonth(), day)
              const dayKey = getDateKey(dayDate)
              const dayLogs = deviceData?.daily_logs?.[dayKey]
              totalEnergy += dayLogs?.total_energy || 0
              maxPeakPower = Math.max(maxPeakPower, dayLogs?.peak_power || 0)
            }
          }
          break
          
        default:
          // Default to today
          const defaultTodayKey = getDateKey(now)
          const defaultTodayLogs = deviceData?.daily_logs?.[defaultTodayKey]
          totalEnergy = defaultTodayLogs?.total_energy || 0
          maxPeakPower = defaultTodayLogs?.peak_power || 0
      }
      
      return {
        total_energy: totalEnergy,
        peak_power: maxPeakPower
      }
    } catch (error) {
      console.error('Error fetching device data for time period:', error)
      return { total_energy: 0, peak_power: 0 }
    }
  }

  // Filter devices based on selected period
  const filterDevicesByPeriod = async (devicesToFilter: DeviceData[], period: string) => {
    const filteredDevices = []
    
    for (const device of devicesToFilter) {
      const periodData = await getDeviceDataForTimePeriod(device, period)
      
      if (periodData.total_energy > 0) {
        filteredDevices.push({
        ...device,
          total_energy: periodData.total_energy,
          peak_power: periodData.peak_power
        })
      }
    }
    
    return filteredDevices
  }

  // Get current time period label for display
  const getCurrentTimeLabel = () => {
    const now = new Date()
    const currentMonth = now.toLocaleString('default', { month: 'long' })
    const currentYear = now.getFullYear()
    const currentDay = now.getDate()
    
    return {
      day: `Today (${currentMonth} ${currentDay})`,
      week: `This Week (${currentMonth} ${currentDay})`,
      month: `${currentMonth} ${currentYear}`,
      year: `${currentYear}`
    }
  }

  // Note: Filtered devices are now handled by the comprehensive useEffect below that includes department filtering

  // Note: Filtered devices rank are now handled by the comprehensive useEffect below that includes department filtering

  // Load electricity rate from database (settings/electricity_rate)
  // Expected structure:
  // settings/electricity_rate: { rate: number, unit: string, updated_at: string, updated_by: string }
  useEffect(() => {
    const electricityRateRef = ref(realtimeDb, 'settings/electricity_rate')
    const unsubscribe = onValue(electricityRateRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val()
        const rateValue = Number(data.rate)
        
        // Update electricity rate data
        setElectricityRateData({
          rate: rateValue,
          unit: data.unit || 'PHP/kWh',
          updated_at: data.updated_at || '',
          updated_by: data.updated_by || 'user'
        })
        
        // Update current rate for calculations
        if (!Number.isNaN(rateValue) && rateValue > 0) {
          setCurrentRate(rateValue)
        }
        
        // Update last rate update timestamp
        if (data.updated_at) {
          try {
            const dt = new Date(data.updated_at)
            setLastRateUpdate(dt.toLocaleString('en-PH'))
          } catch {
            setLastRateUpdate(new Date().toLocaleString('en-PH'))
          }
        } else {
          setLastRateUpdate('')
        }
      } else {
        // No data in database, keep default values
        setElectricityRateData(null)
        setLastRateUpdate('')
      }
    }, (error) => {
      console.error('Error loading electricity rate:', error)
      setElectricityRateData(null)
      setLastRateUpdate('')
    })
    return () => off(electricityRateRef, 'value', unsubscribe)
  }, [])

  // Helper function to get department-specific combined limit path
  const getDepartmentCombinedLimitPath = (department: string) => {
    if (!department) return 'combined_limit_settings'
    return `combined_limit_settings/${department}`
  }

  // Helper function to check if a device is in any department's combined limit group
  const isDeviceInDepartmentCombinedGroup = async (outletKey: string, deviceData: any): Promise<boolean> => {
    try {
      // Get the device's department from office_info
      const deviceDept = deviceData?.office_info?.department
      if (!deviceDept) return false
      
      const deviceDeptKey = deviceDept.toLowerCase().replace(/\s+/g, '-')
      const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
      
      // Check if device's department has combined limits
      const deptPath = `combined_limit_settings/${deviceDeptKey}`
      const deptRef = ref(realtimeDb, deptPath)
      const deptSnapshot = await get(deptRef)
      
      if (!deptSnapshot.exists()) return false
      
      const deptData = deptSnapshot.val()
      if (!deptData?.enabled || !deptData?.selected_outlets) return false
      
      // Check if device is in the department's selected outlets
      const isInDeptLimit = deptData.selected_outlets.some((selectedOutlet: string) => {
        const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
        return normalizedSelected === normalizedOutletKey || 
               selectedOutlet === outletKey ||
               selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
      })
      
      return isInDeptLimit
    } catch (error) {
      console.error(`Error checking if device ${outletKey} is in department combined group:`, error)
      return false
    }
  }

  // CRITICAL: Fetch combined limit info IMMEDIATELY on mount and check monthly limits BEFORE any database changes
  // This ensures devices are turned off immediately when navigating to Dashboard
  useEffect(() => {
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    
    // CRITICAL: Fetch combined limit info IMMEDIATELY using get() before setting up listener
    // This ensures we check monthly limits before any database changes
    const fetchAndCheckMonthlyLimits = async () => {
      try {
        console.log('🔄 Dashboard: Fetching combined limit info IMMEDIATELY on mount...')
        const snapshot = await get(combinedLimitRef)
        
        let limitInfo = {
          enabled: false,
          selectedOutlets: [] as string[],
          combinedLimit: 0,
          device_control: 'on' as string
        }
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('✅ Dashboard: Fetched combined limit data:', data)
          limitInfo = {
            enabled: data.enabled || false,
            selectedOutlets: data.selected_outlets || [],
            combinedLimit: data.combined_limit_watts || 0,
            device_control: data.device_control || 'on'
          }
        } else {
          console.log('⚠️ Dashboard: No combined limit settings found in database')
        }
        
        // Update state immediately
        setCombinedLimitInfo(limitInfo)
        
        // CRITICAL: Check monthly limits IMMEDIATELY after fetching combined limit info
        // This happens BEFORE any database changes
        // First, check ALL department-based combined limits
        console.log('🔍 Dashboard: Running IMMEDIATE monthly limit check on mount for ALL departments (before any database changes)...')
        
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        
        if (devicesSnapshot.exists()) {
          const devicesData = devicesSnapshot.val()
          
          // Get all department combined limits
          const allDeptLimitsSnapshot = await get(combinedLimitRef)
          if (allDeptLimitsSnapshot.exists()) {
            const allDeptLimitsData = allDeptLimitsSnapshot.val()
            const departmentKeys = Object.keys(allDeptLimitsData)
            
            // Check each department's combined limit
            for (const deptKey of departmentKeys) {
              const deptData = allDeptLimitsData[deptKey]
              if (deptData && deptData.enabled && deptData.selected_outlets && deptData.selected_outlets.length > 0) {
                const deptLimitInfo = {
                  enabled: deptData.enabled || false,
                  selectedOutlets: deptData.selected_outlets || [],
                  combinedLimit: deptData.combined_limit_watts || 0,
                  department: deptKey
                }
                
                // Calculate total monthly energy for this department's combined group
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, deptLimitInfo.selectedOutlets)
                const combinedLimitWatts = deptLimitInfo.combinedLimit
                
                // Skip if "No Limit" is set
                if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
                  console.log(`✅ Dashboard: Department ${deptKey} has "No Limit" - setting device_control to "on"`)
                  const deptPath = getDepartmentCombinedLimitPath(deptKey)
                  const deptRef = ref(realtimeDb, deptPath)
                  const currentSettings = await get(deptRef)
                  const currentDeviceControl = currentSettings.val()?.device_control
                  const currentEnforcementReason = currentSettings.val()?.enforcement_reason
                  
                  if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
                    await update(deptRef, {
                      device_control: 'on',
                      enforcement_reason: '',
                      last_enforcement: new Date().toISOString()
                    })
                    console.log(`✅ Dashboard: Set ${deptPath}/device_control='on' (No Limit set)`)
                  }
                  continue
                }
                
                console.log(`📊 Dashboard: Department ${deptKey} monthly limit check:`, {
                  totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,
                  combinedLimitWatts: `${combinedLimitWatts}W`,
                  exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts
                })
                
                const deptPath = getDepartmentCombinedLimitPath(deptKey)
                const deptRef = ref(realtimeDb, deptPath)
                
                // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
                if (totalMonthlyEnergy >= combinedLimitWatts) {
                  const currentSettings = await get(deptRef)
                  const currentDeviceControl = currentSettings.val()?.device_control
                  
                  // If device_control is already 'off', skip all updates to prevent spam
                  if (currentDeviceControl === 'off') {
                    console.log(`✅ Dashboard: Department ${deptKey} monthly limit already enforced - skipping update`)
                    continue
                  }
                  
                  console.log(`🚨 Dashboard: Department ${deptKey} MONTHLY LIMIT EXCEEDED!`)
                  console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
                  
                  // Turn off all devices in this department's combined group
                  let successCount = 0
                  let skippedCount = 0
                  let failCount = 0
                  
                  for (const outletKey of deptLimitInfo.selectedOutlets) {
                    const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
                    const deviceData = devicesData[firebaseKey]
                    
                    if (!deviceData) {
                      failCount++
                      continue
                    }
                    
                    try {
                      const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
                      if (currentMainStatus === 'ON') {
                        skippedCount++
                        continue
                      }
                      
                      await update(ref(realtimeDb, `devices/${firebaseKey}/control`), { device: 'off' })
                      await update(ref(realtimeDb, `devices/${firebaseKey}`), { status: 'OFF' })
                      successCount++
                    } catch (error) {
                      failCount++
                    }
                  }
                  
                  // Update department's device_control, enforcement_reason, and last_enforcement
                  const finalSettings = await get(deptRef)
                  const finalDeviceControl = finalSettings.val()?.device_control
                  
                  if (finalDeviceControl !== 'off') {
                    await update(deptRef, {
                      device_control: 'off',
                      last_enforcement: new Date().toISOString(),
                      enforcement_reason: 'Monthly limit exceeded'
                    })
                    console.log(`🔒 Dashboard: Set ${deptPath}/device_control='off' with enforcement_reason and last_enforcement`)
                  }
                  
                  console.log(`🔒 Dashboard: Department ${deptKey} enforcement complete: ${successCount} turned off, ${skippedCount} skipped, ${failCount} failed`)
                } else {
                  // Limit not exceeded - update device_control to 'on' and clear enforcement_reason
                  const currentSettings = await get(deptRef)
                  const currentDeviceControl = currentSettings.val()?.device_control
                  const currentEnforcementReason = currentSettings.val()?.enforcement_reason
                  
                  if (currentDeviceControl !== 'on' || (currentEnforcementReason && currentEnforcementReason !== '')) {
                    await update(deptRef, {
                      device_control: 'on',
                      enforcement_reason: '',
                      last_enforcement: new Date().toISOString()
                    })
                    console.log(`✅ Dashboard: Set ${deptPath}/device_control='on' (limit not exceeded) - updated enforcement_reason and last_enforcement`)
                  }
                }
              }
            }
          }
          
          // Also check old combined limit structure for backward compatibility
          if (limitInfo.enabled && limitInfo.selectedOutlets.length > 0) {
            console.log('🔍 Dashboard: Also checking old combined limit structure for backward compatibility...')
            
            // Calculate total monthly energy for combined group
            const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, limitInfo.selectedOutlets)
            const combinedLimitWatts = limitInfo.combinedLimit
            
            // CRITICAL: Handle "No Limit" case - always allow devices to be ON
            if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
              console.log('✅ Dashboard: Combined limit is set to "No Limit" or 0 - setting device_control to "on"')
              const currentSettings = await get(combinedLimitRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              const currentEnforcementReason = currentSettings.val()?.enforcement_reason
              
              // Only update if device_control is not already 'on' or enforcement_reason is not empty
              if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
                await update(combinedLimitRef, {
                  device_control: 'on',
                  enforcement_reason: ''
                })
                console.log(`✅ Dashboard: Set combined_limit_settings/device_control='on' (No Limit set)`)
              }
              return
            }
            
            console.log('📊 Dashboard: IMMEDIATE monthly limit check results:', {
              totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,
              combinedLimitWatts: `${combinedLimitWatts}W`,
              selectedOutlets: limitInfo.selectedOutlets,
              exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts,
              percentage: combinedLimitWatts > 0 ? `${((totalMonthlyEnergy / combinedLimitWatts) * 100).toFixed(1)}%` : 'N/A'
            })
            
            // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
            if (totalMonthlyEnergy >= combinedLimitWatts) {
              // CRITICAL: Check if limit is already enforced BEFORE doing anything
              // This prevents spamming last_enforcement when limit is already exceeded
              const currentSettings = await get(combinedLimitRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              
              // If device_control is already 'off', skip all updates to prevent spam
              if (currentDeviceControl === 'off') {
                console.log(`✅ Dashboard: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
                return
              }
              
              console.log('🚨 Dashboard: MONTHLY LIMIT EXCEEDED on mount!')
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
              console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP (IMMEDIATE CHECK ON MOUNT)...')
              
              // Turn off all devices in the combined group (respecting override/bypass mode)
              let successCount = 0
              let skippedCount = 0
              let failCount = 0
              
              for (const outletKey of limitInfo.selectedOutlets) {
                const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
                const deviceData = devicesData[firebaseKey]
                
                console.log(`🔍 Dashboard: Processing ${outletKey} -> Firebase key: ${firebaseKey}`)
                
                if (!deviceData) {
                  console.error(`❌ Dashboard: Device ${firebaseKey} not found in Firebase!`)
                  failCount++
                  continue
                }
                
                try {
                  // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
                  const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
                  if (currentMainStatus === 'ON') {
                    console.log(`⚠️ Dashboard: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
                    skippedCount++
                    continue
                  }
                  
                  // Turn off device control
                  const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
                  await update(controlRef, { device: 'off' })
                  console.log(`✅ Dashboard: Set control.device='off' for ${firebaseKey}`)
                  
                  // Turn off status to prevent immediate re-activation
                  const statusRef = ref(realtimeDb, `devices/${firebaseKey}`)
                  await update(statusRef, { status: 'OFF' })
                  console.log(`✅ Dashboard: Set status='OFF' for ${firebaseKey}`)
                  
                  console.log(`✅ Dashboard: COMPLETELY TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit (IMMEDIATE CHECK)`)
                  successCount++
                } catch (error) {
                  console.error(`❌ Dashboard: FAILED to turn off ${outletKey}:`, error)
                  failCount++
                }
              }
              
              // CRITICAL: Set combined_limit_settings/device_control to "off" to prevent devices from turning back ON
              // We already checked above, but double-check to be safe
              const finalSettings = await get(combinedLimitRef)
              const finalDeviceControl = finalSettings.val()?.device_control
              
              if (finalDeviceControl !== 'off') {
                await update(combinedLimitRef, {
                  device_control: 'off',
                  last_enforcement: new Date().toISOString(),
                  enforcement_reason: 'Monthly limit exceeded'
                })
                console.log(`🔒 Dashboard: Set combined_limit_settings/device_control='off' to prevent re-activation (IMMEDIATE CHECK)`)
              } else {
                console.log(`✅ Dashboard: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
              }
              
              console.log(`🔒 Dashboard: IMMEDIATE MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
            } else {
              console.log('✅ Dashboard: Monthly limit not exceeded on mount - devices can remain active')
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
              
              // Set combined_limit_settings/device_control to "on" to allow devices to turn ON
              const currentSettings = await get(combinedLimitRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              const currentEnforcementReason = currentSettings.val()?.enforcement_reason
              
              // CRITICAL: Always update device_control to 'on' when limit is not exceeded
              // This ensures devices can turn ON based on schedule
              // Only skip if already 'on' AND enforcement_reason is already empty (to prevent spam)
              // Also update last_enforcement when clearing enforcement_reason
              if (currentDeviceControl !== 'on' || (currentEnforcementReason && currentEnforcementReason !== '')) {
                await update(combinedLimitRef, {
                  device_control: 'on',
                  enforcement_reason: '',
                  last_enforcement: new Date().toISOString() // Update last_enforcement when clearing enforcement_reason
                })
                console.log(`✅ Dashboard: Set combined_limit_settings/device_control='on' (limit not exceeded) - updated last_enforcement`)
              } else {
                console.log(`✅ Dashboard: device_control already 'on' and enforcement_reason already cleared - no update needed`)
              }
            }
          }
        } else {
          console.log('🚫 Dashboard: Combined limit not enabled or no outlets selected - skipping immediate monthly limit check')
        }
      } catch (error) {
        console.error('❌ Dashboard: Error fetching combined limit info or checking monthly limits on mount:', error)
      }
    }
    
    // Run immediate fetch and check
    fetchAndCheckMonthlyLimits()
    
    // Set up real-time listener for future updates
    const unsubscribe = onValue(combinedLimitRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val()
        console.log('Dashboard: Real-time update - combined limit data:', data)
        setCombinedLimitInfo({
          enabled: data.enabled || false,
          selectedOutlets: data.selected_outlets || [],
          combinedLimit: data.combined_limit_watts || 0,
          device_control: data.device_control || 'on'
        })
      } else {
        setCombinedLimitInfo({
          enabled: false,
          selectedOutlets: [],
          combinedLimit: 0,
          device_control: 'on'
        })
      }
    }, (error) => {
      console.error('Dashboard: Error listening to combined limit info:', error)
      setCombinedLimitInfo({
        enabled: false,
        selectedOutlets: [],
        combinedLimit: 0,
        device_control: 'on'
      })
    })
    
    // Cleanup listener on unmount
    return () => off(combinedLimitRef, 'value', unsubscribe)
  }, [])

  // CRITICAL: Run monthly limit check immediately when combinedLimitInfo is loaded
  // This ensures devices are turned off immediately when navigating to Dashboard
  // Similar to Schedule.tsx behavior
  useEffect(() => {
    if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
      console.log('🔄 Dashboard: Running immediate monthly limit check when combinedLimitInfo is loaded')
      const checkMonthlyLimitAndTurnOffDevices = async () => {
        try {
          console.log('🔍 Dashboard: Monthly limit check - Input data:', {
            enabled: combinedLimitInfo?.enabled,
            selectedOutlets: combinedLimitInfo?.selectedOutlets,
            combinedLimit: combinedLimitInfo?.combinedLimit
          })
          
          if (!combinedLimitInfo?.enabled || combinedLimitInfo?.selectedOutlets?.length === 0) {
            console.log('🚫 Dashboard: Monthly limit check skipped - not enabled or no outlets selected')
            return
          }

          const devicesRef = ref(realtimeDb, 'devices')
          const snapshot = await get(devicesRef)
          
          if (snapshot.exists()) {
            const devicesData = snapshot.val()
            
            // Calculate total monthly energy for combined group
            const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
            const combinedLimitWatts = combinedLimitInfo.combinedLimit
            
            // CRITICAL: Handle "No Limit" case - always allow devices to be ON
            if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
              console.log('✅ Dashboard: Combined limit is set to "No Limit" or 0 - setting device_control to "on"')
              const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
              const currentSettings = await get(combinedLimitRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              const currentEnforcementReason = currentSettings.val()?.enforcement_reason
              
              // Only update if device_control is not already 'on' or enforcement_reason is not empty
              if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
                await update(combinedLimitRef, {
                  device_control: 'on',
                  enforcement_reason: ''
                })
                console.log(`✅ Dashboard: Set combined_limit_settings/device_control='on' (No Limit set)`)
              }
              return
            }
            
            console.log('📊 Dashboard: Monthly limit check results:', {
              totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,
              combinedLimitWatts: `${combinedLimitWatts}W`,
              selectedOutlets: combinedLimitInfo.selectedOutlets,
              exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts,
              percentage: combinedLimitWatts > 0 ? `${((totalMonthlyEnergy / combinedLimitWatts) * 100).toFixed(1)}%` : 'N/A'
            })
            
            // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
            if (totalMonthlyEnergy >= combinedLimitWatts) {
              // CRITICAL: Check if limit is already enforced BEFORE doing anything
              // This prevents spamming last_enforcement when limit is already exceeded
              const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
              const currentSettings = await get(combinedLimitRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              
              // If device_control is already 'off', skip all updates to prevent spam
              if (currentDeviceControl === 'off') {
                console.log(`✅ Dashboard: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
                return
              }
              
              console.log('🚨 Dashboard: MONTHLY LIMIT EXCEEDED!')
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
              console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP...')
              
              // Turn off all devices in the combined group (respecting override/bypass mode)
              let successCount = 0
              let skippedCount = 0
              let failCount = 0
              
              for (const outletKey of combinedLimitInfo.selectedOutlets) {
                const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
                const deviceData = devicesData[firebaseKey]
                
                console.log(`🔍 Dashboard: Processing ${outletKey} -> Firebase key: ${firebaseKey}`)
                
                if (!deviceData) {
                  console.error(`❌ Dashboard: Device ${firebaseKey} not found in Firebase!`)
                  failCount++
                  continue
                }
                
                try {
                  // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
                  const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
                  if (currentMainStatus === 'ON') {
                    console.log(`⚠️ Dashboard: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
                    skippedCount++
                    continue
                  }
                  
                  // Turn off device control
                  const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
                  await update(controlRef, { device: 'off' })
                  console.log(`✅ Dashboard: Set control.device='off' for ${firebaseKey}`)
                  
                  // Turn off status to prevent immediate re-activation
                  const statusRef = ref(realtimeDb, `devices/${firebaseKey}`)
                  await update(statusRef, { status: 'OFF' })
                  console.log(`✅ Dashboard: Set status='OFF' for ${firebaseKey}`)
                  
                  console.log(`✅ Dashboard: COMPLETELY TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
                  successCount++
                } catch (error) {
                  console.error(`❌ Dashboard: FAILED to turn off ${outletKey}:`, error)
                  failCount++
                }
              }
              
              // CRITICAL: Set combined_limit_settings/device_control to "off" to prevent devices from turning back ON
              // We already checked above, but double-check to be safe
              const finalSettings = await get(combinedLimitRef)
              const finalDeviceControl = finalSettings.val()?.device_control
              
              if (finalDeviceControl !== 'off') {
                await update(combinedLimitRef, {
                  device_control: 'off',
                  last_enforcement: new Date().toISOString(),
                  enforcement_reason: 'Monthly limit exceeded'
                })
                console.log(`🔒 Dashboard: Set combined_limit_settings/device_control='off' to prevent re-activation`)
              } else {
                console.log(`✅ Dashboard: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
              }
              
              console.log(`🔒 Dashboard: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
            } else {
              console.log('✅ Dashboard: Monthly limit not exceeded - devices can remain active')
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
              
              // Set combined_limit_settings/device_control to "on" to allow devices to turn ON
              const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
              const currentSettings = await get(combinedLimitRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              const currentEnforcementReason = currentSettings.val()?.enforcement_reason
              
              // CRITICAL: Always update device_control to 'on' when limit is not exceeded
              // This ensures devices can turn ON based on schedule
              // Only skip if already 'on' AND enforcement_reason is already empty (to prevent spam)
              // Also update last_enforcement when clearing enforcement_reason
              if (currentDeviceControl !== 'on' || (currentEnforcementReason && currentEnforcementReason !== '')) {
                await update(combinedLimitRef, {
                  device_control: 'on',
                  enforcement_reason: '',
                  last_enforcement: new Date().toISOString() // Update last_enforcement when clearing enforcement_reason
                })
                console.log(`✅ Dashboard: Set combined_limit_settings/device_control='on' (limit not exceeded) - updated last_enforcement`)
              } else {
                console.log(`✅ Dashboard: device_control already 'on' and enforcement_reason already cleared - no update needed`)
              }
            }
          }
        } catch (error) {
          console.error('❌ Dashboard: Error checking combined monthly limit:', error)
        }
      }
      
      checkMonthlyLimitAndTurnOffDevices()
    }
  }, [combinedLimitInfo])

  useEffect(() => {
    // Fetch devices data from Firebase
    const devicesRef = ref(realtimeDb, 'devices')
    
    const unsubscribe = onValue(devicesRef, (snapshot) => {
      const data = snapshot.val()
      if (data) {
        const devicesArray: DeviceData[] = []

        const todayDateKey = getTodayDateKey()
        
        Object.keys(data).forEach((outletKey) => {
          const outlet: FirebaseDeviceData = data[outletKey]
          if (outlet.sensor_data) {
            // Map office values to display names
            const officeNames: Record<string, string> = {
              'computer-lab-1': 'Computer Laboratory 1',
              'computer-lab-2': 'Computer Laboratory 2',
              'computer-lab-3': 'Computer Laboratory 3',
              'deans-office': "Dean's Office",
              'faculty-office': 'Faculty Office'
            }
            
            const officeValue = outlet.office_info?.office || ''
            const officeInfo = officeValue ? (officeNames[officeValue] || officeValue) : '—'
            
            // Get today's data from daily_logs
            const todayLogs = outlet.daily_logs?.[todayDateKey]
            
            // Get lifetime_energy from root level (already in kW from database)
            const lifetimeEnergyKw = outlet.lifetime_energy || 0
            
            // Check for idle status from root level
            const sensorStatus = outlet.status
            const isIdleFromSensor = sensorStatus === 'idle'
            
            // Idle detection logic
            const currentTime = Date.now()
            const currentTotalEnergy = todayLogs?.total_energy || 0
            const controlState = outlet.control?.device || 'off'
            
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
            let deviceStatus: string
            
            // PRIORITY 1: UNPLUG - Check if device is unplugged (from root status or disabled_by_unplug flag)
            // This MUST be checked first - UNPLUG takes precedence over Active/Inactive
            if (sensorStatus === 'UNPLUG' || sensorStatus === 'unplug' || outlet.schedule?.disabled_by_unplug === true) {
              deviceStatus = 'UNPLUG'
            } else if ((isIdleFromSensor || isIdleFromLogic) && controlState === 'on') {
              // PRIORITY 2: Show Idle if sensor reports idle OR if device is supposed to be ON but not responding
              deviceStatus = 'Idle'
            } else {
              // PRIORITY 3: Active/Inactive based on control state (only if NOT unplugged)
              // Convert controlState to proper format ('on' -> 'Active', 'off' -> 'Inactive')
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

            const deviceData: DeviceData = {
              outletId: outletKey,
              status: deviceStatus,
              power: outlet.sensor_data.power || 0,
              energy: outlet.sensor_data.energy || 0,
              current: outlet.sensor_data.current || 0,
              voltage: outlet.sensor_data.voltage || 0,
              power_factor: outlet.sensor_data.power_factor || 0,
              timestamp: outlet.sensor_data.timestamp || '',
              avg_power: todayLogs?.avg_power || 0,
              peak_power: todayLogs?.peak_power || 0,
              total_energy: todayLogs?.total_energy || 0,
              lifetime_energy: lifetimeEnergyKw, // Use the raw kW value for calculations
              monthUsage: calculateMonthlyEnergy(outlet), // Calculate monthly energy
              officeRoom: officeInfo,
              appliances: outlet.office_info?.appliance || 'Unassigned',
              office_info: outlet.office_info, // Add office_info data
              relay_control: outlet.relay_control // Add relay_control data
            }
            devicesArray.push(deviceData)
          }
        })

        setDevices(devicesArray)
        
        // Debug logging
        console.log('Dashboard data fetched:', {
          todayDateKey,
          devicesCount: devicesArray.length,
          devices: devicesArray.map(d => ({
            outletId: d.outletId,
            total_energy: d.total_energy,
            peak_power: d.peak_power,
            officeRoom: d.officeRoom
          }))
        })
      }
    })

    return () => off(devicesRef, 'value', unsubscribe)
  }, [])

  // Fetch real-time power consumption data for EcoPlug devices from daily_logs (all days)
  // Real-time updates via Firebase onValue listener (updates automatically when data changes)
  useEffect(() => {
    setRealtimePowerLoading(true)
    setRealtimePowerError(null)
    
    try {
      const devicesRef = ref(realtimeDb, 'devices')
      const unsubscribe = onValue(devicesRef, (snapshot) => {
        try {
          const data = snapshot.val()
          console.log('📊 Real-Time Power Chart - Firebase snapshot received (Real-time updates enabled)')
          console.log('📊 Total outlets in database:', data ? Object.keys(data).length : 0)
          console.log('📊 Current filters - Department:', department, 'Office:', office)
          
          if (data) {
            const devicesArray: Array<{ label: string; totalEnergy: number; outletKey: string; daysCount: number; breakdown: string }> = []
            
            // Get ALL devices, then filter by department/office
            // Safety check: ensure data is an object
            if (typeof data !== 'object' || data === null || Array.isArray(data)) {
              console.error('❌ Invalid data format:', typeof data)
              setRealtimePowerData({ labels: [], powerValues: [] })
              setRealtimePowerLoading(false)
              setRealtimePowerError(null)
              return
            }
            
            const allOutlets = Object.keys(data || {})
              .filter(key => key && typeof key === 'string') // Safety: filter out invalid keys
              .sort((a, b) => {
                try {
                  // Extract outlet numbers for sorting (e.g., "Outlet_1" -> 1, "outlet_1" -> 1)
                  const numA = parseInt(String(a).replace(/\D/g, '')) || 0
                  const numB = parseInt(String(b).replace(/\D/g, '')) || 0
                  return numA - numB
                } catch (e) {
                  return 0 // If sorting fails, maintain order
                }
              })
            
            console.log(`📊 Processing ${allOutlets.length} outlets (before filtering)...`)
            
            allOutlets.forEach((outletKey) => {
              try {
                // Safety check: ensure outletKey is valid
                if (!outletKey || typeof outletKey !== 'string') {
                  return
                }
                
                const outlet = data[outletKey]
                
                // Safety check: ensure outlet exists
                if (!outlet || typeof outlet !== 'object') {
                  return
                }
                
                // Apply department/office filter
                if (department && department !== 'All Departments') {
                  const deviceDept = outlet?.office_info?.department || ''
                  if (typeof deviceDept === 'string' && deviceDept.toLowerCase() !== department.toLowerCase()) {
                    return // Skip this outlet - doesn't match department filter
                  }
                }
                
                if (office && office !== 'All Offices') {
                  const deviceOffice = outlet?.office_info?.office || ''
                  // Map office values to match office names
                  const officeNames: Record<string, string> = {
                    'computer-lab-1': 'Computer Laboratory 1',
                    'computer-lab-2': 'Computer Laboratory 2',
                    'computer-lab-3': 'Computer Laboratory 3',
                    'deans-office': "Dean's Office",
                    'faculty-office': 'Faculty Office'
                  }
                  const deviceOfficeDisplay = deviceOffice && typeof deviceOffice === 'string' 
                    ? (officeNames[deviceOffice] || deviceOffice) 
                    : ''
                  
                  if (deviceOfficeDisplay.toLowerCase() !== office.toLowerCase() && 
                      deviceOffice.toLowerCase() !== office.toLowerCase()) {
                    return // Skip this outlet - doesn't match office filter
                  }
                }
                
                const dailyLogs = outlet?.daily_logs || {}
                
                // Safety check: ensure dailyLogs is an object
                if (typeof dailyLogs !== 'object' || dailyLogs === null || Array.isArray(dailyLogs)) {
                  // If dailyLogs is invalid, use empty object
                  const emptyLogs = {}
                  Object.keys(emptyLogs).forEach(() => {}) // This will do nothing
                }
                
                // Sum all total_energy from all days in daily_logs
                let cumulativeTotalEnergy = 0
                let daysWithData = 0
                const dayBreakdown: string[] = []
                
                try {
                  Object.keys(dailyLogs || {}).forEach((dayKey) => {
                    try {
                      const dayData = dailyLogs[dayKey]
                      if (dayData && typeof dayData === 'object' && typeof dayData.total_energy === 'number' && !isNaN(dayData.total_energy) && isFinite(dayData.total_energy)) {
                        cumulativeTotalEnergy += dayData.total_energy
                        daysWithData++
                        dayBreakdown.push(`${dayKey}: ${dayData.total_energy} kWh`)
                      }
                    } catch (dayError) {
                      // Skip invalid day data
                      console.warn(`⚠️ Error processing day ${dayKey}:`, dayError)
                    }
                  })
                } catch (logsError) {
                  console.warn(`⚠️ Error processing daily_logs for ${outletKey}:`, logsError)
                }
                
                // total_energy is in kWh, convert to W for display
                // Safety: ensure result is a valid number
                const totalEnergyWh = (typeof cumulativeTotalEnergy === 'number' && isFinite(cumulativeTotalEnergy))
                  ? cumulativeTotalEnergy * 1000
                  : 0
                
                // Extract outlet number from key (e.g., "Outlet_1" -> 1, "outlet_2" -> 2)
                let outletNum = 0
                try {
                  outletNum = parseInt(String(outletKey).replace(/\D/g, '')) || devicesArray.length + 1
                } catch (e) {
                  outletNum = devicesArray.length + 1
                }
                const label = `EcoPlug ${outletNum}`
                
                // Detailed logging for verification (wrapped in try-catch)
                try {
                  console.log(`📊 ${outletKey} (${label}):`)
                  console.log(`   - Days with data: ${daysWithData} out of ${Object.keys(dailyLogs || {}).length} total days`)
                  console.log(`   - Cumulative total_energy: ${cumulativeTotalEnergy.toFixed(6)} kWh`)
                  console.log(`   - Converted to W: ${totalEnergyWh.toFixed(3)} W`)
                  if (dayBreakdown.length > 0) {
                    console.log(`   - Day breakdown (first 5):`, dayBreakdown.slice(0, 5))
                  } else {
                    console.log(`   - ⚠️ No total_energy data found in daily_logs`)
                  }
                } catch (logError) {
                  // If logging fails, continue anyway
                }
                
                // Add to array even if total_energy is 0 (to show all filtered outlets)
                // Safety: ensure all values are valid
                devicesArray.push({ 
                  label: String(label || `EcoPlug ${devicesArray.length + 1}`), 
                  totalEnergy: Number(totalEnergyWh) || 0, 
                  outletKey: String(outletKey || ''),
                  daysCount: Number(daysWithData) || 0,
                  breakdown: String(dayBreakdown.join(', ') || '')
                })
              } catch (outletError) {
                // If processing one outlet fails, log and continue with others
                console.warn(`⚠️ Error processing outlet ${outletKey}:`, outletError)
              }
            })
            
            // Safety: ensure devicesArray is valid
            const safeDevicesArray = Array.isArray(devicesArray) ? devicesArray : []
            
            try {
              console.log('📊 FINAL PROCESSED DEVICES ARRAY (after filtering):')
              console.log(`   - Total outlets processed: ${safeDevicesArray.length}`)
              console.log(`   - Filter applied: Department="${department}", Office="${office}"`)
              safeDevicesArray.forEach((device, index) => {
                try {
                  const energy = typeof device?.totalEnergy === 'number' ? device.totalEnergy : 0
                  const days = typeof device?.daysCount === 'number' ? device.daysCount : 0
                  console.log(`   ${index + 1}. ${device?.label || 'Unknown'} (${device?.outletKey || 'Unknown'}): ${energy.toFixed(3)} W (${days} days)`)
                } catch (logError) {
                  // Skip logging for this device if it fails
                }
              })
              
              const totalSum = safeDevicesArray.reduce((sum, d) => {
                const energy = typeof d?.totalEnergy === 'number' && isFinite(d.totalEnergy) ? d.totalEnergy : 0
                return sum + energy
              }, 0)
              console.log(`   - TOTAL SUM OF FILTERED OUTLETS: ${totalSum.toFixed(3)} W`)
            } catch (summaryError) {
              console.warn('⚠️ Error generating summary:', summaryError)
            }
            
            // Safety: ensure all values in arrays are valid
            const safeLabels = safeDevicesArray
              .map(d => String(d?.label || ''))
              .filter(label => label.length > 0)
            
            const safePowerValues = safeDevicesArray
              .map(d => {
                const energy = typeof d?.totalEnergy === 'number' && isFinite(d.totalEnergy) ? d.totalEnergy : 0
                return Math.max(0, energy) // Ensure non-negative
              })
            
            if (safeLabels.length > 0 && safePowerValues.length > 0) {
              setRealtimePowerData({
                labels: safeLabels,
                powerValues: safePowerValues
              })
              setRealtimePowerLoading(false)
              setRealtimePowerError(null)
            } else {
              // No devices found after filtering
              setRealtimePowerData({
                labels: [],
                powerValues: []
              })
              setRealtimePowerLoading(false)
              setRealtimePowerError(null)
            }
          } else {
            console.log('⚠️ No data found in Firebase')
            setRealtimePowerData({
              labels: [],
              powerValues: []
            })
            setRealtimePowerLoading(false)
            setRealtimePowerError(null)
          }
        } catch (error) {
          console.error('❌ Error processing real-time power data:', error)
          setRealtimePowerError('Error processing device data')
          setRealtimePowerLoading(false)
        }
      }, (error) => {
        // Error callback for onValue
        console.error('❌ Firebase real-time listener error:', error)
        setRealtimePowerError('Failed to connect to database')
        setRealtimePowerLoading(false)
      })
      
      return () => {
        unsubscribe()
      }
    } catch (error) {
      console.error('❌ Error setting up real-time power listener:', error)
      setRealtimePowerError('Failed to initialize data connection')
      setRealtimePowerLoading(false)
    }
  }, [department, office]) // Re-run when department or office filter changes

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
            console.log('Dashboard: No device data after initial fetch')
            return
          }
          const freshDevicesData = freshSnapshot.val()
          console.log('🔄 Dashboard: Re-fetched device data to ensure fresh status')
          
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.
          
          console.log(`Dashboard: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(freshDevicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`Dashboard: Checking device ${outletKey}:`, {
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
                console.log(`⚠️ Dashboard: Skipping ${outletKey} - status='OFF' (manually disabled or monthly limit exceeded)`)
                continue
              }
              
              // RESPECT disabled_by_unplug - if schedule is disabled by unplug, don't enable it
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`Dashboard: Device ${outletKey} is disabled by unplug - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`Dashboard: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
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
                console.log(`Dashboard: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
                continue
              }
              
              // CRITICAL: Check if device is in ANY department's combined limit group
              // If it is, skip individual monthly limit check (combined limit takes precedence)
              const isInDeptCombinedGroup = await isDeviceInDepartmentCombinedGroup(outletKey, deviceData)
              
              // Also check old combined limit structure for backward compatibility
              const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
              const isInOldCombinedGroup = combinedLimitInfo?.enabled && 
                                         combinedLimitInfo?.selectedOutlets?.some((selectedOutlet: string) => {
                                           const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                                           return normalizedSelected === normalizedOutletKey || 
                                                  selectedOutlet === outletKey ||
                                                  selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                                         })
              
              const isInAnyCombinedGroup = isInDeptCombinedGroup || isInOldCombinedGroup
              
              // CRITICAL: If device is in combined group and combined_limit_settings/device_control is "off", force device OFF
              if (isInAnyCombinedGroup && combinedLimitInfo?.device_control === 'off') {
                console.log(`🔒 Dashboard: FORCING ${outletKey} OFF - combined_limit_settings/device_control is OFF (monthly limit enforcement)`)
                // Force device OFF
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: 'off'
                })
                await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                  main_status: 'OFF'
                })
                await update(ref(realtimeDb, `devices/${outletKey}`), {
                  status: 'OFF'
                })
                continue
              }
              
              // Check if device should be active based on current time and schedule
              // Skip individual limit check if device is in combined group (combined limit takes precedence)
              const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, currentControlState, deviceData, isInAnyCombinedGroup)
              let newControlState = shouldBeActive ? 'on' : 'off'
              
              // CRITICAL: Additional individual monthly limit checking for devices NOT in any combined groups
              // If device is in a department's combined group, skip individual limit check
              if (!isInAnyCombinedGroup && newControlState === 'on') {
                // Check individual monthly limit for devices not in combined groups
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
                    newControlState = 'off' // Force OFF if monthly limit exceeded
                    console.log(`🔒 Dashboard: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual monthly limit exceeded (${(totalMonthlyEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  }
                }
              }
              
              // CRITICAL: If device is already ON and schedule says it should be ON, don't change anything
              // This prevents Dashboard.tsx from interfering with Schedule.tsx's decisions
              if (currentControlState === 'on' && shouldBeActive) {
                console.log(`✅ Dashboard: Device ${outletKey} is already ON and schedule confirms it should be ON - skipping update to avoid conflicts`)
                continue
              }
              
              // CRITICAL: If device is already OFF and schedule says it should be OFF, don't change anything
              // This prevents unnecessary updates
              if (currentControlState === 'off' && !shouldBeActive) {
                console.log(`✅ Dashboard: Device ${outletKey} is already OFF and schedule confirms it should be OFF - skipping update`)
                continue
              }
              
              console.log(`Dashboard: Schedule check for ${outletKey}:`, {
                currentControlState,
                shouldBeActive,
                newControlState,
                needsUpdate: currentControlState !== newControlState,
                isInAnyCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                console.log(`Dashboard: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
              } else {
                console.log(`Dashboard: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('Dashboard: Error in real-time scheduler:', error)
      }
    }
    
    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`Dashboard: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            const currentControlState = deviceData.control?.device || 'off'
            const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
            
            // Skip if device is already off
            if (currentControlState === 'off') {
              continue
            }
            
            // Check if main_status is 'ON' - if so, skip automatic power limit enforcement (device is in bypass mode)
            if (currentMainStatus === 'ON') {
              console.log(`Dashboard: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // CRITICAL: Check if device is in ANY department's combined limit group
            // If it is, skip individual monthly limit check (combined limit takes precedence)
            const isInDeptCombinedGroup = await isDeviceInDepartmentCombinedGroup(outletKey, deviceData)
            
            // Also check old combined limit structure for backward compatibility
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInOldCombinedGroup = combinedLimitInfo?.enabled && 
                                       combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            const isInAnyCombinedGroup = isInDeptCombinedGroup || isInOldCombinedGroup
            
            // Only check individual monthly limit if device is NOT in any combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInAnyCombinedGroup) {
              console.log(`Dashboard: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
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
                
                console.log(`Dashboard: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000)}W`,
                  currentMonth: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
                  exceedsLimit: totalMonthlyEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInAnyCombinedGroup: isInAnyCombinedGroup
                })
                
                // If monthly energy exceeds power limit, turn off the device
                if (totalMonthlyEnergy >= powerLimit) {
                  console.log(`Dashboard: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(totalMonthlyEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`Dashboard: Device ${outletKey} turned OFF due to power limit exceeded`)
                }
              }
            } else {
              console.log(`Dashboard: Device ${outletKey} is in combined group - checking combined group power limits`)
              
              // For devices in combined groups, check combined monthly limit
              if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitkW = combinedLimitInfo.combinedLimit / 1000 // Convert to kW
                
                console.log(`Dashboard: Combined group limit check for ${outletKey}:`, {
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(0)}W`,
                  combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
                  exceedsLimit: totalMonthlyEnergy >= combinedLimitkW
                })
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  console.log(`Dashboard: Combined monthly limit exceeded - turning off ${outletKey}`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`Dashboard: Device ${outletKey} turned OFF due to combined monthly limit exceeded`)
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Dashboard: Error in power limit monitor:', error)
      }
    }
    
    // Monthly limit check for combined groups - checks ALL department-based combined limits
    const checkMonthlyLimitAndTurnOffDevices = async () => {
      try {
        console.log('🔍 Dashboard: Monthly limit check for ALL departments...')
        
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (!snapshot.exists()) {
          console.log('🚫 Dashboard: No devices found')
          return
        }
        
        const devicesData = snapshot.val()
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const allDeptLimitsSnapshot = await get(combinedLimitRef)
        
        if (!allDeptLimitsSnapshot.exists()) {
          console.log('🚫 Dashboard: No combined limit settings found')
          return
        }
        
        const allDeptLimitsData = allDeptLimitsSnapshot.val()
        const departmentKeys = Object.keys(allDeptLimitsData)
        
        // Check each department's combined limit
        for (const deptKey of departmentKeys) {
          const deptData = allDeptLimitsData[deptKey]
          if (deptData && deptData.enabled && deptData.selected_outlets && deptData.selected_outlets.length > 0) {
            const deptLimitInfo = {
              enabled: deptData.enabled || false,
              selectedOutlets: deptData.selected_outlets || [],
              combinedLimit: deptData.combined_limit_watts || 0,
              department: deptKey
            }
            
            // Calculate total monthly energy for this department's combined group
            const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, deptLimitInfo.selectedOutlets)
            const combinedLimitWatts = deptLimitInfo.combinedLimit
            
            // Skip if "No Limit" is set
            if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
              const deptPath = getDepartmentCombinedLimitPath(deptKey)
              const deptRef = ref(realtimeDb, deptPath)
              const currentSettings = await get(deptRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              const currentEnforcementReason = currentSettings.val()?.enforcement_reason
              
              if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
                await update(deptRef, {
                  device_control: 'on',
                  enforcement_reason: '',
                  last_enforcement: new Date().toISOString()
                })
              }
              continue
            }
            
            console.log(`📊 Dashboard: Department ${deptKey} monthly limit check:`, {
              totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,
              combinedLimitWatts: `${combinedLimitWatts}W`,
              exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts
            })
            
            const deptPath = getDepartmentCombinedLimitPath(deptKey)
            const deptRef = ref(realtimeDb, deptPath)
            
            // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
            if (totalMonthlyEnergy >= combinedLimitWatts) {
              const currentSettings = await get(deptRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              
              // If device_control is already 'off', skip all updates to prevent spam
              if (currentDeviceControl === 'off') {
                console.log(`✅ Dashboard: Department ${deptKey} monthly limit already enforced - skipping update`)
                continue
              }
              
              console.log(`🚨 Dashboard: Department ${deptKey} MONTHLY LIMIT EXCEEDED!`)
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
              console.log(`🔒 TURNING OFF ALL DEVICES IN DEPARTMENT ${deptKey}...`)
              
              // Turn off all devices in this department's combined group
              let successCount = 0
              let skippedCount = 0
              let failCount = 0
              
              for (const outletKey of deptLimitInfo.selectedOutlets) {
                const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
                const deviceData = devicesData[firebaseKey]
                
                if (!deviceData) {
                  failCount++
                  continue
                }
                
                try {
                  const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
                  if (currentMainStatus === 'ON') {
                    console.log(`⚠️ Dashboard: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
                    skippedCount++
                    continue
                  }
                  
                  await update(ref(realtimeDb, `devices/${firebaseKey}/control`), { device: 'off' })
                  await update(ref(realtimeDb, `devices/${firebaseKey}`), { status: 'OFF' })
                  console.log(`✅ Dashboard: Turned OFF ${outletKey} (${firebaseKey}) due to department ${deptKey} monthly limit exceeded`)
                  successCount++
                } catch (error) {
                  console.error(`❌ Dashboard: FAILED to turn off ${outletKey}:`, error)
                  failCount++
                }
              }
              
              // Update department's device_control, enforcement_reason, and last_enforcement
              const finalSettings = await get(deptRef)
              const finalDeviceControl = finalSettings.val()?.device_control
              
              if (finalDeviceControl !== 'off') {
                await update(deptRef, {
                  device_control: 'off',
                  last_enforcement: new Date().toISOString(),
                  enforcement_reason: 'Monthly limit exceeded'
                })
                console.log(`🔒 Dashboard: Set ${deptPath}/device_control='off' with enforcement_reason and last_enforcement`)
              }
              
              console.log(`🔒 Dashboard: Department ${deptKey} enforcement complete: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
            } else {
              // Limit not exceeded - update device_control to 'on' and clear enforcement_reason
              const currentSettings = await get(deptRef)
              const currentDeviceControl = currentSettings.val()?.device_control
              const currentEnforcementReason = currentSettings.val()?.enforcement_reason
              
              if (currentDeviceControl !== 'on' || (currentEnforcementReason && currentEnforcementReason !== '')) {
                await update(deptRef, {
                  device_control: 'on',
                  enforcement_reason: '',
                  last_enforcement: new Date().toISOString()
                })
                console.log(`✅ Dashboard: Set ${deptPath}/device_control='on' (limit not exceeded) - updated enforcement_reason and last_enforcement`)
              }
            }
          }
        }
        
        // Also check old combined limit structure for backward compatibility
        if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
          console.log('🔍 Dashboard: Also checking old combined limit structure for backward compatibility...')
          
          // Calculate total monthly energy for combined group
          const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
          const combinedLimitWatts = combinedLimitInfo.combinedLimit
          
          // CRITICAL: Handle "No Limit" case - always allow devices to be ON
          if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
            console.log('✅ Dashboard: Combined limit is set to "No Limit" or 0 - setting device_control to "on"')
            const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
            const currentSettings = await get(combinedLimitRef)
            const currentDeviceControl = currentSettings.val()?.device_control
            const currentEnforcementReason = currentSettings.val()?.enforcement_reason
            
            // Only update if device_control is not already 'on' or enforcement_reason is not empty
            if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
              await update(combinedLimitRef, {
                device_control: 'on',
                enforcement_reason: ''
              })
              console.log(`✅ Dashboard: Set combined_limit_settings/device_control='on' (No Limit set)`)
            }
            return
          }
          
          console.log('📊 Dashboard: Monthly limit check results:', {
            totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,
            combinedLimitWatts: `${combinedLimitWatts}W`,
            selectedOutlets: combinedLimitInfo.selectedOutlets,
            exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts,
            percentage: combinedLimitWatts > 0 ? `${((totalMonthlyEnergy / combinedLimitWatts) * 100).toFixed(1)}%` : 'N/A'
          })
          
          // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
          if (totalMonthlyEnergy >= combinedLimitWatts) {
            // CRITICAL: Check if limit is already enforced BEFORE doing anything
            // This prevents spamming last_enforcement when limit is already exceeded
            const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
            const currentSettings = await get(combinedLimitRef)
            const currentDeviceControl = currentSettings.val()?.device_control
            
            // If device_control is already 'off', skip all updates to prevent spam
            if (currentDeviceControl === 'off') {
              console.log(`✅ Dashboard: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
              return
            }
            
            console.log('🚨 Dashboard: MONTHLY LIMIT EXCEEDED!')
            console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
            console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP...')
            
            // Turn off all devices in the combined group (respecting override/bypass mode)
            let successCount = 0
            let skippedCount = 0
            let failCount = 0
            
            for (const outletKey of combinedLimitInfo.selectedOutlets) {
              const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
              const deviceData = devicesData[firebaseKey]
              
              console.log(`🔍 Dashboard: Processing ${outletKey} -> Firebase key: ${firebaseKey}`)
              
              if (!deviceData) {
                console.error(`❌ Dashboard: Device ${firebaseKey} not found in Firebase!`)
                failCount++
                continue
              }
              
              try {
                // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
                const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
                if (currentMainStatus === 'ON') {
                  console.log(`⚠️ Dashboard: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
                  skippedCount++
                  continue
                }
                
                // Turn off device control
                const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
                await update(controlRef, { device: 'off' })
                console.log(`✅ Dashboard: Set control.device='off' for ${firebaseKey}`)
                
                // Turn off status to prevent immediate re-activation
                const statusRef = ref(realtimeDb, `devices/${firebaseKey}`)
                await update(statusRef, { status: 'OFF' })
                console.log(`✅ Dashboard: Set status='OFF' for ${firebaseKey}`)
                
                console.log(`✅ Dashboard: COMPLETELY TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
                successCount++
              } catch (error) {
                console.error(`❌ Dashboard: FAILED to turn off ${outletKey}:`, error)
                failCount++
              }
            }
            
            // CRITICAL: Set combined_limit_settings/device_control to "off" to prevent devices from turning back ON
            // We already checked above, but double-check to be safe
            const finalSettings = await get(combinedLimitRef)
            const finalDeviceControl = finalSettings.val()?.device_control
            
            if (finalDeviceControl !== 'off') {
              await update(combinedLimitRef, {
                device_control: 'off',
                last_enforcement: new Date().toISOString(),
                enforcement_reason: 'Monthly limit exceeded'
              })
              console.log(`🔒 Dashboard: Set combined_limit_settings/device_control='off' to prevent re-activation`)
            } else {
              console.log(`✅ Dashboard: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
            }
            
            console.log(`🔒 Dashboard: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
          } else {
            console.log('✅ Dashboard: Monthly limit not exceeded - devices can remain active')
            console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
            
            // Set combined_limit_settings/device_control to "on" to allow devices to turn ON
            const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
            const currentSettings = await get(combinedLimitRef)
            const currentDeviceControl = currentSettings.val()?.device_control
            const currentEnforcementReason = currentSettings.val()?.enforcement_reason
            
            // CRITICAL: Always update device_control to 'on' when limit is not exceeded
            // This ensures devices can turn ON based on schedule
            // Only skip if already 'on' AND enforcement_reason is already empty (to prevent spam)
            // Also update last_enforcement when clearing enforcement_reason
            if (currentDeviceControl !== 'on' || (currentEnforcementReason && currentEnforcementReason !== '')) {
              await update(combinedLimitRef, {
                device_control: 'on',
                enforcement_reason: '',
                last_enforcement: new Date().toISOString() // Update last_enforcement when clearing enforcement_reason
              })
              console.log(`✅ Dashboard: Set combined_limit_settings/device_control='on' (limit not exceeded) - updated last_enforcement`)
            } else {
              console.log(`✅ Dashboard: device_control already 'on' and enforcement_reason already cleared - no update needed`)
            }
          }
        }
      } catch (error) {
        console.error('❌ Dashboard: Error checking combined monthly limit:', error)
      }
    }

    // CRITICAL: Add delay before running schedulers to avoid conflicts with Schedule.tsx
    // Note: Monthly limit check is already done IMMEDIATELY on mount in the combined limit info useEffect
    // This gives Schedule.tsx time to finish any updates before Dashboard.tsx starts
    const INITIAL_DELAY = 2000 // 2 seconds delay
    
    // Store interval IDs for cleanup
    let scheduleInterval: NodeJS.Timeout | null = null
    let powerLimitInterval: NodeJS.Timeout | null = null
    let monthlyLimitInterval: NodeJS.Timeout | null = null
    
    // Run functions after initial delay to avoid conflicts
    const initialTimeout = setTimeout(() => {
      console.log('🔄 Dashboard: Starting schedulers after initial delay to avoid conflicts')
      // CRITICAL: Run monthly limit check to update device_control and enforcement_reason
      // This ensures device_control is set to 'on' when limit is not exceeded
      checkMonthlyLimitAndTurnOffDevices()
      
      // Run schedule check to turn devices on/off based on schedule
      checkScheduleAndUpdateDevices()
      
      // Run power limit check
      checkPowerLimitsAndTurnOffDevices()
      
      // Set up intervals after initial delay
      scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds
      powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 12000) // 12 seconds
      monthlyLimitInterval = setInterval(checkMonthlyLimitAndTurnOffDevices, 10000) // 10 seconds
    }, INITIAL_DELAY)
    
    // Add manual test function for debugging
    ;(window as any).testDashboardSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testDashboardPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).checkDashboardCurrentTime = () => {
      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()
      const currentDay = now.getDay()
      console.log('Dashboard current time debug:', {
        time: now.toLocaleTimeString(),
        minutes: currentTime,
        day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
        date: now.toLocaleDateString()
      })
    }
    
    // Cleanup intervals and timeout on unmount
    return () => {
      clearTimeout(initialTimeout)
      if (scheduleInterval) clearInterval(scheduleInterval)
      if (powerLimitInterval) clearInterval(powerLimitInterval)
      if (monthlyLimitInterval) clearInterval(monthlyLimitInterval)
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
    }
  }, [])

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
                console.log(`Dashboard: Initialized basis for unplug detection on ${outletKey} (no schedule)`)
              } catch (error) {
                console.error(`Dashboard: Error initializing basis for ${outletKey}:`, error)
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
                console.log(`Dashboard: Initialized basis for unplug detection on ${outletKey} (with schedule)`)
              } catch (error) {
                console.error(`Dashboard: Error initializing basis for ${outletKey}:`, error)
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
          if (disabledByUnplug === true) {
            // Check timestamp change using functional setState to get current state
            setDeviceTimestamps(prev => {
              const existing = prev[outletKey]
              
              // Device is marked as unplugged - check if timestamp has changed (device plugged back in)
              if (existing && existing.lastTimestamp && sensorTimestamp && existing.lastTimestamp !== sensorTimestamp) {
                // Timestamp changed - device was plugged back in after being unplugged
                console.log(`🔌 Dashboard: PLUG DETECTED: ${outletKey} - timestamp changed from "${existing.lastTimestamp}" to "${sensorTimestamp}", resetting unplug state`)
                
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
                    console.log(`✅ Dashboard: RESET UNPLUG STATE: ${outletKey} - device plugged back in, disabled_by_unplug set to false, status reset to normal`)
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
                      // Set root status to UNPLUG for display
                      return update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'UNPLUG'
                      })
                    }).then(() => {
                      console.log(`🔌 Dashboard: UNPLUG DETECTED: ${outletKey} - timestamp unchanged for 30+ seconds. Device turned OFF, schedule disabled, and root status set to UNPLUG.`)
                    }).catch(err => {
                      console.error(`Dashboard: Error disabling schedule or setting UNPLUG status for ${outletKey}:`, err)
                    })
                  }).catch(err => {
                    console.error(`Dashboard: Error turning off device ${outletKey}:`, err)
                  })
                }).catch(err => {
                  console.error(`Dashboard: Error marking ${outletKey} as unplugged:`, err)
                })
                
                // Update state to track this timestamp (when device was marked unplugged)
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
        console.error('Dashboard: Error checking unplugged devices:', error)
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
  }, [])

  // Get chart data based on selected time segment
  const getChartDataByTimeSegment = async () => {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    
    // Helper function to get date key for database
    const getDateKey = (date: Date) => {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `day_${year}_${month}_${day}`
    }
    
    // Helper function to fetch device data for a specific date
    const getDeviceDataForDate = async (dateKey: string): Promise<number[]> => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          return filteredDevices.map(device => {
            const outletKey = device.outletId
            const outletData = devicesData[outletKey]
            const dayLogs = outletData?.daily_logs?.[dateKey]
            return dayLogs?.total_energy || 0 // Energy in kW from database
          })
        }
        return filteredDevices.map(() => 0)
      } catch (error) {
        console.error('Error fetching device data for date:', dateKey, error)
        return filteredDevices.map(() => 0)
      }
    }
    
    try {
      switch (timeSegment) {
      case 'Week':
          // Show data from current week (last 7 days)
          const weekLabels: string[] = []
          const weekData: number[][] = []
          
          for (let i = 6; i >= 0; i--) {
            const date = new Date(now)
            date.setDate(date.getDate() - i)
            const dateKey = getDateKey(date)
            const dayData = await getDeviceDataForDate(dateKey)
            
            weekLabels.push(date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))
            weekData.push(dayData)
          }
          
        return {
            labels: weekLabels,
            energyUsage: weekData
        }
      
      case 'Month':
          // Show data from current month (last 30 days)
          const monthLabels: string[] = []
          const monthData: number[][] = []
          
          for (let i = 29; i >= 0; i--) {
            const date = new Date(now)
            date.setDate(date.getDate() - i)
            const dateKey = getDateKey(date)
            const dayData = await getDeviceDataForDate(dateKey)
            
            monthLabels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
            monthData.push(dayData)
          }
          
        return {
            labels: monthLabels,
            energyUsage: monthData
        }
      
      case 'Year':
          // Show data from current year (last 12 months)
          const yearLabels: string[] = []
          const yearData: number[][] = []
          
          for (let i = 11; i >= 0; i--) {
            const date = new Date(now)
            date.setMonth(date.getMonth() - i)
            const monthKey = `${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, '0')}`
            
            // For year view, we'll sum up all days in the month
            const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
            const monthData: number[] = new Array(filteredDevices.length).fill(0)
            
            for (let day = 1; day <= daysInMonth; day++) {
              const dayDate = new Date(date.getFullYear(), date.getMonth(), day)
              const dayKey = getDateKey(dayDate)
              const dayData = await getDeviceDataForDate(dayKey)
              
              for (let deviceIndex = 0; deviceIndex < filteredDevices.length; deviceIndex++) {
                monthData[deviceIndex] += dayData[deviceIndex] || 0
              }
            }
            
            yearLabels.push(date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }))
            yearData.push(monthData)
          }
          
        return {
            labels: yearLabels,
            energyUsage: yearData
        }
      
      default:
          // Default to week view
          const defaultWeekLabels: string[] = []
          const defaultWeekData: number[][] = []
          
          for (let i = 6; i >= 0; i--) {
            const date = new Date(now)
            date.setDate(date.getDate() - i)
            const dateKey = getDateKey(date)
            const dayData = await getDeviceDataForDate(dateKey)
            
            defaultWeekLabels.push(date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))
            defaultWeekData.push(dayData)
          }
          
        return {
            labels: defaultWeekLabels,
            energyUsage: defaultWeekData
          }
      }
    } catch (error) {
      console.error('Error in getChartDataByTimeSegment:', error)
      return {
        labels: [],
        energyUsage: []
        }
    }
  }

  // Chart data based on selected time segment
  const [chartData, setChartData] = useState<{
    labels: string[]
    energyUsage: number[][]
  }>({
    labels: [],
    energyUsage: []
  })
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Determine if we should show bar chart (single device) or line chart (multiple devices)
  const shouldShowBarChart = filteredDevices.length === 1

  // Update chart data when time segment or filtered devices change
  useEffect(() => {
    const updateChartData = async () => {
      if (filteredDevices.length > 0) {
        console.log('Updating chart data for timeSegment:', timeSegment, 'filteredDevices:', filteredDevices.length)
        try {
          const newChartData = await getChartDataByTimeSegment()
          console.log('Chart data loaded:', newChartData)
          setChartData(newChartData)
        } catch (error) {
          console.error('Error loading chart data:', error)
          // Set empty data structure on error
          setChartData({
            labels: [],
            energyUsage: []
          })
        }
      } else {
        // Reset chart data when no devices
        setChartData({
          labels: [],
          energyUsage: []
        })
      }
    }
    
    updateChartData()
  }, [timeSegment, filteredDevices])

  // Device usage data based on filtered data - use today's total_energy (already in kW)
  const deviceUsage = filteredDevices.map(device => {
    // total_energy is today's energy from daily_logs, already in kW from database, convert to W for display
    const todayEnergyKw = device.total_energy
    const usageDisplay = `${formatNumber(todayEnergyKw * 1000)} W`
    
    const outletNumber = (device.outletId && typeof device.outletId === 'string' && device.outletId.includes('_'))
      ? device.outletId.split('_')[1]
      : device.outletId || 'Unknown'
    
    return {
      name: `Outlet ${outletNumber}`,
      usage: device.total_energy, // Today's energy from daily_logs (already in kW from database)
      usageDisplay: usageDisplay, // Display format with W
      percentage: totalEnergy > 0 ? (device.total_energy / totalEnergy) * 100 : 0
    }
  })

  const [departments, setDepartments] = useState<string[]>(['All Departments'])

  // Debug departments state
  useEffect(() => {
    console.log('Departments state updated:', departments)
    console.log('Available departments for dropdown:', departments)
  }, [departments])

  // Function to get filtered offices based on selected department
  const getFilteredOffices = () => {
    if (department === 'All Departments') {
      return ['All Offices', ...offices]
    }
    
    const filteredOffices: string[] = ['All Offices']
    
    Object.values(officesData).forEach((officeData: any) => {
      const dep = officeData?.department
      const off = officeData?.office
      if (dep && off && dep.toLowerCase() === department.toLowerCase()) {
        filteredOffices.push(off)
      }
    })
    
    return filteredOffices
  }

  // Function to calculate office ranking data
  const calculateOfficeRanking = async (devices: DeviceData[], period: string) => {
    try {
      const officeConsumptionMap = new Map<string, {
        office: string
        department: string
        totalConsumption: number
        totalMonthlyConsumption: number
        deviceCount: number
        outlets: string[]
      }>()

      // Group devices by office and calculate total consumption
      for (const device of devices) {
        let officeName = 'Unknown Office'
        let departmentName = 'Unknown Department'
        
        if (device.office_info && device.office_info.office && device.office_info.department) {
          officeName = device.office_info.office
          departmentName = device.office_info.department
        } else if (device.officeRoom && device.officeRoom !== '—') {
          officeName = device.officeRoom
          // Try to find department from officesData
          const officeData = Object.values(officesData).find((data: any) => 
            data.office === device.officeRoom
          )
          if (officeData && (officeData as any).department) {
            departmentName = (officeData as any).department
          }
        }

        const key = `${departmentName}|${officeName}`
        
        if (!officeConsumptionMap.has(key)) {
          officeConsumptionMap.set(key, {
            office: officeName,
            department: departmentName,
            totalConsumption: 0,
            totalMonthlyConsumption: 0,
            deviceCount: 0,
            outlets: []
          })
        }

        const officeData = officeConsumptionMap.get(key)!
        // Use total_energy which contains time-period filtered data
        officeData.totalConsumption += device.total_energy || 0
        // Sum up monthly consumption (parse the string value)
        const monthlyValue = parseFloat((device.monthUsage || '0 W').replace(/[^\d.]/g, '')) || 0
        officeData.totalMonthlyConsumption += monthlyValue
        officeData.deviceCount += 1
        const outletNum = (device.outletId && typeof device.outletId === 'string' && device.outletId.includes('_'))
          ? device.outletId.split('_')[1]
          : device.outletId || 'Unknown'
        officeData.outlets.push(outletNum)
      }

      // Convert to array and sort by consumption
      const rankingData = Array.from(officeConsumptionMap.values())
        .sort((a, b) => b.totalConsumption - a.totalConsumption)
        .map((item, index) => ({
          rank: index + 1,
          office: item.office,
          department: item.department,
          outlets: item.outlets.join(', '),
          consumption: item.totalConsumption * 1000, // Convert to W
          monthConsumption: item.totalMonthlyConsumption, // Already in W
          deviceCount: item.deviceCount
        }))

      setOfficeRankingData(rankingData)
      
      console.log('Office Ranking calculated:', {
        period,
        totalOffices: rankingData.length,
        totalDevices: devices.length,
        rankingData: rankingData.slice(0, 5), // Log top 5 for debugging
        sampleDeviceData: devices.slice(0, 2).map(d => ({
          outletId: d.outletId,
          total_energy: d.total_energy,
          office_info: d.office_info,
          officeRoom: d.officeRoom
        }))
      })
    } catch (error) {
      console.error('Error calculating office ranking:', error)
      setOfficeRankingData([])
    }
  }

  // Fetch offices data from database
  useEffect(() => {
    const fetchOfficesData = async () => {
      try {
        console.log('Fetching offices data from database...')
        const officesRef = ref(realtimeDb, 'offices')
        const snapshot = await get(officesRef)
        
        console.log('Database snapshot exists:', snapshot.exists())
        console.log('Database snapshot value:', snapshot.val())
        
        if (snapshot.exists()) {
          const officesData = snapshot.val()
          setOfficesData(officesData)
          
          // Extract unique departments and offices
          const departmentsSet = new Set<string>()
          const officesSet = new Set<string>()
          
          console.log('Processing offices data:', Object.keys(officesData))
          
          Object.values(officesData).forEach((office: any) => {
            console.log('Processing office entry:', {
              department: office.department,
              office: office.office,
              fullEntry: office
            })
            if (office.department) {
              departmentsSet.add(office.department)
            }
            if (office.office) {
              officesSet.add(office.office)
            }
          })
          
          // Update departments array with unique departments from database
          const uniqueDepartments = Array.from(departmentsSet)
          console.log('Fetched departments from database:', uniqueDepartments)
          console.log('Setting departments to:', ['All Departments', ...uniqueDepartments])
          setDepartments(['All Departments', ...uniqueDepartments])
          
          // Update offices array with unique offices from database
          const uniqueOffices = Array.from(officesSet)
          console.log('Fetched offices from database:', uniqueOffices)
          setOffices(uniqueOffices)
        } else {
          console.log('No offices data found in database')
          // Keep only 'All Departments' if no data exists
          setDepartments(['All Departments'])
        }
      } catch (error) {
        console.error('Error fetching offices data:', error)
        // Keep only 'All Departments' on error
        setDepartments(['All Departments'])
      }
    }
    
    fetchOfficesData()
  }, [])

  // Reset office selection when department changes
  useEffect(() => {
    setOffice('All Offices')
  }, [department])

  // Filter devices based on selected department and office (for Overall Consumption metrics)
  useEffect(() => {
    let filteredDevices = devices
    
    // Filter by department and office selection
    if (department !== 'All Departments') {
      if (office !== 'All Offices') {
        // Filter by specific office within the selected department
        filteredDevices = devices.filter(device => {
          // Check if device has office_info with department and office
          if (device.office_info && device.office_info.department && device.office_info.office) {
            console.log('Device filtering check (office_info):', {
              deviceOfficeRoom: device.officeRoom,
              deviceOfficeInfo: device.office_info,
              selectedOffice: office,
              selectedDepartment: department,
              officeMatch: device.office_info.office === office,
              departmentMatch: device.office_info.department === department
            })
            
            // Check if the device's office_info matches the selected department and office (case-insensitive)
            return device.office_info.department.toLowerCase() === department.toLowerCase() && 
                   device.office_info.office.toLowerCase() === office.toLowerCase()
          } else if (officesData && device.officeRoom) {
            // Fallback: Use officesData if office_info is not available
            const deviceOfficeData = Object.values(officesData).find((officeData: any) => 
              (officeData?.office || '').toLowerCase() === device.officeRoom.toLowerCase()
            )
            
            console.log('Device filtering check (fallback):', {
              deviceOfficeRoom: device.officeRoom,
              selectedOffice: office,
              selectedDepartment: department,
              deviceOfficeData: deviceOfficeData,
              officeMatch: deviceOfficeData && (deviceOfficeData as any).office === office,
              departmentMatch: deviceOfficeData && (deviceOfficeData as any).department === department
            })
            
            // Check if the office matches AND belongs to the selected department (case-insensitive)
            return deviceOfficeData && 
                   ((deviceOfficeData as any).office || '').toLowerCase() === office.toLowerCase() && 
                   ((deviceOfficeData as any).department || '').toLowerCase() === department.toLowerCase()
          }
          return false
        })
      } else {
        // Filter by department (all offices in that department)
        filteredDevices = devices.filter(device => {
          // Check if device has office_info with department
          if (device.office_info && device.office_info.department) {
            console.log('Department filtering check (office_info):', {
              deviceOfficeRoom: device.officeRoom,
              deviceOfficeInfo: device.office_info,
              selectedDepartment: department,
              departmentMatch: device.office_info.department === department
            })
            
            // Check if the device's office_info department matches the selected department (case-insensitive)
            return device.office_info.department.toLowerCase() === department.toLowerCase()
          } else if (officesData && device.officeRoom) {
            // Fallback: Use officesData if office_info is not available
            const deviceOfficeData = Object.values(officesData).find((officeData: any) => 
              (officeData?.office || '').toLowerCase() === device.officeRoom.toLowerCase()
            )
            
            console.log('Department filtering check (fallback):', {
              deviceOfficeRoom: device.officeRoom,
              selectedDepartment: department,
              deviceOfficeData: deviceOfficeData,
              officeDepartment: deviceOfficeData ? (deviceOfficeData as any).department : 'NOT_FOUND',
              matches: deviceOfficeData && (deviceOfficeData as any).department === department
            })
            
            return deviceOfficeData && ((deviceOfficeData as any).department || '').toLowerCase() === department.toLowerCase()
          }
          return false
        })
      }
    }
    
    console.log('Dashboard filtering:', {
      department,
      office,
      totalDevices: devices.length,
      filteredDevices: filteredDevices.length,
      officesData: Object.keys(officesData).length,
      allDevicesWithOfficeInfo: devices.map(device => ({
        outletId: device.outletId,
        officeRoom: device.officeRoom,
        office_info: device.office_info,
        hasOfficeInfo: !!device.office_info,
        hasDepartment: !!(device.office_info && device.office_info.department),
        hasOffice: !!(device.office_info && device.office_info.office)
      })),
      filteredDeviceDetails: filteredDevices.map(device => ({
        outletId: device.outletId,
        officeRoom: device.officeRoom,
        appliances: device.appliances,
        office_info: device.office_info
      }))
    })
    
    // Set filtered devices for Overall Consumption metrics
    const sorted = [...filteredDevices].sort((a, b) => {
      const outletNumA = (a.outletId && typeof a.outletId === 'string' && a.outletId.includes('_'))
        ? parseInt(a.outletId.split('_')[1]) || 0
        : 0
      const outletNumB = (b.outletId && typeof b.outletId === 'string' && b.outletId.includes('_'))
        ? parseInt(b.outletId.split('_')[1]) || 0
        : 0
      return outletNumA - outletNumB
    })
    setOverallConsumptionDevices(sorted)
  }, [department, office, devices, officesData])

  // Filter devices for Energy Consumption tables (department + time period)
  useEffect(() => {
    const updateEnergyConsumptionTables = async () => {
      let filteredByOffice = devices
      
      // Filter by department and office selection
      if (department !== 'All Departments') {
        if (office !== 'All Offices') {
          // Filter by specific office within the selected department
          filteredByOffice = devices.filter(device => {
            // Check if device has office_info with department and office
            if (device.office_info && device.office_info.department && device.office_info.office) {
              console.log('Energy consumption filtering check (office_info):', {
                deviceOfficeRoom: device.officeRoom,
                deviceOfficeInfo: device.office_info,
                selectedOffice: office,
                selectedDepartment: department,
                officeMatch: device.office_info.office === office,
                departmentMatch: device.office_info.department === department
              })
              
              // Check if the device's office_info matches the selected department and office (case-insensitive)
              return device.office_info.department.toLowerCase() === department.toLowerCase() && 
                     device.office_info.office.toLowerCase() === office.toLowerCase()
            } else if (officesData && device.officeRoom) {
              // Fallback: Use officesData if office_info is not available
              const deviceOfficeData = Object.values(officesData).find((officeData: any) => 
                (officeData?.office || '').toLowerCase() === device.officeRoom.toLowerCase()
              )
              
              console.log('Energy consumption filtering check (fallback):', {
                deviceOfficeRoom: device.officeRoom,
                selectedOffice: office,
                selectedDepartment: department,
                deviceOfficeData: deviceOfficeData,
                officeMatch: deviceOfficeData && (deviceOfficeData as any).office === office,
                departmentMatch: deviceOfficeData && (deviceOfficeData as any).department === department
              })
              
              // Check if the office matches AND belongs to the selected department (case-insensitive)
              return deviceOfficeData && 
                     ((deviceOfficeData as any).office || '').toLowerCase() === office.toLowerCase() && 
                     ((deviceOfficeData as any).department || '').toLowerCase() === department.toLowerCase()
            }
            return false
          })
        } else {
          // Filter by department (all offices in that department)
          filteredByOffice = devices.filter(device => {
            // Check if device has office_info with department
            if (device.office_info && device.office_info.department) {
              console.log('Energy consumption department filtering (office_info):', {
                deviceOfficeRoom: device.officeRoom,
                deviceOfficeInfo: device.office_info,
                selectedDepartment: department,
                departmentMatch: device.office_info.department === department
              })
              
              // Check if the device's office_info department matches the selected department (case-insensitive)
              return device.office_info.department.toLowerCase() === department.toLowerCase()
            } else if (officesData && device.officeRoom) {
              // Fallback: Use officesData if office_info is not available
              const deviceOfficeData = Object.values(officesData).find((officeData: any) => 
                (officeData?.office || '').toLowerCase() === device.officeRoom.toLowerCase()
              )
              
              console.log('Energy consumption department filtering (fallback):', {
                deviceOfficeRoom: device.officeRoom,
                selectedDepartment: department,
                deviceOfficeData: deviceOfficeData,
                officeDepartment: deviceOfficeData ? (deviceOfficeData as any).department : 'NOT_FOUND',
                matches: deviceOfficeData && (deviceOfficeData as any).department === department
              })
              
              return deviceOfficeData && ((deviceOfficeData as any).department || '').toLowerCase() === department.toLowerCase()
            }
            return false
          })
        }
      }
      
      // Apply time period filtering for Per Device Consumption table
      if (selectedFilter1 !== 'Day') {
        const timeFiltered = await filterDevicesByPeriod(filteredByOffice, selectedFilter1)
        const sorted = [...timeFiltered].sort((a, b) => {
          const outletNumA = (a.outletId && typeof a.outletId === 'string' && a.outletId.includes('_'))
            ? parseInt(a.outletId.split('_')[1]) || 0
            : 0
          const outletNumB = (b.outletId && typeof b.outletId === 'string' && b.outletId.includes('_'))
            ? parseInt(b.outletId.split('_')[1]) || 0
            : 0
          return outletNumA - outletNumB
        })
        setFilteredDevices(sorted)
      } else {
        // Use department-filtered devices for Day filter
        const sorted = [...filteredByOffice].sort((a, b) => {
          const outletNumA = (a.outletId && typeof a.outletId === 'string' && a.outletId.includes('_'))
            ? parseInt(a.outletId.split('_')[1]) || 0
            : 0
          const outletNumB = (b.outletId && typeof b.outletId === 'string' && b.outletId.includes('_'))
            ? parseInt(b.outletId.split('_')[1]) || 0
            : 0
          return outletNumA - outletNumB
        })
        setFilteredDevices(sorted)
      }
      
      // Apply time period filtering for Usage Rank table
      if (selectedFilter2 !== 'Day') {
        const timeFiltered = await filterDevicesByPeriod(filteredByOffice, selectedFilter2)
        const sorted = [...timeFiltered].sort((a, b) => {
          return b.total_energy - a.total_energy
        })
        setFilteredDevicesRank(sorted)
      } else {
        // Use department-filtered devices for Day filter
        const sorted = [...filteredByOffice].sort((a, b) => {
          return b.total_energy - a.total_energy
        })
        setFilteredDevicesRank(sorted)
        
        console.log('Energy consumption filtering:', {
          department,
          office,
          totalDevices: devices.length,
          filteredByOffice: filteredByOffice.length,
          filteredDevices: filteredDevices.length,
          filteredDevicesRank: sorted.length
        })
      }

      // Calculate office ranking with time period filtering
      if (selectedFilter3 !== 'Day') {
        const timeFilteredForRanking = await filterDevicesByPeriod(filteredByOffice, selectedFilter3)
        await calculateOfficeRanking(timeFilteredForRanking, selectedFilter3)
      } else {
        await calculateOfficeRanking(filteredByOffice, selectedFilter3)
      }
    }
    
    updateEnergyConsumptionTables()
  }, [department, office, devices, officesData, selectedFilter1, selectedFilter2, selectedFilter3])

  // Calculate current month energy when overall consumption devices change (respects department filter only)
  useEffect(() => {
    calculateCurrentMonthEnergy()
  }, [overallConsumptionDevices])

  // Calculate total energy when overall consumption devices change (respects department filter only)
  useEffect(() => {
    calculateTotalEnergy()
  }, [overallConsumptionDevices])

  // Calculate today's energy and daily average when overall consumption devices change (respects department filter only)
  useEffect(() => {
    calculateTodayEnergyAndAverage()
  }, [overallConsumptionDevices])


  // Recalculate stats when filtered devices change
  useEffect(() => {
    if (filteredDevices.length > 0) {
      // CURRENT USAGE: Sum of lifetime_energy (current power usage in kW from database)
      const currentUsageSum = filteredDevices.reduce((sum, device) => sum + (device.lifetime_energy || 0), 0)
      
      // DAILY AVERAGE: Now calculated separately from today's energy data
      
      // TODAY'S TOTAL ENERGY: Sum of total_energy from today's daily_logs (today's energy consumption in kW from database)
      const todayTotalEnergySum = filteredDevices.reduce((sum, device) => sum + (device.total_energy || 0), 0)
      
      setTotalPower(currentUsageSum) // Current usage from lifetime_energy (already in kW)
      setTotalEnergy(todayTotalEnergySum) // Today's total energy from total_energy (already in kW)
      // Daily average now calculated separately based on filter period
    } else {
      setTotalPower(0)
      setTotalEnergy(0)
      setDailyAverage(0)
    }
  }, [filteredDevices])

  // Calculate current and monthly bills when overall consumption devices or rate changes
  useEffect(() => {
    const calculateBills = async () => {
      if (overallConsumptionDevices.length > 0) {
        // Use overall consumption devices for bill calculations (respects department filter only)
        const currentBillValue = await calculateCurrentBill(overallConsumptionDevices)
        const monthlyBillValue = await calculateMonthlyBill(overallConsumptionDevices)
        setCurrentBill(currentBillValue)
        setMonthlyBill(monthlyBillValue)
      } else {
        setCurrentBill(0)
        setMonthlyBill(0)
      }
    }
    
    calculateBills()
  }, [overallConsumptionDevices, currentRate])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!dropdownRef.current) return
      if (!dropdownRef.current.contains(e.target as Node)) {
        setDeptOpen(false)
        setOfficeOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { 
      if (e.key === 'Escape') {
        setDeptOpen(false)
        setOfficeOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [])


  // Get status badge styling (updated for control.device field)
  const getStatusBadge = (status: string) => {
    const statusClasses: { [key: string]: string } = {
      'on': 'status-active',
      'off': 'status-inactive',
      'Active': 'status-active',
      'Inactive': 'status-inactive',
      'Idle': 'status-idle',
      'UNPLUG': 'status-unplug'
    }
    
    // Determine display text
    let displayText = status
    if (status === 'on') displayText = 'Active'
    else if (status === 'off') displayText = 'Inactive'
    
    return (
      <span className={`status-badge ${statusClasses[status] || 'status-inactive'}`}>
        <span className={`status-dot ${statusClasses[status] || 'status-inactive'}`}></span>
        {displayText}
      </span>
    )
  }

  // Format date for display
  const formatDate = (dateString: string) => {
    if (!dateString) return ''
    try {
      const date = new Date(dateString)
      if (isNaN(date.getTime())) return ''
      return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      })
    } catch (error) {
      console.error('Error formatting date:', error)
      return ''
    }
  }

  // Format date range - if same month, use "November 1-30, 2025" format
  const formatDateRange = (startDateString: string, endDateString: string) => {
    if (!startDateString || !endDateString) return ''
    try {
      const startDate = new Date(startDateString)
      const endDate = new Date(endDateString)
      
      // Check if dates are valid
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return `${formatDate(startDateString)} to ${formatDate(endDateString)}`
      }
      
      // Check if same month and year
      const startMonth = startDate.getMonth()
      const startYear = startDate.getFullYear()
      const endMonth = endDate.getMonth()
      const endYear = endDate.getFullYear()
      
      if (startMonth === endMonth && startYear === endYear) {
        // Same month: "November 1-30, 2025"
        const monthName = startDate.toLocaleDateString('en-US', { month: 'long' })
        const startDay = startDate.getDate()
        const endDay = endDate.getDate()
        return `${monthName} ${startDay}-${endDay}, ${startYear}`
      } else {
        // Different months: "November 1, 2025 to November 30, 2025"
        return `${formatDate(startDateString)} to ${formatDate(endDateString)}`
      }
    } catch (error) {
      console.error('Error formatting date range:', error)
      // Fallback to original format on error
      return `${formatDate(startDateString)} to ${formatDate(endDateString)}`
    }
  }

  // Handle date range confirmation
  const handleDateRangeConfirm = () => {
    console.log('Generating report for:', {
      department: selectedReportDepartment,
      office: selectedReportOffice,
      startDate: selectedStartDate,
      endDate: selectedEndDate,
      totalDevices: devices.length
    })
    
    // Close date range modal and open PDF preview modal
    setIsDateRangeModalOpen(false)
    setIsPdfPreviewModalOpen(true)
    
    // Generate preview data (simplified version)
    let filteredDevices = devices.filter(device => {
      if (selectedReportDepartment === 'All Departments') return true
      if (device.office_info && device.office_info.department) {
        return device.office_info.department.toLowerCase() === selectedReportDepartment.toLowerCase()
      }
      return false
    })
    
    // Additional filtering by office if specific office is selected
    if (selectedReportOffice !== 'All Offices') {
      filteredDevices = filteredDevices.filter(device => {
        if (device.office_info && device.office_info.office) {
          return device.office_info.office === selectedReportOffice
        }
        return false
      })
    }
    
    // Calculate preview data
    const deviceCount = filteredDevices.length
    console.log('Filtered devices count:', deviceCount, 'Department:', selectedReportDepartment, 'Office:', selectedReportOffice)
    // Calculate total energy from monthly consumption values (convert W to kWh)
    const totalEnergy = filteredDevices.reduce((sum, device) => {
      const monthlyConsumptionStr = device.monthUsage || '0.000 W'
      const monthlyConsumptionValue = parseFloat(monthlyConsumptionStr.replace(/[^\d.]/g, '')) || 0
      return sum + (monthlyConsumptionValue / 1000) // Convert W to kWh
    }, 0)
    
    // Generate device table data - use same calculation as Reports.tsx
    const deviceTableData = filteredDevices.map(device => {
      // Parse the monthly consumption from monthUsage (e.g., "10.190 W" -> 10.190)
      const monthlyConsumptionStr = device.monthUsage || '0.000 W'
      const monthlyConsumptionValue = parseFloat(monthlyConsumptionStr.replace(/[^\d.]/g, '')) || 0
      // Convert W to kWh for cost calculation
      const monthlyConsumptionKwh = monthlyConsumptionValue / 1000
      // Use same calculation as Reports.tsx: monthlyConsumptionKwh * currentRate
      const monthlyCost = monthlyConsumptionKwh * currentRate
      
      return {
        outletId: device.outletId,
        office: device.office_info?.office || 'Unassigned',
        department: device.office_info?.department || 'Unassigned',
        appliances: device.appliances || 'Unassigned',
        monthlyConsumption: monthlyConsumptionStr, // Use the same format as office ranking
        monthlyCost: monthlyCost, // Same calculation as Reports.tsx
        consumptionValue: monthlyConsumptionValue // For sorting
      }
    })
    
    // Sort by consumption (highest first) if report type is "Outlets"
    if (selectedReportType === 'Outlets') {
      deviceTableData.sort((a, b) => b.consumptionValue - a.consumptionValue)
    }
    
    // Calculate estimated cost using same logic as Reports.tsx
    // Sum the truncated individual costs instead of calculating from total energy
    const estimatedCost = deviceTableData.reduce((sum, device) => sum + (Math.floor(device.monthlyCost * 100) / 100), 0)
    
    setPreviewData({
      deviceCount,
      totalEnergy,
      estimatedCost,
      currentRate,
      deviceTableData
    })
  }

  // Helper function to convert image to base64 data URL for jsPDF and get dimensions
  const imageToDataUrl = (imagePath: string): Promise<{ dataUrl: string; width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0)
          const dataUrl = canvas.toDataURL('image/png')
          resolve({ dataUrl, width: img.width, height: img.height })
        } else {
          reject(new Error('Could not get canvas context'))
        }
      }
      img.onerror = reject
      img.src = imagePath
    })
  }

  // Handle PDF generation
  const handleGeneratePDF = async () => {
    if (!previewData) return

    // Load header and footer images
    const headerImageData = await imageToDataUrl(headerImage)
    const headerImageDataUrl = headerImageData.dataUrl
    const headerImageAspectRatio = headerImageData.width / headerImageData.height

    const footerImageData = await imageToDataUrl(footerImage)
    const footerImageDataUrl = footerImageData.dataUrl
    const footerImageAspectRatio = footerImageData.width / footerImageData.height

    const doc = new jsPDF()
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    let yPosition = 0

    // Footer configuration
    const footerImageMargin = 0
    const footerImageOffsetY = 2
    const footerTextMargin = 15
    const footerTextOffsetY = 16
    const footerImageWidth = Math.min(pageWidth / 3, pageWidth - footerImageMargin * 2)
    const footerImageHeight = footerImageWidth / footerImageAspectRatio
    const footerReservedSpace = footerImageHeight + 20

    // Helper function to add text with wrapping
    const addText = (text: string, x: number, y: number, options: any = {}) => {
      // Only render if coordinates are valid (not 0,0 for measurement)
      if (x === 0 && y === 0) {
        // This is a measurement call, just calculate height
        if (options.maxWidth) {
          const lines = doc.splitTextToSize(text, options.maxWidth)
          return lines.length * (options.fontSize || 12) * 0.4
        }
        return 0
      }
      
      doc.setFontSize(options.fontSize || 12)
      doc.setFont('helvetica', options.bold ? 'bold' : 'normal')
      doc.setTextColor(options.color || '#000000')
      
      if (options.maxWidth) {
        // Split text into lines that fit within maxWidth
        const lines = doc.splitTextToSize(text, options.maxWidth)
        lines.forEach((line: string, index: number) => {
          const lineY = y + (index * (options.fontSize || 12) * 0.4)
          if (options.align) {
            doc.text(line, x, lineY, { align: options.align })
          } else {
            doc.text(line, x, lineY)
          }
        })
        return lines.length * (options.fontSize || 12) * 0.4
      } else {
        if (options.align) {
          doc.text(text, x, y, { align: options.align })
        } else {
          doc.text(text, x, y)
        }
        return 0
      }
    }

    // Helper function to add rectangle with background color
    const addRect = (x: number, y: number, width: number, height: number, fillColor?: [number, number, number]) => {
      if (fillColor) {
        doc.setFillColor(fillColor[0], fillColor[1], fillColor[2])
        doc.rect(x, y, width, height, 'F')
      }
      doc.setDrawColor(0, 0, 0) // Black border
      doc.rect(x, y, width, height, 'S')
    }

    // Helper function to add line
    const addLine = (x1: number, y1: number, x2: number, y2: number) => {
      doc.setDrawColor(200, 200, 200)
      doc.line(x1, y1, x2, y2)
    }

    // Helper function to check for new page
    const checkNewPage = (requiredSpace: number) => {
      if (yPosition + requiredSpace > pageHeight - 20 - footerReservedSpace) {
        doc.addPage()
        yPosition = 0
        // Add header image to new page
        try {
          const headerMargin = 10
          const maxHeaderImageWidth = pageWidth - headerMargin * 2
          const imageWidth = maxHeaderImageWidth
          const imageHeight = imageWidth / headerImageAspectRatio
          doc.addImage(headerImageDataUrl, 'PNG', headerMargin, yPosition, imageWidth, imageHeight)
          yPosition += imageHeight + 10
        } catch (error) {
          console.error('Error adding header image to new page:', error)
        }
      }
    }

    // Header - Add header image
    try {
      const headerMargin = 10
      const maxHeaderImageWidth = pageWidth - headerMargin * 2
      const imageWidth = maxHeaderImageWidth
      const imageHeight = imageWidth / headerImageAspectRatio
      
      // Add the header image
      doc.addImage(headerImageDataUrl, 'PNG', headerMargin, yPosition, imageWidth, imageHeight)
      yPosition += imageHeight + 10
    } catch (error) {
      console.error('Error adding header image to PDF:', error)
      // Fallback to text header if image fails
      addText('Camarines Norte State College', pageWidth / 2, yPosition, { fontSize: 14, bold: true, align: 'center' })
      yPosition += 7
      addText('Daet, Camarines Norte', pageWidth / 2, yPosition, { fontSize: 14, bold: true, align: 'center' })
      yPosition += 15
    }

    // Report title
    addText('Consumption Summary Report', pageWidth / 2, yPosition, { fontSize: 16, bold: true, align: 'center' })
    yPosition += 20

    // Add a separator line
    addLine(20, yPosition, pageWidth - 20, yPosition)
    yPosition += 15

    // Report details
    const dateRangeFormatted = formatDateRange(selectedStartDate, selectedEndDate)
    addText(`Date Range: ${dateRangeFormatted}`, 20, yPosition, { fontSize: 12 })
    yPosition += 7

    if (selectedReportDepartment !== 'All Departments') {
      addText(`Department: ${selectedReportDepartment}`, 20, yPosition, { fontSize: 12 })
      yPosition += 7
    }

    addText(`Offices: ${selectedReportOffice}`, 20, yPosition, { fontSize: 12 })
    yPosition += 7
    addText(`No. of EcoPlug: ${previewData.deviceCount}`, 20, yPosition, { fontSize: 12 })
    yPosition += 7
    addText(`Electricity Rate: PHP ${currentRate.toFixed(4)} per kWh`, 20, yPosition, { fontSize: 12 })
    yPosition += 15

    // Table section
    const tableTitle = selectedReportType === 'Outlets' ? 'I. Top Outlet Consumption Ranking' : 'I. Outlet Performance Breakdown'
    addText(tableTitle, 20, yPosition, { fontSize: 14, bold: true })
    yPosition += 10

    // Table headers
    const headers = selectedReportType === 'Outlets' 
      ? ['Rank', 'Outlet', 'Appliance', 'Office', 'This Month Consumption', 'This Month Cost (PHP)']
      : ['Rank', 'Office', 'Department', 'Outlet', 'This Month Consumption', 'This Month Cost (PHP)']

    const colWidths = [16, 22, 33, 33, 38, 27]
    const rowHeight = 10
    const startX = 20

    // Draw table headers
    let xPosition = startX
    let maxHeaderHeight = rowHeight
    
    // First pass: calculate the maximum height needed
    headers.forEach((header, index) => {
      const textHeight = addText(header, 0, 0, { 
        fontSize: 10, 
        bold: true, 
        maxWidth: colWidths[index] - 4 
      })
      maxHeaderHeight = Math.max(maxHeaderHeight, textHeight + 8)
    })
    
    // Second pass: draw rectangles and text with correct height
    // Draw header row with light blue background
    const lightBlue = [173, 216, 230] as [number, number, number] // Light blue color
    
    // Draw header cells with light blue background
    xPosition = startX
    headers.forEach((header, index) => {
      addRect(xPosition, yPosition - 2, colWidths[index], maxHeaderHeight, lightBlue)
      addText(header, xPosition + 2, yPosition + 6, { 
        fontSize: 10, 
        bold: true, 
        maxWidth: colWidths[index] - 4 
      })
      xPosition += colWidths[index]
    })
    yPosition += maxHeaderHeight

    // Draw table rows
    previewData.deviceTableData.slice(0, 10).forEach((device: any, index: number) => {
      const outletNum = (device.outletId && typeof device.outletId === 'string' && device.outletId.includes('_'))
        ? device.outletId.split('_')[1]
        : device.outletId || 'Unknown'
      
      const rowData = selectedReportType === 'Outlets' 
        ? [
            (index + 1).toString(),
            outletNum,
            device.appliances || 'Unassigned',
            device.office || 'Unassigned',
            device.monthlyConsumption,
            `PHP ${(Math.floor(device.monthlyCost * 100) / 100).toFixed(2)}`
          ]
        : [
            (index + 1).toString(),
            device.office || 'Unassigned',
            device.department || 'Unassigned',
            outletNum,
            device.monthlyConsumption,
            `PHP ${(Math.floor(device.monthlyCost * 100) / 100).toFixed(2)}`
          ]

      // First pass: calculate the maximum height needed for this row
      let maxRowHeight = rowHeight
      rowData.forEach((cellData, cellIndex) => {
        const textHeight = addText(cellData, 0, 0, { 
          fontSize: 9, 
          maxWidth: colWidths[cellIndex] - 4 
        })
        maxRowHeight = Math.max(maxRowHeight, textHeight + 8)
      })
      
      checkNewPage(maxRowHeight + 5)
      
      // Second pass: draw rectangles and text with correct height
      xPosition = startX
      rowData.forEach((cellData, cellIndex) => {
        addRect(xPosition, yPosition - 2, colWidths[cellIndex], maxRowHeight)
        addText(cellData, xPosition + 2, yPosition + 6, { 
          fontSize: 9, 
          maxWidth: colWidths[cellIndex] - 4 
        })
        xPosition += colWidths[cellIndex]
      })
      yPosition += maxRowHeight
    })

    // Summary section
    yPosition += 2
    checkNewPage(20)
    
    const totalTableWidth = colWidths.reduce((sum, width) => sum + width, 0)
    const summaryText = `Estimated Cost: PHP ${previewData.estimatedCost.toFixed(2)}`
    const summaryTextHeight = addText(summaryText, 0, 0, { 
      fontSize: 10, 
      bold: true, 
      maxWidth: totalTableWidth - 4 
    })
    const summaryHeight = Math.max(rowHeight, summaryTextHeight + 8)
    
    addRect(startX, yPosition - 2, totalTableWidth, summaryHeight)
    addText(summaryText, startX + 2, yPosition + 6, { 
      fontSize: 10, 
      bold: true, 
      maxWidth: totalTableWidth - 4 
    })

    // Add footer with image and pagination across all pages
    const addFooterAndPagination = () => {
      const totalPages = (doc as any).internal.getNumberOfPages()
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        doc.setPage(pageNumber)
        const currentPageWidth = doc.internal.pageSize.getWidth()
        const currentPageHeight = doc.internal.pageSize.getHeight()
        const footerY = currentPageHeight - footerImageHeight - footerImageOffsetY
        try {
          doc.addImage(footerImageDataUrl, 'PNG', footerImageMargin, footerY, footerImageWidth, footerImageHeight)
        } catch (error) {
          console.error('Error adding footer image to page', pageNumber, error)
        }
        doc.setFontSize(10)
        doc.setFont('arial', 'normal')
        const pageText = `Page ${pageNumber} of ${totalPages}`
        doc.text(pageText, currentPageWidth - footerTextMargin, footerY + footerImageHeight - footerTextOffsetY, { align: 'right' })
      }
    }

    addFooterAndPagination()

    // Save the PDF
    const fileName = selectedReportType === 'Outlets' 
      ? `Top_Outlet_Consumption_Report_${new Date().toISOString().split('T')[0]}.pdf`
      : `${selectedReportDepartment}_Report_${new Date().toISOString().split('T')[0]}.pdf`
    
    doc.save(fileName)
    
    // Close the preview modal
    setIsPdfPreviewModalOpen(false)
  }

  return (
    <div className="dash-wrap">
      <section className="dash-hero">
        <div className="hero-left">
          <div className="hero-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="18" height="5" rx="2" fill="#dbe7ff"/>
              <rect x="3" y="10" width="10" height="10" rx="2" fill="#a9b9ff"/>
              <rect x="14" y="10" width="7" height="10" rx="2" fill="#dbe7ff"/>
            </svg>
          </div>
          <div className="hero-text">
            <h1>Energy Dashboard</h1>
            <p>Monitor and optimize your electricity consumption</p>
          </div>
        </div>
        <div className="dropdowns-container" ref={dropdownRef}>
          <div className="dropdown">
            <button className="hero-pill" type="button" onClick={() => setDeptOpen(v => !v)} aria-haspopup="listbox" aria-expanded={deptOpen} aria-controls="dept-menu">
              <span>{department}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ transform: deptOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
            {deptOpen && (
              <ul id="dept-menu" role="listbox" className="dropdown-menu">
                {departments.map((d) => (
                  <li key={d}>
                    <button role="option" aria-selected={department === d} className={`menu-item ${department === d ? 'selected' : ''}`} onClick={() => { setDepartment(d); setDeptOpen(false) }}>
                      {d}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {department !== 'All Departments' && (
            <div className="dropdown">
              <button className="hero-pill" type="button" onClick={() => setOfficeOpen(v => !v)} aria-haspopup="listbox" aria-expanded={officeOpen} aria-controls="office-menu">
                <span>{office}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ transform: officeOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
              {officeOpen && (
                <ul id="office-menu" role="listbox" className="dropdown-menu">
                  {getFilteredOffices().map((o) => (
                    <li key={o}>
                      <button role="option" aria-selected={office === o} className={`menu-item ${office === o ? 'selected' : ''}`} onClick={() => { setOffice(o); setOfficeOpen(false) }}>
                        {o}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <span className="bolt" aria-hidden="true">⚡</span>
          <h2>Overall Consumption</h2>
          <p className="panel-subtitle">
            {department === 'All Departments' 
              ? `Showing data for all departments (${overallConsumptionDevices.length} devices)`
              : office === 'All Offices'
                ? `Showing data for ${department} department (${overallConsumptionDevices.length} devices)`
                : `Showing data for ${office} office (${overallConsumptionDevices.length} devices)`
            }
          </p>
        </header>
        <div className="stats-grid">
          <article className="stat-card stat-accent">
            <div className="stat-title">CURRENT USAGE THIS MONTH</div>
            <div className="stat-value">
              {formatNumber(monthlyEnergy)}
            </div>
            <div className="stat-unit">W</div>
            <div className="stat-badge up">↑ This Month</div>
          </article>
          <article className="stat-card">
            <div className="stat-title">TODAY CONSUMPTION</div>
            <div className="stat-value">
              {formatNumber(totalEnergy * 1000)}
            </div>
            <div className="stat-unit">W</div>
          </article>
          <article className="stat-card">
            <div className="stat-title">CURRENT RATE</div>
            <div className="stat-value">₱{formatNumber(PHILIPPINE_RATE_PER_KWH, 2)}</div>
            <div className="stat-unit">per kWh</div>
          </article>
        </div>
      </section>

      <section className="cards-row">
        <div className="mini-card purple">
          <div className="mini-icon-circle purple" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 3L4 14h6l-1 7 9-11h-6l1-7z" fill="#ffffff"/>
            </svg>
          </div>
          <div className="mini-main">
            <div className="mini-title">
              {formatNumber(totalLifetimeEnergy)} W
            </div>
            <div className="mini-sub">Total Energy Usage</div>
          </div>
          <div className="mini-badge">Total energy consumption</div>
        </div>
        <div className="mini-card yellow">
          <div className="mini-icon-circle yellow" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" fill="#ffffff"/>
              <line x1="16" y1="2" x2="16" y2="6" stroke="#ffffff" strokeWidth="2"/>
              <line x1="8" y1="2" x2="8" y2="6" stroke="#ffffff" strokeWidth="2"/>
              <line x1="3" y1="10" x2="21" y2="10" stroke="#ffffff" strokeWidth="2"/>
            </svg>
          </div>
          <div className="mini-main">
            <div className="mini-title">
              {formatNumber(dailyAverage)} W
            </div>
            <div className="mini-sub">Daily Average</div>
          </div>
          <div className="mini-badge">Total energy consumed</div>
        </div>
        <div className="mini-card green">
          <div className="mini-icon-circle green" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 7h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="#ffffff"/>
              <path d="M7 11h10M9 14h6" stroke="#16a34a" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="mini-main">
            <div className="mini-title">₱{formatNumber(monthlyBill, 2)}</div>
            <div className="mini-sub">Estimated Monthly Bill</div>
          </div>
          <div className="mini-badge">Based on current consumption</div>
        </div>
      </section>

      <section className="energy-analytics-container">
        <div className="analytics-header">
          <div className="analytics-title">
            <h2>Energy Consumption</h2>
            <p>Track your energy usage over time</p>
          </div>
          <div className="filter-container">
            <button className="office-reports-btn" type="button" onClick={() => setIsReportTypeModalOpen(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span>Consumption Reports</span>
            </button>
          </div>
        </div>
        
        <div className="tables-section">
          <div className="table-panel">
            <div className="table-header">
              <div className="table-subtitle">
                <h4>Per Device Consumption</h4>
              </div>
              <div className="filter-container">
                <button className="filter-dropdown-btn" type="button" onClick={() => setFilterOpen(v => !v)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                                        <span>
                       {selectedFilter1 === 'Day' ? getCurrentTimeLabel().day :
                        selectedFilter1 === 'Week' ? getCurrentTimeLabel().week :
                        selectedFilter1 === 'Month' ? getCurrentTimeLabel().month :
                        selectedFilter1 === 'Year' ? getCurrentTimeLabel().year : 'Day'
                       }
                    </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: filterOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
                                    {filterOpen && (
                      <div className="filter-dropdown-menu">
                        <button 
                          className={`filter-option ${selectedFilter1 === 'Day' ? 'active' : ''}`} 
                          type="button"
                          onClick={() => {
                            setSelectedFilter1('Day')
                            setFilterOpen(false)
                          }}
                        >
                          Day
                        </button>
                      <button 
                        className={`filter-option ${selectedFilter1 === 'Week' ? 'active' : ''}`} 
                        type="button"
                        onClick={() => {
                          setSelectedFilter1('Week')
                          setFilterOpen(false)
                        }}
                      >
                        Week
                      </button>
                      <button 
                        className={`filter-option ${selectedFilter1 === 'Month' ? 'active' : ''}`} 
                        type="button"
                        onClick={() => {
                          setSelectedFilter1('Month')
                          setFilterOpen(false)
                        }}
                      >
                        Month
                      </button>
                      <button 
                        className={`filter-option ${selectedFilter1 === 'Year' ? 'active' : ''}`} 
                        type="button"
                        onClick={() => {
                          setSelectedFilter1('Year')
                          setFilterOpen(false)
                        }}
                      >
                        Year
                      </button>
                    </div>
                  )}
              </div>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Outlet Number</th>
                    <th>Appliances</th>
                    <th>Today Consumption</th>
                    <th>Month Consumption</th>
                    <th>Office/ Room</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.length > 0 ? (
                    filteredDevices.map((device, index) => (
                      <tr key={device.outletId}>
                        <td>{(index + 1).toString().padStart(3, '0')}</td>
                        <td>{(device.outletId && typeof device.outletId === 'string' && device.outletId.includes('_'))
                          ? device.outletId.split('_')[1]
                          : device.outletId || 'Unknown'}</td>
                        <td>{device.appliances}</td>
                        <td>{formatNumber(device.total_energy * 1000)} W</td>
                        <td>{device.monthUsage || '0.000 W'}</td>
                        <td>{device.officeRoom}</td>
                        <td>
                          {getStatusBadge(device.status)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="no-data-message">
                         {`No data available for ${selectedFilter1.toLowerCase()} period`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="table-panel">
            <div className="table-header">
              <div className="table-title">
                <h3>Usage Rank</h3>
              </div>
              <div className="filter-container">
                <button className="filter-dropdown-btn" type="button" onClick={() => setFilterOpen2(v => !v)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                                        <span>
                       {selectedFilter2 === 'Day' ? getCurrentTimeLabel().day :
                        selectedFilter2 === 'Week' ? getCurrentTimeLabel().week :
                        selectedFilter2 === 'Month' ? getCurrentTimeLabel().month :
                        selectedFilter2 === 'Year' ? getCurrentTimeLabel().year : 'Day'
                       }
                    </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: filterOpen2 ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
                                    {filterOpen2 && (
                      <div className="filter-dropdown-menu">
                        <button 
                          className={`filter-option ${selectedFilter2 === 'Day' ? 'active' : ''}`} 
                          type="button"
                          onClick={() => {
                            setSelectedFilter2('Day')
                            setFilterOpen2(false)
                          }}
                        >
                          Day
                        </button>
                      <button 
                        className={`filter-option ${selectedFilter2 === 'Week' ? 'active' : ''}`} 
                        type="button"
                        onClick={() => {
                          setSelectedFilter2('Week')
                          setFilterOpen2(false)
                        }}
                      >
                        Week
                      </button>
                      <button 
                        className={`filter-option ${selectedFilter2 === 'Month' ? 'active' : ''}`} 
                        type="button"
                        onClick={() => {
                          setSelectedFilter2('Month')
                          setFilterOpen2(false)
                        }}
                      >
                        Month
                      </button>
                      <button 
                        className={`filter-option ${selectedFilter2 === 'Year' ? 'active' : ''}`} 
                        type="button"
                        onClick={() => {
                          setSelectedFilter2('Year')
                          setFilterOpen2(false)
                        }}
                      >
                        Year
                      </button>
                    </div>
                  )}
              </div>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Outlet number</th>
                    <th>Appliances</th>
                    <th>Today Consumption</th>
                    <th>Month Consumption</th>
                    <th>Office/ Room</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevicesRank.length > 0 ? (
                    filteredDevicesRank
                      .sort((a, b) => b.total_energy - a.total_energy) // Sort by total_energy (highest first)
                      .map((device, index) => (
                      <tr key={device.outletId}>
                        <td>{index + 1}</td>
                        <td>{device.outletId.split('_')[1]}</td>
                        <td>{device.appliances}</td>
                        <td>{formatNumber(device.total_energy * 1000)} W</td>
                        <td>{device.monthUsage || '0.000 W'}</td>
                        <td>{device.officeRoom}</td>
                        <td>
                          {getStatusBadge(device.status)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="no-data-message">
                         {`No data available for ${selectedFilter2.toLowerCase()} period`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="table-panel">
          <div className="table-header">
            <div className="table-title">
              <h3>Office Ranking</h3>
            </div>
            <div className="filter-container">
              <button className="filter-dropdown-btn" type="button" onClick={() => setFilterOpen3(v => !v)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>
                  {selectedFilter3 === 'Day' ? getCurrentTimeLabel().day :
                   selectedFilter3 === 'Week' ? getCurrentTimeLabel().week :
                   selectedFilter3 === 'Month' ? getCurrentTimeLabel().month :
                   selectedFilter3 === 'Year' ? getCurrentTimeLabel().year : 'Day'
                  }
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: filterOpen3 ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
              {filterOpen3 && (
                <div className="filter-dropdown-menu">
                  <button 
                    className={`filter-option ${selectedFilter3 === 'Day' ? 'active' : ''}`} 
                    type="button"
                    onClick={() => {
                      setSelectedFilter3('Day')
                      setFilterOpen3(false)
                    }}
                  >
                    Day
                  </button>
                  <button 
                    className={`filter-option ${selectedFilter3 === 'Week' ? 'active' : ''}`} 
                    type="button"
                    onClick={() => {
                      setSelectedFilter3('Week')
                      setFilterOpen3(false)
                    }}
                  >
                    Week
                  </button>
                  <button 
                    className={`filter-option ${selectedFilter3 === 'Month' ? 'active' : ''}`} 
                    type="button"
                    onClick={() => {
                      setSelectedFilter3('Month')
                      setFilterOpen3(false)
                    }}
                  >
                    Month
                  </button>
                  <button 
                    className={`filter-option ${selectedFilter3 === 'Year' ? 'active' : ''}`} 
                    type="button"
                    onClick={() => {
                      setSelectedFilter3('Year')
                      setFilterOpen3(false)
                    }}
                  >
                    Year
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Office</th>
                  <th>Department</th>
                  <th>Outlet</th>
                  <th>Today Consumption</th>
                  <th>Month Consumption</th>
                </tr>
              </thead>
              <tbody>
                {officeRankingData.length > 0 ? (
                  officeRankingData.map((item) => (
                    <tr key={`${item.department}-${item.office}`}>
                      <td>{item.rank}</td>
                      <td>{item.office}</td>
                      <td>{item.department}</td>
                      <td>{item.outlets}</td>
                      <td>{formatNumber(item.consumption)} W</td>
                      <td>{formatNumber(item.monthConsumption)} W</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="no-data-message">
                      {`No data available for ${selectedFilter3.toLowerCase()} period`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="consumption-report-container">
        <div className="report-header">
          <h2>Consumption Report</h2>
        </div>
        
        <div className="report-content">
          <div className="chart-panel">
            <div className="chart-header">
              <h3>{timeSegment} Consumption</h3>
              <div className="chart-controls">
                <div className="time-segments">
                  <button className={`segment-btn ${timeSegment === 'Week' ? 'active' : ''}`} onClick={() => setTimeSegment('Week')}>
                    Week
                  </button>
                  <button className={`segment-btn ${timeSegment === 'Month' ? 'active' : ''}`} onClick={() => setTimeSegment('Month')}>
                    Month
                  </button>
                  <button className={`segment-btn ${timeSegment === 'Year' ? 'active' : ''}`} onClick={() => setTimeSegment('Year')}>
                    Year
                  </button>
                </div>
              </div>
            </div>
            <div className="chart-area" onClick={() => setIsModalOpen(true)} style={{ cursor: 'pointer' }}>
              {chartData.energyUsage.length > 0 && chartData.labels.length > 0 ? (
                shouldShowBarChart ? (
                  // Bar chart for single device - larger, more prominent display
                  <Bar 
                    data={{
                      labels: chartData.labels,
                      datasets: [
                        {
                          label: 'Energy Usage (W)',
                          data: chartData.energyUsage.map(dayData => (dayData[0] || 0) * 1000),
                          backgroundColor: '#2563eb',
                          borderColor: '#2563eb',
                          borderWidth: 2,
                          borderRadius: 0,
                          borderSkipped: false,
                        }
                      ]
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      layout: {
                        padding: {
                          top: 0,
                          bottom: 0,
                          left: 5,
                          right: 5
                        }
                      },
                      plugins: {
                        legend: {
                          display: false
                        },
                        tooltip: {
                          backgroundColor: 'rgba(0, 0, 0, 0.8)',
                          titleColor: '#ffffff',
                          bodyColor: '#ffffff',
                          borderColor: '#eab308',
                          borderWidth: 1,
                          cornerRadius: 8,
                          displayColors: true,
                          callbacks: {
                            label: function(context) {
                              const value = context.parsed.y
                                // Data is already in watts
                                return `Energy Usage: ${formatNumber(value)} W`
                            }
                          }
                        }
                      },
                      scales: {
                        y: {
                          beginAtZero: true,
                          grid: {
                            color: '#f3f4f6'
                          },
                          ticks: {
                            color: '#6b7280',
                            font: {
                              size: 12
                            },
                            padding: 2,
                            maxTicksLimit: 6
                          },
                          border: {
                            display: false
                          },
                          title: {
                            display: true,
                            text: 'Energy (W)',
                            color: '#374151',
                            font: {
                              size: 14,
                              weight: 'bold'
                            },
                            padding: {
                              top: 2,
                              bottom: 2
                            }
                          }
                        },
                        x: {
                          grid: {
                            display: false
                          },
                          ticks: {
                            color: '#6b7280',
                            font: {
                              size: 14,
                              weight: 'bold'
                            },
                            padding: 5
                          },
                          border: {
                            display: false
                          },
                          title: {
                            display: true,
                            text: 'Date',
                            color: '#374151',
                            font: {
                              size: 14,
                              weight: 'bold'
                            },
                            padding: {
                              top: 2,
                              bottom: 2
                            }
                          }
                        }
                      }
                    }}
                  />
                ) : (
                  // Bar chart for multiple devices - show time-based data with outlet bars
                  <Bar 
                    data={{
                      labels: chartData.labels,
                      datasets: filteredDevices.map((device, deviceIndex) => {
                        // Professional color palette
                        const professionalColors = [
                          '#2563eb', // Professional blue
                          '#059669', // Professional green
                          '#dc2626', // Professional red
                          '#7c3aed', // Professional purple
                          '#ea580c', // Professional orange
                          '#0891b2', // Professional cyan
                          '#be123c', // Professional rose
                          '#65a30d', // Professional lime
                        ]
                        const color = professionalColors[deviceIndex % professionalColors.length]
                        
                        return {
                          label: `Outlet ${device.outletId.split('_')[1]} - Energy (W)`,
                          data: chartData.energyUsage.map(dayData => (dayData[deviceIndex] || 0) * 1000),
                          backgroundColor: color,
                          borderColor: color,
                          borderWidth: 2,
                          borderRadius: 0,
                          borderSkipped: false,
                        }
                      })
                    }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    layout: {
                      padding: {
                        top: 0,
                        bottom: 0,
                        left: 2,
                        right: 2
                      }
                    },
                    plugins: {
                      legend: {
                        display: true,
                        position: 'top',
                        labels: {
                          usePointStyle: true,
                          padding: 5,
                          font: {
                            size: 10
                          }
                        }
                      },
                      tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#ffffff',
                        bodyColor: '#ffffff',
                        borderColor: '#eab308',
                        borderWidth: 1,
                        cornerRadius: 8,
                        displayColors: true,
                      callbacks: {
                        label: function(context) {
                          const value = context.parsed.y
                          const label = context.dataset.label || ''
                          return `${label}: ${formatNumber(value)} W`
                        }
                      }
                      }
                    },
                    scales: {
                      y: {
                        beginAtZero: true,
                        grid: {
                          color: '#f3f4f6'
                      },
                        ticks: {
                          color: '#6b7280',
                          font: {
                            size: 10
                          },
                          padding: 2,
                          maxTicksLimit: 5
                        },
                        border: {
                          display: false
                        },
                        title: {
                          display: true,
                          text: 'Energy (W)',
                          color: '#374151',
                          font: {
                            size: 12,
                            weight: 'bold'
                          },
                          padding: {
                            top: 10,
                            bottom: 10
                          }
                        }
                      },
                      x: {
                        grid: {
                          color: '#f3f4f6'
                        },
                        ticks: {
                          color: '#6b7280',
                          font: {
                            size: 10
                          },
                          padding: 2
                        },
                        border: {
                          display: false
                        },
                        title: {
                          display: true,
                          text: 'Date',
                          color: '#374151',
                          font: {
                            size: 12,
                            weight: 'bold'
                          },
                          padding: {
                            top: 10,
                            bottom: 10
                          }
                        }
                      }
                    }
                  }}
                />
              )
            ) : (
                // No data available message with checkmark icon
              <div className="chart-no-data">
                <div className="chart-no-data-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 12l2 2 4-4" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                  <div className="chart-no-data-text">
                    <h3>No Data Available</h3>
                    <p>No energy consumption data found for the selected time period.</p>
                  </div>
              </div>
            )}
            </div>
          </div>

          {/* Real-Time Power Consumption Chart */}
          <div className="chart-panel">
            <div className="chart-header">
              <h3>Real-Time Power Consumption of EcoPlug Devices</h3>
            </div>
            <div className="chart-area">
              {realtimePowerLoading ? (
                <div className="chart-loading">
                  <div className="chart-loading-spinner"></div>
                  <p>Loading real-time power data...</p>
                </div>
              ) : realtimePowerError ? (
                <div className="chart-error">
                  <div className="chart-error-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <div className="chart-error-text">
                    <h3>Error Loading Data</h3>
                    <p>{realtimePowerError}</p>
                  </div>
                </div>
              ) : realtimePowerData && Array.isArray(realtimePowerData.labels) && Array.isArray(realtimePowerData.powerValues) && realtimePowerData.labels.length > 0 && realtimePowerData.powerValues.length > 0 ? (
                (() => {
                  try {
                    // Safety: ensure data is valid before rendering chart
                    const safeLabels = realtimePowerData.labels.filter((label: any) => label != null && String(label).length > 0)
                    const safeValues = realtimePowerData.powerValues
                      .map((val: any) => {
                        const num = typeof val === 'number' && isFinite(val) ? val : 0
                        return Math.max(0, num) // Ensure non-negative
                      })
                      .filter((val: number) => val >= 0) // Filter out invalid values
                    
                    // Ensure arrays have same length
                    const minLength = Math.min(safeLabels.length, safeValues.length)
                    const finalLabels = safeLabels.slice(0, minLength)
                    const finalValues = safeValues.slice(0, minLength)
                    
                    if (finalLabels.length === 0 || finalValues.length === 0) {
                      return (
                        <div className="chart-no-data">
                          <div className="chart-no-data-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M9 12l2 2 4-4" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                          </div>
                          <div className="chart-no-data-text">
                            <h3>No Data Available</h3>
                            <p>No valid data available for display.</p>
                          </div>
                        </div>
                      )
                    }
                    
                    return (
                      <Bar 
                        data={{
                          labels: finalLabels,
                          datasets: [
                            {
                              label: 'Total Energy Consumption (W)',
                              data: finalValues,
                              backgroundColor: '#fb923c',
                              borderColor: '#fb923c',
                              borderWidth: 2,
                              borderRadius: 4,
                              borderSkipped: false,
                            }
                          ]
                        }}
                        options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                      duration: 750
                    },
                    layout: {
                      padding: {
                        top: 10,
                        bottom: 10,
                        left: 10,
                        right: 10
                      }
                    },
                    plugins: {
                      legend: {
                        display: false
                      },
                      tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#ffffff',
                        bodyColor: '#ffffff',
                        borderColor: '#fb923c',
                        borderWidth: 1,
                        cornerRadius: 8,
                        displayColors: true,
                        callbacks: {
                          label: function(context) {
                            const value = context.parsed.y || 0
                            return `Total Energy: ${formatNumber(value, 3)} W`
                          }
                        }
                      }
                    },
                    scales: {
                      y: {
                        beginAtZero: true,
                        min: 0,
                        grid: {
                          color: '#f3f4f6'
                        },
                        ticks: {
                          color: '#6b7280',
                          font: {
                            size: 12
                          },
                          padding: 5,
                          maxTicksLimit: 8,
                          callback: function(value) {
                            return formatNumber(Number(value), 2) + ' W'
                          }
                        },
                        border: {
                          display: false
                        },
                        title: {
                          display: true,
                          text: 'Total Energy Consumption (W)',
                          color: '#374151',
                          font: {
                            size: 14,
                            weight: 'bold'
                          },
                          padding: {
                            top: 5,
                            bottom: 5
                          }
                        }
                      },
                      x: {
                        grid: {
                          display: false
                        },
                        ticks: {
                          color: '#6b7280',
                          font: {
                            size: 12,
                            weight: 'bold'
                          },
                          padding: 8
                        },
                        border: {
                          display: false
                        },
                        title: {
                          display: true,
                          text: 'EcoPlug Devices',
                          color: '#374151',
                          font: {
                            size: 14,
                            weight: 'bold'
                          },
                          padding: {
                            top: 5,
                            bottom: 5
                          }
                        }
                      }
                    }
                  }}
                />
                    )
                  } catch (renderError) {
                    // If chart rendering fails, show error message instead
                    console.error('❌ Error rendering chart:', renderError)
                    return (
                      <div className="chart-error">
                        <div className="chart-error-icon">
                          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"/>
                          </svg>
                        </div>
                        <div className="chart-error-text">
                          <h3>Error Rendering Chart</h3>
                          <p>Unable to display chart data. Please try refreshing the page.</p>
                        </div>
                      </div>
                    )
                  }
                })()
              ) : (
                <div className="chart-no-data">
                  <div className="chart-no-data-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 12l2 2 4-4" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <div className="chart-no-data-text">
                    <h3>No Data Available</h3>
                    <p>No real-time power consumption data available for EcoPlug devices.</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="dashboard-device-usage-panel">
            <div className="dashboard-device-header">
              <h3>Usage<br />per device</h3>
              <button 
                className="dashboard-see-all-btn"
                onClick={() => onNavigate?.('reports')}
              >
                See All
              </button>
            </div>
            <div className="dashboard-device-list">
              {deviceUsage.map((device, index) => (
                <div key={index} className="dashboard-device-item">
                  <div className="dashboard-device-info">
                    <span className="dashboard-device-name">{device.name}</span>
                    <span className="dashboard-device-usage">{device.usageDisplay} ({formatNumber(device.percentage, 1)}%)</span>
                  </div>
                  <div className="dashboard-progress-bar">
                    <div className="dashboard-progress-fill" style={{ width: `${device.percentage}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Chart Modal */}
      {isModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="chart-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>{timeSegment} Consumption - Full View</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsModalOpen(false)}
                aria-label="Close modal"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="chart-modal-body">
              {chartData.energyUsage.length > 0 && chartData.labels.length > 0 ? (
                shouldShowBarChart ? (
                  // Bar chart for single device - larger, more prominent display
                  <Bar 
                    data={{
                      labels: chartData.labels,
                      datasets: [
                        {
                          label: 'Energy Usage (W)',
                          data: chartData.energyUsage.map(dayData => (dayData[0] || 0) * 1000),
                          backgroundColor: '#2563eb',
                          borderColor: '#2563eb',
                          borderWidth: 2,
                          borderRadius: 0,
                          borderSkipped: false,
                        }
                      ]
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: true,
                      aspectRatio: 2,
                      layout: {
                        padding: {
                          top: 30,
                          bottom: 30,
                          left: 20,
                          right: 20
                        }
                      },
                      plugins: {
                        legend: {
                          display: false
                        },
                        tooltip: {
                          backgroundColor: 'rgba(0, 0, 0, 0.8)',
                          titleColor: '#ffffff',
                          bodyColor: '#ffffff',
                          borderColor: '#eab308',
                          borderWidth: 1,
                          cornerRadius: 8,
                          displayColors: true,
                          callbacks: {
                            label: function(context) {
                              const value = context.parsed.y
                              return `Energy Usage: ${formatNumber(value)} W`
                            }
                          }
                        }
                      },
                      scales: {
                        y: {
                          beginAtZero: true,
                          grid: {
                            color: '#f3f4f6'
                          },
                          ticks: {
                            color: '#6b7280',
                            font: {
                              size: 14
                            },
                            padding: 8,
                            maxTicksLimit: 8
                          },
                          border: {
                            display: false
                          },
                          title: {
                            display: true,
                            text: 'Energy (W)',
                            color: '#374151',
                            font: {
                              size: 16,
                              weight: 'bold'
                            },
                            padding: {
                              top: 2,
                              bottom: 2
                            }
                          }
                        },
                        x: {
                          grid: {
                            display: false
                          },
                          ticks: {
                            color: '#6b7280',
                            font: {
                              size: 16,
                              weight: 'bold'
                            },
                            padding: 10
                          },
                          border: {
                            display: false
                          },
                          title: {
                            display: true,
                            text: 'Date',
                            color: '#374151',
                            font: {
                              size: 16,
                              weight: 'bold'
                            },
                            padding: {
                              top: 2,
                              bottom: 2
                            }
                          }
                        }
                      }
                    }}
                  />
                ) : (
                  // Bar chart for multiple devices - show time-based data with outlet bars
                  <Bar 
                    data={{
                      labels: chartData.labels,
                      datasets: filteredDevices.map((device, deviceIndex) => {
                        // Professional color palette
                        const professionalColors = [
                          '#2563eb', // Professional blue
                          '#059669', // Professional green
                          '#dc2626', // Professional red
                          '#7c3aed', // Professional purple
                          '#ea580c', // Professional orange
                          '#0891b2', // Professional cyan
                          '#be123c', // Professional rose
                          '#65a30d', // Professional lime
                        ]
                        const color = professionalColors[deviceIndex % professionalColors.length]
                        
                        return {
                          label: `Outlet ${device.outletId.split('_')[1]} - Energy (W)`,
                          data: chartData.energyUsage.map(dayData => (dayData[deviceIndex] || 0) * 1000),
                          backgroundColor: color,
                          borderColor: color,
                          borderWidth: 2,
                          borderRadius: 0,
                          borderSkipped: false,
                        }
                      })
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: true,
                      aspectRatio: 2,
                      layout: {
                        padding: {
                          top: 20,
                          bottom: 20,
                          left: 10,
                          right: 10
                        }
                      },
                      plugins: {
                        legend: {
                          display: true,
                          position: 'top',
                          labels: {
                            usePointStyle: true,
                            padding: 20,
                            font: {
                              size: 12
                            }
                          }
                        },
                        tooltip: {
                          backgroundColor: 'rgba(0, 0, 0, 0.8)',
                          titleColor: '#ffffff',
                          bodyColor: '#ffffff',
                          borderColor: '#eab308',
                          borderWidth: 1,
                          cornerRadius: 8,
                          displayColors: true,
                      callbacks: {
                        label: function(context) {
                          const value = context.parsed.y
                          const label = context.dataset.label || ''
                          return `${label}: ${formatNumber(value)} W`
                        }
                      }
                      }
                    },
                    scales: {
                      y: {
                        beginAtZero: true,
                        grid: {
                          color: '#f3f4f6'
                      },
                        ticks: {
                          color: '#6b7280',
                          font: {
                            size: 12
                          },
                          padding: 5,
                          maxTicksLimit: 6
                        },
                        border: {
                          display: false
                        },
                        title: {
                          display: true,
                          text: 'Energy (W)',
                          color: '#374151',
                          font: {
                            size: 14,
                            weight: 'bold'
                          },
                          padding: {
                            top: 10,
                            bottom: 10
                          }
                        }
                      },
                      x: {
                        grid: {
                          color: '#f3f4f6'
                        },
                        ticks: {
                          color: '#6b7280',
                          font: {
                            size: 12
                          },
                          padding: 5
                        },
                        border: {
                          display: false
                        },
                        title: {
                          display: true,
                          text: 'Date',
                          color: '#374151',
                          font: {
                            size: 14,
                            weight: 'bold'
                          },
                          padding: {
                            top: 10,
                            bottom: 10
                          }
                        }
                      }
                    }
                  }}
                />
              )
            ) : (
                // No data available message with checkmark icon
              <div className="chart-no-data">
                <div className="chart-no-data-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 12l2 2 4-4" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                  <div className="chart-no-data-text">
                    <h3>No Data Available</h3>
                    <p>No energy consumption data found for the selected time period.</p>
                  </div>
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Report Type Selection Modal */}
      {isReportTypeModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsReportTypeModalOpen(false)}>
          <div className="chart-modal-content report-type-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>Select Report Type</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsReportTypeModalOpen(false)}
                aria-label="Close modal"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
    </div>
            <div className="chart-modal-body">
              <div className="report-type-container">
                <button 
                  className="report-type-option"
                  onClick={() => {
                    setSelectedReportType('Departments')
                    setIsReportTypeModalOpen(false)
                    setIsOfficeReportsModalOpen(true)
                  }}
                >
                  <div className="report-type-content">
                    <h4>Departments</h4>
                    <p>Generate report by department (CCMS, CBPA, etc.)</p>
                  </div>
                </button>
                
                <button 
                  className="report-type-option"
                  onClick={() => {
                    setSelectedReportType('Outlets')
                    setSelectedReportDepartment('All Departments') // Set default for outlets
                    setSelectedReportOffice('All Offices') // Set default for outlets
                    setIsReportTypeModalOpen(false)
                    setIsDateRangeModalOpen(true) // Go directly to date range modal
                  }}
                >
                  <div className="report-type-content">
                    <h4>Outlets</h4>
                    <p>Generate report by individual outlets</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Office Reports Modal */}
      {isOfficeReportsModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsOfficeReportsModalOpen(false)}>
          <div className="chart-modal-content office-selection-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>Select Department for Office Report</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsOfficeReportsModalOpen(false)}
                aria-label="Close modal"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="chart-modal-body">
              <div className="office-selection-grid">
                <button 
                  className="office-option"
                  onClick={() => {
                    setSelectedReportDepartment('All Departments')
                    setSelectedReportOffice('All Offices')
                    setIsOfficeReportsModalOpen(false)
                    setIsDateRangeModalOpen(true)
                  }}
                >
                  <div className="office-option-content">
                    <h4>All Departments</h4>
                    <p>Generate report for all devices across all departments</p>
                    <div className="office-stats">
                      <span>{devices.length} devices</span>
                    </div>
                  </div>
                </button>
                
                {departments.filter(dept => dept !== 'All Departments').map((department) => {
                  const departmentDevices = devices.filter(device => {
                    if (device.office_info && device.office_info.department) {
                      return device.office_info.department.toLowerCase() === department.toLowerCase()
                    }
                    return false
                  })
                  return (
                    <button 
                      key={department}
                      className="office-option"
                      onClick={() => {
                        setSelectedReportDepartment(department)
                        setSelectedReportOffice('All Offices')
                        setIsOfficeReportsModalOpen(false)
                        setIsDateRangeModalOpen(true)
                      }}
                    >
                      <div className="office-option-content">
                        <h4>{department}</h4>
                        <p>Generate report for devices in this department</p>
                        <div className="office-stats">
                          <span>{departmentDevices.length} devices</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Date Range Selection Modal */}
      {isDateRangeModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsDateRangeModalOpen(false)}>
          <div className="chart-modal-content date-range-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>Select Date Range for {selectedReportDepartment}</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsDateRangeModalOpen(false)}
                aria-label="Close modal"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="chart-modal-body">
              <div className="date-range-container">
                <div className="date-input-group">
                  <label htmlFor="start-date">Start Date:</label>
                  <input
                    id="start-date"
                    type="date"
                    value={selectedStartDate}
                    onChange={(e) => setSelectedStartDate(e.target.value)}
                    className="date-input"
                  />
                </div>
                <div className="date-input-group">
                  <label htmlFor="end-date">End Date:</label>
                  <input
                    id="end-date"
                    type="date"
                    value={selectedEndDate}
                    onChange={(e) => setSelectedEndDate(e.target.value)}
                    className="date-input"
                    min={selectedStartDate}
                  />
                </div>
                <div className="date-range-actions">
                  <button 
                    className="btn-secondary"
                    onClick={() => setIsDateRangeModalOpen(false)}
                  >
                    Cancel
                  </button>
                  <button 
                    className="btn-primary"
                    onClick={() => handleDateRangeConfirm()}
                    disabled={!selectedStartDate || !selectedEndDate}
                  >
                    Preview Report
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PDF Preview Modal */}
      {isPdfPreviewModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsPdfPreviewModalOpen(false)}>
          <div className="chart-modal-content dashboard-pdf-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>PDF Report Preview - {selectedReportType === 'Outlets' ? 'Top Outlets' : selectedReportDepartment}</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsPdfPreviewModalOpen(false)}
                aria-label="Close modal"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="chart-modal-body">
              <div className="dashboard-pdf-preview-container">
                <div className="dashboard-pdf-preview-content">
                  {/* PDF Header */}
                  <div className="dashboard-pdf-preview-header">
                    {/* Header Image */}
                    <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                      <img 
                        src={headerImage} 
                        alt="CNSC Header" 
                        style={{ 
                          maxWidth: '100%', 
                          height: 'auto',
                          display: 'block',
                          margin: '0 auto'
                        }} 
                      />
                    </div>
                    <h2 style={{ textAlign: 'center', marginTop: '16px' }}>Consumption Summary Report</h2>
                    <div className="dashboard-pdf-preview-separator"></div>
                    
                    <div className="dashboard-pdf-preview-details" style={{ fontSize: '12px', lineHeight: '1.8' }}>
                      <p><strong>Date Range:</strong> {formatDateRange(selectedStartDate, selectedEndDate)}</p>
                      {selectedReportDepartment !== 'All Departments' && (
                        <p><strong>Department:</strong> {selectedReportDepartment}</p>
                      )}
                      <p><strong>Offices:</strong> {selectedReportOffice}</p>
                      <p><strong>No. of EcoPlug:</strong> {previewData?.deviceCount || 0}</p>
                      <p><strong>Electricity Rate:</strong> PHP {currentRate.toFixed(4)} per kWh</p>
                    </div>
                  </div>

                  {previewData?.deviceTableData?.length === 0 && (
                    <div className="dashboard-no-data-message">
                      <p>⚠️ No data found for the selected date range. Please check:</p>
                      <ul>
                        <li>Date range is correct</li>
                        <li>Devices have data for this period</li>
                        <li>Database connection is working</li>
                      </ul>
                    </div>
                  )}

                  {/* I. Outlet Performance Breakdown */}
                  <div className="dashboard-pdf-preview-table">
                    <h3>{selectedReportType === 'Outlets' ? 'I. Top Outlet Consumption Ranking' : 'I. Outlet Performance Breakdown'}</h3>
                    <div className="dashboard-table-preview">
                      <div className="dashboard-table-header">
                        <div className="dashboard-table-cell">Rank</div>
                        <div className="dashboard-table-cell">{selectedReportType === 'Outlets' ? 'Outlet' : 'Office'}</div>
                        <div className="dashboard-table-cell">{selectedReportType === 'Outlets' ? 'Appliance' : 'Department'}</div>
                        <div className="dashboard-table-cell">{selectedReportType === 'Outlets' ? 'Office' : 'Outlet'}</div>
                        <div className="dashboard-table-cell">This Month Consumption</div>
                        <div className="dashboard-table-cell">This Month Cost (PHP)</div>
                      </div>
                      {previewData?.deviceTableData?.slice(0, 5).map((device: any, index: number) => {
                        return (
                          <div key={index} className="dashboard-table-row">
                            <div className="dashboard-table-cell">{index + 1}</div>
                            <div className="dashboard-table-cell">
                              {selectedReportType === 'Outlets' 
                                ? device.outletId.split('_')[1] || device.outletId
                                : device.office || 'Unassigned'
                              }
                            </div>
                            <div className="dashboard-table-cell">
                              {selectedReportType === 'Outlets' 
                                ? device.appliances || 'Unassigned'
                                : device.department || 'Unassigned'
                              }
                            </div>
                            <div className="dashboard-table-cell">
                              {selectedReportType === 'Outlets' 
                                ? device.office || 'Unassigned'
                                : device.outletId.split('_')[1] || device.outletId
                              }
                            </div>
                            <div className="dashboard-table-cell">{device.monthlyConsumption}</div>
                            <div className="dashboard-table-cell">PHP {(Math.floor(device.monthlyCost * 100) / 100).toFixed(2)}</div>
                          </div>
                        )
                      })}
                      {previewData?.deviceTableData?.length > 5 && (
                        <div className="dashboard-table-row dashboard-more-devices">
                          <div className="dashboard-table-cell" style={{ gridColumn: '1 / -1' }}>
                            ... and {previewData.deviceTableData.length - 5} more devices
                          </div>
                        </div>
                      )}
                      {/* Summary rows */}
                      {previewData?.deviceTableData?.length > 0 && (
                        <>
                          <div className="dashboard-table-row" style={{ fontWeight: 'bold', background: '#f8fafc' }}>
                            <div className="dashboard-table-cell" style={{ gridColumn: '1 / -1' }}>
                              Estimated Cost: PHP {previewData.estimatedCost.toFixed(2)}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                </div>

                <div className="dashboard-preview-actions">
                  <button 
                    className="btn-secondary"
                    onClick={() => {
                      setIsPdfPreviewModalOpen(false)
                      setIsDateRangeModalOpen(true)
                    }}
                  >
                    Back to Date Selection
                  </button>
                  <button 
                    className="btn-primary"
                    onClick={handleGeneratePDF}
                  >
                    Generate PDF
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

