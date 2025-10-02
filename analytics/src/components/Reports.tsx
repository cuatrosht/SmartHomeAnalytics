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
    
    console.log(`📊 TOTAL MONTHLY ENERGY: ${totalMonthlyEnergy.toFixed(3)}kW (${(totalMonthlyEnergy * 1000).toFixed(3)}Wh)`)
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
  officeRoom: string
  appliances: string
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
        const monthPattern = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_`
        
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

  // Calculate current bill based on filtered devices' current month energy with runtime verification
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
        
        // Only process filtered devices (not all devices)
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
              const avgPower = dayData.avg_power || 0 // Average power in Wh
              const usageTimeHours = dayData.usage_time_hours || 0 // Usage time in hours
              
              // Calculate expected energy from runtime
              const expectedEnergy = (avgPower * usageTimeHours) / 1000 // Convert Wh*h to kWh
              
              // Use runtime verification to determine which energy value to use
              let finalEnergy = measuredEnergy
              
              if (usageTimeHours > 0 && avgPower > 0) {
                const energyDifference = Math.abs(measuredEnergy - expectedEnergy)
                const accuracy = Math.min(measuredEnergy, expectedEnergy) / Math.max(measuredEnergy, expectedEnergy)
                
                // If accuracy is below 95%, use calculated energy (sensor might have errors)
                if (accuracy < 0.95 && energyDifference > 0.1) {
                  console.log(`Runtime verification: Using calculated energy for ${outletKey} on ${dateKey}. Measured: ${measuredEnergy}kWh, Calculated: ${expectedEnergy}kWh, Accuracy: ${(accuracy * 100).toFixed(1)}%`)
                  finalEnergy = expectedEnergy
                } else {
                  console.log(`Runtime verification: Using measured energy for ${outletKey} on ${dateKey}. Measured: ${measuredEnergy}kWh, Calculated: ${expectedEnergy}kWh, Accuracy: ${(accuracy * 100).toFixed(1)}%`)
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
    
    console.log(`Current bill calculation with runtime verification: Actual monthly energy = ${actualMonthlyEnergy} kWh, Filtered devices count = ${devices.length}`)
    
    // Energy is already in kWh, multiply by current rate
    return actualMonthlyEnergy * currentRate
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

  // Generate and download PDF report
  const generatePDFReport = async () => {
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
    doc.setFontSize(12)
    doc.setFont('arial', 'normal')
    doc.text('College of Computing and Multimedia Studies', pageWidth / 2, yPosition, { align: 'center' })
    yPosition += 8
    
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
    doc.text('EcoPlug Performance Summary Report', pageWidth / 2, yPosition, { align: 'center' })
    yPosition += 20

    // Add a separator line
    addLine(20, yPosition, pageWidth - 20, yPosition)
    yPosition += 15

    // Add report details from image
    addText('Date: January 01, 2025', 20, yPosition, { fontSize: 12 })
    yPosition += 7

    addText('Department: College of Computing and Multimedia Studies', 20, yPosition, { fontSize: 12 })
    yPosition += 7

    addText('Offices: Dean\'s Office', 20, yPosition, { fontSize: 12 })
    yPosition += 7

    addText('No. of EcoPlug: 5', 20, yPosition, { fontSize: 12 })
    yPosition += 7

    addText('Electricity Rate: 11 kWh', 20, yPosition, { fontSize: 12 })
    yPosition += 7

    addText('Overall Power Limit: 3000 kilowatts', 20, yPosition, { fontSize: 12 })
    yPosition += 15

    // I. Outlet Performance Breakdown table
    checkNewPage(50)
    addText('I. Outlet Performance Breakdown', 20, yPosition, { fontSize: 14, bold: true })
    yPosition += 10

    // Table headers with light blue background and grid structure
    const colWidths = [20, 30, 25, 30, 25, 25, 20]
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
    // Outlet
    addText('Outlet', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    xPosition += colWidths[0]
    
    // Appliance
    addText('Appliance', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    xPosition += colWidths[1]
    
    // Power Limit (Wh) - split into two lines with better spacing
    addText('Power Limit', xPosition + 2, yPosition + 3, { fontSize: 10, bold: true })
    addText('(Wh)', xPosition + 2, yPosition + 9, { fontSize: 10, bold: true })
    xPosition += colWidths[2]
    
    // Total Power Usage (Wh) - split into three lines
    addText('Total Power', xPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Usage', xPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    addText('(Wh)', xPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    xPosition += colWidths[3]
    
    // Total No. of Hours (hrs) - split into three lines
    addText('Total No. of', xPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Hours', xPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    addText('(hrs)', xPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    xPosition += colWidths[4]
    
    // Monthly Cost (₱) - split into two lines with peso sign
    addText('Monthly Cost', xPosition + 2, yPosition + 4, { fontSize: 10, bold: true })
    addText('(₱)', xPosition + 2, yPosition + 8, { fontSize: 10, bold: true })
    xPosition += colWidths[5]
    
    // Share of Total (%) - split into three lines
    addText('Share of', xPosition + 2, yPosition + 2, { fontSize: 10, bold: true })
    addText('Total', xPosition + 2, yPosition + 6, { fontSize: 10, bold: true })
    addText('(%)', xPosition + 2, yPosition + 10, { fontSize: 10, bold: true })
    
    yPosition += headerHeight + 2

    // Table data with hours column added back
    const tableData = [
      ['Outlet 1', 'Aircon', '500', '450', '150', '', ''],
      ['Outlet 2', 'Television', '500', '300', '140', '', ''],
      ['Outlet 3', 'Refrigerator', '500', '400', '130', '', ''],
      ['Outlet 4', 'Electric fan', '500', '350', '160', '', ''],
      ['Outlet 5', 'Water Dispenser', '500', '380', '155', '', '']
    ]

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

    // Add summary rows as part of the table structure
    checkNewPage(20)
    
    // Calculate total table width
    const totalTableWidth = colWidths.reduce((sum, width) => sum + width, 0)
    
    // Total Usage row - single cell spanning all columns
    addRect(20, yPosition - 2, totalTableWidth, rowHeight)
    addText('Total Usage:', 22, yPosition + 4, { fontSize: 10, bold: true })
    yPosition += rowHeight
    
    // Estimated Cost row - single cell spanning all columns
    addRect(20, yPosition - 2, totalTableWidth, rowHeight)
    addText('Estimated Cost:', 22, yPosition + 4, { fontSize: 10, bold: true })
    yPosition += rowHeight

    // Add power usage summary text at the bottom of the chart
    yPosition += 20
    checkNewPage(60)
    
    // Power usage summary text with Aptos font
    doc.setFont('helvetica', 'normal') // Using helvetica as closest to Aptos in jsPDF
    doc.setFontSize(12)
    doc.setTextColor('#000000')
    
    const powerUsageText = "The outlet performance data shows a total power usage of 1,880 Wh across all monitored appliances, operating for a combined 735 hours, which resulted in an estimated monthly cost of P3,040.50. The air conditioner, running for 150 hours, recorded the highest consumption but remained under the suggested power limit at 450 Wh. In contrast, the television, operating for 140 hours, registered the lowest consumption and also stayed under the suggested limit at 300 Wh."
    
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

    // Table data for Power Saving Recommendation
    const powerSavingTableData = [
      ['Outlet 1', 'Aircon', '10', '500', '450', '450'],
      ['Outlet 2', 'Television', '5', '500', '300', ''],
      ['Outlet 3', 'Refrigerator', '15', '500', '400', ''],
      ['Outlet 4', 'Electric fan', '5', '500', '350', ''],
      ['Outlet 5', 'Water Dispenser', '6', '500', '380', '']
    ]

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
    
    const powerSavingAnalysisText = "The power-saving analysis shows that all appliances operated under the set power limit of 500 Wh, but further optimization is still possible. The air conditioner, with an actual usage of 450 Wh, stayed below the set limit, and a new recommended limit of 350 Wh could yield about 22% savings through reduced operating hours and optimized temperature settings. The television consumed 300 Wh, also under the limit, and with a new recommended limit of 250 Wh, it can achieve around 17% savings by minimizing standby use. The refrigerator, which recorded 400 Wh, remained under the set limit, and a new recommended limit of 380 Wh allows for modest savings of about 5%, as it requires continuous operation. The electric fan used 350 Wh, under the limit as well, and reducing it to a recommended 300 Wh could provide 14% savings if aligned with actual room occupancy. Finally, the water dispenser consumed 380 Wh, also under the limit, and with a new recommended limit of 320 Wh, it can achieve approximately 16% savings by reducing standby usage during off-hours. Collectively, these adjustments highlight that even appliances operating within limits can still be optimized, with potential overall monthly savings of 15–20%."
    
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
    addText('College of Computing and Multimedia Studies - Camarines Norte State College', 20, yPosition, { 
      fontSize: 9, 
      color: '#666666' 
    })
    yPosition += 5
    addText('For questions or concerns, please contact the system administrator.', 20, yPosition, { 
      fontSize: 9, 
      color: '#666666' 
    })

    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0]
    const departmentName = department === 'College of Computer and Multimedia Studies' ? 'CCMS' : department.replace(/\s+/g, '_')
    const filename = `CNSC_CCMS_Power_Report_${departmentName}_${timestamp}.pdf`

    // Save the PDF
    doc.save(filename)
  }

  const [deptOpen, setDeptOpen] = useState(false)
  const [timeSegment, setTimeSegment] = useState('Week')
  const [department, setDepartment] = useState('College of Computer and Multimedia Studies')
  const [searchQuery, setSearchQuery] = useState('')
  const [devices, setDevices] = useState<DeviceData[]>([])
  const [filteredDevices, setFilteredDevices] = useState<DeviceData[]>([])
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
        
        // Check if we have any non-zero data, if not, generate sample data
        const hasWeekData = weekEnergyData.some(dayData => dayData.some(energy => energy > 0))
        if (!hasWeekData) {
          console.log('No real data found for week, generating sample data')
          // Generate sample data for demonstration
          const sampleData = weekLabels.map(() => 
            filteredDevices.map((_, deviceIndex) => 
              Math.random() * 0.5 + 0.1 + (deviceIndex * 0.2) // Random values between 0.1-0.6 kW
            )
          )
          return {
            labels: weekLabels,
            energyUsage: sampleData
          }
        }
        
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
        
        // Check if we have any non-zero data, if not, generate sample data
        const hasMonthData = monthEnergyData.some(dayData => dayData.some(energy => energy > 0))
        if (!hasMonthData) {
          console.log('No real data found for month, generating sample data')
          // Generate sample data for demonstration
          const sampleData = monthLabels.map(() => 
            filteredDevices.map((_, deviceIndex) => 
              Math.random() * 0.5 + 0.1 + (deviceIndex * 0.2) // Random values between 0.1-0.6 kW
            )
          )
          return {
            labels: monthLabels,
            energyUsage: sampleData
          }
        }
        
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
        
        // Check if we have any non-zero data, if not, generate sample data
        const hasYearData = yearEnergyData.some(monthData => monthData.some(energy => energy > 0))
        if (!hasYearData) {
          console.log('No real data found for year, generating sample data')
          // Generate sample data for demonstration
          const sampleData = yearLabels.map(() => 
            filteredDevices.map((_, deviceIndex) => 
              Math.random() * 2.0 + 0.5 + (deviceIndex * 0.5) // Random values between 0.5-2.5 kW
            )
          )
          return {
            labels: yearLabels,
            energyUsage: sampleData
          }
        }
        
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
        
        // Check if we have any non-zero data, if not, generate sample data
        const hasDefaultWeekData = defaultWeekEnergyData.some((dayData: number[]) => dayData.some((energy: number) => energy > 0))
        if (!hasDefaultWeekData) {
          console.log('No real data found for default week, generating sample data')
          // Generate sample data for demonstration
          const sampleData = defaultWeekLabels.map(() => 
            filteredDevices.map((_, deviceIndex) => 
              Math.random() * 0.5 + 0.1 + (deviceIndex * 0.2) // Random values between 0.1-0.6 kW
            )
          )
          return {
            labels: defaultWeekLabels,
            energyUsage: sampleData
          }
        }
        
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

  const departments = [
    'College of Computer and Multimedia Studies',
    'Computer Laboratory 1',
    'Computer Laboratory 2', 
    'Computer Laboratory 3',
    "Dean's Office",
    'Faculty Office'
  ]

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
              status: outlet.relay_control?.status || 'OFF',
              power: outlet.sensor_data.power || 0,
              energy: outlet.sensor_data.energy || 0,
              current: outlet.sensor_data.current || 0,
              voltage: outlet.sensor_data.voltage || 0,
              power_factor: outlet.sensor_data.power_factor || 0,
              timestamp: outlet.sensor_data.timestamp || '',
              avg_power: todayLogs?.avg_power || 0,
              peak_power: todayLogs?.peak_power || 0,
              total_energy: todayLogs?.total_energy || 0, // This is in kW from daily logs
              lifetime_energy: lifetimeEnergyKw, // This is in kW from root level
              officeRoom: officeInfo,
              appliances: outlet.office_info?.appliance || 'Unassigned'
            }
            devicesArray.push(deviceData)
          }
        })

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
            officeRoom: d.officeRoom
          }))
        })
      }
    })

    return () => off(devicesRef, 'value', unsubscribe)
  }, [])

  // Filter devices based on selected department
  useEffect(() => {
    if (department === 'College of Computer and Multimedia Studies') {
      setFilteredDevices(devices)
    } else {
      const filtered = devices.filter(device => device.officeRoom === department)
      setFilteredDevices(filtered)
    }
  }, [department, devices])

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
    if (filteredDevices.length > 0) {
      // Current Power Usage: Sum of total_energy from today's daily_logs (already in kW)
      const currentTotalPowerSum = filteredDevices.reduce((sum, device) => {
        return sum + (device.total_energy || 0)
      }, 0) // Already in kW from database
      
      // Total Consumption: Sum of lifetime_energy from root level (already in kW)
      const currentTotalEnergySum = filteredDevices.reduce((sum, device) => {
        return sum + (device.lifetime_energy || 0)
      }, 0) // Already in kW from database
      
      // Store previous values for trend calculation
      setPreviousTotalPower(totalPower)
      setPreviousTotalEnergy(totalEnergy)
      
      setTotalPower(currentTotalPowerSum)
      setTotalEnergy(currentTotalEnergySum)
    } else {
      setTotalPower(0)
      setTotalEnergy(0)
    }
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
              
              // Always check schedule - main_status is just a manual override flag
              // The real control is through control.device which we will update based on schedule
              console.log(`Reports: Device ${outletKey} main status is ${currentMainStatus} - checking schedule anyway`)
              
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
              console.log(`Reports: Device ${outletKey} is in combined group - skipping individual daily limit check (monthly limit takes precedence)`)
            }
          }
        }
      } catch (error) {
        console.error('Reports: Error in power limit monitor:', error)
      }
    }
    
    // Run both functions immediately
    checkScheduleAndUpdateDevices()
    checkPowerLimitsAndTurnOffDevices()
    
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
    
    // Cleanup intervals on unmount
    return () => {
      clearInterval(scheduleInterval)
      clearInterval(powerLimitInterval)
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
            onClick={() => generatePDFReport()}
            title="Generate PDF Report"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6v-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Print Report
          </button>
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
        </div>
      </section>

      {/* Key Metrics Overview */}
      <section className="metrics-overview">
        {department !== 'College of Computer and Multimedia Studies' && (
          <div className="panel-subtitle">
            Showing data for {department} ({filteredDevices.length} devices)
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
                {(totalEnergy * 1000).toFixed(3)} Wh
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
              <div className="metric-title">Current Power Usage</div>
              <div className="metric-value">
                {(totalPower * 1000).toFixed(3)} Wh
              </div>
              <div className="metric-trend positive">
                Live power consumption
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
              <div className="metric-value">₱{currentBill.toFixed(2)}</div>
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
                                return `Energy Usage: ${value.toFixed(3)} Wh`
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
                            return `${label}: ${value.toFixed(3)} Wh`
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
                  const usageDisplay = `${(lifetimeEnergyKw * 1000).toFixed(3)} Wh`
                  
                  const currentEnergy = lifetimeEnergyKw // Already in kW from database
                  const percentage = currentTotalEnergy > 0 ? (currentEnergy / currentTotalEnergy) * 100 : 0
                  
                  return (
                    <div key={index} className="device-item">
                      <div className="device-info">
                        <span className="device-name">Outlet {device.outletId.split('_')[1]}</span>
                        <span className="device-usage">
                          {usageDisplay} ({percentage.toFixed(1)}%)
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
                    <p>No devices found in {department}</p>
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
                            return `${label}: ${value.toFixed(3)} Wh`
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
    </div>
  )
}
