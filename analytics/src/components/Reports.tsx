import { useEffect, useRef, useState } from 'react'
import { Bar } from 'react-chartjs-2'
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
import jsPDF from 'jspdf'
import './Reports.css'

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
        console.log(`📊 Skipping duplicate outlet: ${outletKey}`)
        return
      }
      
      processedOutlets.add(outletKey)
      
      // Convert display name to Firebase key (Outlet 1 -> Outlet_1)
      const firebaseKey = outletKey.replace(' ', '_')
      const deviceData = devicesData[firebaseKey]
      
      if (deviceData && deviceData.daily_logs) {
        let outletMonthlyEnergy = 0
        
        // Sum energy for all days in the current month
        for (let day = 1; day <= daysInMonth; day++) {
          const dayKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
          const dayData = deviceData.daily_logs[dayKey]
          
          if (dayData && dayData.total_energy !== undefined) {
            outletMonthlyEnergy += dayData.total_energy
          }
        }
        
        totalMonthlyEnergy += outletMonthlyEnergy
        
        console.log(`📊 Outlet ${outletKey} (${firebaseKey}) monthly energy: ${(outletMonthlyEnergy * 1000).toFixed(0)}Wh`)
      } else {
        console.log(`📊 No data found for outlet: ${outletKey} (${firebaseKey})`)
      }
    })
    
    console.log(`📊 Total combined monthly energy: ${(totalMonthlyEnergy * 1000).toFixed(0)}Wh`)
    return totalMonthlyEnergy
  } catch (error) {
    console.error('📊 Error calculating combined monthly energy:', error)
    return 0
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

interface FirebaseDeviceData {
  status?: string // Add status property at root level
  lifetime_energy?: number // Add lifetime_energy at the root level
  daily_logs?: {
    [date: string]: {
      avg_power: number
      peak_power: number
      total_energy: number
      lifetime_energy: number
      usage_time_hours?: number
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
  officeRoom: string
  appliances: string
  office_info?: {
    assigned_date: string
    office: string
    department?: string
    appliance?: string
    enable_power_scheduling?: boolean
  }
  relay_control?: {
    auto_cutoff?: {
      enabled: boolean
      power_limit: number
    }
    status: string
    main_status?: string
  }
}

export default function Reports() {
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




  // Calculate estimated monthly bill based on daily average consumption
  const calculateMonthlyBill = async (devices: DeviceData[]) => {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    
    // Calculate daily average energy consumption
    let totalDailyEnergy = 0
    let daysWithData = 0
    
    try {
      // Fetch all devices data to get daily_logs for the current month
      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (snapshot.exists()) {
        const devicesData = snapshot.val()
        
        // Calculate total energy for each day in the current month
        for (let day = 1; day <= daysInMonth; day++) {
          const dayStr = String(day).padStart(2, '0')
          const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${dayStr}`
          let dayEnergy = 0
          
          devices.forEach((device) => {
            const outletKey = device.outletId
            const outlet = devicesData[outletKey]
            
            if (!outlet) return
            
            const dailyLogs = outlet.daily_logs || {}
            const dayData = dailyLogs[dateKey]
            
            if (dayData) {
              const measuredEnergy = dayData.total_energy || 0
              const avgPower = dayData.avg_power || 0
              const usageTimeHours = dayData.usage_time_hours || 0
              
              // Calculate expected energy from runtime
              const expectedEnergy = (avgPower * usageTimeHours) / 1000
              
              // Use runtime verification to determine which energy value to use
              let finalEnergy = measuredEnergy
              
              if (usageTimeHours > 0 && avgPower > 0) {
                const energyDifference = Math.abs(measuredEnergy - expectedEnergy)
                const accuracy = Math.min(measuredEnergy, expectedEnergy) / Math.max(measuredEnergy, expectedEnergy)
                
                if (accuracy < 0.95 && energyDifference > 0.1) {
                  finalEnergy = expectedEnergy
                }
              }
              
              dayEnergy += finalEnergy
            }
          })
          
          if (dayEnergy > 0) {
            totalDailyEnergy += dayEnergy
            daysWithData++
          }
        }
      }
    } catch (error) {
      console.error('Error calculating daily average:', error)
      // Fallback: use current day's data
      const currentDayEnergy = devices.reduce((sum, device) => {
        return sum + (device.total_energy || 0)
      }, 0)
      totalDailyEnergy = currentDayEnergy
      daysWithData = 1
    }
    
    // Calculate daily average
    const dailyAverage = daysWithData > 0 ? totalDailyEnergy / daysWithData : 0
    
    // Estimate monthly bill based on daily average
    const estimatedMonthlyEnergy = dailyAverage * daysInMonth
    const estimatedMonthlyBill = estimatedMonthlyEnergy * currentRate
    
    console.log(`Reports estimated monthly bill: Daily average = ${dailyAverage.toFixed(3)} kWh, Days in month = ${daysInMonth}, Estimated monthly energy = ${estimatedMonthlyEnergy.toFixed(3)} kWh, Estimated bill = PHP ${estimatedMonthlyBill.toFixed(2)}`)
    
    return estimatedMonthlyBill
  }

  // Calculate current bill using EXACT same method as PDF (no runtime verification)
  const calculateCurrentBill = async (devices: DeviceData[]) => {
    let totalBill = 0
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    
    try {
      // Fetch all devices data to get daily_logs for the current month
      const devicesRef = ref(realtimeDb, 'devices')
      const snapshot = await get(devicesRef)
      
      if (snapshot.exists()) {
        const devicesData = snapshot.val()
        
        console.log(`🔍 Current bill calculation: Processing ${currentYear}-${String(currentMonth).padStart(2, '0')} with ${daysInMonth} days`)
        
        // Process each device individually (same as PDF calculation)
        for (const device of devices) {
          const outletKey = device.outletId
          const outlet = devicesData[outletKey]
          
          if (outlet && outlet.daily_logs) {
            let monthlyEnergy = 0
            
            // Sum up all daily energy for the current month (EXACT same as PDF)
            for (let day = 1; day <= daysInMonth; day++) {
              const dayKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
              const dayData = outlet.daily_logs[dayKey]
              
              if (dayData) {
                monthlyEnergy += dayData.total_energy || 0 // Already in kW (same as PDF)
              }
            }
            
            // Calculate cost for this device and truncate to 2 decimals (same as PDF)
            const deviceCost = monthlyEnergy * currentRate
            const truncatedCost = Math.floor(deviceCost * 100) / 100
            totalBill += truncatedCost
            
            console.log(`📊 Device ${outletKey}: Monthly energy = ${monthlyEnergy.toFixed(6)} kWh, Cost = PHP ${truncatedCost.toFixed(2)}`)
          }
        }
      }
    } catch (error) {
      console.error('❌ Error calculating current bill:', error)
      // Fallback: use current day's data
      const totalMonthlyEnergy = devices.reduce((sum, device) => {
        return sum + (device.total_energy || 0)
      }, 0)
      const fallbackCost = totalMonthlyEnergy * currentRate
      totalBill = Math.floor(fallbackCost * 100) / 100
    }
    
    console.log(`📊 Current bill calculation results:`)
    console.log(`   Total bill (sum of truncated costs): PHP ${totalBill.toFixed(2)}`)
    
    // Return sum of truncated individual costs (EXACT same as PDF calculation)
    return totalBill
  }

  // Calculate trend percentage
  const calculateTrend = (current: number, previous: number): { percentage: number; isPositive: boolean } => {
    if (previous === 0) return { percentage: 0, isPositive: true }
    const change = ((current - previous) / previous) * 100
    return { percentage: Math.abs(change), isPositive: change >= 0 }
  }

  // Get trend indicator
  const getTrendIndicator = (current: number, previous: number) => {
    const trend = calculateTrend(current, previous)
    if (trend.percentage === 0) return null
    
    return (
      <span className={`trend-indicator ${trend.isPositive ? 'positive' : 'negative'}`}>
        {trend.isPositive ? '↑' : '↓'} {trend.percentage.toFixed(1)}%
      </span>
    )
  }

  // Get current time label for better context
  const getCurrentTimeLabel = (period: string) => {
    const now = new Date()
    
    switch (period) {
      case 'Week':
        const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        return `Last 7 days (${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      case 'Month':
        return now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      case 'Year':
        return now.getFullYear().toString()
      default:
        return period
    }
  }

  // Filter devices based on search query
  const getFilteredDevicesBySearch = (devices: DeviceData[], query: string) => {
    if (!query.trim()) return devices
    
    const searchLower = query.toLowerCase()
    
    return devices.filter(device => {
      const outletName = `Outlet ${device.outletId.split('_')[1]}`
      return outletName.toLowerCase().includes(searchLower) ||
             device.outletId.toLowerCase().includes(searchLower)
    })
  }

  // Clear search query
  const clearSearch = () => {
    setSearchQuery('')
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
        console.log(`Reports: Schedule check - Device power limit exceeded:`, {
          todayTotalEnergy: `${(todayTotalEnergy * 1000).toFixed(3)}Wh`,
          powerLimit: `${(powerLimit * 1000)}Wh`,
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

  // Show department selection dialog for PDF generation
  const showPdfDepartmentSelection = () => {
    setIsPdfDepartmentModalOpen(true)
  }

  // Format date for display
  const formatDate = (dateString: string) => {
    if (!dateString) return ''
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })
  }

  // Handle date range confirmation and show preview
  const handleDateRangeConfirm = async () => {
    // Updated: Using same logic as PDF generation for consistency - Force redeploy
    if (!selectedStartDate || !selectedEndDate) return
    
    setIsLoadingPreview(true)
    console.log('Date range selected:', { selectedStartDate, selectedEndDate, selectedOffice, selectedPdfDepartment })
    
    try {
      // Use the EXACT same logic as PDF generation (which works)
      const startDate = new Date(selectedStartDate)
      const endDate = new Date(selectedEndDate)
      
      // Filter devices based on selected department and office (SAME AS PDF GENERATION)
      let reportDevices = devices
      let officeDisplayName = 'All Offices'
      
      // First filter by department
      if (selectedPdfDepartment !== 'All Departments') {
        reportDevices = devices.filter(device => {
          if (device.office_info && device.office_info.department) {
            return device.office_info.department.toLowerCase() === selectedPdfDepartment.toLowerCase()
          }
          return false
        })
      }
      
      // Then filter by office if specific office is selected (SAME AS PDF GENERATION)
      if (selectedPdfOffice && selectedPdfOffice !== 'All Offices') {
        reportDevices = reportDevices.filter(device => {
          if (device.office_info && device.office_info.office) {
            return device.office_info.office === selectedPdfOffice
          }
          return false
        })
        officeDisplayName = selectedPdfOffice
      }

      console.log('Preview: Filtered devices for preview:', reportDevices.length, 'Department:', selectedPdfDepartment, 'Office:', selectedPdfOffice)
      console.log('Preview: Date range:', { startDate, endDate })
      console.log('Preview: Total devices available:', devices.length)
      console.log('Preview: Sample devices:', devices.slice(0, 3).map(d => ({ outletId: d.outletId, office_info: d.office_info })))

      // Calculate monthly energy consumption for each device (SAME LOGIC AS PDF GENERATION)
      const deviceMonthlyData = await Promise.all(reportDevices.map(async (device) => {
        console.log(`Preview: Processing device ${device.outletId}`)
        try {
          const devicesRef = ref(realtimeDb, 'devices')
          const snapshot = await get(devicesRef)
          
          if (snapshot.exists()) {
            const devicesData = snapshot.val()
            const outlet = devicesData[device.outletId]
            console.log(`Preview: Device ${device.outletId} outlet data:`, outlet)
            
            if (outlet && outlet.daily_logs) {
              let monthlyEnergy = 0
              let totalHours = 0
              
              // Use date range filtering with robust date parsing (SAME AS PDF)
              const start = new Date(startDate)
              const end = new Date(endDate)
              
              console.log(`Preview: Processing daily_logs for ${device.outletId}, date range:`, { start, end })
              console.log(`Preview: Available daily_logs dates:`, Object.keys(outlet.daily_logs))
              
              for (const [dateStr, dayData] of Object.entries(outlet.daily_logs)) {
                // Handle different date formats from the database (SAME AS PDF)
                let logDate: Date
                try {
                  // Try parsing as-is first
                  logDate = new Date(dateStr)
                  
                  // If that fails or gives invalid date, try parsing day_YYYY_MM_DD format
                  if (isNaN(logDate.getTime()) && dateStr.startsWith('day_')) {
                    const datePart = dateStr.replace('day_', '').replace(/_/g, '-')
                    logDate = new Date(datePart)
                  }
                  
                  // If still invalid, try to extract date from the string
                  if (isNaN(logDate.getTime())) {
                    const match = dateStr.match(/(\d{4})_(\d{2})_(\d{2})/)
                    if (match) {
                      const [, year, month, day] = match
                      logDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
                    }
                  }
                } catch (error) {
                  console.error(`Error parsing date ${dateStr}:`, error)
                  continue
                }
                
                if (logDate >= start && logDate <= end) {
                  const dayDataTyped = dayData as { total_energy?: number; usage_time_hours?: number }
                  console.log(`Preview: Adding data for ${dateStr} in date range:`, dayDataTyped)
                  monthlyEnergy += dayDataTyped.total_energy || 0 // Already in kW
                  totalHours += dayDataTyped.usage_time_hours || 0 // Usage time in hours
                }
              }
              
              console.log(`Preview: Device ${device.outletId} calculated:`, { monthlyEnergy, totalHours })
              
              const deviceData = {
                outletId: device.outletId,
                appliance: outlet.office_info?.appliance || 'Unassigned',
                powerLimit: (outlet.relay_control?.auto_cutoff?.power_limit || 0) * 1000, // Convert to watts
                monthlyEnergy: monthlyEnergy * 1000, // Convert to watts
                totalHours: totalHours,
                monthlyCost: monthlyEnergy * currentRate
              }
              
              return deviceData
            } else {
              console.log(`Preview: Device ${device.outletId} has no daily_logs`)
            }
          } else {
            console.log(`Preview: Firebase snapshot does not exist for device ${device.outletId}`)
          }
          
          return {
            outletId: device.outletId,
            appliance: device.appliances || 'Unassigned',
            powerLimit: 0,
            monthlyEnergy: 0,
            totalHours: 0,
            monthlyCost: 0
          }
        } catch (error) {
          console.error(`Error calculating data for ${device.outletId}:`, error)
          return {
            outletId: device.outletId,
            appliance: device.appliances || 'Unassigned',
            powerLimit: 0,
            monthlyEnergy: 0,
            totalHours: 0,
            monthlyCost: 0
          }
        }
      }))

      // Calculate totals (SAME AS PDF GENERATION)
      const totalEnergy = deviceMonthlyData.reduce((sum, device) => sum + device.monthlyEnergy, 0) / 1000 // Convert back to kWh
      const estimatedCost = deviceMonthlyData.reduce((sum, device) => sum + (Math.floor(device.monthlyCost * 100) / 100), 0)
      const deviceCount = deviceMonthlyData.length

      console.log('Preview data calculated (SAME AS PDF):', {
        deviceCount,
        totalEnergy,
        estimatedCost,
        currentRate,
        deviceTableDataLength: deviceMonthlyData.length,
        deviceTableData: deviceMonthlyData.slice(0, 3) // Show first 3 devices for debugging
      })

      // Sort deviceTableData by energy consumption (highest first) if report type is "Outlets"
      if (selectedReportType === 'Outlets') {
        deviceMonthlyData.sort((a, b) => b.monthlyEnergy - a.monthlyEnergy)
      }

      setPreviewData({
        deviceCount,
        totalEnergy,
        estimatedCost,
        filteredDevices: reportDevices,
        deviceTableData: deviceMonthlyData
      })

      setIsLoadingPreview(false)
      setIsDateRangeModalOpen(false)
      setIsPdfPreviewModalOpen(true)
      
    } catch (error) {
      console.error('Error generating preview data:', error)
      setIsLoadingPreview(false)
      alert('Error generating preview data. Please try again.')
    }
  }

  // Handle PDF generation with filtered data
  const handleGeneratePDF = () => {
    generatePDFReport(selectedOffice, selectedStartDate, selectedEndDate)
    setIsPdfPreviewModalOpen(false)
  }

  // Generate and download PDF report with selected office data
  const generatePDFReport = async (targetOffice: string = '', startDate?: string, endDate?: string) => {
    try {
      console.log('PDF Generation started with:', { targetOffice, startDate, endDate })
      
      // Get current date
      const now = new Date()
      const currentDate = now.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      })

      // Filter devices based on selected department and office
      let reportDevices = devices
      let officeDisplayName = 'All Offices'
      
      // First filter by department
      if (selectedPdfDepartment !== 'All Departments') {
        reportDevices = devices.filter(device => {
          if (device.office_info && device.office_info.department) {
            return device.office_info.department.toLowerCase() === selectedPdfDepartment.toLowerCase()
          }
          return false
        })
      }
      
      // Then filter by office if specific office is selected
      if (targetOffice && targetOffice !== 'All Offices') {
        reportDevices = reportDevices.filter(device => {
          if (device.office_info && device.office_info.office) {
            return device.office_info.office === targetOffice
          }
          return false
        })
        officeDisplayName = targetOffice
      }

      // Calculate real data
      const totalDevices = reportDevices.length
      
      // Note: Power limit calculation removed as it's not used in the current PDF generation

      // Get current month data for calculations
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()

      // Calculate monthly energy consumption for each device
      const deviceMonthlyData = await Promise.all(reportDevices.map(async (device) => {
        try {
          const devicesRef = ref(realtimeDb, 'devices')
          const snapshot = await get(devicesRef)
          
          if (snapshot.exists()) {
            const devicesData = snapshot.val()
            const outlet = devicesData[device.outletId]
            
            if (outlet && outlet.daily_logs) {
              let monthlyEnergy = 0
              let totalHours = 0
              
              if (startDate && endDate) {
                // Use date range filtering with robust date parsing
                const start = new Date(startDate)
                const end = new Date(endDate)
                
                for (const [dateStr, dayData] of Object.entries(outlet.daily_logs)) {
                  // Handle different date formats from the database
                  let logDate: Date
                  try {
                    // Try parsing as-is first
                    logDate = new Date(dateStr)
                    
                    // If that fails or gives invalid date, try parsing day_YYYY_MM_DD format
                    if (isNaN(logDate.getTime()) && dateStr.startsWith('day_')) {
                      const datePart = dateStr.replace('day_', '').replace(/_/g, '-')
                      logDate = new Date(datePart)
                    }
                    
                    // If still invalid, try to extract date from the string
                    if (isNaN(logDate.getTime())) {
                      const match = dateStr.match(/(\d{4})_(\d{2})_(\d{2})/)
                      if (match) {
                        const [, year, month, day] = match
                        logDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
                      }
                    }
                  } catch (error) {
                    console.error(`Error parsing date ${dateStr}:`, error)
                    continue
                  }
                  
                  if (logDate >= start && logDate <= end) {
                    const dayDataTyped = dayData as { total_energy?: number; usage_time_hours?: number }
                    console.log(`PDF: Adding data for ${dateStr} in date range:`, dayDataTyped)
                    monthlyEnergy += dayDataTyped.total_energy || 0 // Already in kW
                    totalHours += dayDataTyped.usage_time_hours || 0 // Usage time in hours
                  }
                }
              } else {
                // Fallback to current month calculation
                for (let day = 1; day <= daysInMonth; day++) {
                  const dayKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
                  const dayData = outlet.daily_logs[dayKey]
                  
                  if (dayData) {
                    monthlyEnergy += dayData.total_energy || 0 // Already in kW
                    totalHours += dayData.usage_time_hours || 0 // Usage time in hours
                  }
                }
              }
              
              const deviceData = {
                outletId: device.outletId,
                appliance: device.appliances || 'Unassigned',
                powerLimit: (device.relay_control?.auto_cutoff?.power_limit || 0) * 1000, // Convert to watts
                monthlyEnergy: monthlyEnergy * 1000, // Convert to watts
                totalHours: totalHours,
                monthlyCost: monthlyEnergy * currentRate
              }
              
              console.log(`PDF: Device ${device.outletId} calculated data:`, deviceData)
              return deviceData
            }
          }
          
          return {
            outletId: device.outletId,
            appliance: device.appliances || 'Unassigned',
            powerLimit: (device.relay_control?.auto_cutoff?.power_limit || 0) * 1000,
            monthlyEnergy: 0,
            totalHours: 0,
            monthlyCost: 0
          }
        } catch (error) {
          console.error(`Error calculating data for ${device.outletId}:`, error)
          return {
            outletId: device.outletId,
            appliance: device.appliances || 'Unassigned',
            powerLimit: (device.relay_control?.auto_cutoff?.power_limit || 0) * 1000,
            monthlyEnergy: 0,
            totalHours: 0,
            monthlyCost: 0
          }
        }
      }))

      console.log('PDF: All device data calculated:', deviceMonthlyData)
      console.log('PDF: Total devices:', deviceMonthlyData.length)
      console.log('PDF: Total energy:', deviceMonthlyData.reduce((sum, device) => sum + (device.monthlyEnergy / 1000), 0), 'kWh')
      console.log('PDF: Total cost:', deviceMonthlyData.reduce((sum, device) => sum + device.monthlyCost, 0), 'PHP')

      const doc = new jsPDF()
      const pageWidth = doc.internal.pageSize.getWidth()
      const pageHeight = doc.internal.pageSize.getHeight()
      let yPosition = 20

      // Helper function to add text with proper formatting
      const addText = (text: string, x: number, y: number, options: any = {}) => {
        doc.setFontSize(options.fontSize || 12)
        doc.setTextColor(options.color || '#000000')
        if (options.bold) {
          doc.setFont('arial', 'bold')
        } else {
          doc.setFont('arial', 'normal')
        }
        doc.text(text, x, y)
      }

      // Helper function to add line
      const addLine = (x1: number, y1: number, x2: number, y2: number) => {
        doc.setDrawColor(200, 200, 200)
        doc.line(x1, y1, x2, y2)
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

      // Helper function to check if we need a new page
      const checkNewPage = (requiredSpace: number = 20) => {
        if (yPosition + requiredSpace > pageHeight - 20) {
          doc.addPage()
          yPosition = 20
          return true
        }
        return false
      }

      // Institutional Header
      // Only show department name if not "All Departments"
      if (selectedPdfDepartment !== 'All Departments') {
        doc.setFontSize(12)
        doc.setFont('arial', 'normal')
        doc.text(selectedPdfDepartment, pageWidth / 2, yPosition, { align: 'center' })
        yPosition += 8
      }
      
      doc.setFontSize(12)
      doc.setFont('arial', 'normal')
      doc.text('Camarines Norte State College', pageWidth / 2, yPosition, { align: 'center' })
      yPosition += 8
      
      doc.setFontSize(12)
      doc.setFont('arial', 'normal')
      doc.text('Daet, Camarines Norte', pageWidth / 2, yPosition, { align: 'center' })
      yPosition += 15
      
      // Report Title
      doc.setFontSize(16)
      doc.setFont('arial', 'bold')
      const reportTitle = selectedReportType === 'Outlets' ? 'Outlet Consumption Ranking' : 'EcoPlug Performance Summary Report'
      doc.text(reportTitle, pageWidth / 2, yPosition, { align: 'center' })
      yPosition += 20

      // Add a separator line
      addLine(20, yPosition, pageWidth - 20, yPosition)
      yPosition += 15

      // Add report details with real data
      if (startDate && endDate) {
        const startDateFormatted = new Date(startDate).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })
        const endDateFormatted = new Date(endDate).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })
        addText(`Date Range: ${startDateFormatted} to ${endDateFormatted}`, 20, yPosition, { fontSize: 12 })
      } else {
        addText(`Date: ${currentDate}`, 20, yPosition, { fontSize: 12 })
      }
      yPosition += 7

      // Only show department line if not "All Departments"
      if (selectedPdfDepartment !== 'All Departments') {
        addText(`Department: ${selectedPdfDepartment}`, 20, yPosition, { fontSize: 12 })
        yPosition += 7
      }

      addText(`Offices: ${officeDisplayName}`, 20, yPosition, { fontSize: 12 })
      yPosition += 7

      addText(`No. of EcoPlug: ${totalDevices}`, 20, yPosition, { fontSize: 12 })
      yPosition += 7

      addText(`Electricity Rate: PHP ${currentRate.toFixed(4)} per kWh`, 20, yPosition, { fontSize: 12 })
      yPosition += 15

    // I. Outlet Performance Breakdown table
    checkNewPage(50)
    addText('I. Outlet Performance Breakdown', 20, yPosition, { fontSize: 14, bold: true })
    yPosition += 10

    // Table headers with light blue background and grid structure
    const colWidths = selectedReportType === 'Outlets' ? [15, 20, 30, 25, 30, 25, 25] : [20, 30, 25, 30, 25, 25, 20]
    const headerHeight = 16
    let xPosition = 20

    // Draw header row with light blue background
    const lightBlue = [173, 216, 230] as [number, number, number] // Light blue color
    
    // Draw header cells with light blue background
    colWidths.forEach((width) => {
      addRect(xPosition, yPosition - 2, width, headerHeight, lightBlue)
      xPosition += width
    })
    
    // Reset position for text
    xPosition = 20
    
    // Draw table headers with multi-line text
    // Rank (only for outlets)
    if (selectedReportType === 'Outlets') {
      addText('Rank', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
      xPosition += colWidths[0]
    }
    
    // Outlet
    addText('Outlet', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    xPosition += colWidths[selectedReportType === 'Outlets' ? 1 : 0]
    
    // Appliance
    addText('Appliance', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    xPosition += colWidths[selectedReportType === 'Outlets' ? 2 : 1]
    
    // Power Limit (Wh) - split into two lines with better spacing
    addText('Power Limit', xPosition + 2, yPosition + 3, { fontSize: 10, bold: true })
    addText('(Wh)', xPosition + 2, yPosition + 9, { fontSize: 10, bold: true })
    xPosition += colWidths[selectedReportType === 'Outlets' ? 3 : 2]
    
    // Total Power Usage (Wh) - split into three lines
    addText('Total Power', xPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Usage', xPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    addText('(Wh)', xPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    xPosition += colWidths[selectedReportType === 'Outlets' ? 4 : 3]
    
    // Total No. of Hours (hrs) - split into three lines
    addText('Total No. of', xPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Hours', xPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    addText('(hrs)', xPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    xPosition += colWidths[selectedReportType === 'Outlets' ? 5 : 4]
    
    // Monthly Cost (PHP) - split into two lines
    addText('Monthly Cost', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    addText('(PHP)', xPosition + 2, yPosition + 8, { fontSize: 10, bold: true })
    xPosition += colWidths[selectedReportType === 'Outlets' ? 5 : 5]
    
    // Share of Total (%) - only show if not outlets
    if (selectedReportType !== 'Outlets') {
      addText('Share of', xPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
      addText('Total', xPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
      addText('(%)', xPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    }
    
    yPosition += headerHeight + 2

    // Table data with real device data - using 3 decimal places format
    const tableData = deviceMonthlyData.map((device, index) => {
      const outletNumber = device.outletId.split('_')[1] || (index + 1).toString()
      
      // Show combined limit only for outlets that are part of the combined group
      let powerLimitDisplay = ''
      // Convert outletId to display format for comparison (Outlet_1 -> Outlet 1)
      const outletDisplayName = device.outletId.replace('_', ' ')
      if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)) {
        // This outlet is part of the combined limit group
        if (String(combinedLimitInfo.combinedLimit) === "No Limit") {
          powerLimitDisplay = 'No Limit'
        } else {
          // Show the actual combined limit value for outlets in the combined group (including 0.000)
          const limitValue = combinedLimitInfo.combinedLimit
          powerLimitDisplay = (limitValue !== null && limitValue !== undefined && !isNaN(limitValue)) 
            ? limitValue.toFixed(3) 
            : 'No Limit'
        }
      } else {
        // This outlet is not part of the combined group, show individual limit (including 0.000)
        const limitValue = device.powerLimit
        powerLimitDisplay = (limitValue !== null && limitValue !== undefined && !isNaN(limitValue)) 
          ? limitValue.toFixed(3) 
          : 'No Limit'
      }
      const monthlyEnergyDisplay = device.monthlyEnergy.toFixed(3)
      const totalHoursDisplay = device.totalHours.toFixed(3)
      // Truncate to 2 decimal places without rounding
      const monthlyCostDisplay = `PHP ${(Math.floor(device.monthlyCost * 100) / 100).toFixed(2)}`
      const sharePercentage = deviceMonthlyData.reduce((sum, d) => sum + d.monthlyEnergy, 0) > 0 
        ? ((device.monthlyEnergy / deviceMonthlyData.reduce((sum, d) => sum + d.monthlyEnergy, 0)) * 100).toFixed(3)
        : '0.000'
      
      const baseData = [
        `Outlet ${outletNumber}`,
        device.appliance,
        powerLimitDisplay,
        monthlyEnergyDisplay,
        totalHoursDisplay,
        monthlyCostDisplay
      ]
      
      // Add share percentage only if not outlets
      if (selectedReportType !== 'Outlets') {
        baseData.push(sharePercentage)
      }
      
      // Add rank at the beginning if report type is "Outlets"
      if (selectedReportType === 'Outlets') {
        return [(index + 1).toString(), ...baseData]
      }
      
      return baseData
    })

    // Draw table rows with grid structure
    const rowHeight = 10
    tableData.forEach((row) => {
      checkNewPage(15)
      xPosition = 20
      
      // Draw cell borders for each row
      colWidths.forEach((width) => {
        addRect(xPosition, yPosition - 2, width, rowHeight)
        xPosition += width
      })
      
      // Reset position for text
      xPosition = 20
      
      // Add text to each cell
      row.forEach((data, index) => {
        addText(data, xPosition + 2, yPosition + 4, { fontSize: 9 })
        xPosition += colWidths[index]
      })
      yPosition += rowHeight
    })

    // Add summary rows with real calculated data
    checkNewPage(20)
    
    // Calculate totals
    const totalMonthlyEnergy = deviceMonthlyData.reduce((sum, device) => sum + device.monthlyEnergy, 0)
    // Sum the truncated individual costs instead of calculating from total
    const totalMonthlyCost = deviceMonthlyData.reduce((sum, device) => sum + (Math.floor(device.monthlyCost * 100) / 100), 0)
    const totalHours = deviceMonthlyData.reduce((sum, device) => sum + device.totalHours, 0)
    
    // Calculate total table width
    const totalTableWidth = colWidths.reduce((sum, width) => sum + width, 0)
    
    // Total Usage row - single cell spanning all columns
    addRect(20, yPosition - 2, totalTableWidth, rowHeight)
    addText(`Total Usage: ${totalMonthlyEnergy.toFixed(3)} Wh (${totalHours.toFixed(3)} hours)`, 22, yPosition + 4, { fontSize: 10, bold: true })
    yPosition += rowHeight
    
    // Estimated Cost row - single cell spanning all columns
    addRect(20, yPosition - 2, totalTableWidth, rowHeight)
    // totalMonthlyCost is already the sum of truncated values
    addText(`Estimated Cost: PHP ${totalMonthlyCost.toFixed(2)}`, 22, yPosition + 4, { fontSize: 10, bold: true })
    yPosition += rowHeight

    // Add power usage summary text right after the estimated cost row
    yPosition += 10
    checkNewPage(60)
    
    // Power usage summary text with Aptos font
    doc.setFont('helvetica', 'normal') // Using helvetica as closest to Aptos in jsPDF
    doc.setFontSize(12)
    doc.setTextColor('#000000')
    
    // Create power usage summary text based on whether combined limit is used
    let powerUsageText = ''
    if (combinedLimitInfo?.enabled && combinedLimitInfo?.combinedLimit > 0) {
      powerUsageText = `The outlet performance data shows a total power usage of ${totalMonthlyEnergy.toFixed(3)} Wh across all monitored appliances, operating for a combined ${totalHours.toFixed(3)} hours, which resulted in an estimated monthly cost of PHP ${totalMonthlyCost.toFixed(2)}. The analysis covers ${totalDevices} EcoPlug devices in ${officeDisplayName}, with a combined power limit of ${(combinedLimitInfo.combinedLimit / 1000).toFixed(0)} kilowatts.`
    } else {
      powerUsageText = `The outlet performance data shows a total power usage of ${totalMonthlyEnergy.toFixed(3)} Wh across all monitored appliances, operating for a combined ${totalHours.toFixed(3)} hours, which resulted in an estimated monthly cost of PHP ${totalMonthlyCost.toFixed(2)}. The analysis covers ${totalDevices} EcoPlug devices in ${officeDisplayName}, with individual power limits ranging from ${Math.min(...deviceMonthlyData.map(d => d.powerLimit).filter(p => p > 0)).toFixed(3)} Wh to ${Math.max(...deviceMonthlyData.map(d => d.powerLimit).filter(p => p > 0)).toFixed(3)} Wh.`
    }
    
    // Split text into lines to fit page width
    const powerUsageMaxWidth = pageWidth - 40 // 20px margin on each side
    const lines = doc.splitTextToSize(powerUsageText, powerUsageMaxWidth)
    
    // Add each line
    lines.forEach((line: string) => {
      checkNewPage(15)
      doc.text(line, 20, yPosition)
      yPosition += 6
    })

    // II. Power Saving Recommendation table
    yPosition += 20
    checkNewPage(80)
    addText('II. Power Saving Recommendation', 20, yPosition, { fontSize: 14, bold: true })
    yPosition += 15

    // Table headers with light blue background and grid structure - bigger width
    const powerSavingColWidths = [24, 34, 29, 29, 29, 29]
    const powerSavingHeaderHeight = 16
    let powerSavingXPosition = 20

    // Draw header row with light blue background
    const powerSavingLightBlue = [173, 216, 230] as [number, number, number] // Light blue color
    
    // Draw header cells with light blue background
    powerSavingColWidths.forEach((width) => {
      addRect(powerSavingXPosition, yPosition - 2, width, powerSavingHeaderHeight, powerSavingLightBlue)
      powerSavingXPosition += width
    })
    
    // Reset position for text
    powerSavingXPosition = 20
    
    // Draw table headers with multi-line text - same style as Outlet Performance Breakdown
    // Outlet
    addText('Outlet', powerSavingXPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    powerSavingXPosition += powerSavingColWidths[0]
    
    // Appliance
    addText('Appliance', powerSavingXPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    powerSavingXPosition += powerSavingColWidths[1]
    
    // Avg. Daily Power Usage (Wh) - split into multiple lines
    addText('Avg. Daily', powerSavingXPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Power Usage', powerSavingXPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    addText('(Wh)', powerSavingXPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    powerSavingXPosition += powerSavingColWidths[2]
    
    // Power Limit
    addText('Power Limit', powerSavingXPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    powerSavingXPosition += powerSavingColWidths[3]
    
    // Total Power Usage (Wh) - split into multiple lines
    addText('Total Power', powerSavingXPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Usage (Wh)', powerSavingXPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    powerSavingXPosition += powerSavingColWidths[4]
    
    // Recommended Power Limit - split into multiple lines
    addText('Recommended', powerSavingXPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Power Limit', powerSavingXPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    
    yPosition += powerSavingHeaderHeight + 2

    // Table data for Power Saving Recommendation with real data - using 3 decimal places format
    const powerSavingTableData = deviceMonthlyData.map((device, index) => {
      const outletNumber = device.outletId.split('_')[1] || (index + 1).toString()
      // Calculate average daily power usage based on actual usage hours
      const avgDailyPower = device.totalHours > 0 ? (device.monthlyEnergy / daysInMonth).toFixed(3) : '0.000'
      
      // Show combined limit only for outlets that are part of the combined group
      let powerLimitDisplay = ''
      // Convert outletId to display format for comparison (Outlet_1 -> Outlet 1)
      const outletDisplayName = device.outletId.replace('_', ' ')
      if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)) {
        // This outlet is part of the combined limit group
        if (String(combinedLimitInfo.combinedLimit) === "No Limit") {
          powerLimitDisplay = 'No Limit'
        } else {
          // Show the actual combined limit value for outlets in the combined group (including 0.000)
          const limitValue = combinedLimitInfo.combinedLimit
          powerLimitDisplay = (limitValue !== null && limitValue !== undefined && !isNaN(limitValue)) 
            ? limitValue.toFixed(3) 
            : 'No Limit'
        }
      } else {
        // This outlet is not part of the combined group, show individual limit (including 0.000)
        const limitValue = device.powerLimit
        powerLimitDisplay = (limitValue !== null && limitValue !== undefined && !isNaN(limitValue)) 
          ? limitValue.toFixed(3) 
          : 'No Limit'
      }
      const monthlyEnergyDisplay = device.monthlyEnergy.toFixed(3)
      
      // Calculate recommended power limit based on total power usage (monthly energy)
      let recommendedLimit = ''
      if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)) {
        // This outlet is part of the combined limit group
        if (String(combinedLimitInfo.combinedLimit) === "No Limit") {
          recommendedLimit = 'No Limit'
        } else {
          // For outlets in combined group, use total power usage as recommended limit
          const totalUsageValue = device.monthlyEnergy
          if (totalUsageValue !== null && totalUsageValue !== undefined && !isNaN(totalUsageValue)) {
            recommendedLimit = totalUsageValue.toFixed(3)
          } else {
            recommendedLimit = 'No Limit'
          }
        }
      } else {
        // This outlet is not part of the combined group, use total power usage as recommended limit
        const totalUsageValue = device.monthlyEnergy
        if (totalUsageValue !== null && totalUsageValue !== undefined && !isNaN(totalUsageValue)) {
          recommendedLimit = totalUsageValue.toFixed(3)
        } else {
          recommendedLimit = 'No Limit'
        }
      }
      
      return [
        `Outlet ${outletNumber}`,
        device.appliance,
        avgDailyPower,
        powerLimitDisplay,
        monthlyEnergyDisplay,
        recommendedLimit
      ]
    })

    // Draw table rows with grid structure - same style as Outlet Performance Breakdown
    const powerSavingRowHeight = 10
    powerSavingTableData.forEach((row) => {
      checkNewPage(15)
      powerSavingXPosition = 20
      
      // Draw cell borders for each row
      powerSavingColWidths.forEach((width) => {
        addRect(powerSavingXPosition, yPosition - 2, width, powerSavingRowHeight)
        powerSavingXPosition += width
      })
      
      // Reset position for text
      powerSavingXPosition = 20
      
      // Add text to each cell
      row.forEach((data, index) => {
        addText(data, powerSavingXPosition + 2, yPosition + 4, { fontSize: 9 })
        powerSavingXPosition += powerSavingColWidths[index]
      })
      yPosition += powerSavingRowHeight
    })

    // Add power-saving analysis text at the bottom of the table
    yPosition += 15
    checkNewPage(80)
    
    // Power-saving analysis text with Aptos font
    doc.setFont('helvetica', 'normal') // Using helvetica as closest to Aptos in jsPDF
    doc.setFontSize(12)
    doc.setTextColor('#000000')
    
    const totalCurrentLimits = deviceMonthlyData.reduce((sum, device) => sum + device.powerLimit, 0)
    const totalRecommendedLimits = deviceMonthlyData.reduce((sum, device) => sum + (device.powerLimit * 0.9), 0)
    const potentialSavings = totalCurrentLimits > 0 ? ((totalCurrentLimits - totalRecommendedLimits) / totalCurrentLimits * 100).toFixed(1) : '0'
    
    const powerSavingAnalysisText = `The power-saving analysis shows that all appliances in ${officeDisplayName} operated under their respective power limits, but further optimization is still possible. The analysis covers ${totalDevices} devices with a total current power limit of ${totalCurrentLimits.toFixed(3)} Wh. By implementing the recommended power limits totaling ${totalRecommendedLimits.toFixed(3)} Wh, potential savings of approximately ${potentialSavings}% could be achieved through optimized operating schedules and reduced standby consumption. This optimization strategy focuses on maintaining functionality while reducing energy waste, particularly during off-hours and low-usage periods.`
    
    // Split text into lines to fit page width
    const analysisMaxWidth = pageWidth - 40 // 20px margin on each side
    const analysisLines = doc.splitTextToSize(powerSavingAnalysisText, analysisMaxWidth)
    
    // Add each line
    analysisLines.forEach((line: string) => {
      checkNewPage(15)
      doc.text(line, 20, yPosition)
      yPosition += 6
    })

    // Footer
    yPosition += 20
    checkNewPage(40)
    addLine(20, yPosition, pageWidth - 20, yPosition)
    yPosition += 10
    
    // Footer content
    addText('This report was generated automatically by the Energy Management System', 20, yPosition, { 
      fontSize: 9, 
      color: '#666666' 
    })
    yPosition += 5
    // Only show department in footer if not "All Departments"
    if (selectedPdfDepartment !== 'All Departments') {
      addText(`${selectedPdfDepartment} - Camarines Norte State College`, 20, yPosition, { 
        fontSize: 9, 
        color: '#666666' 
      })
    } else {
      addText('Camarines Norte State College', 20, yPosition, { 
        fontSize: 9, 
        color: '#666666' 
      })
    }
    yPosition += 5
    addText('For questions or concerns, please contact the system administrator.', 20, yPosition, { 
      fontSize: 9, 
      color: '#666666' 
    })

    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0]
    const officeName = officeDisplayName === 'All Offices' ? 'All_Offices' : officeDisplayName.replace(/\s+/g, '_')
    // Create department abbreviation by filtering out common words
    const wordsToExclude = ['of', 'and', 'the', 'in', 'for', 'a', 'an', 'to']
    const departmentAbbrev = selectedPdfDepartment === 'All Departments' 
      ? 'All_Departments' 
      : selectedPdfDepartment.split(' ')
          .filter(word => !wordsToExclude.includes(word.toLowerCase()))
          .map(word => word.charAt(0).toUpperCase())
          .join('')
    const filename = `CNSC_${departmentAbbrev}_Power_Report_${officeName}_${timestamp}.pdf`

    // Save the PDF
    doc.save(filename)
    
    // Close the office selection modal if it was open
    setIsPdfOfficeModalOpen(false)
    
    } catch (error) {
      console.error('Error generating PDF report:', error)
      alert('Error generating PDF report. Please try again.')
    }
  }

  const [deptOpen, setDeptOpen] = useState(false)
  const [officeOpen, setOfficeOpen] = useState(false)
  const [timeSegment, setTimeSegment] = useState('Week')
  const [department, setDepartment] = useState('All Departments')
  const [office, setOffice] = useState('All Offices')
  const [searchQuery, setSearchQuery] = useState('')
  const [devices, setDevices] = useState<DeviceData[]>([])
  const [filteredDevices, setFilteredDevices] = useState<DeviceData[]>([])
  const [officesData, setOfficesData] = useState<any>({})
  const [offices, setOffices] = useState<string[]>([])
  const [departments, setDepartments] = useState<string[]>(['All Departments'])

  // Report Type Modal States
  const [isReportTypeModalOpen, setIsReportTypeModalOpen] = useState(false)
  const [selectedReportType, setSelectedReportType] = useState('')

  // Debug departments state
  useEffect(() => {
    console.log('Departments state updated:', departments)
    console.log('Available departments for dropdown:', departments)
  }, [departments])

  const [totalPower, setTotalPower] = useState(0)
  const [totalEnergy, setTotalEnergy] = useState(0)
  const [currentTotalEnergy, setCurrentTotalEnergy] = useState(0) // For device list (not time-filtered)
  const [previousTotalEnergy, setPreviousTotalEnergy] = useState(0)
  const [previousTotalPower, setPreviousTotalPower] = useState(0)
  const [currentRate, setCurrentRate] = useState(9.3885)
  const [, setMonthlyBill] = useState(0)
  const [currentBill, setCurrentBill] = useState(0)
  const [chartData, setChartData] = useState<{
    labels: string[]
    energyUsage: number[][]
  }>({
    labels: [],
    energyUsage: []
  })
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isPdfDepartmentModalOpen, setIsPdfDepartmentModalOpen] = useState(false)
  const [isPdfOfficeModalOpen, setIsPdfOfficeModalOpen] = useState(false)
  const [isDateRangeModalOpen, setIsDateRangeModalOpen] = useState(false)
  const [isPdfPreviewModalOpen, setIsPdfPreviewModalOpen] = useState(false)
  const [selectedPdfDepartment, setSelectedPdfDepartment] = useState('')
  const [selectedPdfOffice, setSelectedPdfOffice] = useState('')
  const [selectedOffice, setSelectedOffice] = useState('')
  const [selectedStartDate, setSelectedStartDate] = useState('')
  const [selectedEndDate, setSelectedEndDate] = useState('')
  const [previewData, setPreviewData] = useState<any>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0
  })
  const dropdownRef = useRef<HTMLDivElement | null>(null)



  // Chart data based on selected time period and database data
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
          const deviceData: number[] = []
          
          console.log(`Fetching data for date: ${dateKey}`)
          console.log('Available devices:', Object.keys(devicesData))
          
          filteredDevices.forEach(device => {
            const outlet = devicesData[device.outletId]
            if (outlet && outlet.daily_logs && outlet.daily_logs[dateKey]) {
              const dayData = outlet.daily_logs[dateKey]
              console.log(`Found data for ${device.outletId} on ${dateKey}:`, dayData)
              deviceData.push(dayData.total_energy || 0) // Already in kW
            } else {
              console.log(`No data found for ${device.outletId} on ${dateKey}`)
              deviceData.push(0)
            }
          })
          
          console.log(`Device data for ${dateKey}:`, deviceData)
          return deviceData
        } else {
          console.log('No devices data found in database')
        }
      } catch (error) {
        console.error('Error fetching device data for date:', dateKey, error)
      }
      
      // Return zeros if no data found
      return filteredDevices.map(() => 0)
    }
    
    switch (timeSegment) {
      case 'Week':
        // Show data for last 7 days
        const weekLabels = []
        const weekEnergyData = []
        
        console.log('Generating week data...')
        
        for (let i = 6; i >= 0; i--) {
          const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
          const dayLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          const dateKey = getDateKey(date)
          
          weekLabels.push(dayLabel)
          
          const dayData = await getDeviceDataForDate(dateKey)
          weekEnergyData.push(dayData)
        }
        
        console.log('Week data generated:', { labels: weekLabels, energyUsage: weekEnergyData })
        
        return {
          labels: weekLabels,
          energyUsage: weekEnergyData
        }
      
      case 'Month':
        // Show data for current month (last 30 days)
        const monthLabels = []
        const monthEnergyData = []
        
        console.log('Generating month data...')
        
        for (let i = 29; i >= 0; i--) {
          const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
          const dayLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          const dateKey = getDateKey(date)
          
          monthLabels.push(dayLabel)
          
          const dayData = await getDeviceDataForDate(dateKey)
          monthEnergyData.push(dayData)
        }
        
        console.log('Month data generated:', { labels: monthLabels, energyUsage: monthEnergyData })
        
        return {
          labels: monthLabels,
          energyUsage: monthEnergyData
        }
      
      case 'Year':
        // Show data for current year (last 12 months) - aggregate monthly data
        const yearLabels = []
        const yearEnergyData = []
        
        console.log('Generating year data...')
        
        for (let i = 11; i >= 0; i--) {
          const date = new Date(currentYear, currentMonth - 1 - i, 1)
          const monthLabel = date.toLocaleDateString('en-US', { month: 'long' })
          
          yearLabels.push(monthLabel)
          
          // For year view, we'll aggregate the month's data
          // Get first and last day of the month
          const firstDay = new Date(date.getFullYear(), date.getMonth(), 1)
          const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0)
          
          // Aggregate data for the month
          const monthEnergySum: number[] = []
          
          for (let d = 0; d < lastDay.getDate(); d++) {
            const dayDate = new Date(firstDay.getTime() + d * 24 * 60 * 60 * 1000)
            const dayKey = getDateKey(dayDate)
            const dayData = await getDeviceDataForDate(dayKey)
            
            if (d === 0) {
              // Initialize arrays
              dayData.forEach((energy, index) => {
                monthEnergySum[index] = energy
              })
            } else {
              // Add to existing values
              dayData.forEach((energy, index) => {
                monthEnergySum[index] += energy
              })
            }
          }
          
          yearEnergyData.push(monthEnergySum)
        }
        
        console.log('Year data generated:', { labels: yearLabels, energyUsage: yearEnergyData })
        
        return {
          labels: yearLabels,
          energyUsage: yearEnergyData
        }
      
      default:
        // Default to Week view
        const defaultWeekLabels = []
        const defaultWeekEnergyData = []
        
        console.log('Generating default week data...')
        
        for (let i = 6; i >= 0; i--) {
          const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
          const dayLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          const dateKey = getDateKey(date)
          
          defaultWeekLabels.push(dayLabel)
          
          const dayData = await getDeviceDataForDate(dateKey)
          defaultWeekEnergyData.push(dayData)
        }
        
        console.log('Default week data generated:', { labels: defaultWeekLabels, energyUsage: defaultWeekEnergyData })
        
        return {
          labels: defaultWeekLabels,
          energyUsage: defaultWeekEnergyData
        }
    }
  }

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


  // Subscribe to CANORECO electricity rate (Region V - Camarines Norte)
  useEffect(() => {
    const rateRef = ref(realtimeDb, 'rates/canoreco')
    const unsubscribe = onValue(rateRef, (snapshot) => {
      const data = snapshot.val()
      if (!data) return
      const nextRate = Number(data.rate ?? data.value)
      if (!Number.isNaN(nextRate) && nextRate > 0) {
        setCurrentRate(nextRate)
      }
    })
    return () => off(rateRef, 'value', unsubscribe)
  }, [])

  // Fetch devices data from Firebase
  useEffect(() => {
    console.log('=== DEVICE LOADING DEBUG ===')
    const devicesRef = ref(realtimeDb, 'devices')
    console.log('Firebase devices reference:', devicesRef.toString())
    
    const unsubscribe = onValue(devicesRef, (snapshot) => {
      console.log('Firebase snapshot received:', snapshot.exists())
      const data = snapshot.val()
      console.log('Firebase data:', data)
      
      if (data) {
        console.log('Firebase data exists, processing devices...')
        const devicesArray: DeviceData[] = []

        const todayDateKey = getTodayDateKey()
        console.log('Today date key:', todayDateKey)
        console.log('Available device keys:', Object.keys(data))
        
        Object.keys(data).forEach((outletKey) => {
          const outlet: FirebaseDeviceData = data[outletKey]
          console.log(`Processing device ${outletKey}:`, {
            hasSensorData: !!outlet.sensor_data,
            hasOfficeInfo: !!outlet.office_info,
            hasRelayControl: !!outlet.relay_control,
            lifetimeEnergy: outlet.lifetime_energy
          })
          
          // Include ALL devices, even those without sensor_data
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
            status: outlet.relay_control?.status || 'OFF',
            power: outlet.sensor_data?.power || 0,
            energy: outlet.sensor_data?.energy || 0,
            current: outlet.sensor_data?.current || 0,
            voltage: outlet.sensor_data?.voltage || 0,
            power_factor: outlet.sensor_data?.power_factor || 0,
            timestamp: outlet.sensor_data?.timestamp || '',
            avg_power: todayLogs?.avg_power || 0,
            peak_power: todayLogs?.peak_power || 0,
            total_energy: todayLogs?.total_energy || 0, // This is in kW from daily logs
            lifetime_energy: lifetimeEnergyKw, // This is in kW from root level
            officeRoom: officeInfo,
            appliances: outlet.office_info?.appliance || 'Unassigned',
            office_info: outlet.office_info, // Add office_info data
            relay_control: outlet.relay_control // Add relay_control data
          }
          devicesArray.push(deviceData)
        })

        console.log('Processed devices array length:', devicesArray.length)
        setDevices(devicesArray)
        
        // Debug logging
        console.log('Reports data fetched:', {
          todayDateKey,
          devicesCount: devicesArray.length,
          devices: devicesArray.map(d => ({
            outletId: d.outletId,
            total_energy: d.total_energy,
            lifetime_energy: d.lifetime_energy,
            peak_power: d.peak_power,
            officeRoom: d.officeRoom,
            office_info: d.office_info
          }))
        })
      } else {
        console.error('ERROR: No data received from Firebase devices collection!')
        console.log('Firebase snapshot:', snapshot)
        setDevices([])
      }
    }, (error) => {
      console.error('Firebase error:', error)
    })

    return () => off(devicesRef, 'value', unsubscribe)
  }, [])

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

  // Function to get filtered offices based on selected department
  const getFilteredOffices = () => {
    if (department === 'All Departments') {
      return ['All Offices', ...offices]
    }
    
    const filteredOffices: string[] = ['All Offices']
    
    Object.values(officesData).forEach((officeData: any) => {
      if (officeData.department === department && officeData.office) {
        filteredOffices.push(officeData.office)
      }
    })
    
    return filteredOffices
  }

  // Function to get filtered offices for PDF based on selected PDF department
  const getFilteredOfficesForPdf = (pdfDepartment: string) => {
    console.log('PDF Office Filtering:', {
      pdfDepartment,
      officesData: Object.values(officesData),
      allOffices: offices
    })
    
    if (pdfDepartment === 'All Departments') {
      return ['All Offices', ...offices]
    }
    
    const filteredOffices: string[] = ['All Offices']
    
    Object.values(officesData).forEach((officeData: any) => {
      console.log('Checking office data:', {
        officeData,
        pdfDepartment,
        departmentMatch: officeData.department && officeData.department.toLowerCase() === pdfDepartment.toLowerCase()
      })
      
      if (officeData.department && officeData.office && 
          officeData.department.toLowerCase() === pdfDepartment.toLowerCase()) {
        filteredOffices.push(officeData.office)
      }
    })
    
    console.log('Filtered offices for PDF:', filteredOffices)
    return filteredOffices
  }

  // Reset office selection when department changes
  useEffect(() => {
    setOffice('All Offices')
  }, [department])

  // Filter devices based on selected department and office
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
              officeData.office === device.officeRoom
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
                   (deviceOfficeData as any).office.toLowerCase() === office.toLowerCase() && 
                   (deviceOfficeData as any).department.toLowerCase() === department.toLowerCase()
          }
          return false
        })
      } else {
        // Filter by department (all offices in that department)
        filteredDevices = devices.filter(device => {
          // Check if device has office_info with department (case-insensitive)
          if (device.office_info && device.office_info.department) {
            return device.office_info.department.toLowerCase() === department.toLowerCase()
          } else if (officesData && device.officeRoom) {
            // Fallback: Use officesData if office_info is not available
            const deviceOfficeData = Object.values(officesData).find((officeData: any) => 
              officeData.office === device.officeRoom
            )
            
            return deviceOfficeData && (deviceOfficeData as any).department.toLowerCase() === department.toLowerCase()
          }
          return false
        })
      }
    }
    
    setFilteredDevices(filteredDevices)
    
    console.log('Device filtering result:', {
      totalDevices: devices.length,
      filteredDevices: filteredDevices.length,
      department: department,
      office: office,
      allDevicesOfficeInfo: devices.map(d => ({
        outletId: d.outletId,
        officeRoom: d.officeRoom,
        office_info: d.office_info
      })),
      filteredDevicesList: filteredDevices.map(d => ({
        outletId: d.outletId,
        officeRoom: d.officeRoom,
        office_info: d.office_info
      }))
    })
  }, [department, office, devices, officesData])

  // Calculate current total energy for device list (not time-filtered)
  useEffect(() => {
    if (filteredDevices.length > 0) {
      const currentTotalEnergySum = filteredDevices.reduce((sum, device) => {
        return sum + (device.lifetime_energy || 0)
      }, 0) // Already in kW from database
      setCurrentTotalEnergy(currentTotalEnergySum)
    } else {
      setCurrentTotalEnergy(0)
    }
  }, [filteredDevices])

  // Calculate time-filtered data for chart (separate from metrics cards)
  useEffect(() => {
    if (filteredDevices.length > 0) {
      // Chart data is calculated in the component above
    }
  }, [filteredDevices, timeSegment])

  // Calculate current stats for metrics cards (not time-filtered)
  useEffect(() => {
    const calculateMonthlyStats = async () => {
      if (filteredDevices.length > 0) {
        try {
          // Get current month data
          const now = new Date()
          const currentYear = now.getFullYear()
          const currentMonth = now.getMonth() + 1
          const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
          
          // Calculate monthly energy consumption for all devices
          let currentTotalPowerSum = 0
          
          for (const device of filteredDevices) {
            try {
              const deviceRef = ref(realtimeDb, `devices/${device.outletId}`)
              const snapshot = await get(deviceRef)
              
              if (snapshot.exists()) {
                const outlet = snapshot.val()
                
                if (outlet && outlet.daily_logs) {
                  let monthlyEnergy = 0
                  
                  // Sum up all daily energy for the current month
                  for (let day = 1; day <= daysInMonth; day++) {
                    const dayKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
                    const dayData = outlet.daily_logs[dayKey]
                    
                    if (dayData) {
                      monthlyEnergy += dayData.total_energy || 0 // Already in kW
                    }
                  }
                  
                  currentTotalPowerSum += monthlyEnergy
                }
              }
            } catch (error) {
              console.error(`Error calculating monthly data for ${device.outletId}:`, error)
            }
          }
          
          // Total Consumption: Use lifetime_energy from each device (more efficient and accurate)
          let currentTotalEnergySum = 0
          
          for (const device of filteredDevices) {
            try {
              const deviceRef = ref(realtimeDb, `devices/${device.outletId}`)
              const snapshot = await get(deviceRef)
              
              if (snapshot.exists()) {
                const outlet = snapshot.val()
                
                // Use lifetime_energy directly from the root level (already in kW from database)
                if (outlet && outlet.lifetime_energy !== undefined) {
                  currentTotalEnergySum += outlet.lifetime_energy
                }
              }
            } catch (error) {
              console.error(`Error calculating total energy for ${device.outletId}:`, error)
            }
          }
          
          // Store previous values for trend calculation
          setPreviousTotalPower(totalPower)
          setPreviousTotalEnergy(totalEnergy)
          
          setTotalPower(currentTotalPowerSum)
          setTotalEnergy(currentTotalEnergySum)
        } catch (error) {
          console.error('Error calculating monthly stats:', error)
          setTotalPower(0)
          setTotalEnergy(0)
        }
      } else {
        setTotalPower(0)
        setTotalEnergy(0)
      }
    }
    
    calculateMonthlyStats()
  }, [filteredDevices]) // Removed timeSegment dependency

  // Calculate monthly bill and current bill when devices or rate changes
  useEffect(() => {
    const calculateBills = async () => {
      if (filteredDevices.length > 0) {
        const bill = await calculateMonthlyBill(filteredDevices)
        const currentBillValue = await calculateCurrentBill(filteredDevices)
        setMonthlyBill(bill)
        setCurrentBill(currentBillValue)
      } else {
        setMonthlyBill(0)
        setCurrentBill(0)
      }
    }
    
    calculateBills()
  }, [filteredDevices, currentRate])

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
            combinedLimit: data.combined_limit_watts !== undefined ? data.combined_limit_watts : 0 // Preserve "No Limit" string or use 0 as default
          })
        } else {
          setCombinedLimitInfo({
            enabled: false,
            selectedOutlets: [],
            combinedLimit: 0
          })
        }
      } catch (error) {
        console.error('Reports: Error fetching combined limit info:', error)
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
          
          console.log(`Reports: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`Reports: Checking device ${outletKey}:`, {
              hasSchedule: !!(deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)),
              enablePowerScheduling: deviceData.office_info?.enable_power_scheduling,
              schedule: deviceData.schedule
            })
            
            if (deviceData.schedule && 
                (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
              
              const currentControlState = deviceData.control?.device || 'off'
              const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
              
              // RESPECT disabled_by_unplug - if schedule is disabled by unplug, don't enable it
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`Reports: Device ${outletKey} is disabled by unplug - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`Reports: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
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
                console.log(`Reports: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
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
                    console.log(`🔒 Reports: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (${(todayTotalEnergy * 1000).toFixed(3)}Wh >= ${(powerLimit * 1000)}Wh)`)
                  }
                }
              }
              
              console.log(`Reports: Schedule check for ${outletKey}:`, {
                currentControlState,
                shouldBeActive,
                newControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                console.log(`Reports: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
              } else {
                console.log(`Reports: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('Reports: Error in real-time scheduler:', error)
      }
    }
    
    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`Reports: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
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
              console.log(`Reports: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual daily limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`Reports: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Get today's total energy consumption from daily_logs
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                
                console.log(`Reports: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}Wh`,
                  todayTotalEnergy: `${(todayTotalEnergy * 1000)}Wh`,
                  todayDateKey: todayDateKey,
                  exceedsLimit: todayTotalEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If today's energy exceeds power limit, turn off the device
                if (todayTotalEnergy >= powerLimit) {
                  console.log(`Reports: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(todayTotalEnergy * 1000).toFixed(3)}Wh >= ${(powerLimit * 1000)}Wh)`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`Reports: Device ${outletKey} turned OFF due to power limit exceeded`)
                }
              }
            } else {
              console.log(`Reports: Device ${outletKey} is in combined group - checking combined group power limits`)
              
              // For devices in combined groups, check combined monthly limit
              if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitkW = combinedLimitInfo.combinedLimit / 1000 // Convert to kW
                
                console.log(`Reports: Combined group limit check for ${outletKey}:`, {
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(0)}W`,
                  combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
                  exceedsLimit: totalMonthlyEnergy >= combinedLimitkW
                })
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  console.log(`Reports: Combined monthly limit exceeded - turning off ${outletKey}`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`Reports: Device ${outletKey} turned OFF due to combined monthly limit exceeded`)
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Reports: Error in power limit monitor:', error)
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
          
          console.log(`Reports: Monthly limit check - Total: ${(totalMonthlyEnergy * 1000).toFixed(0)}W / Limit: ${combinedLimitWatts}W`)
          
          if (totalMonthlyEnergy >= combinedLimitkW) {
            console.log(`Reports: Monthly limit exceeded! Turning off all devices in combined group.`)
            
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
        console.error('Reports: Error in monthly limit check:', error)
      }
    }

    // Re-enable schedule checking with bypass support
    checkScheduleAndUpdateDevices()
    
    // Run power limit check
    checkPowerLimitsAndTurnOffDevices()
    
    // Run monthly limit check
    checkMonthlyLimitAndTurnOffDevices()
    
    // Add manual test function for debugging
    ;(window as any).testReportsSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testReportsPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).checkReportsCurrentTime = () => {
      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()
      const currentDay = now.getDay()
      console.log('Reports current time debug:', {
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
  }, [])


  return (
    <div className="reports-container">
      {/* Header Section */}
      <section className="reports-hero">
        <div className="hero-left">
          <div className="hero-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#dbe7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="14,2 14,8 20,8" stroke="#dbe7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="16" y1="13" x2="8" y2="13" stroke="#dbe7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="16" y1="17" x2="8" y2="17" stroke="#dbe7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="10,9 9,9 8,9" stroke="#dbe7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="hero-text">
            <h1>Power Consumption Report</h1>
            <p>Comprehensive analysis of energy usage patterns</p>
          </div>
        </div>
        <div className="hero-actions">
          <button 
            className="print-report-btn" 
            type="button" 
            onClick={() => setIsReportTypeModalOpen(true)}
            title="Generate PDF Report"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6v-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Print Report
          </button>
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
        </div>
      </section>

      {/* Key Metrics Overview */}
      <section className="metrics-overview">
        {department !== 'All Departments' && (
          <div className="panel-subtitle">
            Showing data for {department}{office !== 'All Offices' ? ` - ${office}` : ''} ({filteredDevices.length} devices)
          </div>
        )}
        <div className="metrics-grid">
          <article className="metric-card metric-blue">
            <div className="metric-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 3L4 14h6l-1 7 9-11h-6l1-7z" fill="#ffffff"/>
              </svg>
            </div>
            <div className="metric-content">
              <div className="metric-title">Total Consumption</div>
              <div className="metric-value">
                {formatNumber(totalEnergy * 1000)} Wh
              </div>
              <div className="metric-trend positive">
                Live data from database
                {getTrendIndicator(totalEnergy, previousTotalEnergy)}
              </div>
            </div>
          </article>

          <article className="metric-card metric-blue">
            <div className="metric-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" fill="#ffffff"/>
                <line x1="16" y1="2" x2="16" y2="6" stroke="#ffffff" strokeWidth="2"/>
                <line x1="8" y1="2" x2="8" y2="6" stroke="#ffffff" strokeWidth="2"/>
                <line x1="3" y1="10" x2="21" y2="10" stroke="#ffffff" strokeWidth="2"/>
              </svg>
            </div>
            <div className="metric-content">
              <div className="metric-title">Current Power Usage This Month</div>
              <div className="metric-value">
                {formatNumber(totalPower * 1000)} Wh
              </div>
              <div className="metric-trend positive">
                Monthly power consumption
                {getTrendIndicator(totalPower, previousTotalPower)}
              </div>
            </div>
          </article>

          <article className="metric-card metric-green">
            <div className="metric-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <polyline points="14,2 14,8 20,8" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="16" y1="13" x2="8" y2="13" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="16" y1="17" x2="8" y2="17" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="10" y1="9" x2="8" y2="9" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="metric-content">
              <div className="metric-title">Current Bill</div>
              <div className="metric-value">PHP {formatNumber(currentBill, 2)}</div>
              <div className="metric-trend positive">
                Based on current consumption
              </div>
            </div>
          </article>
        </div>
      </section>

      {/* Main Content Area */}
      <section className="reports-content">
        <div className="content-grid">
          {/* Daily Consumption Chart */}
          <div className="chart-panel">
            <div className="chart-header">
              <h3>{timeSegment} Consumption</h3>
              <div className="chart-subtitle">{getCurrentTimeLabel(timeSegment)}</div>
              <div className="chart-controls">
                <div className="time-segments">
                  <button 
                    className={`segment-btn ${timeSegment === 'Week' ? 'active' : ''}`} 
                    onClick={() => setTimeSegment('Week')}
                  >
                    Week
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Month' ? 'active' : ''}`} 
                    onClick={() => setTimeSegment('Month')}
                  >
                    Month
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Year' ? 'active' : ''}`} 
                    onClick={() => setTimeSegment('Year')}
                  >
                    Year
                  </button>
                </div>
              </div>
            </div>
            <div className="chart-area" onClick={() => setIsModalOpen(true)} style={{ cursor: 'pointer' }}>
              {chartData.energyUsage.length > 0 && chartData.labels.length > 0 ? (
                shouldShowBarChart ? (
                  // Bar chart for single device - show time-based data
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
                              top: 2,
                              bottom: 2
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
                              top: 2,
                              bottom: 2
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
                      <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="#6b7280" strokeWidth="2"/>
                    </svg>
                  </div>
                  <p>No data available for {timeSegment.toLowerCase()} period</p>
                  <p className="chart-no-data-subtitle">Try selecting a different time period or check if devices have recent data</p>
                </div>
              )}
            </div>
          </div>

          {/* Usage per Device */}
          <div className="device-panel">
            <h3 className="device-title">Usage per device</h3>
            <div className="search-container">
              <div className="search-input-wrapper">
                <input
                  type="text"
                  placeholder="Search device (e.g., Outlet 1, Outlet 2)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="device-search"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    className="search-clear-btn"
                    aria-label="Clear search"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <div className="device-list-container">
              <div className="device-list">
                {getFilteredDevicesBySearch(filteredDevices, searchQuery).map((device, index) => {
                  // Use lifetime_energy for device consumption display (convert to watts)
                  const lifetimeEnergyKw = device.lifetime_energy || 0
                  const usageDisplay = `${formatNumber(lifetimeEnergyKw * 1000)} Wh`
                  
                  const currentEnergy = lifetimeEnergyKw // Already in kW from database
                  const percentage = currentTotalEnergy > 0 ? (currentEnergy / currentTotalEnergy) * 100 : 0
                  
                  return (
                    <div key={index} className="device-item">
                      <div className="device-info">
                        <span className="device-name">Outlet {device.outletId.split('_')[1]}</span>
                        <span className="device-usage">
                          {usageDisplay} ({formatNumber(percentage, 1)}%)
                        </span>
                      </div>
                      <div className="device-progress">
                        <div 
                          className="device-progress-fill" 
                          style={{ width: `${percentage}%` }}
                        ></div>
                      </div>
                    </div>
                  )
                })}
                
                {/* Show message when search has no results */}
                {filteredDevices.length > 0 && 
                 getFilteredDevicesBySearch(filteredDevices, searchQuery).length === 0 && (
                  <div className="no-devices">
                    <p>No devices found matching "{searchQuery}"</p>
                  </div>
                )}
                
                {/* Show message when no devices in office */}
                {filteredDevices.length === 0 && (
                  <div className="no-devices">
                    <p>No devices found in {department}{office !== 'All Offices' ? ` - ${office}` : ''}</p>
                  </div>
                )}
              </div>
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
                  // Bar chart for single device - show time-based data
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
                              return `Energy Usage: ${value.toFixed(3)} W`
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
                              top: 2,
                              bottom: 2
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
                              top: 2,
                              bottom: 2
                            }
                          }
                        }
                      }
                    }}
                  />
                )
              ) : (
                <div className="chart-no-data">
                  <div className="chart-no-data-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 12l2 2 4-4" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/>
                      <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="#6b7280" strokeWidth="2"/>
                    </svg>
                  </div>
                  <p>No data available for {timeSegment.toLowerCase()} period</p>
                  <p className="chart-no-data-subtitle">Try selecting a different time period or check if devices have recent data</p>
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
                    setIsPdfDepartmentModalOpen(true)
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
                    setSelectedPdfDepartment('All Departments') // Set default for outlets
                    setSelectedPdfOffice('All Offices') // Set default for outlets
                    setIsReportTypeModalOpen(false)
                    setIsDateRangeModalOpen(true) // Go directly to date range modal
                  }}
                >
                  <div className="report-type-content">
                    <h4>Outlet Consumption Ranking</h4>
                    <p>Generate report by consumption</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Department Selection Modal for PDF */}
      {isPdfDepartmentModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsPdfDepartmentModalOpen(false)}>
          <div className="chart-modal-content office-selection-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>Select Department for PDF Report</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsPdfDepartmentModalOpen(false)}
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
                    setSelectedPdfDepartment('All Departments')
                    setIsPdfDepartmentModalOpen(false)
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
                        setSelectedPdfDepartment(department)
                        setSelectedPdfOffice('All Offices') // Set default office
                        setIsPdfDepartmentModalOpen(false)
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

      {/* Office Selection Modal for PDF */}
      {isPdfOfficeModalOpen && (
        <div className="chart-modal-overlay" onClick={() => setIsPdfOfficeModalOpen(false)}>
          <div className="chart-modal-content office-selection-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>Select Office for {selectedPdfDepartment}</h3>
              <button 
                className="chart-modal-close" 
                onClick={() => setIsPdfOfficeModalOpen(false)}
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
                    setSelectedPdfOffice('All Offices')
                    setSelectedOffice('All Offices')
                    setIsPdfOfficeModalOpen(false)
                    setIsDateRangeModalOpen(true)
                  }}
                >
                  <div className="office-option-content">
                    <h4>All Offices</h4>
                    <p>Generate report for all devices in {selectedPdfDepartment}</p>
                    <div className="office-stats">
                      <span>{devices.filter(device => {
                        if (device.office_info && device.office_info.department) {
                          return device.office_info.department.toLowerCase() === selectedPdfDepartment.toLowerCase()
                        }
                        return false
                      }).length} devices</span>
                    </div>
                  </div>
                </button>
                
                {getFilteredOfficesForPdf(selectedPdfDepartment).filter(office => office !== 'All Offices').map((office) => {
                  const officeDevices = devices.filter(device => {
                    if (device.office_info && device.office_info.department && device.office_info.office) {
                      return device.office_info.department.toLowerCase() === selectedPdfDepartment.toLowerCase() &&
                             device.office_info.office.toLowerCase() === office.toLowerCase()
                    }
                    return false
                  })
                  return (
                    <button 
                      key={office}
                      className="office-option"
                      onClick={() => {
                        setSelectedPdfOffice(office)
                        setSelectedOffice(office)
                        setIsPdfOfficeModalOpen(false)
                        setIsDateRangeModalOpen(true)
                      }}
                    >
                      <div className="office-option-content">
                        <h4>{office}</h4>
                        <p>Generate report for devices in this office</p>
                        <div className="office-stats">
                          <span>{officeDevices.length} devices</span>
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
              <h3>Select Date Range for {selectedPdfDepartment}{selectedPdfOffice && selectedPdfOffice !== 'All Offices' ? ` - ${selectedPdfOffice}` : ''}</h3>
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
                    disabled={!selectedStartDate || !selectedEndDate || isLoadingPreview}
                  >
                    {isLoadingPreview ? 'Loading...' : 'Preview Report'}
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
          <div className="chart-modal-content pdf-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-modal-header">
              <h3>PDF Report Preview - {selectedPdfDepartment}{selectedPdfOffice && selectedPdfOffice !== 'All Offices' ? ` - ${selectedPdfOffice}` : ''}</h3>
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
              <div className="pdf-preview-container">
                <div className="pdf-preview-content">
                  {/* PDF Header */}
                  <div className="pdf-preview-header">
                    <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                      {/* Only show department name if not "All Departments" */}
                      {selectedPdfDepartment !== 'All Departments' && (
                        <p style={{ margin: '4px 0', fontSize: '14px', fontWeight: '500' }}>{selectedPdfDepartment}</p>
                      )}
                      <p style={{ margin: '4px 0', fontSize: '14px', fontWeight: '500' }}>Camarines Norte State College</p>
                      <p style={{ margin: '4px 0', fontSize: '14px', fontWeight: '500' }}>Daet, Camarines Norte</p>
                    </div>
                    <h2 style={{ textAlign: 'center', marginTop: '16px' }}>{selectedReportType === 'Outlets' ? 'Outlet Consumption Ranking' : 'EcoPlug Performance Summary Report'}</h2>
                    <div className="pdf-preview-separator"></div>
                    
                    <div className="pdf-preview-details" style={{ fontSize: '12px', lineHeight: '1.8' }}>
                      <p><strong>Date Range:</strong> {formatDate(selectedStartDate)} to {formatDate(selectedEndDate)}</p>
                      {selectedPdfDepartment !== 'All Departments' && (
                        <p><strong>Department:</strong> {selectedPdfDepartment}</p>
                      )}
                      <p><strong>Offices:</strong> {selectedPdfOffice}</p>
                      <p><strong>No. of EcoPlug:</strong> {previewData?.deviceCount || 0}</p>
                      <p><strong>Electricity Rate:</strong> PHP {currentRate.toFixed(4)} per kWh</p>
                    </div>
                  </div>

                  {previewData?.deviceTableData?.length === 0 && (
                    <div className="no-data-message">
                      <p>⚠️ No data found for the selected date range. Please check:</p>
                      <ul>
                        <li>Date range is correct</li>
                        <li>Devices have data for this period</li>
                        <li>Database connection is working</li>
                      </ul>
                    </div>
                  )}

                  {/* I. Outlet Performance Breakdown */}
                  <div className="pdf-preview-table">
                    <h3>I. Outlet Performance Breakdown</h3>
                    <div className="table-preview">
                      <div className="table-header">
                        {selectedReportType === 'Outlets' && <div className="table-cell">Rank</div>}
                        <div className="table-cell">Outlet</div>
                        <div className="table-cell">Appliance</div>
                        <div className="table-cell">Power Limit (Wh)</div>
                        <div className="table-cell">Total Power Usage (Wh)</div>
                        <div className="table-cell">Total No. of Hours (hrs)</div>
                        <div className="table-cell">Monthly Cost (PHP)</div>
                        {selectedReportType !== 'Outlets' && <div className="table-cell">Share of Total (%)</div>}
                      </div>
                      {previewData?.deviceTableData?.slice(0, 5).map((device: any, index: number) => {
                        const totalEnergy = previewData.totalEnergy || 0
                        const sharePercentage = totalEnergy > 0 ? ((device.monthlyEnergy / (totalEnergy * 1000)) * 100).toFixed(3) : '0.000'
                        return (
                          <div key={index} className="table-row">
                            {selectedReportType === 'Outlets' && <div className="table-cell">{index + 1}</div>}
                            <div className="table-cell">{device.outletId}</div>
                            <div className="table-cell">{device.appliance}</div>
                            <div className="table-cell">{device.powerLimit.toFixed(3)}</div>
                            <div className="table-cell">{device.monthlyEnergy.toFixed(3)}</div>
                            <div className="table-cell">{device.totalHours.toFixed(3)}</div>
                            <div className="table-cell">PHP {(Math.floor(device.monthlyCost * 100) / 100).toFixed(2)}</div>
                            {selectedReportType !== 'Outlets' && <div className="table-cell">{sharePercentage}</div>}
                          </div>
                        )
                      })}
                      {previewData?.deviceTableData?.length > 5 && (
                        <div className="table-row more-devices">
                          <div className="table-cell" style={{ gridColumn: '1 / -1' }}>
                            ... and {previewData.deviceTableData.length - 5} more devices
                          </div>
                        </div>
                      )}
                      {/* Summary rows */}
                      {previewData?.deviceTableData?.length > 0 && (
                        <>
                          <div className="table-row" style={{ fontWeight: 'bold', background: '#f8fafc' }}>
                            <div className="table-cell" style={{ gridColumn: '1 / -1' }}>
                              Total Usage: {previewData.totalEnergy.toFixed(3)} kWh ({previewData.deviceTableData.reduce((sum: number, d: any) => sum + d.totalHours, 0).toFixed(3)} hours)
                            </div>
                          </div>
                          <div className="table-row" style={{ fontWeight: 'bold', background: '#f8fafc' }}>
                            <div className="table-cell" style={{ gridColumn: '1 / -1' }}>
                              Estimated Cost: PHP {previewData.estimatedCost.toFixed(2)}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* II. Power Saving Recommendation Preview */}
                  <div className="pdf-preview-table">
                    <h3>II. Power Saving Recommendation</h3>
                    <div className="table-preview">
                      <div className="table-header">
                        <div className="table-cell">Outlet</div>
                        <div className="table-cell">Appliance</div>
                        <div className="table-cell">Avg. Daily Power Usage (Wh)</div>
                        <div className="table-cell">Power Limit</div>
                        <div className="table-cell">Total Power Usage (Wh)</div>
                        <div className="table-cell">Recommended Power Limit</div>
                      </div>
                      {previewData?.deviceTableData?.slice(0, 3).map((device: any, index: number) => {
                        const daysInMonth = Math.ceil((new Date(selectedEndDate).getTime() - new Date(selectedStartDate).getTime()) / (1000 * 60 * 60 * 24))
                        const avgDailyPower = daysInMonth > 0 ? (device.monthlyEnergy / daysInMonth).toFixed(3) : '0.000'
                        // Use total power usage (monthlyEnergy) as recommended limit - same as PDF
                        const recommendedLimit = device.monthlyEnergy.toFixed(3)
                        return (
                          <div key={index} className="table-row">
                            <div className="table-cell">{device.outletId}</div>
                            <div className="table-cell">{device.appliance}</div>
                            <div className="table-cell">{avgDailyPower}</div>
                            <div className="table-cell">{device.powerLimit.toFixed(3)}</div>
                            <div className="table-cell">{device.monthlyEnergy.toFixed(3)}</div>
                            <div className="table-cell">{recommendedLimit}</div>
                          </div>
                        )
                      })}
                      {previewData?.deviceTableData?.length > 3 && (
                        <div className="table-row more-devices">
                          <div className="table-cell" style={{ gridColumn: '1 / -1' }}>
                            ... and {previewData.deviceTableData.length - 3} more devices
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="preview-actions">
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
                    onClick={() => handleGeneratePDF()}
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
