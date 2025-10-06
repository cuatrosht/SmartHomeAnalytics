import React, { useState, useEffect, useRef } from 'react';
import { ref, onValue, off, update, remove, get } from 'firebase/database';
import { realtimeDb } from '../firebase/config';
import './UserManagment.css';

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

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface UserLog {
  id: string;
  user: string;
  role: string;
  action: string;
  timestamp: string;
  status: string;
  authProvider: string;
}

interface DeviceLog {
  id: string;
  user: string;
  activity: string;
  officeRoom: string;
  outletSource: string;
  applianceConnected: string;
  timestamp: string;
  userId?: string;
  userRole?: string;
}

type Props = { 
  onNavigate?: (key: string) => void;
  currentView?: string;
}

const UserManagment: React.FC<Props> = ({ onNavigate, currentView = 'users' }) => {
  // Helper function to format numbers with commas
  const formatNumber = (num: number, decimals: number = 3): string => {
    return num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    })
  }

  const [searchTerm, setSearchTerm] = useState('');
  const [userLogsSearchTerm, setUserLogsSearchTerm] = useState('');
  const [userLogsFilter, setUserLogsFilter] = useState<'all' | 'day' | 'week' | 'month' | 'year'>('all');
  const [users, setUsers] = useState<User[]>([]);
  const [userLogs, setUserLogs] = useState<UserLog[]>([]);
  const [deviceLogs, setDeviceLogs] = useState<DeviceLog[]>([]);
  const [deviceLogsSearchTerm, setDeviceLogsSearchTerm] = useState('');
  const [deviceLogsFilter, setDeviceLogsFilter] = useState<'all' | 'day' | 'week' | 'month' | 'year'>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [modalType, setModalType] = useState<'edit' | 'delete' | 'feedback' | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'faculty'>('faculty');
  const [feedback, setFeedback] = useState<{ success: boolean; message: string } | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState(
    currentView === 'userLogs' ? 'UserLogs' : 
    currentView === 'deviceLogs' ? 'Device Logs' : 
    'UserManagement'
  );
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0
  });
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const usersRef = ref(realtimeDb, 'users');
    const handleValue = (snapshot: any) => {
      const data = snapshot.val();
      if (data) {
        const userList: User[] = Object.entries(data).map(([uid, user]: any) => ({
          id: uid,
          name: user.displayName || ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || user.email || uid,
          email: user.email || '',
          role: user.role || 'faculty',
        }));
        setUsers(userList);
      } else {
        setUsers([]);
      }
    };
    onValue(usersRef, handleValue);
    return () => off(usersRef, 'value', handleValue);
  }, []);

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
          
          console.log(`UserManagement: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as any
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`UserManagement: Checking device ${outletKey}:`, {
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
              console.log(`UserManagement: Device ${outletKey} main status is ${currentMainStatus} - checking schedule anyway`)
              
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
                    console.log(`🔒 UserManagement: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  }
                }
              }
              
              console.log(`UserManagement: Schedule check for ${outletKey}:`, {
                currentControlState,
                shouldBeActive,
                newControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                console.log(`UserManagement: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
              } else {
                console.log(`UserManagement: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('UserManagement: Error in real-time scheduler:', error)
      }
    }
    
    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`UserManagement: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as any
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
              console.log(`UserManagement: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Get today's total energy consumption from daily_logs
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                
                console.log(`UserManagement: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
                  todayDateKey: todayDateKey,
                  exceedsLimit: todayTotalEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If today's energy exceeds power limit, turn off the device
                if (todayTotalEnergy >= powerLimit) {
                  console.log(`UserManagement: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`UserManagement: Device ${outletKey} turned OFF due to power limit exceeded`)
                }
              }
            } else {
              console.log(`UserManagement: Device ${outletKey} is in combined group - skipping individual daily limit check (monthly limit takes precedence)`)
            }
          }
        }
      } catch (error) {
        console.error('UserManagement: Error in power limit monitor:', error)
      }
    }
    
    // Run both functions immediately
    checkScheduleAndUpdateDevices()
    checkPowerLimitsAndTurnOffDevices()
    
    // Add manual test function for debugging
    ;(window as any).testUserManagementSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testUserManagementPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).checkUserManagementCurrentTime = () => {
      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()
      const currentDay = now.getDay()
      console.log('UserManagement current time debug:', {
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
  }, []);

  // Fetch user logs data
  useEffect(() => {
    const userLogsRef = ref(realtimeDb, 'user_logs');
    const handleUserLogsValue = (snapshot: any) => {
      const data = snapshot.val();
      if (data) {
        const logsList: UserLog[] = Object.entries(data).map(([logId, logData]: any) => ({
          id: logId,
          user: logData.user || 'Unknown',
          role: logData.userId ? getRoleFromUserId(logData.userId) : 'Unknown',
          action: logData.action || 'Unknown Action',
          timestamp: logData.timestamp || new Date().toISOString(),
          status: (logData.type === 'success' || logData.type === 'info') ? 'Success' : 'Failed',
          authProvider: logData.authProvider || 'email'
        }));
        // Sort by timestamp (newest first)
        logsList.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setUserLogs(logsList);
      } else {
        setUserLogs([]);
      }
    };
    onValue(userLogsRef, handleUserLogsValue);
    return () => off(userLogsRef, 'value', handleUserLogsValue);
  }, [users]);

  // Fetch device logs data
  useEffect(() => {
    const deviceLogsRef = ref(realtimeDb, 'device_logs');
    const handleDeviceLogsValue = (snapshot: any) => {
      const data = snapshot.val();
      if (data) {
        const logsList: DeviceLog[] = Object.entries(data).map(([logId, logData]: any) => ({
          id: logId,
          user: logData.user || 'Unknown',
          activity: logData.activity || 'Unknown Activity',
          officeRoom: logData.officeRoom || 'Unknown',
          outletSource: logData.outletSource || 'Unknown',
          applianceConnected: logData.applianceConnected || 'Unknown',
          timestamp: logData.timestamp || new Date().toISOString(),
          userId: logData.userId,
          userRole: logData.userRole
        }));
        // Sort by timestamp (newest first)
        logsList.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setDeviceLogs(logsList);
      } else {
        setDeviceLogs([]);
      }
    };
    onValue(deviceLogsRef, handleDeviceLogsValue);
    return () => off(deviceLogsRef, 'value', handleDeviceLogsValue);
  }, []);

  // Helper function to get user role from userId
  const getRoleFromUserId = (userId: string): string => {
    const user = users.find(u => u.id === userId);
    return user ? user.role : 'Unknown';
  };

  // Handle click outside dropdown to close it
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  // Update selectedOption when currentView changes
  useEffect(() => {
    if (currentView === 'userLogs') {
      setSelectedOption('UserLogs');
    } else if (currentView === 'deviceLogs') {
      setSelectedOption('Device Logs');
    } else if (currentView === 'users') {
      setSelectedOption('UserManagement');
    }
  }, [currentView]);

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
        console.error('UserManagement: Error fetching combined limit info:', error)
      }
    }
    
    fetchCombinedLimitInfo()
  }, [])

  const filteredUsers = users.filter(user =>
    user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Helper function to filter logs by time period
  const filterLogsByTimePeriod = (logs: UserLog[], period: 'all' | 'day' | 'week' | 'month' | 'year'): UserLog[] => {
    if (period === 'all') return logs;
    
    const now = new Date();
    const logDate = new Date();
    
    return logs.filter(log => {
      logDate.setTime(new Date(log.timestamp).getTime());
      
      switch (period) {
        case 'day':
          return logDate.toDateString() === now.toDateString();
        case 'week':
          const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          return logDate >= weekAgo;
        case 'month':
          return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear();
        case 'year':
          return logDate.getFullYear() === now.getFullYear();
        default:
          return true;
      }
    });
  };

  const filteredUserLogs = filterLogsByTimePeriod(
    userLogs.filter(log =>
      log.user.toLowerCase().includes(userLogsSearchTerm.toLowerCase()) ||
      log.action.toLowerCase().includes(userLogsSearchTerm.toLowerCase()) ||
      log.role.toLowerCase().includes(userLogsSearchTerm.toLowerCase())
    ),
    userLogsFilter
  );

  // Helper function to filter device logs by time period
  const filterDeviceLogsByTimePeriod = (logs: DeviceLog[], period: 'all' | 'day' | 'week' | 'month' | 'year'): DeviceLog[] => {
    if (period === 'all') return logs;
    
    const now = new Date();
    const logDate = new Date();
    
    return logs.filter(log => {
      logDate.setTime(new Date(log.timestamp).getTime());
      
      switch (period) {
        case 'day':
          return logDate.toDateString() === now.toDateString();
        case 'week':
          const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          return logDate >= weekAgo;
        case 'month':
          return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear();
        case 'year':
          return logDate.getFullYear() === now.getFullYear();
        default:
          return true;
      }
    });
  };

  const filteredDeviceLogs = filterDeviceLogsByTimePeriod(
    deviceLogs.filter(log =>
      log.user.toLowerCase().includes(deviceLogsSearchTerm.toLowerCase()) ||
      log.activity.toLowerCase().includes(deviceLogsSearchTerm.toLowerCase()) ||
      log.officeRoom.toLowerCase().includes(deviceLogsSearchTerm.toLowerCase()) ||
      log.outletSource.toLowerCase().includes(deviceLogsSearchTerm.toLowerCase()) ||
      log.applianceConnected.toLowerCase().includes(deviceLogsSearchTerm.toLowerCase())
    ),
    deviceLogsFilter
  );

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
        console.log(`UserManagement: Schedule check - Device power limit exceeded:`, {
          todayTotalEnergy: `${formatNumber(todayTotalEnergy * 1000)}W`,
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

  const openEditModal = (user: User) => {
    setSelectedUser(user);
    setEditRole((user.role as 'admin' | 'faculty') || 'faculty');
    setModalType('edit');
    setModalOpen(true);
  };

  const openDeleteModal = (user: User) => {
    setSelectedUser(user);
    setModalType('delete');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalType(null);
    setSelectedUser(null);
    setFeedback(null);
  };

  const handleEdit = (userId: string) => {
    const user = users.find(u => u.id === userId);
    if (user) openEditModal(user);
  };

  const handleDelete = (userId: string) => {
    const user = users.find(u => u.id === userId);
    if (user) openDeleteModal(user);
  };

  const handleUpdateRole = async () => {
    if (!selectedUser) return;
    if (selectedUser.role === editRole) {
      setFeedback({ success: false, message: 'No changes made.' });
      setModalType('feedback');
      return;
    }
    try {
      await update(ref(realtimeDb, `users/${selectedUser.id}`), { role: editRole });
      setFeedback({ success: true, message: 'Role updated successfully.' });
      setModalType('feedback');
    } catch (error) {
      setFeedback({ success: false, message: 'Failed to update role.' });
      setModalType('feedback');
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedUser) return;
    try {
      await remove(ref(realtimeDb, `users/${selectedUser.id}`));
      setFeedback({ success: true, message: 'User deleted successfully.' });
      setModalType('feedback');
    } catch (error) {
      setFeedback({ success: false, message: 'Failed to delete user.' });
      setModalType('feedback');
    }
  };

  const handleDropdownSelect = (option: string) => {
    setSelectedOption(option);
    setDropdownOpen(false);
    
    // Handle navigation based on selected option
    if (option === 'UserLogs' && onNavigate) {
      onNavigate('userLogs');
    } else if (option === 'Device Logs' && onNavigate) {
      onNavigate('deviceLogs');
    } else if (option === 'UserManagement' && onNavigate) {
      onNavigate('users');
    }
  };

  const toggleDropdown = () => {
    setDropdownOpen(!dropdownOpen);
  };

  return (
    <div className="user-management">
      <div className="um-header">
        <div className="um-header-left">
          <div className="um-user-info">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
            </svg>
            <span>
              {currentView === 'userLogs' ? 'User Logs' : 
               currentView === 'deviceLogs' ? 'Device Logs' : 
               'User Management'}
            </span>
          </div>
        </div>
        <div className="um-header-right">
          <div className={`um-dropdown-container ${dropdownOpen ? 'open' : ''}`} ref={dropdownRef}>
            <button className="um-dropdown-btn" onClick={toggleDropdown}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3 3v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {selectedOption}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="dropdown-arrow">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {dropdownOpen && (
              <div className="um-dropdown-menu">
                <button 
                  className={`um-dropdown-item ${selectedOption === 'UserManagement' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('UserManagement')}
                >
                  UserManagement
                </button>
                <button 
                  className={`um-dropdown-item ${selectedOption === 'UserLogs' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('UserLogs')}
                >
                  UserLogs
                </button>
                <button 
                  className={`um-dropdown-item ${selectedOption === 'Device Logs' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('Device Logs')}
                >
                  Device Logs
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="um-content">
        {currentView === 'userLogs' ? (
          <>
            <div className="um-content-header">
              <h2>User Logs</h2>
              <div className="um-controls">
                <div className="um-search">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                    <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <input 
                    type="text" 
                    placeholder="Search user logs..." 
                    value={userLogsSearchTerm}
                    onChange={(e) => setUserLogsSearchTerm(e.target.value)}
                  />
                </div>
                <div className="um-filter-dropdown">
                  <select 
                    value={userLogsFilter}
                    onChange={(e) => setUserLogsFilter(e.target.value as 'all' | 'day' | 'week' | 'month' | 'year')}
                    className="um-filter-select"
                  >
                    <option value="all">All Time</option>
                    <option value="day">Today</option>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                    <option value="year">This Year</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="um-table-container">
              <table className="um-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Action</th>
                    <th>Timestamp</th>
                    <th>Status</th>
                    <th>Auth Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUserLogs.length > 0 ? (
                    filteredUserLogs.map((log) => (
                      <tr key={log.id}>
                        <td>{log.user}</td>
                        <td>{log.role.charAt(0).toUpperCase() + log.role.slice(1)}</td>
                        <td>{log.action}</td>
                        <td>{new Date(log.timestamp).toLocaleString()}</td>
                        <td>
                          <span className={`status-badge ${log.status.toLowerCase()}`}>
                            {log.status}
                          </span>
                        </td>
                        <td>
                          <span className={`auth-provider-badge ${log.authProvider}`}>
                            {log.authProvider === 'google' ? 'Google' : 
                             log.authProvider === 'email' ? 'Email' : 
                             log.authProvider === 'system' ? 'System' : log.authProvider}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>
                        {userLogs.length === 0 ? 'No user logs found' : 'No logs match your search criteria'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : currentView === 'deviceLogs' ? (
          <>
            <div className="um-content-header">
              <h2>Device Activity</h2>
              <div className="um-controls">
                <div className="um-search">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                    <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <input 
                    type="text" 
                    placeholder="Search device logs..." 
                    value={deviceLogsSearchTerm}
                    onChange={(e) => setDeviceLogsSearchTerm(e.target.value)}
                  />
                </div>
                <div className="um-filter-dropdown">
                  <select 
                    value={deviceLogsFilter}
                    onChange={(e) => setDeviceLogsFilter(e.target.value as 'all' | 'day' | 'week' | 'month' | 'year')}
                    className="um-filter-select"
                  >
                    <option value="all">All Time</option>
                    <option value="day">Today</option>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                    <option value="year">This Year</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="um-table-container">
              <table className="um-table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Activity</th>
                        <th>Outlet/ Source</th>
                        <th>Appliance Connected</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                <tbody>
                  {filteredDeviceLogs.length > 0 ? (
                    filteredDeviceLogs.map((log) => (
                      <tr key={log.id}>
                        <td>{log.user}</td>
                        <td>{log.activity}</td>
                        <td>{log.outletSource}</td>
                        <td>{log.applianceConnected}</td>
                        <td>{new Date(log.timestamp).toLocaleString()}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>
                        {deviceLogs.length === 0 ? 'No device logs found' : 'No logs match your search criteria'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="um-content-header">
              <h2>Manage Users</h2>
              <div className="um-controls">
                <div className="um-search">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                    <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <input
                    type="text"
                    placeholder="Search users..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <button className="um-filter-btn">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 6h18M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>

            <div className="um-table-container">
              <table className="um-table">
                <thead>
                  <tr>
                    <th>No</th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Roles</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((user, idx) => (
                    <tr key={user.id}>
                      <td>{idx + 1}</td>
                      <td>{user.name}</td>
                      <td>{user.email}</td>
                      <td>{user.role.charAt(0).toUpperCase() + user.role.slice(1)}</td>
                      <td>
                        <div className="um-actions">
                          <button
                            className="action-btn edit-btn"
                            onClick={() => handleEdit(user.id)}
                            aria-label={`Edit ${user.name}`}
                            title="Edit user"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                              <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                          </button>
                          <button
                            className="action-btn delete-btn"
                            onClick={() => handleDelete(user.id)}
                            aria-label={`Delete ${user.name}`}
                            title="Delete user"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
            </div>
          </>
        )}
      </div>

      {/* Edit Modal */}
      {modalOpen && modalType === 'edit' && selectedUser && (
        <div className="um-modal-overlay">
          <div className="um-modal">
            <div className="um-modal-header edit">
              <span className="um-modal-icon" aria-hidden="true">
                {/* Pencil Icon */}
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/></svg>
              </span>
              <h3 className="um-modal-title">Edit User Role</h3>
            </div>
            <div className="um-modal-body">
              <p><strong>Name:</strong> {selectedUser.name}</p>
              <p><strong>Email:</strong> {selectedUser.email}</p>
              <label htmlFor="edit-role" className="um-modal-label">Role:</label>
              <select
                id="edit-role"
                value={editRole}
                onChange={e => setEditRole(e.target.value as 'admin' | 'faculty')}
              >
                <option value="admin">Admin</option>
                <option value="faculty">Faculty</option>
              </select>
            </div>
            <div className="um-modal-actions">
              <button className="um-modal-btn" onClick={handleUpdateRole}>Save</button>
              <button className="um-modal-btn cancel" onClick={closeModal}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {modalOpen && modalType === 'delete' && selectedUser && (
        <div className="um-modal-overlay">
          <div className="um-modal">
            <div className="um-modal-header delete">
              <span className="um-modal-icon" aria-hidden="true">
                {/* Trash Icon */}
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>
              </span>
              <h3 className="um-modal-title">Delete User</h3>
            </div>
            <div className="um-modal-body">
              <p>Are you sure you want to delete <strong>{selectedUser.name}</strong>?</p>
            </div>
            <div className="um-modal-actions">
              <button className="um-modal-btn delete" onClick={handleConfirmDelete}>Delete</button>
              <button className="um-modal-btn cancel" onClick={closeModal}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback Modal */}
      {modalOpen && modalType === 'feedback' && feedback && (
        <div className="um-modal-overlay">
          <div className="um-modal">
            <div className={`um-modal-header ${feedback.success ? 'success' : 'error'}`}>
              <span className="um-modal-icon" aria-hidden="true">
                {feedback.success ? (
                  // Check Icon
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>
                ) : (
                  // Exclamation Icon
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                )}
              </span>
              <h3 className="um-modal-title">{feedback.success ? 'Success' : 'Error'}</h3>
              <button className="um-modal-close" onClick={closeModal} aria-label="Close modal">&times;</button>
            </div>
            <div className="um-modal-body">
              <p>{feedback.message}</p>
            </div>
            <div className="um-modal-actions">
              <button className="um-modal-btn" onClick={closeModal}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagment;
