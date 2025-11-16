import React, { useState, useEffect, useRef } from 'react';
import { ref, onValue, off, update, remove, get } from 'firebase/database';
import { realtimeDb } from '../firebase/config';
import { logDeviceActivity } from '../utils/deviceLogging';
import { auth } from '../firebase/config';
import './UserManagment.css';

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
  const [userLogsCurrentPage, setUserLogsCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [users, setUsers] = useState<User[]>([]);
  const [userLogs, setUserLogs] = useState<UserLog[]>([]);
  const [deviceLogs, setDeviceLogs] = useState<DeviceLog[]>([]);
  const [deviceLogsSearchTerm, setDeviceLogsSearchTerm] = useState('');
  const [deviceLogsFilter, setDeviceLogsFilter] = useState<'all' | 'day' | 'week' | 'month' | 'year'>('all');
  const [deviceLogsCurrentPage, setDeviceLogsCurrentPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalType, setModalType] = useState<'edit' | 'delete' | 'feedback' | 'addOffice' | 'editOffice' | 'deleteOffice' | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'Coordinator'>('Coordinator');
  const [feedback, setFeedback] = useState<{ success: boolean; message: string } | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState(
    currentView === 'userLogs' ? 'UserLogs' : 
    currentView === 'deviceLogs' ? 'User Activity' : 
    currentView === 'offices' ? 'Offices' :
    'User & Management'
  );
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
  });
  // Track all department combined limits
  const [allDepartmentCombinedLimits, setAllDepartmentCombinedLimits] = useState<Record<string, {
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    device_control?: string;
    department?: string;
  }>>({});
  const [offices, setOffices] = useState<Array<{id: string, department: string, office: string}>>([]);
  const [newOffice, setNewOffice] = useState({ department: '', office: '' });
  const [editOffice, setEditOffice] = useState({ id: '', department: '', office: '' });
  const [selectedOffice, setSelectedOffice] = useState<{id: string, department: string, office: string} | null>(null);
  const [existingDepartments, setExistingDepartments] = useState<string[]>([]);
  const [departmentDropdownOpen, setDepartmentDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [currentElectricityRate, setCurrentElectricityRate] = useState<string>(''); // Current rate from database (for display)
  const [electricityRate, setElectricityRate] = useState<string>(''); // Input field value (for editing)
  const [electricityRateLoading, setElectricityRateLoading] = useState(false);
  const [electricityRateSaving, setElectricityRateSaving] = useState(false);
  const [electricityRateSuccessModal, setElectricityRateSuccessModal] = useState(false);

  // Load electricity rate from database
  useEffect(() => {
    const electricityRateRef = ref(realtimeDb, 'settings/electricity_rate');
    setElectricityRateLoading(true);
    
    const unsubscribe = onValue(electricityRateRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const rateValue = data.rate ? data.rate.toString() : '';
        setCurrentElectricityRate(rateValue); // Update display value from database
        // Only update input field if it's empty (initial load)
        if (!electricityRate) {
          setElectricityRate(rateValue);
        }
      } else {
        setCurrentElectricityRate('');
        if (!electricityRate) {
          setElectricityRate('');
        }
      }
      setElectricityRateLoading(false);
    }, (error) => {
      console.error('Error loading electricity rate:', error);
      setElectricityRateLoading(false);
    });
    
    return () => off(electricityRateRef, 'value', unsubscribe);
  }, []);

  useEffect(() => {
    const usersRef = ref(realtimeDb, 'users');
    const handleValue = (snapshot: any) => {
      const data = snapshot.val();
      if (data) {
        const userList: User[] = Object.entries(data).map(([uid, user]: any) => ({
          id: uid,
          name: user.displayName || ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || user.email || uid,
          email: user.email || '',
          role: user.role || 'Coordinator',
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
          
          // CRITICAL: Check monthly limit FIRST, then re-fetch fresh data
          await checkMonthlyLimitAndTurnOffDevices()
          
          // CRITICAL: Re-fetch device data AFTER monthly limit check
          // The monthly limit function may have set status='OFF' in Firebase
          // We need fresh data to respect those changes
          const freshSnapshot = await get(devicesRef)
          if (!freshSnapshot.exists()) {
            console.log('UserManagement: No device data after initial fetch')
            return
          }
          const freshDevicesData = freshSnapshot.val()
          console.log('🔄 UserManagement: Re-fetched device data to ensure fresh status')
          
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.
          
          console.log(`UserManagement: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(freshDevicesData)) {
            const deviceData = outletData as any
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`UserManagement: Checking device ${outletKey}:`, {
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
                console.log(`⚠️ UserManagement: Skipping ${outletKey} - status='OFF' (manually disabled or monthly limit exceeded)`)
                continue
              }
              
              // RESPECT disabled_by_unplug - if schedule is disabled by unplug, don't enable it
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`UserManagement: Device ${outletKey} is disabled by unplug - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`UserManagement: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
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
                console.log(`UserManagement: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
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
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, deviceDepartmentLimit.limitInfo.selectedOutlets)
                const combinedLimitWatts = deviceDepartmentLimit.limitInfo.combinedLimit
                const combinedLimitkW = combinedLimitWatts / 1000 // Convert to kW
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  // CRITICAL: If monthly limit exceeded, FORCE OFF and skip schedule check entirely
                  limitsExceeded = true
                  newControlState = 'off'
                  console.log(`🔒 UserManagement: FORCING ${outletKey} OFF - MONTHLY LIMIT EXCEEDED for department ${deviceDepartmentLimit.department} - SKIPPING SCHEDULE CHECK`)
                  
                  // CRITICAL: Always update device control to 'off' when monthly limit is exceeded
                  // This ensures devices are automatically turned off even if they're already on
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  console.log(`🔒 UserManagement: Enforced device_control='off' for ${outletKey} due to monthly limit exceeded in department ${deviceDepartmentLimit.department}`)
                }
              } else if (isInOldCombinedGroup && combinedLimitInfo?.enabled) {
                // For devices in old combined limit structure (backward compatibility): Check old combined limits
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitWatts = combinedLimitInfo.combinedLimit
                const combinedLimitkW = combinedLimitWatts / 1000 // Convert to kW
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  limitsExceeded = true
                  newControlState = 'off'
                  console.log(`🔒 UserManagement: FORCING ${outletKey} OFF - OLD COMBINED MONTHLY LIMIT EXCEEDED - SKIPPING SCHEDULE CHECK`)
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
                    console.log(`🔒 UserManagement: FORCING ${outletKey} OFF - INDIVIDUAL MONTHLY LIMIT EXCEEDED - SKIPPING SCHEDULE CHECK`)
                  }
                }
              } else {
                // Device is in combined group but detection failed - log warning and skip individual check
                console.log(`⚠️ UserManagement: Device ${outletKey} detection issue - isInCombinedGroup=${isInCombinedGroup}, deviceDepartmentLimit=${!!deviceDepartmentLimit}, isInOldCombinedGroup=${isInOldCombinedGroup} - SKIPPING INDIVIDUAL LIMIT CHECK`)
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
                console.log(`✅ UserManagement: Limits OK for ${outletKey} - Current state: ${currentControlState}, Schedule says: ${shouldBeActive ? 'ON' : 'OFF'}, New state: ${newControlState}`)
              }
              
              console.log(`UserManagement: Final status determination for ${outletKey}:`, {
                limitsExceeded: limitsExceeded,
                finalDecision: newControlState,
                currentState: currentControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup: isInCombinedGroup
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
            
            // Check if main_status is 'ON' - if so, skip automatic power limit enforcement (device is in bypass mode)
            if (currentMainStatus === 'ON') {
              console.log(`UserManagement: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual monthly limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`UserManagement: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
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
                
                console.log(`UserManagement: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000)}W`,
                  currentMonth: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
                  exceedsLimit: totalMonthlyEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If monthly energy exceeds power limit, turn off the device
                if (totalMonthlyEnergy >= powerLimit) {
                  console.log(`UserManagement: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(totalMonthlyEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
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
              console.log(`UserManagement: Device ${outletKey} is in combined group - checking combined group power limits`)
              
              // For devices in combined groups, check combined monthly limit
              if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
                const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
                const combinedLimitkW = combinedLimitInfo.combinedLimit / 1000 // Convert to kW
                
                console.log(`UserManagement: Combined group limit check for ${outletKey}:`, {
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(0)}W`,
                  combinedLimit: `${combinedLimitInfo.combinedLimit}W`,
                  exceedsLimit: totalMonthlyEnergy >= combinedLimitkW
                })
                
                if (totalMonthlyEnergy >= combinedLimitkW) {
                  console.log(`UserManagement: Combined monthly limit exceeded - turning off ${outletKey}`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`UserManagement: Device ${outletKey} turned OFF due to combined monthly limit exceeded`)
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('UserManagement: Error in power limit monitor:', error)
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
          
          console.log(`UserManagement: Monthly limit check - Total: ${(totalMonthlyEnergy * 1000).toFixed(0)}W / Limit: ${combinedLimitWatts}W`)
          
          if (totalMonthlyEnergy >= combinedLimitkW) {
            console.log(`UserManagement: Monthly limit exceeded! Turning off all devices in combined group.`)
            
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
                  console.log(`⚠️ UserManagement: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
                  skippedCount++
                  continue
                }
                
                // Turn off device control
                const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
                await update(controlRef, { device: 'off' })
                
                // Turn off main status to prevent immediate re-activation
                const mainStatusRef = ref(realtimeDb, `devices/${firebaseKey}/relay_control`)
                await update(mainStatusRef, { main_status: 'OFF' })
                
                console.log(`✅ UserManagement: TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
                successCount++
              } catch (error) {
                console.error(`❌ UserManagement: FAILED to turn off ${outletKey}:`, error)
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
              console.log(`🔒 UserManagement: Set combined_limit_settings/device_control='off' to prevent re-activation`)
            }
            
            console.log(`🔒 UserManagement: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
          } else {
            console.log('✅ UserManagement: Monthly limit not exceeded - devices can remain active')
            
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
              console.log(`✅ UserManagement: Set combined_limit_settings/device_control='on' (limit not exceeded)`)
            }
          }
        }
      } catch (error) {
        console.error('UserManagement: Error in monthly limit check:', error)
      }
    }

    // CRITICAL: Add a small delay before first run to ensure database state is fully loaded
    // This prevents devices from being incorrectly turned off when navigating to UserManagement.tsx
    const initialDelay = setTimeout(() => {
      checkScheduleAndUpdateDevices()
      checkPowerLimitsAndTurnOffDevices()
      checkMonthlyLimitAndTurnOffDevices()
    }, 500) // 500ms delay to ensure database state is ready
    
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
      // Close department dropdown when clicking outside
      setDepartmentDropdownOpen(false);
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
      setSelectedOption('User Activity');
    } else if (currentView === 'offices') {
      setSelectedOption('Offices');
    } else if (currentView === 'users') {
      setSelectedOption('User & Management');
    }
  }, [currentView]);

  // Real-time listener for combined limit info - listens to all departments
  useEffect(() => {
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    
    // Set up real-time listener for all departments
    const unsubscribe = onValue(combinedLimitRef, (snapshot) => {
      if (snapshot.exists()) {
        const allDepartmentsData = snapshot.val()
        console.log('UserManagement: Real-time update - all departments combined limit data:', allDepartmentsData)
        
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
        console.log('UserManagement: No combined limit settings found')
        setAllDepartmentCombinedLimits({})
        setCombinedLimitInfo({
          enabled: false,
          selectedOutlets: [],
          combinedLimit: 0,
          device_control: 'on'
        })
      }
    }, (error) => {
      console.error('UserManagement: Error listening to combined limit info:', error)
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

  // Fetch offices from database
  useEffect(() => {
    const officesRef = ref(realtimeDb, 'offices');
    const handleOfficesValue = (snapshot: any) => {
      const data = snapshot.val();
      if (data) {
        const officesList = Object.entries(data).map(([id, office]: any) => ({
          id,
          department: office.department || '',
          office: office.office || ''
        }));
        setOffices(officesList);
        
        // Extract unique departments for dropdown
        const departments = [...new Set(officesList.map(o => o.department))].filter(d => d);
        setExistingDepartments(departments);
      } else {
        setOffices([]);
        setExistingDepartments([]);
      }
    };
    onValue(officesRef, handleOfficesValue);
    return () => off(officesRef, 'value', handleOfficesValue);
  }, []);

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

  // Calculate pagination for user logs
  const userLogsTotalPages = Math.ceil(filteredUserLogs.length / itemsPerPage);
  const userLogsStartIndex = (userLogsCurrentPage - 1) * itemsPerPage;
  const userLogsEndIndex = userLogsStartIndex + itemsPerPage;
  const paginatedUserLogs = filteredUserLogs.slice(userLogsStartIndex, userLogsEndIndex);

  // Reset to page 1 when filters or search change
  useEffect(() => {
    setUserLogsCurrentPage(1);
  }, [userLogsSearchTerm, userLogsFilter]);

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

  // Calculate pagination for device logs
  const deviceLogsTotalPages = Math.ceil(filteredDeviceLogs.length / itemsPerPage);
  const deviceLogsStartIndex = (deviceLogsCurrentPage - 1) * itemsPerPage;
  const deviceLogsEndIndex = deviceLogsStartIndex + itemsPerPage;
  const paginatedDeviceLogs = filteredDeviceLogs.slice(deviceLogsStartIndex, deviceLogsEndIndex);

  // Reset to page 1 when filters or search change
  useEffect(() => {
    setDeviceLogsCurrentPage(1);
  }, [deviceLogsSearchTerm, deviceLogsFilter]);

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
        console.log(`UserManagement: Schedule check - Device monthly power limit exceeded:`, {
          totalMonthlyEnergy: `${formatNumber(totalMonthlyEnergy * 1000)}W`,
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

  const openEditModal = (user: User) => {
    setSelectedUser(user);
    setEditRole((user.role as 'admin' | 'Coordinator') || 'Coordinator');
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
    setSelectedOffice(null);
    setFeedback(null);
    setNewOffice({ department: '', office: '' });
    setEditOffice({ id: '', department: '', office: '' });
    setDepartmentDropdownOpen(false);
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

  const handleAddOffice = async () => {
    if (!newOffice.department.trim() || !newOffice.office.trim()) {
      setFeedback({ success: false, message: 'Please fill in both department and office fields.' });
      setModalType('feedback');
      return;
    }

    // Check for duplicate office name across ALL departments
    const trimmedDepartment = newOffice.department.trim();
    const trimmedOffice = newOffice.office.trim();
    
    const duplicateOffice = offices.find(office => 
      office.office.toLowerCase() === trimmedOffice.toLowerCase()
    );

    if (duplicateOffice) {
      setFeedback({ success: false, message: `Office "${trimmedOffice}" already exists in the "${duplicateOffice.department}" department. Please choose a different office name.` });
      setModalType('feedback');
      return;
    }

    try {
      const newOfficeRef = ref(realtimeDb, 'offices');
      const newOfficeData = {
        department: trimmedDepartment,
        office: trimmedOffice,
        createdAt: new Date().toISOString()
      };
      
      await update(newOfficeRef, {
        [Date.now().toString()]: newOfficeData
      });
      
      setFeedback({ success: true, message: 'Office added successfully.' });
      setModalType('feedback');
      setNewOffice({ department: '', office: '' });
    } catch (error) {
      console.error('Error adding office:', error);
      setFeedback({ success: false, message: 'Failed to add office.' });
      setModalType('feedback');
    }
  };

  const handleEditOffice = async () => {
    if (!editOffice.department.trim() || !editOffice.office.trim()) {
      setFeedback({ success: false, message: 'Please fill in both department and office fields.' });
      setModalType('feedback');
      return;
    }

    // Check for duplicate office name across ALL departments (excluding current office)
    const trimmedDepartment = editOffice.department.trim();
    const trimmedOffice = editOffice.office.trim();
    
    const duplicateOffice = offices.find(office => 
      office.id !== editOffice.id && // Exclude the current office being edited
      office.office.toLowerCase() === trimmedOffice.toLowerCase()
    );

    if (duplicateOffice) {
      setFeedback({ success: false, message: `Office "${trimmedOffice}" already exists in the "${duplicateOffice.department}" department. Please choose a different office name.` });
      setModalType('feedback');
      return;
    }

    try {
      const officeRef = ref(realtimeDb, `offices/${editOffice.id}`);
      const updatedOfficeData = {
        department: trimmedDepartment,
        office: trimmedOffice,
        updatedAt: new Date().toISOString()
      };
      
      await update(officeRef, updatedOfficeData);
      
      setFeedback({ success: true, message: 'Office updated successfully.' });
      setModalType('feedback');
      setEditOffice({ id: '', department: '', office: '' });
    } catch (error) {
      console.error('Error updating office:', error);
      setFeedback({ success: false, message: 'Failed to update office.' });
      setModalType('feedback');
    }
  };

  const handleDeleteOffice = async () => {
    if (!selectedOffice) return;
    
    try {
      const officeRef = ref(realtimeDb, `offices/${selectedOffice.id}`);
      await remove(officeRef);
      
      setFeedback({ success: true, message: 'Office deleted successfully.' });
      setModalType('feedback');
      setSelectedOffice(null);
    } catch (error) {
      console.error('Error deleting office:', error);
      setFeedback({ success: false, message: 'Failed to delete office.' });
      setModalType('feedback');
    }
  };

  const openEditOfficeModal = (office: {id: string, department: string, office: string}) => {
    setSelectedOffice(office);
    setEditOffice({ id: office.id, department: office.department, office: office.office });
    setModalType('editOffice');
    setModalOpen(true);
  };

  const openDeleteOfficeModal = (office: {id: string, department: string, office: string}) => {
    setSelectedOffice(office);
    setModalType('deleteOffice');
    setModalOpen(true);
  };

  const handleDropdownSelect = (option: string) => {
    setSelectedOption(option);
    setDropdownOpen(false);
    
    // Handle navigation based on selected option
    if (option === 'UserLogs' && onNavigate) {
      onNavigate('userLogs');
    } else if ((option === 'Device Logs' || option === 'User Activity') && onNavigate) {
      onNavigate('deviceLogs');
    } else if (option === 'Offices' && onNavigate) {
      onNavigate('offices');
    } else if ((option === 'UserManagement' || option === 'User & Management') && onNavigate) {
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
               currentView === 'deviceLogs' ? 'User Activity' : 
               currentView === 'offices' ? 'Offices' :
               'User & Management'}
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
                  className={`um-dropdown-item ${selectedOption === 'User & Management' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('User & Management')}
                >
                  User & Management
                </button>
                <button 
                  className={`um-dropdown-item ${selectedOption === 'UserLogs' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('UserLogs')}
                >
                  UserLogs
                </button>
                <button 
                  className={`um-dropdown-item ${selectedOption === 'User Activity' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('User Activity')}
                >
                  User Activity
                </button>
                <button 
                  className={`um-dropdown-item ${selectedOption === 'Offices' ? 'active' : ''}`}
                  onClick={() => handleDropdownSelect('Offices')}
                >
                  Offices
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="um-content">
        {/* Electricity Rate Settings Container - Only show in User & Management view */}
        {currentView === 'users' && (
        <div style={{ 
          display: 'flex', 
          gap: '20px', 
          marginBottom: '20px',
          flexWrap: 'wrap'
        }}>
          {/* Current Electricity Rate Display */}
          <div style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1), 0 2px 4px rgba(0,0,0,0.06)',
            border: 'none',
            flex: '1',
            minWidth: '250px',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{
              position: 'absolute',
              top: '-50%',
              right: '-50%',
              width: '200%',
              height: '200%',
              background: 'radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%)',
              borderRadius: '50%'
            }}></div>
            <div style={{ position: 'relative', zIndex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <div style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(255,255,255,0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backdropFilter: 'blur(10px)'
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: '#fff' }}>
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#fff', opacity: 0.9 }}>Current Rate</h3>
              </div>
              <div style={{ fontSize: '32px', fontWeight: '700', color: '#fff', marginTop: '8px', lineHeight: '1.2' }}>
                {electricityRateLoading ? (
                  <span style={{ fontSize: '16px', opacity: 0.8 }}>Loading...</span>
                ) : currentElectricityRate ? (
                  <>₱{parseFloat(currentElectricityRate).toFixed(2)}<span style={{ fontSize: '16px', fontWeight: '400', opacity: 0.8, marginLeft: '4px' }}>/kWh</span></>
                ) : (
                  <span style={{ fontSize: '16px', opacity: 0.8 }}>Not set</span>
                )}
              </div>
            </div>
          </div>

          {/* Electricity Rate Settings */}
          <div style={{
            backgroundColor: '#fff',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1), 0 2px 4px rgba(0,0,0,0.06)',
            border: '1px solid #e5e7eb',
            flex: '1',
            minWidth: '300px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: '#fff' }}>
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M17 21v-8H7v8M7 3v5h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: '#1f2937' }}>Update Rate</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: '1', minWidth: '180px' }}>
                <label style={{ fontSize: '14px', fontWeight: '500', color: '#374151' }}>
                  New Rate (₱/kWh)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={electricityRate}
                  onChange={(e) => setElectricityRate(e.target.value)}
                  placeholder="e.g., 9.38"
                  style={{
                    padding: '12px 16px',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '14px',
                    outline: 'none',
                    transition: 'all 0.2s',
                    background: '#fafafa',
                    fontWeight: '500'
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = '#6366f1';
                    e.target.style.background = '#fff';
                    e.target.style.boxShadow = '0 0 0 3px rgba(99, 102, 241, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '#e5e7eb';
                    e.target.style.background = '#fafafa';
                    e.target.style.boxShadow = 'none';
                  }}
                  disabled={electricityRateSaving}
                />
              </div>
              <button
                onClick={async () => {
                  if (!electricityRate || parseFloat(electricityRate) <= 0) {
                    setFeedback({ success: false, message: 'Please enter a valid electricity rate (greater than 0)' });
                    setModalType('feedback');
                    setModalOpen(true);
                    return;
                  }
                  setElectricityRateSaving(true);
                  try {
                    const electricityRateRef = ref(realtimeDb, 'settings/electricity_rate');
                    const savedRate = parseFloat(electricityRate);
                    
                    // Get current user info for logging
                    let currentUserName = 'Unknown User';
                    if (auth.currentUser) {
                      currentUserName = auth.currentUser.displayName || auth.currentUser.email || 'Authenticated User';
                    } else {
                      const userData = localStorage.getItem('currentUser');
                      if (userData) {
                        const parsedUser = JSON.parse(userData);
                        currentUserName = parsedUser.displayName || parsedUser.email || 'Unknown User';
                      }
                    }
                    
                    await update(electricityRateRef, {
                      rate: savedRate,
                      unit: 'PHP/kWh',
                      updated_at: new Date().toISOString(),
                      updated_by: currentUserName
                    });
                    
                    // Log the electricity rate update to device_logs (User Activity)
                    await logDeviceActivity(
                      `Updated electricity rate to ₱${savedRate.toFixed(2)}/kWh`,
                      'System Settings',
                      'System',
                      'Electricity Rate',
                      currentUserName
                    );
                    
                    // Update current rate display after successful save
                    setCurrentElectricityRate(savedRate.toString());
                    setElectricityRateSuccessModal(true);
                  } catch (error) {
                    console.error('Error saving electricity rate:', error);
                    setFeedback({ success: false, message: 'Failed to save electricity rate. Please try again.' });
                    setModalType('feedback');
                    setModalOpen(true);
                  } finally {
                    setElectricityRateSaving(false);
                  }
                }}
                disabled={electricityRateSaving || !electricityRate}
                style={{
                  padding: '12px 24px',
                  background: electricityRateSaving || !electricityRate 
                    ? 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)' 
                    : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: electricityRateSaving || !electricityRate ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  whiteSpace: 'nowrap',
                  boxShadow: electricityRateSaving || !electricityRate ? 'none' : '0 4px 6px rgba(102, 126, 234, 0.3)'
                }}
                onMouseEnter={(e) => {
                  if (!electricityRateSaving && electricityRate) {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 6px 12px rgba(102, 126, 234, 0.4)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!electricityRateSaving && electricityRate) {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 6px rgba(102, 126, 234, 0.3)';
                  }
                }}
              >
                {electricityRateSaving ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeDashoffset="32">
                        <animate attributeName="stroke-dasharray" dur="2s" values="0 32;16 16;0 32;0 32" repeatCount="indefinite"/>
                        <animate attributeName="stroke-dashoffset" dur="2s" values="0;-16;-32;-32" repeatCount="indefinite"/>
                      </circle>
                    </svg>
                    Saving...
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M17 21v-8H7v8M7 3v5h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Save Rate
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
        )}

        {currentView === 'offices' ? (
          <>
            <div className="um-content-header">
              <h2>Offices</h2>
              <div className="um-controls">
                <div className="um-search">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                    <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <input 
                    type="text" 
                    placeholder="Search offices..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <button 
                  className="um-add-btn"
                  onClick={() => {
                    setNewOffice({ department: '', office: '' });
                    setModalType('addOffice');
                    setModalOpen(true);
                  }}
                  title="Add new office"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Add Office
                </button>
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
                    <th>Department</th>
                    <th>Office</th>
                    <th style={{ textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {offices.length > 0 ? (
                    offices.map((office, index) => (
                      <tr key={office.id}>
                        <td>{index + 1}</td>
                        <td>{office.department}</td>
                        <td>{office.office}</td>
                        <td>
                          <div className="um-actions">
                            <button
                              className="action-btn edit-btn"
                              onClick={() => openEditOfficeModal(office)}
                              aria-label="Edit office"
                              title="Edit office"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                                <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                              </svg>
                            </button>
                            <button
                              className="action-btn delete-btn"
                              onClick={() => openDeleteOfficeModal(office)}
                              aria-label="Delete office"
                              title="Delete office"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                                <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>
                        No offices found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : currentView === 'userLogs' ? (
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
                  {paginatedUserLogs.length > 0 ? (
                    paginatedUserLogs.map((log) => (
                      <tr key={log.id}>
                        <td>{log.user}</td>
                        <td>{log.role === 'admin' ? 'GSO' : log.role === 'Coordinator' ? 'Coordinator' : log.role.charAt(0).toUpperCase() + log.role.slice(1)}</td>
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

            {/* Pagination Controls for User Logs */}
            {filteredUserLogs.length > itemsPerPage && (
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '1rem 0',
                marginTop: '1rem',
                borderTop: '1px solid #e5e7eb'
              }}>
                <div style={{ color: '#6b7280', fontSize: '0.875rem' }}>
                  Showing {userLogsStartIndex + 1} to {Math.min(userLogsEndIndex, filteredUserLogs.length)} of {filteredUserLogs.length} entries
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    onClick={() => setUserLogsCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={userLogsCurrentPage === 1}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      background: userLogsCurrentPage === 1 ? '#f3f4f6' : 'white',
                      color: userLogsCurrentPage === 1 ? '#9ca3af' : '#374151',
                      cursor: userLogsCurrentPage === 1 ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: '500',
                      transition: 'all 0.2s'
                    }}
                  >
                    Previous
                  </button>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {Array.from({ length: userLogsTotalPages }, (_, i) => i + 1)
                      .filter(page => {
                        // Show first page, last page, current page, and pages around current
                        if (page === 1 || page === userLogsTotalPages) return true;
                        if (Math.abs(page - userLogsCurrentPage) <= 1) return true;
                        return false;
                      })
                      .flatMap((page, index, array) => {
                        const elements: React.ReactNode[] = [];
                        if (index > 0 && array[index] - array[index - 1] > 1) {
                          elements.push(
                            <span key={`ellipsis-${index}`} style={{ padding: '0.5rem', color: '#6b7280' }}>
                              ...
                            </span>
                          );
                        }
                        elements.push(
                          <button
                            key={page}
                            onClick={() => setUserLogsCurrentPage(page)}
                            style={{
                              padding: '0.5rem 0.75rem',
                              border: '1px solid #e5e7eb',
                              borderRadius: '8px',
                              background: userLogsCurrentPage === page ? '#3b82f6' : 'white',
                              color: userLogsCurrentPage === page ? 'white' : '#374151',
                              cursor: 'pointer',
                              fontSize: '0.875rem',
                              fontWeight: '500',
                              minWidth: '2.5rem',
                              transition: 'all 0.2s'
                            }}
                          >
                            {page}
                          </button>
                        );
                        return elements;
                      })}
                  </div>
                  <button
                    onClick={() => setUserLogsCurrentPage(prev => Math.min(userLogsTotalPages, prev + 1))}
                    disabled={userLogsCurrentPage === userLogsTotalPages}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      background: userLogsCurrentPage === userLogsTotalPages ? '#f3f4f6' : 'white',
                      color: userLogsCurrentPage === userLogsTotalPages ? '#9ca3af' : '#374151',
                      cursor: userLogsCurrentPage === userLogsTotalPages ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: '500',
                      transition: 'all 0.2s'
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        ) : currentView === 'deviceLogs' ? (
          <>
            <div className="um-content-header">
              <h2>User Activity</h2>
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
                  {paginatedDeviceLogs.length > 0 ? (
                    paginatedDeviceLogs.map((log) => (
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

            {/* Pagination Controls for Device Logs */}
            {filteredDeviceLogs.length > itemsPerPage && (
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '1rem 0',
                marginTop: '1rem',
                borderTop: '1px solid #e5e7eb'
              }}>
                <div style={{ color: '#6b7280', fontSize: '0.875rem' }}>
                  Showing {deviceLogsStartIndex + 1} to {Math.min(deviceLogsEndIndex, filteredDeviceLogs.length)} of {filteredDeviceLogs.length} entries
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    onClick={() => setDeviceLogsCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={deviceLogsCurrentPage === 1}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      background: deviceLogsCurrentPage === 1 ? '#f3f4f6' : 'white',
                      color: deviceLogsCurrentPage === 1 ? '#9ca3af' : '#374151',
                      cursor: deviceLogsCurrentPage === 1 ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: '500',
                      transition: 'all 0.2s'
                    }}
                  >
                    Previous
                  </button>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {Array.from({ length: deviceLogsTotalPages }, (_, i) => i + 1)
                      .filter(page => {
                        // Show first page, last page, current page, and pages around current
                        if (page === 1 || page === deviceLogsTotalPages) return true;
                        if (Math.abs(page - deviceLogsCurrentPage) <= 1) return true;
                        return false;
                      })
                      .flatMap((page, index, array) => {
                        const elements: React.ReactNode[] = [];
                        if (index > 0 && array[index] - array[index - 1] > 1) {
                          elements.push(
                            <span key={`ellipsis-${index}`} style={{ padding: '0.5rem', color: '#6b7280' }}>
                              ...
                            </span>
                          );
                        }
                        elements.push(
                          <button
                            key={page}
                            onClick={() => setDeviceLogsCurrentPage(page)}
                            style={{
                              padding: '0.5rem 0.75rem',
                              border: '1px solid #e5e7eb',
                              borderRadius: '8px',
                              background: deviceLogsCurrentPage === page ? '#3b82f6' : 'white',
                              color: deviceLogsCurrentPage === page ? 'white' : '#374151',
                              cursor: 'pointer',
                              fontSize: '0.875rem',
                              fontWeight: '500',
                              minWidth: '2.5rem',
                              transition: 'all 0.2s'
                            }}
                          >
                            {page}
                          </button>
                        );
                        return elements;
                      })}
                  </div>
                  <button
                    onClick={() => setDeviceLogsCurrentPage(prev => Math.min(deviceLogsTotalPages, prev + 1))}
                    disabled={deviceLogsCurrentPage === deviceLogsTotalPages}
                    style={{
                      padding: '0.5rem 1rem',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      background: deviceLogsCurrentPage === deviceLogsTotalPages ? '#f3f4f6' : 'white',
                      color: deviceLogsCurrentPage === deviceLogsTotalPages ? '#9ca3af' : '#374151',
                      cursor: deviceLogsCurrentPage === deviceLogsTotalPages ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: '500',
                      transition: 'all 0.2s'
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
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
                      <td>{user.role === 'admin' ? 'GSO' : user.role.charAt(0).toUpperCase() + user.role.slice(1)}</td>
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
                onChange={e => setEditRole(e.target.value as 'admin' | 'Coordinator')}
              >
                <option value="admin">GSO</option>
                <option value="Coordinator">Coordinator</option>
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

      {/* Add Office Modal */}
      {modalOpen && modalType === 'addOffice' && (
        <div className="um-modal-overlay">
          <div className="um-modal" style={{
            maxWidth: '500px',
            width: '90%',
            borderRadius: '16px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            backdropFilter: 'blur(8px)',
            background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)'
          }}>
            <div className="um-modal-header" style={{
              background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
              color: 'white',
              padding: '2rem 2rem 1.5rem 2rem',
              borderRadius: '16px 16px 0 0',
              textAlign: 'center',
              position: 'relative',
              overflow: 'hidden'
            }}>
              <div style={{
                position: 'absolute',
                top: '-50%',
                right: '-20%',
                width: '120px',
                height: '120px',
                background: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '50%',
                zIndex: 0
              }}></div>
              <div style={{
                position: 'absolute',
                bottom: '-30%',
                left: '-10%',
                width: '80px',
                height: '80px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '50%',
                zIndex: 0
              }}></div>
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div style={{
                  width: '64px',
                  height: '64px',
                  background: 'rgba(255, 255, 255, 0.2)',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1rem auto',
                  backdropFilter: 'blur(10px)',
                  border: '2px solid rgba(255, 255, 255, 0.3)'
                }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                </div>
                <h3 style={{
                  margin: 0,
                  fontSize: '1.5rem',
                  fontWeight: '700',
                  letterSpacing: '-0.025em'
                }}>Add New Office</h3>
                <p style={{
                  margin: '0.5rem 0 0 0',
                  fontSize: '0.875rem',
                  opacity: 0.9,
                  fontWeight: '400'
                }}>Create a new office entry for your organization</p>
              </div>
            </div>
            
            <div className="um-modal-body" style={{
              padding: '2rem',
              background: 'white'
            }}>
              <div style={{ marginBottom: '1.5rem' }}>
                <label htmlFor="department" style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  color: '#374151',
                  marginBottom: '0.5rem',
                  letterSpacing: '0.025em',
                  textAlign: 'left'
                }}>Department</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="department"
                    type="text"
                    value={newOffice.department}
                    onChange={(e) => {
                      setNewOffice({ ...newOffice, department: e.target.value });
                      setDepartmentDropdownOpen(true);
                    }}
                    placeholder="Enter or select department"
                    style={{
                      width: '100%',
                      padding: '0.875rem 1rem',
                      border: '2px solid #e5e7eb',
                      borderRadius: '12px',
                      fontSize: '0.875rem',
                      fontWeight: '500',
                      background: '#fafafa',
                      transition: 'all 0.2s ease',
                      outline: 'none',
                      boxSizing: 'border-box'
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = '#3b82f6';
                      e.target.style.background = 'white';
                      e.target.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                      setDepartmentDropdownOpen(true);
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = '#e5e7eb';
                      e.target.style.background = '#fafafa';
                      e.target.style.boxShadow = 'none';
                    }}
                  />
                  {departmentDropdownOpen && existingDepartments.length > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      background: 'white',
                      border: '2px solid #e5e7eb',
                      borderRadius: '12px',
                      boxShadow: '0 10px 25px rgba(0, 0, 0, 0.15)',
                      zIndex: 1000,
                      maxHeight: '200px',
                      overflowY: 'auto',
                      marginTop: '4px'
                    }}>
                      {existingDepartments
                        .filter(dept => dept.toLowerCase().includes(newOffice.department.toLowerCase()))
                        .map((dept, index) => (
                          <div
                            key={index}
                            onClick={() => {
                              setNewOffice({ ...newOffice, department: dept });
                              setDepartmentDropdownOpen(false);
                            }}
                            style={{
                              padding: '0.75rem 1rem',
                              cursor: 'pointer',
                              borderBottom: '1px solid #f3f4f6',
                              fontSize: '0.875rem',
                              fontWeight: '500',
                              color: '#374151',
                              transition: 'all 0.15s ease'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = '#f8fafc';
                              e.currentTarget.style.color = '#1f2937';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = 'white';
                              e.currentTarget.style.color = '#374151';
                            }}
                          >
                            {dept}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </div>
              
              <div>
                <label htmlFor="office" style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  color: '#374151',
                  marginBottom: '0.5rem',
                  letterSpacing: '0.025em',
                  textAlign: 'left'
                }}>Office Name</label>
                <input
                  id="office"
                  type="text"
                  value={newOffice.office}
                  onChange={(e) => setNewOffice({ ...newOffice, office: e.target.value })}
                  placeholder="Enter office name"
                  style={{
                    width: '100%',
                    padding: '0.875rem 1rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '12px',
                    fontSize: '0.875rem',
                    fontWeight: '500',
                    background: '#fafafa',
                    transition: 'all 0.2s ease',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = '#3b82f6';
                    e.target.style.background = 'white';
                    e.target.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '#e5e7eb';
                    e.target.style.background = '#fafafa';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>
            
            <div className="um-modal-actions" style={{
              padding: '1rem 2rem 1.5rem 2rem',
              background: 'linear-gradient(145deg, #f8fafc 0%, #ffffff 100%)',
              borderRadius: '0 0 16px 16px',
              display: 'flex',
              gap: '0.75rem',
              justifyContent: 'flex-end'
            }}>
              <button 
                className="um-modal-btn cancel" 
                onClick={closeModal}
                style={{
                  background: 'white',
                  color: '#6b7280',
                  border: '2px solid #e5e7eb',
                  padding: '0.75rem 1.5rem',
                  borderRadius: '10px',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  minWidth: '100px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#d1d5db';
                  e.currentTarget.style.color = '#374151';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#e5e7eb';
                  e.currentTarget.style.color = '#6b7280';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Cancel
              </button>
              <button 
                className="um-modal-btn" 
                onClick={handleAddOffice}
                style={{
                  background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
                  color: 'white',
                  border: 'none',
                  padding: '0.75rem 1.5rem',
                  borderRadius: '10px',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  minWidth: '100px',
                  boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 20px rgba(59, 130, 246, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.3)';
                }}
              >
                Save Office
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Office Modal */}
      {modalOpen && modalType === 'editOffice' && selectedOffice && (
        <div className="um-modal-overlay">
          <div className="um-modal" style={{
            maxWidth: '500px',
            width: '90%',
            borderRadius: '16px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            backdropFilter: 'blur(8px)',
            background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)'
          }}>
            <div className="um-modal-header" style={{
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              color: 'white',
              padding: '2rem 2rem 1.5rem 2rem',
              borderRadius: '16px 16px 0 0',
              textAlign: 'center',
              position: 'relative',
              overflow: 'hidden'
            }}>
              <div style={{
                position: 'absolute',
                top: '-50%',
                right: '-20%',
                width: '120px',
                height: '120px',
                background: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '50%',
                zIndex: 0
              }}></div>
              <div style={{
                position: 'absolute',
                bottom: '-30%',
                left: '-10%',
                width: '80px',
                height: '80px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '50%',
                zIndex: 0
              }}></div>
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div style={{
                  width: '64px',
                  height: '64px',
                  background: 'rgba(255, 255, 255, 0.2)',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1rem auto',
                  backdropFilter: 'blur(10px)',
                  border: '2px solid rgba(255, 255, 255, 0.3)'
                }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </div>
                <h3 style={{
                  margin: 0,
                  fontSize: '1.5rem',
                  fontWeight: '700',
                  letterSpacing: '-0.025em'
                }}>Edit Office</h3>
                <p style={{
                  margin: '0.5rem 0 0 0',
                  fontSize: '0.875rem',
                  opacity: 0.9,
                  fontWeight: '400'
                }}>Update office information</p>
              </div>
            </div>
            
            <div className="um-modal-body" style={{
              padding: '2rem',
              background: 'white'
            }}>
              <div style={{ marginBottom: '1.5rem' }}>
                <label htmlFor="edit-department" style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  color: '#374151',
                  marginBottom: '0.5rem',
                  letterSpacing: '0.025em',
                  textAlign: 'left'
                }}>Department</label>
                <input
                  id="edit-department"
                  type="text"
                  value={editOffice.department}
                  onChange={(e) => setEditOffice({ ...editOffice, department: e.target.value })}
                  placeholder="Enter department"
                  style={{
                    width: '100%',
                    padding: '0.875rem 1rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '12px',
                    fontSize: '0.875rem',
                    fontWeight: '500',
                    background: '#fafafa',
                    transition: 'all 0.2s ease',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = '#10b981';
                    e.target.style.background = 'white';
                    e.target.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '#e5e7eb';
                    e.target.style.background = '#fafafa';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
              
              <div>
                <label htmlFor="edit-office" style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  color: '#374151',
                  marginBottom: '0.5rem',
                  letterSpacing: '0.025em',
                  textAlign: 'left'
                }}>Office Name</label>
                <input
                  id="edit-office"
                  type="text"
                  value={editOffice.office}
                  onChange={(e) => setEditOffice({ ...editOffice, office: e.target.value })}
                  placeholder="Enter office name"
                  style={{
                    width: '100%',
                    padding: '0.875rem 1rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '12px',
                    fontSize: '0.875rem',
                    fontWeight: '500',
                    background: '#fafafa',
                    transition: 'all 0.2s ease',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = '#10b981';
                    e.target.style.background = 'white';
                    e.target.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '#e5e7eb';
                    e.target.style.background = '#fafafa';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>
            
            <div className="um-modal-actions" style={{
              padding: '1rem 2rem 1.5rem 2rem',
              background: 'linear-gradient(145deg, #f8fafc 0%, #ffffff 100%)',
              borderRadius: '0 0 16px 16px',
              display: 'flex',
              gap: '0.75rem',
              justifyContent: 'flex-end'
            }}>
              <button 
                className="um-modal-btn cancel" 
                onClick={closeModal}
                style={{
                  background: 'white',
                  color: '#6b7280',
                  border: '2px solid #e5e7eb',
                  padding: '0.75rem 1.5rem',
                  borderRadius: '10px',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  minWidth: '100px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#d1d5db';
                  e.currentTarget.style.color = '#374151';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#e5e7eb';
                  e.currentTarget.style.color = '#6b7280';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Cancel
              </button>
              <button 
                className="um-modal-btn" 
                onClick={handleEditOffice}
                style={{
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  color: 'white',
                  border: 'none',
                  padding: '0.75rem 1.5rem',
                  borderRadius: '10px',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  minWidth: '100px',
                  boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 20px rgba(16, 185, 129, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.3)';
                }}
              >
                Update Office
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Office Modal */}
      {modalOpen && modalType === 'deleteOffice' && selectedOffice && (
        <div className="um-modal-overlay">
          <div className="um-modal">
            <div className="um-modal-header delete">
              <span className="um-modal-icon" aria-hidden="true">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                  <path d="M10 11v6M14 11v6"/>
                </svg>
              </span>
              <h3 className="um-modal-title">Delete Office</h3>
            </div>
            <div className="um-modal-body">
              <p>Are you sure you want to delete <strong>{selectedOffice.department} - {selectedOffice.office}</strong>?</p>
              <p style={{ color: '#ef4444', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                This action cannot be undone.
              </p>
            </div>
            <div className="um-modal-actions">
              <button className="um-modal-btn delete" onClick={handleDeleteOffice}>Delete</button>
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

      {/* Electricity Rate Success Modal */}
      {electricityRateSuccessModal && (
        <div className="um-modal-overlay" onClick={() => setElectricityRateSuccessModal(false)}>
          <div className="um-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="um-modal-header success">
              <span className="um-modal-icon" aria-hidden="true">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7"/>
                </svg>
              </span>
              <h3 className="um-modal-title">Success</h3>
              <button 
                className="um-modal-close" 
                onClick={() => setElectricityRateSuccessModal(false)} 
                aria-label="Close modal"
              >
                &times;
              </button>
            </div>
            <div className="um-modal-body">
              <p style={{ fontSize: '16px', marginBottom: '8px', fontWeight: '500' }}>Electricity rate saved successfully!</p>
              <p style={{ fontSize: '14px', color: '#6b7280', margin: 0 }}>
                The new rate of <strong style={{ color: '#1f2937' }}>₱{currentElectricityRate ? parseFloat(currentElectricityRate).toFixed(2) : '0.00'}/kWh</strong> has been updated in the database.
              </p>
            </div>
            <div className="um-modal-actions">
              <button 
                className="um-modal-btn primary" 
                onClick={() => setElectricityRateSuccessModal(false)}
                style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  border: 'none',
                  color: '#fff'
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagment;

