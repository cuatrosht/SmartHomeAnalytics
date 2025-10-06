import { useEffect, useRef, useState } from 'react'
import { Line, Bar } from 'react-chartjs-2'
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
import './Dashboard.css'

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
  officeRoom: string // Add office information
  appliances: string // Add appliance information
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
    const isWithinTimeRange = currentTime >= startTime && currentTime <= endTime

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
        console.log(`Dashboard: Schedule check - Device power limit exceeded:`, {
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


  const [deptOpen, setDeptOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpen2, setFilterOpen2] = useState(false)
  const [selectedFilter1, setSelectedFilter1] = useState('Day')
  const [selectedFilter2, setSelectedFilter2] = useState('Day')
  const [timeSegment, setTimeSegment] = useState('Week')
  const [department, setDepartment] = useState('College of Computer and Multimedia Studies')
  const [devices, setDevices] = useState<DeviceData[]>([])
  const [totalPower, setTotalPower] = useState(0)
  const [totalEnergy, setTotalEnergy] = useState(0)
  const [monthlyEnergy, setMonthlyEnergy] = useState(0)
  const [totalLifetimeEnergy, setTotalLifetimeEnergy] = useState(0)
  const [dailyAverage, setDailyAverage] = useState(0)
  const [todayTotalEnergy, setTodayTotalEnergy] = useState(0)
  const [currentRate, setCurrentRate] = useState(9.3885) // Default CANORECO Residential rate (Aug 2025)
  const [lastRateUpdate, setLastRateUpdate] = useState<string>('')
  const [currentBill, setCurrentBill] = useState(0)
  const [monthlyBill, setMonthlyBill] = useState(0)
  const [filteredDevices, setFilteredDevices] = useState<DeviceData[]>([])
  const [filteredDevicesRank, setFilteredDevicesRank] = useState<DeviceData[]>([])
  const [overallConsumptionDevices, setOverallConsumptionDevices] = useState<DeviceData[]>([])
  const dropdownRef = useRef<HTMLDivElement | null>(null)

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
                const accuracy = Math.min(measuredEnergy, expectedEnergy) / Math.max(measuredEnergy, expectedEnergy)
                
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

  // Calculate estimated monthly bill based on daily average consumption pattern
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
      
      if (snapshot.exists()) {
        const devicesData = snapshot.val()
        
        console.log(`📊 Processing ${devices.length} filtered devices for estimated monthly bill calculation`)
        
        // Process each day in the current month to count days with data
        for (let day = 1; day <= daysInMonth; day++) {
          const dayStr = String(day).padStart(2, '0')
          const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${dayStr}`
          let dayEnergy = 0
          
          // Process each filtered device for this day
          devices.forEach((device) => {
            const outletKey = device.outletId
            const outlet = devicesData[outletKey]
            
            if (!outlet || !outlet.daily_logs) return
            
            const dayData = outlet.daily_logs[dateKey]
            
            if (dayData) {
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
      }
    } catch (error) {
      console.error('❌ Error calculating estimated monthly bill:', error)
      // Fallback: use current day's data
      totalEnergySoFar = devices.reduce((sum, device) => {
        return sum + (device.total_energy || 0)
      }, 0)
      daysWithData = 1
    }
    
    // Calculate daily average from days with actual data
    const dailyAverage = daysWithData > 0 ? totalEnergySoFar / daysWithData : 0
    
    // Estimate monthly bill based on daily average projected to full month
    const estimatedMonthlyEnergy = dailyAverage * daysInMonth
    const estimatedMonthlyBill = estimatedMonthlyEnergy * PHILIPPINE_RATE_PER_KWH
    
    console.log(`📊 Estimated monthly bill calculation results:`)
    console.log(`   Total energy so far: ${totalEnergySoFar.toFixed(6)} kWh`)
    console.log(`   Days with data: ${daysWithData}`)
    console.log(`   Daily average: ${dailyAverage.toFixed(6)} kWh`)
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
        
        // Loop through all daily logs for this device
        if (deviceData.daily_logs) {
          for (const [dateKey, dayLogs] of Object.entries(deviceData.daily_logs)) {
            const dayData = dayLogs as any
            const dayEnergy = dayData?.total_energy || 0 // Energy in kW
            totalLifetimeEnergy += dayEnergy
          }
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
      let totalMonthlyEnergy = 0
      let daysWithData = 0
      
      // Calculate today's energy and monthly energy for daily average with runtime verification
      for (const device of overallConsumptionDevices) {
        const outletKey = device.outletId
        const deviceData = devicesData[outletKey]
        
        if (!deviceData) continue
        
        // Today's energy with runtime verification
        const todayLogs = deviceData?.daily_logs?.[todayKey]
        if (todayLogs) {
          const measuredEnergy = todayLogs.total_energy || 0 // Energy in kWh
          const avgPower = todayLogs.avg_power || 0 // Average power in Wh
          const usageTimeHours = todayLogs.usage_time_hours || 0 // Usage time in hours
          
          // Calculate expected energy from runtime
          const expectedEnergy = (avgPower * usageTimeHours) / 1000
          
          // Use runtime verification
          let finalTodayEnergy = measuredEnergy
          if (usageTimeHours > 0 && avgPower > 0) {
            const energyDifference = Math.abs(measuredEnergy - expectedEnergy)
            const accuracy = Math.min(measuredEnergy, expectedEnergy) / Math.max(measuredEnergy, expectedEnergy)
            
            if (accuracy < 0.95 && energyDifference > 0.001) {
              finalTodayEnergy = expectedEnergy
            }
          }
          
          totalTodayEnergy += finalTodayEnergy
        }
        
        // Monthly energy for daily average calculation with runtime verification
        for (let day = 1; day <= currentDay; day++) {
          const dayKey = getDateKey(currentYear, currentMonth, day)
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
              const accuracy = Math.min(measuredEnergy, expectedEnergy) / Math.max(measuredEnergy, expectedEnergy)
              
              if (accuracy < 0.95 && energyDifference > 0.001) {
                finalDayEnergy = expectedEnergy
              }
            }
            
            if (finalDayEnergy > 0) {
              totalMonthlyEnergy += finalDayEnergy
              daysWithData++ // Count all days with data, not just current day
            }
          }
        }
      }
      
      // Calculate daily average using the formula: Daily Average (Wh) = Total Energy Used for current month (Wh) ÷ Number of active days
      const totalMonthlyEnergyWh = totalMonthlyEnergy * 1000 // Convert kWh to Wh
      const dailyAverageWh = daysWithData > 0 ? totalMonthlyEnergyWh / daysWithData : 0
      
      // Convert to Watts and set states
      setTodayTotalEnergy(totalTodayEnergy * 1000) // Convert kW to W
      setDailyAverage(dailyAverageWh) // Already in Wh
      
      console.log('Daily Average Calculation (Updated Formula):', {
        totalMonthlyEnergyKwh: `${totalMonthlyEnergy.toFixed(6)} kWh`,
        totalMonthlyEnergyWh: `${totalMonthlyEnergyWh.toFixed(3)} Wh`,
        activeDays: daysWithData,
        dailyAverageWh: `${dailyAverageWh.toFixed(3)} Wh`,
        formula: `Daily Average = ${totalMonthlyEnergyWh.toFixed(3)} Wh ÷ ${daysWithData} days = ${dailyAverageWh.toFixed(3)} Wh`,
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
      
      // Convert from kW to Wh and set state
      setMonthlyEnergy(totalMonthlyEnergy * 1000)
      
      console.log('Current month energy calculated:', {
        totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(3)} Wh`,
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
        console.error('Dashboard: Error fetching combined limit info:', error)
      }
    }
    
    fetchCombinedLimitInfo()
  }, [])

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
            
            const deviceData: DeviceData = {
              outletId: outletKey,
              status: outlet.control?.device || 'off',
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
              officeRoom: officeInfo,
              appliances: outlet.office_info?.appliance || 'Unassigned'
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
          
          console.log(`Dashboard: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`Dashboard: Checking device ${outletKey}:`, {
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
              console.log(`Dashboard: Device ${outletKey} main status is ${currentMainStatus} - checking schedule anyway`)
              
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
                    console.log(`🔒 Dashboard: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  }
                }
              }
              
              console.log(`Dashboard: Schedule check for ${outletKey}:`, {
                currentControlState,
                shouldBeActive,
                newControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup
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
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual daily limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`Dashboard: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Get today's total energy consumption from daily_logs
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                
                console.log(`Dashboard: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
                  todayDateKey: todayDateKey,
                  exceedsLimit: todayTotalEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If today's energy exceeds power limit, turn off the device
                if (todayTotalEnergy >= powerLimit) {
                  console.log(`Dashboard: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
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
              console.log(`Dashboard: Device ${outletKey} is in combined group - skipping individual daily limit check (monthly limit takes precedence)`)
            }
          }
        }
      } catch (error) {
        console.error('Dashboard: Error in power limit monitor:', error)
      }
    }
    
    // Run both functions immediately
    checkScheduleAndUpdateDevices()
    checkPowerLimitsAndTurnOffDevices()
    
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
    
    // Set up intervals for automatic checking
    const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds (more frequent for short schedules)
    const powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 30000) // 30 seconds (more frequent for power limits)
    
    // Cleanup intervals on unmount
    return () => {
      clearInterval(scheduleInterval)
      clearInterval(powerLimitInterval)
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
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0
  })

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
    const usageDisplay = `${formatNumber(todayEnergyKw * 1000)} Wh`
    
    return {
      name: `Outlet ${device.outletId.split('_')[1]}`,
      usage: device.total_energy, // Today's energy from daily_logs (already in kW from database)
      usageDisplay: usageDisplay, // Display format with Wh
      percentage: totalEnergy > 0 ? (device.total_energy / totalEnergy) * 100 : 0
    }
  })

  const departments = [
    'College of Computer and Multimedia Studies',
    'Computer Laboratory 1',
    'Computer Laboratory 2', 
    'Computer Laboratory 3',
    "Dean's Office",
    'Faculty Office'
  ]

  // Filter devices based on selected department (for Overall Consumption metrics)
  useEffect(() => {
    let filteredByOffice = devices
    
    // Filter by office selection
    if (department !== 'College of Computer and Multimedia Studies') {
      filteredByOffice = devices.filter(device => device.officeRoom === department)
    }
    
    // Set filtered devices for Overall Consumption metrics (department only)
    const sorted = [...filteredByOffice].sort((a, b) => {
      const outletNumA = parseInt(a.outletId.split('_')[1]) || 0
      const outletNumB = parseInt(b.outletId.split('_')[1]) || 0
      return outletNumA - outletNumB
    })
    setOverallConsumptionDevices(sorted)
  }, [department, devices])

  // Filter devices for Energy Consumption tables (department + time period)
  useEffect(() => {
    const updateEnergyConsumptionTables = async () => {
      let filteredByOffice = devices
      
      // First filter by office selection
      if (department !== 'College of Computer and Multimedia Studies') {
        filteredByOffice = devices.filter(device => device.officeRoom === department)
      }
      
      // Apply time period filtering for Per Device Consumption table
      if (selectedFilter1 !== 'Day') {
        const timeFiltered = await filterDevicesByPeriod(filteredByOffice, selectedFilter1)
        const sorted = [...timeFiltered].sort((a, b) => {
          const outletNumA = parseInt(a.outletId.split('_')[1]) || 0
          const outletNumB = parseInt(b.outletId.split('_')[1]) || 0
          return outletNumA - outletNumB
        })
        setFilteredDevices(sorted)
      } else {
        // Use department-filtered devices for Day filter
        const sorted = [...filteredByOffice].sort((a, b) => {
          const outletNumA = parseInt(a.outletId.split('_')[1]) || 0
          const outletNumB = parseInt(b.outletId.split('_')[1]) || 0
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
      }
    }
    
    updateEnergyConsumptionTables()
  }, [department, devices, selectedFilter1, selectedFilter2])

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
      if (!dropdownRef.current.contains(e.target as Node)) setDeptOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDeptOpen(false) }
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
      'off': 'status-inactive'
    }
    
    return (
      <span className={`status-badge ${statusClasses[status] || 'status-inactive'}`}>
        <span className={`status-dot ${statusClasses[status] || 'status-inactive'}`}></span>
        {status === 'on' ? 'Active' : 'Inactive'}
      </span>
    )
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
        <div className="dropdown" ref={dropdownRef}>
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
      </section>

      <section className="panel">
        <header className="panel-head">
          <span className="bolt" aria-hidden="true">⚡</span>
          <h2>Overall Consumption</h2>
          <p className="panel-subtitle">
            {department === 'College of Computer and Multimedia Studies' 
              ? `Showing data for all offices (${overallConsumptionDevices.length} devices)`
              : `Showing data for ${department} (${overallConsumptionDevices.length} devices)`
            }
          </p>
        </header>
        <div className="stats-grid">
          <article className="stat-card stat-accent">
            <div className="stat-title">CURRENT USAGE THIS MONTH</div>
            <div className="stat-value">
              {formatNumber(monthlyEnergy)}
            </div>
            <div className="stat-unit">Wh</div>
            <div className="stat-badge up">↑ This Month</div>
          </article>
          <article className="stat-card">
            <div className="stat-title">DAILY AVERAGE</div>
            <div className="stat-value">
              {formatNumber(dailyAverage)}
            </div>
            <div className="stat-unit">Wh</div>
          </article>
          <article className="stat-card">
            <div className="stat-title">CURRENT RATE</div>
            <div className="stat-value">₱{formatNumber(PHILIPPINE_RATE_PER_KWH, 2)}</div>
            <div className="stat-unit">per kWh</div>
            {lastRateUpdate && (
              <div className="stat-badge" style={{ fontSize: '10px', marginTop: '4px' }}>
                Updated: {lastRateUpdate}
              </div>
            )}
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
              {formatNumber(totalLifetimeEnergy)} Wh
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
              {formatNumber(totalEnergy * 1000)} Wh
            </div>
            <div className="mini-sub">Today Consumption</div>
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
                    <th>Consumption</th>
                    <th>Office/ Room</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.length > 0 ? (
                    filteredDevices.map((device, index) => (
                      <tr key={device.outletId}>
                        <td>{(index + 1).toString().padStart(3, '0')}</td>
                        <td>{device.outletId.split('_')[1]}</td>
                        <td>{device.appliances}</td>
                        <td>{formatNumber(device.total_energy * 1000)} Wh</td>
                        <td>{device.officeRoom}</td>
                        <td>
                          {getStatusBadge(device.status)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="no-data-message">
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
                    <th>Consumption</th>
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
                        <td>{formatNumber(device.total_energy * 1000)} Wh</td>
                        <td>{device.officeRoom}</td>
                        <td>
                          {getStatusBadge(device.status)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="no-data-message">
                         {`No data available for ${selectedFilter2.toLowerCase()} period`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
                          label: 'Energy Usage (Wh)',
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
                                return `Energy Usage: ${formatNumber(value)} Wh`
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
                            text: 'Energy (Wh)',
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
                          label: `Outlet ${device.outletId.split('_')[1]} - Energy (Wh)`,
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
                          return `${label}: ${formatNumber(value)} Wh`
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
                          text: 'Energy (Wh)',
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
                          label: 'Energy Usage (Wh)',
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
                            text: 'Energy (Wh)',
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
                          label: `Outlet ${device.outletId.split('_')[1]} - Energy (Wh)`,
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
                          return `${label}: ${formatNumber(value)} Wh`
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
                          text: 'Energy (Wh)',
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

    </div>
  )
}
