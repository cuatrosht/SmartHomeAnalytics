import React, { useState, useEffect, useRef } from 'react'
import { ref, onValue, off, update, remove, get } from 'firebase/database'
import { realtimeDb } from '../firebase/config'
import { logCombinedLimitActivity, logIndividualLimitActivity, logScheduleActivity, logDeviceControlActivity } from '../utils/deviceLogging'
import { logger, throttledLog } from '../utils/logger'
import './SetUp.css'

// Helper function to format numbers with commas
const formatNumber = (num: number, decimals: number = 3): string => {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

// Helper function to format office name with proper capitalization
const formatOfficeName = (officeName: string): string => {
  return officeName
    .split(/[\s-]+/) // Split by spaces or hyphens
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

const formatDepartmentName = (departmentName: string): string => {
  return departmentName
    .split(/[\s-]+/) // Split by spaces or hyphens
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
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
    return `${formatNumber(totalMonthlyEnergy * 1000)} Wh`
  } catch (error) {
    console.error('Error calculating monthly energy:', error)
    return '0.000 Wh'
  }
}

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
      
      // Convert display format to Firebase format - replace ALL spaces/special chars
      const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
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

// Helper function to get department-specific combined limit path
const getDepartmentCombinedLimitPath = (department: string) => {
  if (!department) return 'combined_limit_settings'
  return `combined_limit_settings/${department}`
}

// Function to check and enforce combined monthly limits
const checkCombinedMonthlyLimit = async (devicesData: any, combinedLimitInfo: any) => {
  try {
    console.log('🔍 Monthly limit check - Input data:', {
      combinedLimitInfo,
      devicesDataKeys: Object.keys(devicesData || {}),
      enabled: combinedLimitInfo?.enabled,
      selectedOutlets: combinedLimitInfo?.selectedOutlets,
      combinedLimit: combinedLimitInfo?.combinedLimit,
      department: combinedLimitInfo?.department
    })
    
    if (!combinedLimitInfo?.enabled || !combinedLimitInfo?.selectedOutlets || combinedLimitInfo.selectedOutlets.length === 0) {
      console.log('🚫 Monthly limit check skipped - not enabled or no outlets selected')
      return
    }
    
    if (!combinedLimitInfo?.department) {
      console.log('🚫 Monthly limit check skipped - no department specified')
      return
    }
    
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const combinedLimitWatts = combinedLimitInfo.combinedLimit
    
    const departmentPath = getDepartmentCombinedLimitPath(combinedLimitInfo.department)
    
    // CRITICAL: Handle "No Limit" case - always allow devices to be ON
    if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
      console.log('✅ SetUp: Combined limit is set to "No Limit" or 0 - setting device_control to "on"')
      const combinedLimitRef = ref(realtimeDb, departmentPath)
      const currentSettings = await get(combinedLimitRef)
      const currentDeviceControl = currentSettings.val()?.device_control
      const currentEnforcementReason = currentSettings.val()?.enforcement_reason
      
      // Only update if device_control is not already 'on' or enforcement_reason is not empty
      if (currentDeviceControl !== 'on' || currentEnforcementReason !== '') {
        await update(combinedLimitRef, {
          device_control: 'on',
          enforcement_reason: ''
        })
        console.log(`✅ SetUp: Set ${departmentPath}/device_control='on' (No Limit set)`)
      }
      return
    }
    
    console.log('📊 Monthly limit check results:', {
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
      const combinedLimitRef = ref(realtimeDb, departmentPath)
      const currentSettings = await get(combinedLimitRef)
      const currentDeviceControl = currentSettings.val()?.device_control
      
      // If device_control is already 'off', skip all updates to prevent spam
      if (currentDeviceControl === 'off') {
        console.log(`✅ SetUp: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
        return
      }
      
      console.log('🚨 MONTHLY LIMIT EXCEEDED!')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
      console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP...')
      
      // Turn off all devices in the combined limit group (respecting override/bypass mode)
      const turnOffPromises = combinedLimitInfo.selectedOutlets.map(async (outletKey: string) => {
        try {
          // Convert display format to Firebase format - replace ALL spaces/special chars
          const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
          const deviceData = devicesData[firebaseKey]
          
          // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
          const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
          if (currentMainStatus === 'ON') {
            console.log(`⚠️ SetUp: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
            return { outletKey, success: true, skipped: true, reason: 'Bypass mode active' }
          }
          
          // Get current control state before turning off
          const currentControlState = deviceData?.control?.device || 'off'
          
          // Turn off device control
          const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
          await update(controlRef, { device: 'off' })
          
          // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
          // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
          // For idle devices, leave status as is - the display logic will show "Inactive" when control='off'
          if (currentControlState === 'on') {
            // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
            console.log(`✅ SetUp: Device ${outletKey} (${firebaseKey}) was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
          } else {
            // Device was already off - safe to set status='OFF'
            const statusRef = ref(realtimeDb, `devices/${firebaseKey}`)
            await update(statusRef, { status: 'OFF' })
            console.log(`✅ SetUp: TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
          }
          return { outletKey, success: true }
        } catch (error) {
          console.error(`❌ SetUp: FAILED to turn off ${outletKey}:`, error)
          return { outletKey, success: false, error }
        }
      })
      
      // Wait for all turn-off operations to complete
      const results = await Promise.all(turnOffPromises)
      const successCount = results.filter(r => r.success && !r.skipped).length
      const skippedCount = results.filter(r => r.skipped).length
      const failCount = results.filter(r => !r.success && !r.skipped).length
      
      // CRITICAL: Set department-specific combined_limit_settings/device_control to "off" to prevent devices from turning back ON
      // We already checked above, but double-check to be safe
      const finalSettings = await get(combinedLimitRef)
      const finalDeviceControl = finalSettings.val()?.device_control
      
      // Only update if device_control is not already 'off' (avoid unnecessary writes)
      if (finalDeviceControl !== 'off') {
        await update(combinedLimitRef, {
          device_control: 'off',
          last_enforcement: new Date().toISOString(),
          enforcement_reason: 'Monthly limit exceeded'
        })
        console.log(`🔒 SetUp: Set ${departmentPath}/device_control='off' to prevent re-activation`)
      } else {
        console.log(`✅ SetUp: device_control already 'off' - skipping update to prevent spam`)
      }
      
      console.log(`🔒 SetUp: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
    } else {
      console.log('✅ Monthly limit not exceeded - devices can remain active')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
      
      // Set department-specific combined_limit_settings/device_control to "on" to allow devices to turn ON
      const combinedLimitRef = ref(realtimeDb, departmentPath)
      const currentSettings = await get(combinedLimitRef)
      const currentDeviceControl = currentSettings.val()?.device_control
      const currentEnforcementReason = currentSettings.val()?.enforcement_reason
      
      // CRITICAL: Always update device_control to 'on' when limit is not exceeded
      // This ensures devices can turn ON based on schedule
      // Only skip if already 'on' AND enforcement_reason is already empty (to prevent spam)
      if (currentDeviceControl !== 'on' || (currentEnforcementReason && currentEnforcementReason !== '')) {
        await update(combinedLimitRef, {
          device_control: 'on',
          enforcement_reason: ''
        })
        console.log(`✅ SetUp: Set ${departmentPath}/device_control='on' (limit not exceeded) - allowing devices to turn ON`)
      } else {
        console.log(`✅ SetUp: device_control already 'on' and enforcement_reason already cleared - no update needed`)
      }
    }
  } catch (error) {
    console.error('❌ Error checking combined monthly limit:', error)
  }
}

// Function to remove a device from combined group when monthly limit is exceeded
const removeDeviceFromCombinedGroup = async (outletKey: string, department?: string): Promise<{
  success: boolean;
  reason?: string;
}> => {
  try {
    console.log(`🔧 Attempting to remove ${outletKey} from combined group due to monthly limit exceeded`)
    
    if (!department) {
      return { success: false, reason: 'No department specified' }
    }
    
    // Get current combined limit settings for the department
    const departmentPath = getDepartmentCombinedLimitPath(department)
    const combinedLimitRef = ref(realtimeDb, departmentPath)
    const combinedLimitSnapshot = await get(combinedLimitRef)
    
    if (!combinedLimitSnapshot.exists()) {
      return { success: false, reason: 'No combined limit settings found for department' }
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
    
    // IMPORTANT: When device is removed from combined group, turn it OFF
    // This is because it's no longer protected by combined monthly limit
    // and will now be subject to individual monthly limits
    try {
      // Get current control state before turning off
      const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
      const deviceSnapshot = await get(deviceRef)
      const currentControlState = deviceSnapshot.val()?.control?.device || 'off'
      
      const deviceControlRef = ref(realtimeDb, `devices/${outletKey}/control`)
      await update(deviceControlRef, { device: 'off' })
      
      // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
      // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
      if (currentControlState === 'on') {
        // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
        console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
      } else {
        // Device was already off - safe to set status='OFF'
        const deviceStatusRef = ref(realtimeDb, `devices/${outletKey}`)
        await update(deviceStatusRef, { status: 'OFF' })
        console.log(`🔒 SetUp: Turned OFF ${outletKey} after removing from combined group (now subject to individual monthly limits)`)
      }
    } catch (error) {
      console.error(`❌ Error turning off device ${outletKey} after removal from combined group:`, error)
    }
    
    console.log(`✅ Successfully removed ${outletKey} from combined group and turned it OFF. Remaining outlets: ${updatedSelectedOutlets.length}`)
    
    return { success: true, reason: `Device removed from combined group and turned OFF. Remaining outlets: ${updatedSelectedOutlets.length}` }
  } catch (error) {
    console.error('❌ Error removing device from combined group:', error)
    return { success: false, reason: 'Failed to remove device from combined group' }
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
    if (!combinedLimitInfo.enabled || combinedLimitInfo.selectedOutlets.length === 0) {
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

// Device interface for type safety
interface Device {
  id: string
  outletName: string
  officeRoom: string
  appliances: string
  enablePowerScheduling: boolean
  limit: string
  powerUsage: string
  currentAmpere: string
  todayUsage: string
  monthUsage?: string
  status: 'Active' | 'Inactive' | 'Warning' | 'Idle' | 'UNPLUG'
  department?: string
  schedule?: {
    timeRange: string
    frequency: string
  }
}

// Firebase device data interface
interface FirebaseDeviceData {
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
  power_limit: number
  lifetime_energy?: number
  daily_logs?: {
    [date: string]: {
      avg_power: number
      peak_power: number
      total_energy: number
      lifetime_energy: number
    }
  }
  control?: {
    device: string
  }
  office_info?: {
    assigned_date: string
    office: string
    department?: string
    appliance?: string
    enable_power_scheduling?: boolean
  }
  schedule?: {
    timeRange?: string
    frequency?: string
    startTime?: string
    endTime?: string
    combinedScheduleId?: string
    isCombinedSchedule?: boolean
    selectedOutlets?: string[]
    disabled_by_unplug?: boolean
    basis?: number
  }
  relay_control?: {
    auto_cutoff?: {
      enabled: boolean
      power_limit: number
    }
    status?: string
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
}

// Add Device Modal Props
interface AddDeviceModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (deviceData: {
    deviceType: string
    department: string
    office: string
    outletName: string
    powerLimit: string
    appliance: string
    enableScheduling: boolean
    enablePowerLimit: boolean
    deviceControl: string
  }) => void
}

// Custom styled dropdown used across the SetUp modal
function StyledSelect({
  id,
  value,
  placeholder,
  options,
  onChange,
  error,
  disabled
}: {
  id: string
  value: string
  placeholder: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (v: string) => void
  error?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const selected = options.find(o => o.value === value)

  return (
    <div className={`styled-select${open ? ' open' : ''}${disabled ? ' disabled' : ''}`} ref={ref}>
      <button
        type="button"
        id={id}
        className={`styled-select-btn${error ? ' error' : ''}${disabled ? ' disabled' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen(v => !v)}
        disabled={disabled}
      >
        <span className={`styled-select-label ${selected ? '' : 'placeholder'}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </button>
      {open && (
        <ul role="listbox" className="styled-options">
          {options.map(opt => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={value === opt.value}
                className={`styled-option${value === opt.value ? ' active' : ''}${opt.disabled ? ' disabled' : ''}`}
                onClick={() => { 
                  if (!opt.disabled) {
                    onChange(opt.value); 
                    setOpen(false) 
                  }
                }}
                disabled={opt.disabled}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Success Modal Component
function SuccessModal({ 
  isOpen, 
  onClose, 
  title = "Device Added Successfully!",
  message = "Your new device has been configured and added to the system."
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  title?: string;
  message?: string;
}) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay success-overlay" onClick={onClose}>
      <div className="setup-success-modal" onClick={(e) => e.stopPropagation()}>
        <div className="setup-success-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#10b981" stroke="#10b981" strokeWidth="2"/>
            <path d="M9 12l2 2 4-4" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        <button className="btn-primary" onClick={onClose}>
          Continue
        </button>
      </div>
    </div>
  )
}

// Delete Confirmation Modal Component
function DeleteConfirmationModal({ 
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
    <div className="modal-overlay delete-overlay" onClick={onClose}>
      <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="delete-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#fef2f2" stroke="#fbbf24" strokeWidth="2"/>
            <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
          </svg>
        </div>
        <h3>Delete Device</h3>
        <p>Are you sure you want to delete <strong>"{deviceName}"</strong>? This action cannot be undone.</p>
        <div className="delete-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-danger" onClick={onConfirm}>
            Delete Device
          </button>
        </div>
      </div>
    </div>
  )
}

// Delete Success Modal Component
function DeleteSuccessModal({ 
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
    <div className="modal-overlay success-overlay" onClick={onClose}>
      <div className="setup-delete-success-modal" onClick={(e) => e.stopPropagation()}>
        <div className="setup-delete-success-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#10b981" stroke="#10b981" strokeWidth="2"/>
            <path d="M9 12l2 2 4-4" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h3>Device Deleted Successfully!</h3>
        <p><strong>"{deviceName}"</strong> has been removed from the system.</p>
        <button className="btn-primary" onClick={onClose}>
          Continue
        </button>
      </div>
    </div>
  )
}



// No Power Limit Warning Modal Component
function NoPowerLimitWarningModal({ 
  isOpen, 
  onClose, 
  device,
  onGoToSetup
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  device: Device | null;
  onGoToSetup: () => void;
}) {
  if (!isOpen || !device) return null

  // Determine the warning type and message
  const hasNoLimit = !(device as any).powerLimit || (device as any).powerLimit <= 0
  const exceedsLimit = !hasNoLimit && (device as any).monthlyEnergy >= (device as any).powerLimit

  let title = ''
  let message = ''
  let statusLabel = ''
  let statusValue = ''
  let actionLabel = ''
  let actionValue = ''
  let warningMessage = ''

  if (hasNoLimit) {
    title = 'Power Limit Required!'
    message = `"${device.outletName}" cannot be turned ON without a power limit.`
    statusLabel = 'Current Status:'
    statusValue = 'No Power Limit Set'
    actionLabel = 'Required Action:'
    actionValue = 'Set Power Limit'
    warningMessage = 'For safety reasons, devices must have a power limit before they can be activated. Please set a power limit in the Setup section.'
  } else if (exceedsLimit) {
    title = 'Power Limit Exceeded!'
    message = `"${device.outletName}" cannot be turned ON because monthly energy consumption has exceeded the power limit.`
    statusLabel = 'Monthly Energy:'
    statusValue = `${formatNumber(((device as any).todayTotalEnergy * 1000) || 0)} Wh`
    actionLabel = 'Power Limit:'
    actionValue = `${((device as any).powerLimit * 1000) || '0'} Wh`
    warningMessage = 'Monthly total energy consumption has reached or exceeded the monthly power limit. The device cannot be activated until next month or the power limit is increased.'
  }

  return (
    <div className="modal-overlay warning-overlay" onClick={onClose}>
      <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
        <div className="warning-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
            <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
          </svg>
        </div>
        <h3>{title}</h3>
        <p><strong>{message}</strong></p>
        <div className="warning-details">
          <div className="warning-stat">
            <span className="label">{statusLabel}</span>
            <span className="value">{statusValue}</span>
          </div>
          <div className="warning-stat">
            <span className="label">{actionLabel}</span>
            <span className="value">{actionValue}</span>
          </div>
          {exceedsLimit && (device as any).currentDate && (device as any).currentTime && (
            <>
              <div className="warning-stat">
                <span className="label">Date:</span>
                <span className="value">{(device as any).currentDate}</span>
              </div>
              <div className="warning-stat">
                <span className="label">Time:</span>
                <span className="value">{(device as any).currentTime}</span>
              </div>
            </>
          )}
        </div>
        <p className="warning-message">{warningMessage}</p>
        <div className="warning-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-warning" onClick={onGoToSetup}>
            Go to Setup
          </button>
        </div>
      </div>
    </div>
  )
}

// Power Limit Warning Field Component
function PowerLimitWarningField({ 
  device, 
  newPowerLimit 
}: { 
  device: Device; 
  newPowerLimit: number; 
}) {
  const [monthlyEnergy, setMonthlyEnergy] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchMonthlyEnergy = async () => {
      try {
        const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        const deviceData = deviceSnapshot.val()
        
        if (deviceData && deviceData.daily_logs) {
          // Calculate monthly energy from daily logs
          const now = new Date()
          const currentYear = now.getFullYear()
          const currentMonth = now.getMonth() + 1
          const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
          let totalMonthlyEnergy = 0
          
          // Sum up energy for all days in the current month
          for (let day = 1; day <= daysInMonth; day++) {
            const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
            const dayData = deviceData.daily_logs[dateKey]
            if (dayData && dayData.total_energy) {
              totalMonthlyEnergy += dayData.total_energy // Already in kW from database
            }
          }
          
          setMonthlyEnergy(totalMonthlyEnergy)
        } else {
          setMonthlyEnergy(0)
        }
      } catch (error) {
        console.error('Error fetching monthly energy data:', error)
        // Fallback to current usage
        const currentPowerUsage = device.powerUsage.includes('kW') ? 
          parseFloat(device.powerUsage.replace(' kW', '')) : 
          parseFloat(device.powerUsage.replace(' Wh', '')) / 1000
        setMonthlyEnergy(currentPowerUsage)
      } finally {
        setLoading(false)
      }
    }

    fetchMonthlyEnergy()
  }, [device])

  if (loading) return null

  if (monthlyEnergy !== null && newPowerLimit < monthlyEnergy) {
    return (
      <div className="field-warning field-warning-error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" fill="#fef2f2" stroke="#dc2626" strokeWidth="2"/>
          <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#dc2626"/>
        </svg>
        <span>Power limit ({(newPowerLimit * 1000).toFixed(3)} Wh) is below monthly energy consumption ({(monthlyEnergy * 1000).toFixed(3)} Wh). Increase the limit or reduce usage first.</span>
      </div>
    )
  }

  return null
}

// Monthly Limit Warning Modal Component
function MonthlyLimitWarningModal({ 
  isOpen, 
  onClose, 
  device, 
  reason,
  currentMonthlyEnergy,
  combinedLimit
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  device: Device | null;
  reason: string;
  currentMonthlyEnergy?: number;
  combinedLimit?: number;
}) {
  if (!isOpen || !device) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content monthly-limit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-icon warning">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
              <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
            </svg>
          </div>
          <h3>Monthly Limit Exceeded!</h3>
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
          <p>
            <strong>"{device.outletName}" cannot be turned ON because the monthly energy limit has been exceeded.</strong>
          </p>
          <div className="monthly-limit-details">
            <div className="limit-stat">
              <span className="label">Current Monthly Energy:</span>
              <span className="value">{currentMonthlyEnergy ? `${formatNumber(currentMonthlyEnergy / 1000)} kW` : 'N/A'}</span>
            </div>
            <div className="limit-stat">
              <span className="label">Monthly Limit:</span>
              <span className="value">{combinedLimit ? `${formatNumber(combinedLimit / 1000)} kW` : 'N/A'}</span>
            </div>
            <div className="limit-stat">
              <span className="label">Date:</span>
              <span className="value">{new Date().toLocaleDateString()}</span>
            </div>
            <div className="limit-stat">
              <span className="label">Time:</span>
              <span className="value">{new Date().toLocaleTimeString()}</span>
            </div>
          </div>
          <p className="warning-message">
            {reason}
          </p>
          <p className="info-message">
            The device cannot be activated until next month or the monthly limit is increased. This helps prevent exceeding the combined monthly energy consumption limit for all selected outlets.
          </p>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn-primary"
            onClick={onClose}
          >
            Understood
          </button>
        </div>
      </div>
    </div>
  )
}

// Edit Restriction Modal Component
function EditRestrictionModal({ 
  isOpen, 
  onClose, 
  device,
  combinedLimit
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  device: Device | null;
  combinedLimit: number | string;
}) {
  if (!isOpen || !device) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Device Cannot Be Edited</h3>
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
          <div className="restriction-notice">
            <div className="notice-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="notice-content">
              <h4>Monthly Limit Active</h4>
              <p>
                <strong>{device.outletName}</strong> cannot be edited because it is part of an active monthly power limit group.
              </p>
              <div className="limit-info">
                <div className="limit-item">
                  <span className="label">Combined Limit:</span>
                  <span className="value">
                    {combinedLimit === "No Limit" ? "No Limit" : `${combinedLimit}Wh`}
                  </span>
                </div>
                <div className="limit-item">
                  <span className="label">Selected Outlets:</span>
                  <span className="value">Multiple devices in group</span>
                </div>
              </div>
              <p className="instruction">
                To edit this device, you must first disable or modify the monthly power limit settings.
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
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onClose()
              // You can add logic here to open the combined limit modal
            }}
          >
            Manage Monthly Limit
          </button>
        </div>
      </div>
    </div>
  )
}

// Edit Device Modal Component
function EditDeviceModal({ 
  isOpen, 
  onClose, 
  device, 
  onSave,
  combinedLimitInfo
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  device: Device | null; 
  onSave: (updatedDevice: Device & { enableScheduling: boolean; enablePowerLimit: boolean }) => void;
  combinedLimitInfo: {
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  };
}) {
  const [formData, setFormData] = useState({
    outletName: '',
    powerLimit: '',
    status: 'Active' as Device['status'],
    department: '',
    office: '',
    officeRoom: '',
    enabled: true
  })

  const [enableScheduling, setEnableScheduling] = useState(false)
  const [enablePowerLimit, setEnablePowerLimit] = useState(true)

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [departments, setDepartments] = useState<Array<{value: string, label: string}>>([])
  const [officesData, setOfficesData] = useState<any>({})

  // Function to get filtered offices based on selected department
  const getFilteredOffices = () => {
    if (!formData.department || !officesData) return []
    
    const filteredOffices: Array<{value: string, label: string}> = []
    
    Object.values(officesData).forEach((office: any) => {
      if (office.department && office.department.toLowerCase().replace(/\s+/g, '-') === formData.department) {
        filteredOffices.push({
          value: office.office.toLowerCase().replace(/\s+/g, '-'),
          label: office.office
        })
      }
    })
    
    return filteredOffices
  }

  // Auto-set power limit to "No Limit" when only scheduling is enabled
  // Auto-set device control to OFF when power limit is disabled
  useEffect(() => {
    if (enableScheduling && !enablePowerLimit) {
      setFormData(prev => ({ ...prev, powerLimit: 'No Limit' }))
      setFormData(prev => ({ ...prev, enabled: false })) // Auto-set to OFF when power limit is disabled
    } else if (!enableScheduling && enablePowerLimit && formData.powerLimit === 'No Limit') {
      setFormData(prev => ({ ...prev, powerLimit: '' }))
    } else if (!enablePowerLimit) {
      setFormData(prev => ({ ...prev, enabled: false })) // Auto-set to OFF when power limit is disabled
    }
  }, [enableScheduling, enablePowerLimit])

  // Fetch departments and offices from database
  useEffect(() => {
    if (isOpen) {
      const fetchDepartmentsAndOffices = async () => {
        try {
          const officesRef = ref(realtimeDb, 'offices')
          const snapshot = await get(officesRef)
          
          if (snapshot.exists()) {
            const officesData = snapshot.val()
            setOfficesData(officesData)
            
            const departmentsSet = new Set<string>()
            
            // Extract unique departments
            Object.values(officesData).forEach((office: any) => {
              if (office.department) {
                departmentsSet.add(office.department)
              }
            })
            
            // Convert departments set to array
            const departmentsList = Array.from(departmentsSet).map(dept => ({
              value: dept.toLowerCase().replace(/\s+/g, '-'),
              label: dept
            }))
            
            setDepartments(departmentsList)
          }
        } catch (error) {
          console.error('Error fetching departments and offices:', error)
        }
      }
      
      fetchDepartmentsAndOffices()
    }
  }, [isOpen])

  // Initialize form data when device changes
  useEffect(() => {
    if (device) {
      const powerLimitValue = device.limit.replace(' Wh', '').replace(' W', '').replace(' kW', '')
      // Find the department and office for the existing device
      let existingDepartment = ''
      let existingOffice = ''
      
      if (device.officeRoom && device.officeRoom !== '—' && officesData) {
        // Look for the office in the offices data to find its department
        Object.values(officesData).forEach((office: any) => {
          if (office.office === device.officeRoom) {
            existingDepartment = office.department?.toLowerCase().replace(/\s+/g, '-') || ''
            existingOffice = office.office.toLowerCase().replace(/\s+/g, '-')
          }
        })
      }

      setFormData({
        outletName: device.outletName,
        powerLimit: powerLimitValue,
        status: device.status,
        department: existingDepartment,
        office: existingOffice,
        officeRoom: device.officeRoom === '—' ? '' : device.officeRoom,
        enabled: device.status === 'Active' || device.status === 'Warning' // Set enabled based on current status
      })
      
      // Set checkbox states based on power limit value and device state
      // If power limit is "No Limit", enable scheduling and disable power limit
      // If power limit has a value, enable power limit and disable scheduling
      const hasPowerLimit = Boolean(powerLimitValue && powerLimitValue !== 'No Limit' && powerLimitValue !== '0' && powerLimitValue !== '')
      const isNoLimit = Boolean(powerLimitValue === 'No Limit' || powerLimitValue === '0' || powerLimitValue === '')
      
      setEnablePowerLimit(hasPowerLimit)
      // Use the actual enablePowerScheduling value from the device data, not just based on power limit
      setEnableScheduling(device.enablePowerScheduling || isNoLimit)
      
      console.log('EditDeviceModal: Device data mapping:', {
        device: device.outletName,
        powerLimitValue,
        hasPowerLimit,
        isNoLimit,
        deviceEnablePowerScheduling: device.enablePowerScheduling,
        enablePowerLimit: hasPowerLimit,
        enableScheduling: device.enablePowerScheduling || isNoLimit,
        existingDepartment,
        existingOffice,
        deviceOfficeRoom: device.officeRoom,
        officesDataAvailable: !!officesData
      })
      
      setErrors({})
    }
  }, [device, officesData])

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
    
    // Clear office field when department changes
    if (field === 'department') {
      setFormData(prev => ({ ...prev, office: '' }))
    }
  }

  const handlePowerLimitChange = (value: string) => {
    // Allow numbers and decimal point for W values
    const numericValue = value.replace(/[^0-9.]/g, '')
    // Ensure only one decimal point
    const parts = numericValue.split('.')
    const formattedValue = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : numericValue
    setFormData(prev => ({ ...prev, powerLimit: formattedValue }))
    
    // Clear error when user starts typing
    if (errors.powerLimit) {
      setErrors(prev => ({ ...prev, powerLimit: '' }))
    }
  }


  const validateForm = async () => {
    const newErrors: Record<string, string> = {}
    
    // Validate department and office
    if (!formData.department) newErrors.department = 'Department is required'
    if (!formData.office) newErrors.office = 'Office is required'
    
    // Check if this device is part of the combined limit group
    const deviceOutletName = device?.outletName || ''
    const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
    const isUsingCombinedLimit = combinedLimitInfo.enabled && 
      (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
       combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
    
    // Determine which power limit to validate
    let powerLimitToValidate
    if (isUsingCombinedLimit) {
      powerLimitToValidate = combinedLimitInfo.combinedLimit
    } else {
      // Handle "No Limit" case
      if (formData.powerLimit === 'No Limit') {
        powerLimitToValidate = 0 // Set to 0 for "No Limit" case
      } else {
        powerLimitToValidate = parseFloat(formData.powerLimit)
      }
    }
    
    if (isUsingCombinedLimit) {
      // For combined limits, we don't need to validate the power limit field since it's disabled
      // The combined limit should already be valid
      console.log('Edit modal: Using combined limit for validation:', powerLimitToValidate)
    } else {
      // For individual limits, validate the form data
      if (enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0))) {
        newErrors.powerLimit = 'Power limit must be greater than 0 Wh'
      } else if (enablePowerLimit && formData.powerLimit !== 'No Limit') {
        // Check if power limit is less than monthly energy consumption
        if (device) {
          try {
            // Get monthly energy consumption from database
            const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
            const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
            const deviceSnapshot = await get(deviceRef)
            const deviceData = deviceSnapshot.val()
            
            // Calculate monthly energy from daily logs
            const now = new Date()
            const currentYear = now.getFullYear()
            const currentMonth = now.getMonth() + 1
            const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
            let totalMonthlyEnergy = 0
            
            // Sum up energy for all days in the current month
            for (let day = 1; day <= daysInMonth; day++) {
              const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
              const dayData = deviceData?.daily_logs?.[dateKey]
              if (dayData && dayData.total_energy) {
                totalMonthlyEnergy += dayData.total_energy // Already in kW from database
              }
            }
            
            const newPowerLimitkW = parseFloat(formData.powerLimit) / 1000 // Convert from Wh to kW
            
            // Check if new limit is less than current monthly energy
            if (newPowerLimitkW < totalMonthlyEnergy) {
              const currentPowerLimit = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
              
              // Provide a more specific error message if monthly energy already exceeds the current limit
              if (currentPowerLimit > 0 && totalMonthlyEnergy >= currentPowerLimit) {
                newErrors.powerLimit = `Monthly energy consumption (${(totalMonthlyEnergy * 1000).toFixed(3)} Wh) already exceeds the current limit (${(currentPowerLimit * 1000).toFixed(3)} Wh). Please increase the limit to at least ${(totalMonthlyEnergy * 1000).toFixed(3)} Wh to save changes.`
              } else {
                newErrors.powerLimit = `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than current monthly energy consumption (${(totalMonthlyEnergy * 1000).toFixed(3)} Wh). Please increase the limit to at least ${(totalMonthlyEnergy * 1000).toFixed(3)} Wh to save changes.`
              }
            }
          } catch (error) {
            console.error('Error fetching monthly energy data:', error)
            // Fallback to current usage if database fetch fails
            const currentPowerUsage = device.powerUsage.includes('kW') ? 
              parseFloat(device.powerUsage.replace(' kW', '')) : 
              parseFloat(device.powerUsage.replace(' Wh', '')) / 1000
            const newPowerLimitkW = parseFloat(formData.powerLimit) / 1000 // Convert from Wh to kW
            
            if (newPowerLimitkW < currentPowerUsage) {
              newErrors.powerLimit = `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than current usage (${(currentPowerUsage * 1000).toFixed(3)} Wh)`
            }
          }
        }
      }
    }
    
    // Prevent turning ON device without power limit (only if power limit is enabled)
    if (formData.enabled && enablePowerLimit && powerLimitToValidate <= 0) {
      newErrors.deviceControl = 'Cannot turn ON device without a valid power limit'
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (await validateForm() && device) {
      // Check if this device is part of the combined limit group
      const deviceOutletName = device.outletName || ''
      const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
      const isUsingCombinedLimit = combinedLimitInfo.enabled && 
        (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
         combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
      
      // Determine which power limit to use for validation
      let powerLimitToValidate
      if (isUsingCombinedLimit) {
        powerLimitToValidate = combinedLimitInfo.combinedLimit
      } else {
        // Handle "No Limit" case
        if (formData.powerLimit === 'No Limit') {
          powerLimitToValidate = 0 // Set to 0 for "No Limit" case
        } else {
          powerLimitToValidate = parseFloat(formData.powerLimit)
        }
      }
      
      // Additional validation: prevent turning ON device without power limit (only if power limit is enabled)
      if (formData.enabled && enablePowerLimit && powerLimitToValidate <= 0) {
        setErrors(prev => ({ ...prev, deviceControl: 'Cannot turn ON device without a valid power limit' }))
        return
      }
      
      // Additional validation: prevent setting power limit below monthly energy consumption
      // Note: This is a duplicate check - the main validation in validateForm already handles this
      // Keeping this for extra safety, but it should match the validateForm logic
      if (device && powerLimitToValidate > 0) {
        try {
          // Get monthly energy consumption from database
          const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
          const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
          const deviceSnapshot = await get(deviceRef)
          const deviceData = deviceSnapshot.val()
          
          if (deviceData && deviceData.daily_logs) {
            // Calculate monthly energy from daily logs
            const now = new Date()
            const currentYear = now.getFullYear()
            const currentMonth = now.getMonth() + 1
            const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
            let totalMonthlyEnergy = 0
            
            // Sum up energy for all days in the current month
            for (let day = 1; day <= daysInMonth; day++) {
              const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
              const dayData = deviceData.daily_logs[dateKey]
              if (dayData && dayData.total_energy) {
                totalMonthlyEnergy += dayData.total_energy // Already in kW from database
              }
            }
            
            const newPowerLimitkW = powerLimitToValidate / 1000 // Convert from Wh to kW
            
            if (newPowerLimitkW < totalMonthlyEnergy) {
              setErrors(prev => ({ 
                ...prev, 
                powerLimit: `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than monthly energy consumption (${(totalMonthlyEnergy * 1000).toFixed(3)} Wh)` 
              }))
              return
            }
          }
        } catch (error) {
          console.error('Error fetching monthly energy data:', error)
          // Fallback to current usage if database fetch fails
          const currentPowerUsage = device.powerUsage.includes('kW') ? 
            parseFloat(device.powerUsage.replace(' kW', '')) : 
            parseFloat(device.powerUsage.replace(' Wh', '')) / 1000
          const newPowerLimitkW = powerLimitToValidate / 1000 // Convert from Wh to kW
          
          if (newPowerLimitkW < currentPowerUsage) {
            setErrors(prev => ({ 
              ...prev, 
              powerLimit: `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than current usage (${(currentPowerUsage * 1000).toFixed(3)} Wh)` 
            }))
            return
          }
        }
      }
      
      // Schedule validation: prevent turning ON device outside scheduled time
      if (formData.enabled && device.schedule && device.schedule.timeRange) {
        try {
          // Get device schedule data from database
          const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
          const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
          const deviceSnapshot = await get(deviceRef)
          const deviceData = deviceSnapshot.val()
          
          if (deviceData && deviceData.schedule) {
            const schedule = deviceData.schedule
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
                  return
                }
                
                startTime = startHours * 60 + startMinutes
                endTime = endHours * 60 + endMinutes
              } catch (error) {
                // If parsing fails, skip this check
                return
              }
            } else if (schedule.timeRange && schedule.timeRange !== 'No schedule' && 
                       typeof schedule.timeRange === 'string' && schedule.timeRange.includes(' - ')) {
              try {
                // Parse timeRange format (e.g., "8:36 PM - 8:40 PM")
                const timeRange = schedule.timeRange
                const [startTimeStr, endTimeStr] = timeRange.split(' - ')
                
                // Validate split results
                if (!startTimeStr || !endTimeStr) {
                  return
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
                // If parsing fails, skip this check
                return
              }
            } else {
              // No valid schedule time found
              return
            }
            
            // Check if current time is within the scheduled time range
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
            } else if (frequency.includes(',')) {
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
                // If frequency parsing fails, skip this check
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
            
            // Check if device is within scheduled time
            const isWithinSchedule = isWithinTimeRange && isCorrectDay
            
            if (!isWithinSchedule) {
              let scheduleError = 'Device is outside scheduled time'
              if (schedule.timeRange && schedule.timeRange !== 'No schedule') {
                scheduleError = `Outside scheduled time: ${schedule.timeRange} (Current: ${now.toLocaleTimeString()})`
              } else if (schedule.startTime && schedule.endTime) {
                scheduleError = `Outside scheduled time: ${schedule.startTime} - ${schedule.endTime} (Current: ${now.toLocaleTimeString()})`
              }
              
              setErrors(prev => ({ 
                ...prev, 
                deviceControl: scheduleError 
              }))
              return
            }
          }
        } catch (error) {
          console.error('Error checking schedule validation:', error)
          // Continue with save if schedule check fails
        }
      }
      
      try {
        console.log('Edit modal: Starting database update for:', device.outletName)
        console.log('Edit modal: Power limit to set:', formData.powerLimit)
        console.log('Edit modal: Enabled status to set:', formData.enabled)
        console.log('Edit modal: Office to set:', formData.officeRoom)
        
        // Update Firebase database
        const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
        // const outletRef = ref(realtimeDb, `devices/${outletKey}`)
        
        // Update power limit and relay status
        const autoCutoffRef = ref(realtimeDb, `devices/${outletKey}/relay_control/auto_cutoff`)
        console.log('Edit modal: Updating auto_cutoff at path:', `devices/${outletKey}/relay_control/auto_cutoff`)
        
        // Check if this device is part of the combined limit group
        const deviceOutletName = device.outletName || ''
        const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
        const isUsingCombinedLimit = combinedLimitInfo.enabled && 
          (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
           combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
        
        // Use combined limit if device is part of combined limit group, otherwise use form data
        let powerLimitToUse
        if (isUsingCombinedLimit) {
          powerLimitToUse = combinedLimitInfo.combinedLimit
        } else {
          // Handle "No Limit" case
          if (formData.powerLimit === 'No Limit') {
            powerLimitToUse = 0 // Set to 0 for "No Limit" case
          } else {
            powerLimitToUse = parseFloat(formData.powerLimit)
          }
        }
        console.log('Edit modal: Using power limit:', powerLimitToUse, isUsingCombinedLimit ? '(Combined Limit)' : '(Individual Limit)')
        
        // Handle "No Limit" case for database storage
        let powerLimitToStore
        if (formData.powerLimit === 'No Limit') {
          powerLimitToStore = "No Limit" // Store as string for "No Limit" case
        } else {
          powerLimitToStore = powerLimitToUse / 1000 // Convert from W to kW for storage
        }
        
        const autoCutoffUpdate = await update(autoCutoffRef, {
          enabled: true, // Keep auto_cutoff enabled
          power_limit: powerLimitToStore
        })
        console.log('Edit modal: Auto_cutoff update result:', autoCutoffUpdate)

        // Update control state
        const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
        const newControlState = formData.enabled ? 'on' : 'off'
        console.log('Edit modal: Updating control state to:', newControlState)
        
        const controlUpdate = await update(controlRef, {
          device: newControlState
        })
        console.log('Edit modal: Control state update result:', controlUpdate)
        
        // If setting device control to 'on', reset disabled_by_unplug and status from UNPLUG
        if (newControlState === 'on') {
          // Reset disabled_by_unplug flag
          const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
          const scheduleSnapshot = await get(scheduleRef)
          const scheduleData = scheduleSnapshot.val() || {}
          
          if (scheduleData.disabled_by_unplug === true) {
            await update(scheduleRef, {
              disabled_by_unplug: false
            })
            console.log(`Edit modal: Reset disabled_by_unplug to false for ${outletKey}`)
          }
          
          // Reset status from UNPLUG to ON
          const deviceStatusRef = ref(realtimeDb, `devices/${outletKey}`)
          const deviceStatusSnapshot = await get(deviceStatusRef)
          const deviceStatusData = deviceStatusSnapshot.val()
          
          if (deviceStatusData?.status === 'UNPLUG' || deviceStatusData?.status === 'unplug') {
            await update(deviceStatusRef, {
              status: 'ON'
            })
            console.log(`Edit modal: Reset status from UNPLUG to ON for ${outletKey}`)
          } else {
            // Update status to ON if not already UNPLUG
            await update(deviceStatusRef, {
              status: 'ON'
            })
          }
        } else {
          // If setting device control to 'off' manually from Edit modal, DO NOT change root status
          // Only update control.device - leave root status as is
          // This preserves the current status (could be 'ON', 'OFF', 'UNPLUG', 'Idle', etc.)
          console.log(`✅ SetUp: Device ${outletKey} control set to 'off' from Edit modal - leaving root status unchanged`)
        }

        // Update office information with scheduling settings
        const officeRef = ref(realtimeDb, `devices/${outletKey}/office_info`)
        if (formData.office.trim()) {
          // Find the office name from the offices data
          let officeName = ''
          if (officesData) {
            Object.values(officesData).forEach((office: any) => {
              if (office.office.toLowerCase().replace(/\s+/g, '-') === formData.office) {
                officeName = office.office
              }
            })
          }
          
          console.log('Edit modal: Updating office info at path:', `devices/${outletKey}/office_info`)
          console.log('Edit modal: Scheduling settings:', { enableScheduling, enablePowerLimit })
          
          // Get the department name from the selected department and format it properly
          const selectedDepartment = formatDepartmentName(formData.department)
          
          console.log('Edit Modal: Saving office_info with:', {
            office: officeName,
            department: selectedDepartment,
            enable_power_scheduling: enableScheduling
          })
          
          const officeUpdate = await update(officeRef, {
            office: officeName,
            department: selectedDepartment,
            assigned_date: new Date().toISOString(),
            enable_power_scheduling: enableScheduling // ✅ Update scheduling setting
          })
          console.log('Edit modal: Office update result:', officeUpdate)
        } else {
          // Clear office assignment but keep scheduling setting
          console.log('Edit modal: Clearing office info at path:', `devices/${outletKey}/office_info`)
          const officeUpdate = await update(officeRef, {
            enable_power_scheduling: enableScheduling // ✅ Update scheduling setting
          })
          console.log('Edit modal: Office update result:', officeUpdate)
        }

        // Handle schedule data based on enableScheduling flag
        const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
        if (enableScheduling) {
          console.log('Edit modal: Scheduling is enabled - updating basis and disabled_by_unplug')
          // If schedule exists, update basis and disabled_by_unplug
          const scheduleSnapshot = await get(scheduleRef)
          const existingSchedule = scheduleSnapshot.val()
          
          if (existingSchedule && (existingSchedule.timeRange || existingSchedule.startTime)) {
            // Create basis timestamp for unplug detection
            const basis = Date.now()
            await update(scheduleRef, {
              basis: basis,
              disabled_by_unplug: false
            })
            console.log(`Edit modal: Updated basis and disabled_by_unplug for ${outletKey}`)
          }
        } else {
          console.log('Edit modal: Scheduling is disabled - deleting existing schedule data')
          // Delete all schedule data when scheduling is disabled
          try {
            await update(scheduleRef, {
              timeRange: null,
              startTime: null,
              endTime: null,
              days: null,
              frequency: null,
              selectedDays: null,
              combinedScheduleId: null,
              isCombinedSchedule: false,
              selectedOutlets: null,
              enabled: false
            })
            console.log(`Edit modal: Successfully deleted schedule data for ${outletKey}`)
          } catch (error) {
            console.error(`Edit modal: Error deleting schedule data for ${outletKey}:`, error)
          }
        }

        
        console.log('Edit modal: Database updates completed successfully!')
        
        // Log the individual limit activity
        const activity = 'Edit individual limit'
        const limitValue = formData.powerLimit === 'No Limit' ? 'No Limit' : formData.powerLimit
        await logIndividualLimitActivity(
          activity,
          device.outletName,
          limitValue,
          formData.officeRoom || device.officeRoom || 'Unknown',
          device.appliances || 'Unknown'
        )
        
        // Create updated device object
        // Find the office name for display
        let displayOfficeName = '—'
        if (formData.office && officesData) {
          Object.values(officesData).forEach((office: any) => {
            if (office.office.toLowerCase().replace(/\s+/g, '-') === formData.office) {
              displayOfficeName = office.office
            }
          })
        }
        
        const updatedDevice: Device & { enableScheduling: boolean; enablePowerLimit: boolean } = {
          ...device,
          outletName: formData.outletName || device.outletName,
          limit: formData.powerLimit === 'No Limit' ? 'No Limit' : `${powerLimitToUse.toFixed(3)} Wh`,
          status: formData.enabled ? 'Active' : 'Inactive',
          officeRoom: displayOfficeName,
          enableScheduling,
          enablePowerLimit
        }
        
        onSave(updatedDevice)
        onClose()
      } catch (error) {
        console.error('Edit modal: Error updating database:', error)
        console.error('Edit modal: Error details:', {
          deviceName: device.outletName,
          powerLimit: formData.powerLimit,
          enabled: formData.enabled,
          officeRoom: formData.officeRoom,
          error: error
        })
      }
    }
  }

  const handleClose = () => {
    setErrors({})
    onClose()
  }

  // Check if form can be saved
  const canSaveForm = () => {
    const hasPowerLimitIssue = formData.enabled && enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0))
    
    // Check if monthly energy exceeds the new limit
    let hasUsageExceedLimit = false
    if (device && formData.powerLimit && formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) > 0 && device.monthUsage) {
      // Parse monthly energy from device.monthUsage (format: "14.700 Wh")
      const monthlyEnergyStr = device.monthUsage.replace(' Wh', '').replace(' W', '').trim()
      const monthlyEnergy = parseFloat(monthlyEnergyStr) || 0
      const newLimit = parseFloat(formData.powerLimit)
      
      // Check if new limit is less than monthly energy
      if (newLimit < monthlyEnergy) {
        hasUsageExceedLimit = true
      }
    }
    
    return !hasPowerLimitIssue && !hasUsageExceedLimit
  }

  const getSaveButtonTitle = () => {
    const hasPowerLimitIssue = formData.enabled && enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0))
    
    // Check if monthly energy exceeds the new limit
    let hasUsageExceedLimit = false
    let monthlyEnergy = 0
    if (device && formData.powerLimit && formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) > 0 && device.monthUsage) {
      // Parse monthly energy from device.monthUsage (format: "14.700 Wh")
      const monthlyEnergyStr = device.monthUsage.replace(' Wh', '').replace(' W', '').trim()
      monthlyEnergy = parseFloat(monthlyEnergyStr) || 0
      const newLimit = parseFloat(formData.powerLimit)
      
      // Check if new limit is less than monthly energy
      if (newLimit < monthlyEnergy) {
        hasUsageExceedLimit = true
      }
    }
    
    if (hasPowerLimitIssue) return 'Cannot save: Power limit is required to turn ON device'
    if (hasUsageExceedLimit) return `Cannot save: Power limit (${parseFloat(formData.powerLimit).toFixed(3)} Wh) is below monthly energy consumption (${monthlyEnergy.toFixed(3)} Wh)`
    return 'Save changes'
  }

  if (!isOpen || !device) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Edit</h3>
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
            <div className="form-group">
              <label htmlFor="editOutletName">
                Outlet Name
              </label>
              <div className="outlet-display">
                {formData.outletName || 'No outlet name'}
              </div>
            </div>


            <div className={`form-group ${errors.powerLimit ? 'error' : ''}`}>
              <label htmlFor="editPowerLimit">
                Change power limit (Wh) {enablePowerLimit && <span className="required">*</span>}
              </label>
              {(() => {
                // Check if this device is part of the combined limit group
                const deviceOutletName = device?.outletName || ''
                const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
                const isUsingCombinedLimit = combinedLimitInfo.enabled && 
                  (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
                   combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
                
                if (isUsingCombinedLimit) {
                  return (
                    <div className="combined-limit-disabled-field">
                      <input
                        type="text"
                        id="editPowerLimit"
                        placeholder="e.g., 150 Wh"
                        value={`${String(combinedLimitInfo.combinedLimit) === "No Limit" ? "No Limit" : `${combinedLimitInfo.combinedLimit}Wh`} (Combined Limit)`}
                        disabled
                        className="disabled-input"
                      />
                      <div className="combined-limit-notice">
                        <div className="notice-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                        <div className="notice-text">
                          <strong>Power limit cannot be edited</strong> because this device is part of a combined power limit group. 
                          The combined limit of {String(combinedLimitInfo.combinedLimit) === "No Limit" ? "No Limit" : `${combinedLimitInfo.combinedLimit}Wh`} applies to all selected outlets.
                        </div>
                      </div>
                    </div>
                  )
                } else {
                  return (
                    <>
                      {(enablePowerLimit || enableScheduling) && (
                        <input
                          type="text"
                          id="editPowerLimit"
                          placeholder="e.g., 150 Wh"
                          value={formData.powerLimit}
                          onChange={(e) => handlePowerLimitChange(e.target.value)}
                          maxLength={8}
                          className={enableScheduling && !enablePowerLimit ? 'disabled-input' : ''}
                          disabled={enableScheduling && !enablePowerLimit}
                          required={enablePowerLimit}
                        />
                      )}
                      <div className="field-hint">
                        {enableScheduling && !enablePowerLimit 
                          ? "Devices will only turn off based on the schedule set. No power limit is applied."
                          : "Enter value in Wh (watt-hours). This limit will be applied to monthly energy consumption."
                        }
                      </div>
                      {errors.powerLimit && <span className="error-message">{errors.powerLimit}</span>}
                    </>
                  )
                }
              })()}
              
              {/* Show warning when power limit is required but not set */}
              {formData.enabled && enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0)) && (
                <div className="field-warning">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
                    <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
                  </svg>
                  <span>Power limit is required to turn ON this device</span>
                </div>
              )}
              
              {/* Show warning when power limit is below monthly energy consumption */}
              {device && formData.powerLimit && parseFloat(formData.powerLimit) > 0 && (
                <PowerLimitWarningField 
                  device={device} 
                  newPowerLimit={parseFloat(formData.powerLimit)} 
                />
              )}
            </div>

            <div className={`form-group ${errors.department ? 'error' : ''}`}>
              <label htmlFor="editDepartment">
                Select Department <span className="required">*</span>
              </label>
              <StyledSelect
                id="editDepartment"
                value={formData.department}
                placeholder="Choose department"
                options={departments}
                onChange={(v) => handleInputChange('department', v)}
                error={!!errors.department}
              />
              {errors.department && <span className="error-message">{errors.department}</span>}
            </div>

            <div className={`form-group ${errors.office ? 'error' : ''}`}>
              <label htmlFor="editOffice">
                Select Office <span className="required">*</span>
              </label>
              <StyledSelect
                id="editOffice"
                value={formData.office}
                placeholder={formData.department ? "Choose office" : "Select department first"}
                options={formData.department ? getFilteredOffices() : []}
                onChange={(v) => handleInputChange('office', v)}
                error={!!errors.office}
                disabled={!formData.department}
              />
              <div className="field-hint">You can change the office assignment for any selected device</div>
              {errors.office && <span className="error-message">{errors.office}</span>}
            </div>

            {/* Device Control */}
            <div className={`form-group ${errors.deviceControl ? 'error' : ''}`}>
                <label htmlFor="editEnabled">
                  Device Control
                </label>
                <select
                  id="editEnabled"
                  value={formData.enabled.toString()}
                  onChange={(e) => {
                    const enabled = e.target.value === 'true'
                    setFormData(prev => ({
                      ...prev,
                      enabled: enabled,
                      status: enabled ? 'Active' : 'Inactive'
                    }))
                    // Clear error when user changes selection
                    if (errors.deviceControl) {
                      setErrors(prev => ({ ...prev, deviceControl: '' }))
                    }
                    
                    // Real-time validation: check if trying to turn ON without power limit
                    if (enabled && (!formData.powerLimit || parseFloat(formData.powerLimit) <= 0)) {
                      setErrors(prev => ({ ...prev, deviceControl: 'Cannot turn ON device without a valid power limit' }))
                    }
                  }}
                >
                  <option value="true">Turn ON (Active)</option>
                  <option value="false">Turn OFF (Inactive)</option>
                </select>
                <div className="field-hint">
                  Controls the control.device setting (on/off)
                </div>
                {errors.deviceControl && <span className="error-message">{errors.deviceControl}</span>}
                
                {/* Real-time validation feedback */}
                {formData.enabled && (!formData.powerLimit || parseFloat(formData.powerLimit) <= 0) && (
                  <div className="validation-warning">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
                      <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#f59e0b"/>
                    </svg>
                    <span>Device cannot be turned ON without a power limit. Please set a power limit above.</span>
                  </div>
                )}
              </div>

            {/* Enable Scheduling Checkbox */}
            <div className="field-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enableScheduling}
                  onChange={(e) => {
                    const isChecked = e.target.checked
                    setEnableScheduling(isChecked)
                    
                    // Allow both scheduling and power limit to be enabled simultaneously
                    // Only set power limit to "No Limit" if power limit is disabled
                    if (isChecked && !enablePowerLimit) {
                      setFormData(prev => ({ 
                        ...prev, 
                        powerLimit: 'No Limit',
                        enabled: false // Auto-set device control to OFF when only scheduling is enabled
                      }))
                    }
                    
                    console.log('Enable Scheduling changed:', isChecked)
                  }}
                  className="checkbox-input"
                />
                <span className="checkbox-custom"></span>
                Enable Scheduling
              </label>
              <p className="field-description">
                Enable automatic scheduling for the selected outlets
              </p>
            </div>

            {/* Enable Power Limit Checkbox */}
            <div className="field-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enablePowerLimit}
                  onChange={(e) => {
                    const isChecked = e.target.checked
                    setEnablePowerLimit(isChecked)
                    
                    if (isChecked) {
                      // Allow both scheduling and power limit to be enabled simultaneously
                      // Clear the power limit field to allow user to enter new value
                      if (formData.powerLimit === 'No Limit') {
                        setFormData(prev => ({ ...prev, powerLimit: '' }))
                      }
                    } else {
                      // If disabling power limit and scheduling is enabled, set to "No Limit"
                      if (enableScheduling) {
                        setFormData(prev => ({ 
                          ...prev, 
                          powerLimit: 'No Limit',
                          enabled: false // Auto-set to OFF when power limit is disabled
                        }))
                      }
                    }
                    
                    console.log('Enable Power Limit changed:', isChecked)
                  }}
                  className="checkbox-input"
                />
                <span className="checkbox-custom"></span>
                Enable Power Limit
              </label>
              <p className="field-description">
                Set a combined power limit for the selected outlets
              </p>
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
              className={`btn-primary ${!canSaveForm() ? 'disabled' : ''}`}
              disabled={!canSaveForm()}
              title={getSaveButtonTitle()}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Combined Limit Modal Component
function CombinedLimitModal({ 
  isOpen, 
  onClose, 
  onSave,
  existingData
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  onSave: (data: { selectedOutlets: string[]; combinedLimit: number; deviceControl: string; enableScheduling: boolean; department?: string }) => void;
  existingData?: {
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    department?: string;
  };
}) {
  const [selectedOutlets, setSelectedOutlets] = useState<string[]>([])
  const [combinedLimit, setCombinedLimit] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [availableOutlets, setAvailableOutlets] = useState<string[]>([])
  const [allOutlets, setAllOutlets] = useState<any>({})
  const [selectedDepartment, setSelectedDepartment] = useState<string>('')
  const [departments, setDepartments] = useState<Array<{value: string, label: string}>>([])
  const [officesData, setOfficesData] = useState<any>({})
  const [isFormInitialized, setIsFormInitialized] = useState(false)
  const [isUserEditing, setIsUserEditing] = useState(false)
  const [enableScheduling, setEnableScheduling] = useState(false)
  const [enablePowerLimit, setEnablePowerLimit] = useState(false)
  const [deviceControl, setDeviceControl] = useState('on')
  const [controlDropdownOpen, setControlDropdownOpen] = useState(false)
  
  const deviceControlOptions = [
    { value: 'on', label: 'Turn ON (Active)', description: 'Device will be turned on' },
    { value: 'off', label: 'Turn OFF (Inactive)', description: 'Device will be turned off' }
  ]

  // Fetch departments and offices from database
  useEffect(() => {
    if (isOpen) {
      const fetchDepartmentsAndOffices = async () => {
        try {
          const officesRef = ref(realtimeDb, 'offices')
          const snapshot = await get(officesRef)
          
          if (snapshot.exists()) {
            const officesData = snapshot.val()
            setOfficesData(officesData)
            
            const departmentsSet = new Set<string>()
            
            // Extract unique departments
            Object.values(officesData).forEach((office: any) => {
              if (office.department) {
                departmentsSet.add(office.department)
              }
            })
            
            // Convert departments set to array
            const departmentsList = Array.from(departmentsSet).map(dept => ({
              value: dept.toLowerCase().replace(/\s+/g, '-'),
              label: dept
            }))
            
            setDepartments(departmentsList)
          }
        } catch (error) {
          console.error('Error fetching departments and offices:', error)
        }
      }
      
      fetchDepartmentsAndOffices()
    }
  }, [isOpen])

  // Function to filter outlets based on selected department
  const getFilteredOutlets = (devicesData: any, department: string) => {
    if (!department || !devicesData) {
      return []
    }
    
    const filteredOutlets: string[] = []
    
    Object.keys(devicesData).forEach((outletKey) => {
      const outletData = devicesData[outletKey]
      const outletDepartment = outletData?.office_info?.department
      
      if (outletDepartment) {
        const departmentKey = outletDepartment.toLowerCase().replace(/\s+/g, '-')
        if (departmentKey === department) {
          filteredOutlets.push(outletKey.replace(/_/g, ' '))
        }
      }
    })
    
    return filteredOutlets
  }

  // Handle department selection change
  const handleDepartmentChange = (department: string) => {
    setSelectedDepartment(department)
    setIsUserEditing(true)
    // Clear selected outlets when department changes
    setSelectedOutlets([])
    // Clear error when user makes changes
    if (errors.department) {
      setErrors(prev => ({ ...prev, department: '' }))
    }
  }

  // Fetch available outlets from database and populate existing data
  useEffect(() => {
    const fetchOutlets = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          setAllOutlets(devicesData)
          
          // Filter outlets based on selected department
          if (selectedDepartment) {
            const filtered = getFilteredOutlets(devicesData, selectedDepartment)
            setAvailableOutlets(filtered)
          } else {
            // If no department selected, show all outlets
            const outlets = Object.keys(devicesData).map(outletKey => 
              outletKey.replace(/_/g, ' ')
            )
            setAvailableOutlets(outlets)
          }
        }
      } catch (error) {
        console.error('Error fetching outlets:', error)
      }
    }

    if (isOpen) {
      fetchOutlets()
      
      // Only populate form data when modal first opens, not on every existingData change
      // Also don't update if user is actively editing
      if (!isFormInitialized && !isUserEditing) {
        if (existingData && existingData.enabled) {
          setSelectedOutlets(existingData.selectedOutlets)
          setCombinedLimit(existingData.combinedLimit.toString())
          setEnablePowerLimit(String(existingData.combinedLimit) !== "No Limit") // Enable power limit if not "No Limit"
          
          // Set department if it exists in existing data
          if (existingData.department) {
            setSelectedDepartment(existingData.department)
          }
          
          // Check actual database state for enable scheduling
          const checkSchedulingState = async () => {
            try {
              const devicesRef = ref(realtimeDb, 'devices')
              const snapshot = await get(devicesRef)
              
              if (snapshot.exists()) {
                const devicesData = snapshot.val()
                let hasSchedulingEnabled = false
                
                // Check if any of the selected outlets have enable_power_scheduling = true
                for (const outletName of existingData.selectedOutlets) {
                  const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
                  const outletData = devicesData[outletKey]
                  
                  if (outletData?.office_info?.enable_power_scheduling === true) {
                    hasSchedulingEnabled = true
                    break
                  }
                }
                
                setEnableScheduling(hasSchedulingEnabled)
                console.log('SetUp: Scheduling state from database:', {
                  selectedOutlets: existingData.selectedOutlets,
                  hasSchedulingEnabled,
                  combinedLimit: existingData.combinedLimit
                })
              }
            } catch (error) {
              console.error('Error checking scheduling state:', error)
              // Fallback to original logic if database check fails
              setEnableScheduling(String(existingData.combinedLimit) === "No Limit")
            }
          }
          
          checkSchedulingState()
          console.log('SetUp: Populating modal with existing data:', existingData)
        } else {
          // Reset form for new combined limit
          setSelectedOutlets([])
          setCombinedLimit('')
          setEnablePowerLimit(false)
          setEnableScheduling(false)
          setDeviceControl('on')
          setSelectedDepartment('')
        }
        setIsFormInitialized(true)
      }
    } else {
      // Reset initialization flag and user editing state when modal closes
      setIsFormInitialized(false)
      setIsUserEditing(false)
    }
  }, [isOpen, existingData, isFormInitialized, selectedDepartment])

  // Close control dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (controlDropdownOpen) {
        const target = event.target as Element
        if (!target.closest('.control-dropdown-container')) {
          setControlDropdownOpen(false)
        }
      }
    }

    if (controlDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [controlDropdownOpen])

  // Auto-set power limit to "No Limit" when only scheduling is enabled
  useEffect(() => {
    if (enableScheduling && !enablePowerLimit) {
      setCombinedLimit('No Limit')
      setIsUserEditing(true)
    } else if (!enableScheduling && enablePowerLimit && combinedLimit === 'No Limit') {
      setCombinedLimit('')
      setIsUserEditing(true)
    }
  }, [enableScheduling, enablePowerLimit])

  const handleOutletToggle = (outlet: string) => {
    setSelectedOutlets(prev => 
      prev.includes(outlet) 
        ? prev.filter(o => o !== outlet)
        : [...prev, outlet]
    )
    setIsUserEditing(true) // Mark that user is actively editing
    // Clear error when user makes changes
    if (errors.outlets) {
      setErrors(prev => ({ ...prev, outlets: '' }))
    }
  }

  const handleSelectAll = () => {
    if (selectedOutlets.length === availableOutlets.length) {
      setSelectedOutlets([])
    } else {
      setSelectedOutlets([...availableOutlets])
    }
    setIsUserEditing(true) // Mark that user is actively editing
    // Clear error when user makes changes
    if (errors.outlets) {
      setErrors(prev => ({ ...prev, outlets: '' }))
    }
  }

  const handleLimitChange = (value: string) => {
    // Allow only numbers and decimal point for W values
    const numericValue = value.replace(/[^0-9.]/g, '')
    setCombinedLimit(numericValue)
    setIsUserEditing(true) // Mark that user is actively editing
    // Clear error when user makes changes
    if (errors.combinedLimit) {
      setErrors(prev => ({ ...prev, combinedLimit: '' }))
    }
  }

  const validateForm = async () => {
    const newErrors: Record<string, string> = {}
    
    // Require department selection
    if (!selectedDepartment) {
      newErrors.department = 'Please select a department'
    }
    
    // Only require outlets when creating a new combined limit, not when editing (allowing disable)
    if (!existingData && selectedOutlets.length === 0) {
      newErrors.outlets = 'Please select at least one outlet'
    }
    
    if (enablePowerLimit && (!combinedLimit || (combinedLimit !== 'No Limit' && parseFloat(combinedLimit) <= 0))) {
      newErrors.combinedLimit = 'Combined limit must be greater than 0 Wh'
    }
    
    // Check if the proposed limit is less than current month's energy consumption
    if (enablePowerLimit && combinedLimit && combinedLimit !== 'No Limit' && selectedOutlets.length > 0) {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        
        if (devicesSnapshot.exists()) {
          const devicesData = devicesSnapshot.val()
          const proposedLimit = parseFloat(combinedLimit)
          const currentMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, selectedOutlets)
          
          if (proposedLimit < currentMonthlyEnergy) {
            newErrors.combinedLimit = `Combined limit (${proposedLimit.toFixed(0)} Wh) cannot be less than current month's energy consumption (${currentMonthlyEnergy.toFixed(0)} Wh)`
          }
        }
      } catch (error) {
        console.error('Error validating against current monthly energy:', error)
        // Don't block the form if we can't fetch the data, but log the error
      }
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    const isValid = await validateForm()
    if (isValid) {
      onSave({
        selectedOutlets,
        combinedLimit: combinedLimit === 'No Limit' ? 0 : parseFloat(combinedLimit),
        deviceControl,
        enableScheduling,
        department: selectedDepartment
      })
    }
  }

  const handleClose = () => {
    setSelectedOutlets([])
    setCombinedLimit('')
    setEnablePowerLimit(false)
    setEnableScheduling(false)
    setDeviceControl('on')
    setControlDropdownOpen(false)
    setSelectedDepartment('')
    setErrors({})
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{existingData && existingData.enabled ? 'Edit Monthly Power Limit' : 'Set Combined Power Limit'}</h3>
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
            {/* Department Selection */}
            <div className={`field-group ${errors.department ? 'error' : ''}`}>
              <label htmlFor="department">
                Select Department <span className="required">*</span>
              </label>
              <select
                id="department"
                value={selectedDepartment}
                onChange={(e) => handleDepartmentChange(e.target.value)}
                className={errors.department ? 'error' : ''}
                required
              >
                <option value="">-- Select Department --</option>
                {departments.map((dept) => (
                  <option key={dept.value} value={dept.value}>
                    {dept.label}
                  </option>
                ))}
              </select>
              {errors.department && <span className="error-message">{errors.department}</span>}
              <p className="field-description">
                Select a department to filter available outlets
              </p>
            </div>

            {/* Outlet Selection */}
            <div className={`field-group ${errors.outlets ? 'error' : ''} ${!selectedDepartment ? 'disabled' : ''}`}>
              <label>
                Select Outlets <span className="required">*</span>
              </label>
              {!selectedDepartment ? (
                <div className="outlet-selection-disabled">
                  <p className="field-description">
                    Please select a department first to view available outlets
                  </p>
                </div>
              ) : (
                <div className="outlet-selection">
                  <div className="select-all-container">
                    <button
                      type="button"
                      className="select-all-btn"
                      onClick={handleSelectAll}
                    >
                      {selectedOutlets.length === availableOutlets.length ? 'Deselect All' : 'Select All'}
                    </button>
                    <span className="selection-count">
                      {selectedOutlets.length} of {availableOutlets.length} selected
                    </span>
                  </div>
                  <div className="outlet-grid">
                    {availableOutlets.length > 0 ? (
                      availableOutlets.map((outlet) => (
                        <div
                          key={outlet}
                          className={`outlet-option ${selectedOutlets.includes(outlet) ? 'selected' : ''}`}
                          onClick={() => handleOutletToggle(outlet)}
                        >
                          <div className="outlet-checkbox">
                            {selectedOutlets.includes(outlet) && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <polyline points="20,6 9,17 4,12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </div>
                          <span className="outlet-label">{outlet}</span>
                        </div>
                      ))
                    ) : (
                      <p className="field-description">
                        No outlets available for the selected department
                      </p>
                    )}
                  </div>
                </div>
              )}
              {errors.outlets && <span className="error-message">{errors.outlets}</span>}
            </div>

            {/* Enable Scheduling Checkbox */}
            <div className="field-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enableScheduling}
                  onChange={(e) => {
                    setEnableScheduling(e.target.checked)
                    setIsUserEditing(true)
                    // Auto-set device control to OFF when only scheduling is enabled (no power limit)
                    if (e.target.checked && !enablePowerLimit) {
                      setDeviceControl('off')
                    }
                  }}
                  className="checkbox-input"
                />
                <span className="checkbox-custom"></span>
                Enable Scheduling
              </label>
              <p className="field-description">
                Enable automatic scheduling for the selected outlets
              </p>
            </div>

            {/* Enable Power Limit Checkbox */}
            <div className="field-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enablePowerLimit}
                  onChange={(e) => {
                    setEnablePowerLimit(e.target.checked)
                    setIsUserEditing(true)
                    if (!e.target.checked) {
                      setCombinedLimit('')
                      setDeviceControl('off') // Auto-set to OFF when power limit is disabled
                    }
                  }}
                  className="checkbox-input"
                />
                <span className="checkbox-custom"></span>
                Enable Power Limit
              </label>
              <p className="field-description">
                Set a combined power limit for the selected outlets
              </p>
            </div>

            {/* Device Control Dropdown - Only show when scheduling is unchecked and power limit is checked */}
            {!enableScheduling && enablePowerLimit && (
              <div className="field-group">
                <label>
                  Device Control <span className="required">*</span>
                </label>
                <div className="control-dropdown-container">
                  <button
                    type="button"
                    className="control-dropdown-trigger"
                    onClick={() => setControlDropdownOpen(!controlDropdownOpen)}
                    aria-expanded={controlDropdownOpen}
                    aria-haspopup="listbox"
                  >
                    <span>{deviceControlOptions.find(option => option.value === deviceControl)?.label}</span>
                    <svg 
                      width="16" 
                      height="16" 
                      viewBox="0 0 24 24" 
                      fill="none" 
                      xmlns="http://www.w3.org/2000/svg"
                      className={`dropdown-arrow ${controlDropdownOpen ? 'open' : ''}`}
                    >
                      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  {controlDropdownOpen && (
                    <ul className="dropdown-menu" role="listbox">
                      {deviceControlOptions.map((option) => (
                        <li key={option.value}>
                          <button 
                            type="button"
                            role="option" 
                            aria-selected={deviceControl === option.value} 
                            className={`menu-item ${deviceControl === option.value ? 'selected' : ''}`} 
                            onClick={() => { 
                              setDeviceControl(option.value); 
                              setControlDropdownOpen(false);
                              setIsUserEditing(true);
                            }}
                          >
                            <div className="option-content">
                              <div className="option-label">{option.label}</div>
                              <div className="option-description">{option.description}</div>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="field-description">
                  Controls the control.device setting (on/off)
                </p>
              </div>
            )}

            {/* Combined Limit Input - Show when power limit is enabled OR when only scheduling is enabled */}
            {(enablePowerLimit || enableScheduling) && (
              <div className={`field-group ${errors.combinedLimit ? 'error' : ''}`}>
                <label htmlFor="combinedLimit">
                  Monthly Power Limit (Wh) {enablePowerLimit && <span className="required">*</span>}
                </label>
              <input
                type="text"
                id="combinedLimit"
                value={combinedLimit}
                onChange={(e) => handleLimitChange(e.target.value)}
                placeholder="e.g., 500 W"
                className={`form-input ${enableScheduling && !enablePowerLimit ? 'disabled-input' : ''}`}
                disabled={enableScheduling && !enablePowerLimit}
                required={enablePowerLimit}
              />
              <div className="field-hint">
                {enableScheduling && !enablePowerLimit 
                  ? "Devices will only turn off based on the schedule set. No power limit is applied."
                  : "Enter the total monthly energy limit in watts. When the combined monthly energy consumption of all selected outlets reaches this limit, all devices will automatically turn off."
                }
              </div>
              {errors.combinedLimit && <span className="error-message">{errors.combinedLimit}</span>}
              </div>
            )}

            {/* Summary */}
            {selectedOutlets.length > 0 && (enablePowerLimit || enableScheduling) && selectedDepartment && (
              <div className="limit-summary">
                <h4>Summary</h4>
                <div className="summary-details">
                  <div className="summary-item">
                    <span className="label">Department:</span>
                    <span className="value">
                      {departments.find(d => d.value === selectedDepartment)?.label || selectedDepartment}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="label">Selected Outlets:</span>
                    <span className="value">{selectedOutlets.length} outlets</span>
                  </div>
                  <div className="summary-item">
                    <span className="label">Combined Limit:</span>
                    <span className="value">
                      {enableScheduling && !enablePowerLimit 
                        ? "No Limit" 
                        : `${parseFloat(combinedLimit).toFixed(0)} Wh`
                      }
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="label">Action:</span>
                    <span className="value">
                      {enableScheduling && !enablePowerLimit
                        ? "Devices will turn off based on schedule only"
                        : "All devices will turn off when limit is reached"
                      }
                    </span>
                  </div>
                </div>
              </div>
            )}
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
              disabled={!existingData && (!selectedDepartment || selectedOutlets.length === 0 || !combinedLimit)}
            >
              {existingData && existingData.enabled ? 'Update Combined Limit' : 'Set Combined Limit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Combined Limit Success Modal Component
function CombinedLimitSuccessModal({ 
  isOpen, 
  onClose, 
  selectedOutlets, 
  combinedLimit,
  isEdit
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  selectedOutlets: string[]; 
  combinedLimit: number;
  isEdit: boolean;
}) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="setup-combined-limit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="setup-combined-limit-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h3>{isEdit ? 'Combined Limit Updated Successfully!' : 'Combined Limit Set Successfully!'}</h3>
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
          <div className="success-message">
            <p>{isEdit ? 'Your combined power limit has been successfully updated!' : 'Your combined power limit has been successfully configured!'}</p>
          </div>

          <div className="success-details">
            <div className="detail-item">
              <span className="detail-label">Combined Limit:</span>
              <span className="detail-value">{combinedLimit} W</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Selected Outlets:</span>
              <span className="detail-value">{selectedOutlets.length} outlets</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Action:</span>
              <span className="detail-value">All devices will turn off when limit is reached</span>
            </div>
          </div>

          <div className="outlet-list">
            <h4>Selected Outlets:</h4>
            <div className="outlet-tags">
              {selectedOutlets.map((outlet, index) => (
                <span key={index} className="outlet-tag">
                  {outlet}
                </span>
              ))}
            </div>
          </div>

          <div className="info-box">
            <div className="info-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                <path d="M12 16v-4M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="info-text">
              <strong>How it works:</strong> The system will continuously monitor the combined monthly energy consumption of all selected outlets. When the total monthly energy reaches {combinedLimit}Wh, all active devices in this group will automatically turn off to prevent exceeding the monthly limit.
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn-primary"
            onClick={onClose}
          >
            Got it!
          </button>
        </div>
      </div>
    </div>
  )
}

// Add Device Modal Component
function AddDeviceModal({ isOpen, onClose, onSave }: AddDeviceModalProps) {
  const [formData, setFormData] = useState({
    deviceType: '',
    department: '',
    office: '',
    outletName: '',
    powerLimit: '',
    appliance: ''
  })

  const [enableScheduling, setEnableScheduling] = useState(false)
  const [enablePowerLimit, setEnablePowerLimit] = useState(true)
  const [deviceControl, setDeviceControl] = useState('on')
  const [controlDropdownOpen, setControlDropdownOpen] = useState(false)

  const [errors, setErrors] = useState<Record<string, string>>({})

  // Auto-set power limit to "No Limit" when only scheduling is enabled
  // Auto-set device control to OFF when power limit is disabled
  useEffect(() => {
    if (enableScheduling && !enablePowerLimit) {
      setFormData(prev => ({ ...prev, powerLimit: 'No Limit' }))
      setDeviceControl('off') // Auto-set to OFF when power limit is disabled
    } else if (!enableScheduling && enablePowerLimit && formData.powerLimit === 'No Limit') {
      setFormData(prev => ({ ...prev, powerLimit: '' }))
    } else if (!enablePowerLimit) {
      setDeviceControl('off') // Auto-set to OFF when power limit is disabled
    }
  }, [enableScheduling, enablePowerLimit])

  // Close control dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (controlDropdownOpen) {
        const target = event.target as Element
        if (!target.closest('.control-dropdown-container')) {
          setControlDropdownOpen(false)
        }
      }
    }

    if (controlDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [controlDropdownOpen])
  const [showSuccess, setShowSuccess] = useState(false)
  const [availableOutlets, setAvailableOutlets] = useState<string[]>([])
  const [allOutlets, setAllOutlets] = useState<any>({})
  const [departments, setDepartments] = useState<Array<{value: string, label: string}>>([])
  const [officesData, setOfficesData] = useState<any>({})

  // Function to get filtered offices based on selected department
  const getFilteredOffices = () => {
    if (!formData.department || !officesData) return []
    
    const filteredOffices: Array<{value: string, label: string}> = []
    
    Object.values(officesData).forEach((office: any) => {
      if (office.department && office.department.toLowerCase().replace(/\s+/g, '-') === formData.department) {
        filteredOffices.push({
          value: office.office.toLowerCase().replace(/\s+/g, '-'),
          label: office.office
        })
      }
    })
    
    return filteredOffices
  }

  // Fetch all outlets to determine which ones are available
  useEffect(() => {
    if (isOpen) {
      const devicesRef = ref(realtimeDb, 'devices')
      
      const unsubscribe = onValue(devicesRef, (snapshot) => {
        const data = snapshot.val()
        if (data) {
          setAllOutlets(data)
          
          // Show all outlets, regardless of assignment status
          const allOutletKeys = Object.keys(data)
          setAvailableOutlets(allOutletKeys)
        }
      })

      return () => off(devicesRef, 'value', unsubscribe)
    }
  }, [isOpen])

  // Fetch departments and offices from database
  useEffect(() => {
    if (isOpen) {
      const fetchDepartmentsAndOffices = async () => {
        try {
          const officesRef = ref(realtimeDb, 'offices')
          const snapshot = await get(officesRef)
          
          if (snapshot.exists()) {
            const officesData = snapshot.val()
            setOfficesData(officesData)
            
            const departmentsSet = new Set<string>()
            
            // Extract unique departments
            Object.values(officesData).forEach((office: any) => {
              if (office.department) {
                departmentsSet.add(office.department)
              }
            })
            
            // Convert departments set to array
            const departmentsList = Array.from(departmentsSet).map(dept => ({
              value: dept.toLowerCase().replace(/\s+/g, '-'),
              label: dept
            }))
            
            setDepartments(departmentsList)
          }
        } catch (error) {
          console.error('Error fetching departments and offices:', error)
        }
      }
      
      fetchDepartmentsAndOffices()
    }
  }, [isOpen])

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
    
    // Clear office field when department changes
    if (field === 'department') {
      setFormData(prev => ({ ...prev, office: '' }))
    }
    
    // Auto-update outlet name and populate existing data when device type changes
    if (field === 'deviceType') {
      const outletData = allOutlets[value]
      
      // Get power limit from existing data
      let existingPowerLimit = ''
      const powerLimitRaw = outletData?.relay_control?.auto_cutoff?.power_limit
      if (powerLimitRaw === "No Limit") {
        existingPowerLimit = "No Limit"
      } else if (powerLimitRaw && powerLimitRaw > 0) {
        existingPowerLimit = (powerLimitRaw * 1000).toFixed(0) // Convert from kW to W
      }
      
      // Find the department for the existing office
      let existingDepartment = ''
      if (outletData?.office_info?.office && officesData) {
        // Look for the office in the offices data to find its department
        Object.values(officesData).forEach((office: any) => {
          if (office.office === outletData.office_info.office) {
            existingDepartment = office.department?.toLowerCase().replace(/\s+/g, '-') || ''
          }
        })
      }

      // Convert office name to dropdown format (lowercase with hyphens)
      let existingOffice = ''
      if (outletData?.office_info?.office) {
        existingOffice = outletData.office_info.office.toLowerCase().replace(/\s+/g, '-')
      }

      setFormData(prev => ({ 
        ...prev, 
        [field]: value,
        outletName: value,
        // Auto-populate department, office, appliance, and power limit from existing data if available
        department: existingDepartment || prev.department,
        office: existingOffice || prev.office,
        appliance: outletData?.office_info?.appliance || prev.appliance,
        powerLimit: existingPowerLimit || prev.powerLimit
      }))
      
      // Set checkbox states - allow both to be enabled simultaneously
      if (existingPowerLimit === "No Limit") {
        setEnableScheduling(true)
        setEnablePowerLimit(false) // No power limit set, so disable power limit checkbox
        setDeviceControl('off')
      } else if (existingPowerLimit && existingPowerLimit !== '') {
        setEnableScheduling(true) // Allow scheduling to be enabled even with power limit
        setEnablePowerLimit(true) // Power limit is set, so enable power limit checkbox
        setDeviceControl('on')
      } else {
        // Default state for new devices - allow both to be enabled
        setEnableScheduling(true)
        setEnablePowerLimit(true)
        setDeviceControl('on')
      }
      
      // If we found an existing department, the office dropdown will be automatically enabled
      // and filtered to show only offices from that department
    }
  }

  const handlePowerLimitChange = (value: string) => {
    // Allow numbers and decimal point for W values
    const numericValue = value.replace(/[^0-9.]/g, '')
    // Ensure only one decimal point
    const parts = numericValue.split('.')
    const formattedValue = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : numericValue
    setFormData(prev => ({ ...prev, powerLimit: formattedValue }))
    
    // Clear error when user starts typing
    if (errors.powerLimit) {
      setErrors(prev => ({ ...prev, powerLimit: '' }))
    }
  }

  const validateForm = async () => {
    const newErrors: Record<string, string> = {}
    
    if (!formData.deviceType) newErrors.deviceType = 'Device type is required'
    if (!formData.department) newErrors.department = 'Department is required'
    if (!formData.office) newErrors.office = 'Office is required'
    if (enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0))) {
      newErrors.powerLimit = 'Power limit must be greater than 0 Wh'
    }
    if (!formData.appliance) newErrors.appliance = 'Appliance type is required'
    
    // Check if power limit is less than monthly energy consumption
    if (enablePowerLimit && formData.powerLimit && formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) > 0) {
      try {
        // Get monthly energy consumption from database for the device being added
        const outletKey = formData.deviceType.replace(/\s+/g, '_').replace(/'/g, '')
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        const deviceData = deviceSnapshot.val()
        
        if (deviceData && deviceData.daily_logs) {
          // Calculate monthly energy from daily logs
          const now = new Date()
          const currentYear = now.getFullYear()
          const currentMonth = now.getMonth() + 1
          const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
          let totalMonthlyEnergy = 0
          
          // Sum up energy for all days in the current month
          for (let day = 1; day <= daysInMonth; day++) {
            const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
            const dayData = deviceData.daily_logs[dateKey]
            if (dayData && dayData.total_energy) {
              totalMonthlyEnergy += dayData.total_energy // Already in kW from database
            }
          }
          
          const newPowerLimitkW = parseFloat(formData.powerLimit) / 1000 // Convert from Wh to kW
          
          // Check if new limit is less than current monthly energy
          if (newPowerLimitkW < totalMonthlyEnergy) {
            const currentPowerLimit = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
            
            // Provide a more specific error message if monthly energy already exceeds the current limit
            if (currentPowerLimit > 0 && totalMonthlyEnergy >= currentPowerLimit) {
              newErrors.powerLimit = `Monthly energy consumption (${(totalMonthlyEnergy * 1000).toFixed(3)} Wh) already exceeds the current limit (${(currentPowerLimit * 1000).toFixed(3)} Wh). Please increase the limit to at least ${(totalMonthlyEnergy * 1000).toFixed(3)} Wh to save changes.`
            } else {
              newErrors.powerLimit = `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than current monthly energy consumption (${(totalMonthlyEnergy * 1000).toFixed(3)} Wh). Please increase the limit to at least ${(totalMonthlyEnergy * 1000).toFixed(3)} Wh to save changes.`
            }
          }
        }
      } catch (error) {
        console.error('Error fetching monthly energy data:', error)
        // Don't block the form if we can't fetch the data, but log the error
      }
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (await validateForm()) {
      try {
        console.log('Starting database update for:', formData.deviceType)
        console.log('Power limit to set (Wh):', formData.powerLimit)
        console.log('Office to assign:', formData.office)
        
        // Update existing outlet in Firebase database
        const outletRef = ref(realtimeDb, `devices/${formData.deviceType}`)
        
        // Always update power limit (allow updating existing power limits)
        const autoCutoffRef = ref(realtimeDb, `devices/${formData.deviceType}/relay_control/auto_cutoff`)
        console.log('Updating power limit at path:', `devices/${formData.deviceType}/relay_control/auto_cutoff`)
        
        // Handle "No Limit" case for power limit
        let powerLimitToStore
        if (formData.powerLimit === 'No Limit') {
          powerLimitToStore = "No Limit" // Store as string for "No Limit" case
        } else {
          powerLimitToStore = parseFloat(formData.powerLimit) / 1000 // Convert from Wh to kW for storage
        }
        
        const powerLimitUpdate = await update(autoCutoffRef, {
          enabled: true,
          power_limit: powerLimitToStore
        })
        console.log('Power limit update result:', powerLimitUpdate)

        // Add office information to the existing outlet
        const officeRef = ref(realtimeDb, `devices/${formData.deviceType}/office_info`)
        console.log('Updating office info at path:', `devices/${formData.deviceType}/office_info`)
        console.log('Add device: Scheduling settings:', { enableScheduling, enablePowerLimit })
        
        // Get the department name from the selected department and format it properly
        const selectedDepartment = formatDepartmentName(formData.department)
        
        // Get the original office name from the database (not formatted)
        let originalOfficeName = formData.office
        if (officesData) {
          Object.values(officesData).forEach((office: any) => {
            if (office.office.toLowerCase().replace(/\s+/g, '-') === formData.office) {
              originalOfficeName = office.office
            }
          })
        }
        
        console.log('Add Device: Saving office_info with:', {
          office: originalOfficeName,
          department: selectedDepartment,
          appliance: formData.appliance,
          enable_power_scheduling: enableScheduling
        })
        
        const officeUpdate = await update(officeRef, {
          office: originalOfficeName,
          department: selectedDepartment,
          assigned_date: new Date().toISOString(),
          appliance: formData.appliance,
          enable_power_scheduling: enableScheduling // ✅ Update scheduling setting
        })
        console.log('Office update result:', officeUpdate)

        // Handle schedule data based on enableScheduling flag
        const scheduleRef = ref(realtimeDb, `devices/${formData.deviceType}/schedule`)
        if (enableScheduling) {
          console.log('Add device: Scheduling is enabled - keeping existing schedule data')
          // Schedule data remains unchanged when scheduling is enabled
        } else {
          console.log('Add device: Scheduling is disabled - clearing any existing schedule data')
          // Clear all schedule data when scheduling is disabled
          try {
            await update(scheduleRef, {
              timeRange: null,
              startTime: null,
              endTime: null,
              days: null,
              frequency: null,
              selectedDays: null,
              combinedScheduleId: null,
              isCombinedSchedule: false,
              selectedOutlets: null,
              enabled: false
            })
            console.log(`Add device: Successfully cleared schedule data for ${formData.deviceType}`)
          } catch (error) {
            console.error(`Add device: Error clearing schedule data for ${formData.deviceType}:`, error)
          }
        }
        
        console.log('Database updates completed successfully!')
        
        // Add "Wh" suffix to power limit for local state
        const deviceDataWithUnit = {
          ...formData,
          office: originalOfficeName,
          powerLimit: formData.powerLimit === 'No Limit' ? 'No Limit' : `${formData.powerLimit} W`,
          enableScheduling,
          enablePowerLimit,
          deviceControl
        }
        
        onSave(deviceDataWithUnit)
        setFormData({
          deviceType: '',
          department: '',
          office: '',
          outletName: '',
          powerLimit: '',
          appliance: ''
        })
        setShowSuccess(true)
      } catch (error) {
        console.error('Error updating database:', error)
        console.error('Error details:', {
          deviceType: formData.deviceType,
          powerLimit: formData.powerLimit,
          office: formData.office,
          error: error
        })
        // Handle error - you might want to show an error message to the user
      }
    }
  }

  const handleClose = () => {
    setFormData({
      deviceType: '',
      department: '',
      office: '',
      outletName: '',
      powerLimit: '',
      appliance: ''
    })
    setEnableScheduling(true)
    setEnablePowerLimit(true)
    setDeviceControl('on')
    setControlDropdownOpen(false)
    setErrors({})
    onClose()
  }

  const handleSuccessClose = () => {
    setShowSuccess(false)
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      <div className="modal-overlay" onClick={handleClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Add Device</h3>
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
              {/* Required Fields Section */}
              <div className="form-section">
                <div className={`form-group ${errors.deviceType ? 'error' : ''}`}>
                  <label htmlFor="deviceType">
                    Select Device <span className="required">*</span>
                    <span className="info-icon">⋯</span>
                  </label>
                  <StyledSelect
                    id="deviceType"
                    value={formData.deviceType}
                    placeholder="Choose a device"
                    options={Object.keys(allOutlets).map(outlet => {
                      const isAssigned = allOutlets[outlet]?.office_info?.office
                      return {
                        value: outlet,
                        label: isAssigned ? `${outlet} (Currently assigned to ${allOutlets[outlet].office_info.office})` : outlet,
                        disabled: false // Allow all devices to be selectable
                      }
                    })}
                    onChange={(v) => handleInputChange('deviceType', v)}
                    error={!!errors.deviceType}
                  />
                  {errors.deviceType && <span className="error-message">{errors.deviceType}</span>}
                </div>

                <div className={`form-group ${errors.department ? 'error' : ''}`}>
                  <label htmlFor="department">
                    Select Department <span className="required">*</span>
                  </label>
                  <StyledSelect
                    id="department"
                    value={formData.department}
                    placeholder="Choose department"
                    options={departments}
                    onChange={(v) => handleInputChange('department', v)}
                    error={!!errors.department}
                  />
                  {errors.department && <span className="error-message">{errors.department}</span>}
                </div>

                <div className={`form-group ${errors.office ? 'error' : ''}`}>
                  <label htmlFor="office">
                    Select office <span className="required">*</span>
                  </label>
                  <StyledSelect
                    id="office"
                    value={formData.office}
                    placeholder={formData.department ? "Choose office" : "Select department first"}
                    options={formData.department ? getFilteredOffices() : []}
                    onChange={(v) => handleInputChange('office', v)}
                    error={!!errors.office}
                    disabled={!formData.department}
                  />
                  <div className="field-hint">
                    You can change the office assignment for any selected device
                  </div>
                  {errors.office && <span className="error-message">{errors.office}</span>}
                </div>

                <div className={`form-group ${errors.appliance ? 'error' : ''}`}>
                  <label htmlFor="appliance">
                    Appliance <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    id="appliance"
                    placeholder="e.g., Computer, Monitor, Printer"
                    value={formData.appliance}
                    onChange={(e) => handleInputChange('appliance', e.target.value)}
                  />
                  {errors.appliance && <span className="error-message">{errors.appliance}</span>}
                </div>
              </div>

              {/* Divider */}
              <div className="form-divider"></div>

              {/* Optional Fields Section */}
              <div className="form-section">
                <div className="form-group">
                  <label htmlFor="outletName">
                    Outlet Name
                  </label>
                  <div className="outlet-display">
                    {formData.outletName || 'No device selected'}
                  </div>
                </div>

                {/* Enable Scheduling Checkbox */}
                <div className="field-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={enableScheduling}
                      onChange={(e) => {
                        setEnableScheduling(e.target.checked)
                        // Auto-set device control to OFF when only scheduling is enabled (no power limit)
                        if (e.target.checked && !enablePowerLimit) {
                          setDeviceControl('off')
                        }
                      }}
                      className="checkbox-input"
                    />
                    <span className="checkbox-custom"></span>
                    Enable Scheduling
                  </label>
                  <p className="field-description">
                    Enable automatic scheduling for the selected outlets
                  </p>
                </div>

                {/* Enable Power Limit Checkbox */}
                <div className="field-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={enablePowerLimit}
                      onChange={(e) => {
                        setEnablePowerLimit(e.target.checked)
                        if (!e.target.checked && enableScheduling) {
                          // If power limit is unchecked and scheduling is checked, set power limit to "No Limit"
                          setFormData(prev => ({ ...prev, powerLimit: 'No Limit' }))
                          setDeviceControl('off') // Auto-set to OFF when power limit is disabled
                        } else if (e.target.checked && formData.powerLimit === 'No Limit') {
                          // If power limit is checked and current value is "No Limit", clear it
                          setFormData(prev => ({ ...prev, powerLimit: '' }))
                        } else if (!e.target.checked) {
                          setDeviceControl('off') // Auto-set to OFF when power limit is disabled
                        }
                      }}
                      className="checkbox-input"
                    />
                    <span className="checkbox-custom"></span>
                    Enable Power Limit
                  </label>
                  <p className="field-description">
                    Set a combined power limit for the selected outlets
                  </p>
                </div>

                {/* Device Control Dropdown - Only show when Enable Power Limit is checked and Enable Scheduling is not checked */}
                {!enableScheduling && enablePowerLimit && (
                  <div className="form-group">
                    <label htmlFor="deviceControl">
                      Device Control
                    </label>
                    <div className="control-dropdown-container">
                      <div 
                        className="control-dropdown-trigger"
                        onClick={() => setControlDropdownOpen(!controlDropdownOpen)}
                      >
                        <div className="option-content">
                          <div className="option-label">
                            {deviceControl === 'on' ? 'Turn ON' : 'Turn OFF'}
                          </div>
                          <div className="option-description">
                            {deviceControl === 'on' 
                              ? 'Device will be turned on after saving' 
                              : 'Device will be turned off after saving'
                            }
                          </div>
                        </div>
                        <svg 
                          width="16" 
                          height="16" 
                          viewBox="0 0 24 24" 
                          fill="none" 
                          xmlns="http://www.w3.org/2000/svg"
                          className={`dropdown-arrow ${controlDropdownOpen ? 'open' : ''}`}
                        >
                          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                      
                      {controlDropdownOpen && (
                        <div className="control-dropdown-menu">
                          <div 
                            className={`control-dropdown-option ${deviceControl === 'on' ? 'selected' : ''}`}
                            onClick={() => {
                              setDeviceControl('on')
                              setControlDropdownOpen(false)
                            }}
                          >
                            <div className="option-content">
                              <div className="option-label">Turn ON</div>
                              <div className="option-description">Device will be turned on after saving</div>
                            </div>
                          </div>
                          <div 
                            className={`control-dropdown-option ${deviceControl === 'off' ? 'selected' : ''}`}
                            onClick={() => {
                              setDeviceControl('off')
                              setControlDropdownOpen(false)
                            }}
                          >
                            <div className="option-content">
                              <div className="option-label">Turn OFF</div>
                              <div className="option-description">Device will be turned off after saving</div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {(enablePowerLimit || enableScheduling) && (
                  <div className={`form-group ${errors.powerLimit ? 'error' : ''}`}>
                    <label htmlFor="powerLimit">
                      Set power limit (Wh) {enablePowerLimit && <span className="required">*</span>}
                    </label>
                    <input
                      type="text"
                      id="powerLimit"
                      placeholder="e.g., 150 W"
                      value={formData.powerLimit}
                      onChange={(e) => handlePowerLimitChange(e.target.value)}
                      maxLength={8}
                      className={enableScheduling && !enablePowerLimit ? 'disabled-input' : ''}
                      disabled={enableScheduling && !enablePowerLimit}
                      required={enablePowerLimit}
                    />
                    <div className="field-hint">
                      {enableScheduling && !enablePowerLimit 
                        ? "Devices will only turn off based on the schedule set. No power limit is applied."
                        : "Enter value in Wh (watt-hours). This limit will be applied to monthly energy consumption."
                      }
                    </div>
                    {errors.powerLimit && <span className="error-message">{errors.powerLimit}</span>}
                  </div>
                )}

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
              >
                Save
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Success Modal */}
      <SuccessModal isOpen={showSuccess} onClose={handleSuccessClose} />
    </>
  )
}

// Function to automatically determine device status based on power usage
const getAutomaticStatus = (powerUsage: string, limit: string): 'Active' | 'Inactive' | 'Warning' => {
  // Extract numeric values (remove 'W' suffix)
  const usage = parseFloat(powerUsage.replace(' Wh', ''))
  const limitValue = parseFloat(limit.replace(' Wh', '').replace(' W', '').replace('kW', ''))
  
  if (usage === 0) return 'Inactive'
  
  // If usage reaches or exceeds the limit, set to Inactive
  if (usage >= limitValue) return 'Inactive'
  
  // Calculate the difference from limit
  const difference = limitValue - usage
  
  // Apply Warning status when within 2 watts of the limit
  if (difference <= 2) return 'Warning'
  
  return 'Active'
}

// Helper function to check if device should be active based on schedule
// Copied from ActiveDevice.tsx - working version
// IMPORTANT: This function uses disabled_by_unplug from schedule as the PRIMARY basis for turning devices off
// Daily logs are ONLY used for power limit checks, NOT for unplug detection
const isDeviceActiveBySchedule = (schedule: any, controlState: string, deviceData?: any, skipIndividualLimitCheck?: boolean): boolean => {
  // PRIMARY CHECK: RESPECT disabled_by_unplug from schedule - this is the basis for automatically turning devices off
  // If schedule is disabled by unplug, device should NEVER be active, regardless of daily logs or any other factors
  if (schedule?.disabled_by_unplug === true) {
    return false
  }

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

  // If no frequency or invalid type, assume daily (always active)
  if (!frequency || typeof frequency !== 'string' || frequency.trim() === '') {
    isCorrectDay = true
  } else if (frequency.toLowerCase() === 'daily') {
    isCorrectDay = true
  } else if (frequency.toLowerCase() === 'weekdays') {
    isCorrectDay = currentDay >= 1 && currentDay <= 5 // Monday to Friday
  } else if (frequency.toLowerCase() === 'weekends') {
    isCorrectDay = currentDay === 0 || currentDay === 6 // Sunday or Saturday
  } else if (frequency.includes(',')) {
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
    } else {
      // If frequency doesn't match any pattern, default to true (assume daily)
      // This prevents devices from being stuck off due to unrecognized frequency formats
      console.warn(`SetUp: Unrecognized frequency format: "${frequency}" - defaulting to daily`)
      isCorrectDay = true
    }
  }

  // Check power limit validation if device data is provided and not skipping individual limit check
  if (deviceData && !skipIndividualLimitCheck) {
    const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0 // Power limit in kW
    
    // Calculate monthly energy from daily logs
    if (deviceData.daily_logs) {
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
      let totalMonthlyEnergy = 0
      
      // Sum up energy for all days in the current month
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
        const dayData = deviceData.daily_logs[dateKey]
        if (dayData && dayData.total_energy) {
          totalMonthlyEnergy += dayData.total_energy // Already in kW from database
        }
      }
      
      // If device has a power limit and monthly energy exceeds it, don't activate
      if (powerLimit > 0 && totalMonthlyEnergy >= powerLimit) {
        console.log(`Schedule check: Device ${deviceData.outletName || 'Unknown'} power limit exceeded:`, {
          monthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(3)}W`,
          powerLimit: `${(powerLimit * 1000)}W`,
          scheduleResult: false,
          reason: 'Monthly energy consumption exceeded power limit'
        })
        return false
      }
    }
  }

  // Device is active if it's within time range and on correct day
  return isWithinTimeRange && isCorrectDay
}




// Function to check if device can be turned ON based on schedule
// Note: Main status ON can override schedule restrictions
const canDeviceBeTurnedOn = (schedule: any): boolean => {
  // If no schedule exists, device can always be turned ON
  if (!schedule || (!schedule.timeRange && !schedule.startTime)) {
    return true
  }

  // Check if device is currently within its scheduled time range
  // However, main status ON will override this restriction
  return isDeviceActiveBySchedule(schedule, 'on')
}

  // Function to check if device can be manually controlled based on schedule and current status
  const canDeviceBeManuallyControlled = (schedule: any, currentStatus: string): boolean => {
    // If no schedule exists, device can always be controlled
    if (!schedule || (!schedule.timeRange && !schedule.startTime)) {
      return true
    }

    // Check if device is currently within its scheduled time range
    const isWithinSchedule = isDeviceActiveBySchedule(schedule, 'on')
    
    // If within schedule: can be turned ON or OFF
    // If outside schedule: can only be turned OFF
    return isWithinSchedule || currentStatus === 'OFF'
  }

export default function SetUp() {
  const [searchTerm, setSearchTerm] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null)
  
  // Add debounce mechanism to prevent duplicate monthly limit checks
  const [lastMonthlyLimitCheck, setLastMonthlyLimitCheck] = useState<number>(0)
  const MONTHLY_LIMIT_DEBOUNCE_MS = 5000 // 5 seconds debounce
  const [editModal, setEditModal] = useState<{
    isOpen: boolean;
    device: Device | null;
  }>({
    isOpen: false,
    device: null
  })
  const [editSuccessModal, setEditSuccessModal] = useState<{
    isOpen: boolean;
    deviceName: string;
  }>({
    isOpen: false,
    deviceName: ''
  })
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean;
    deviceId: string;
    deviceName: string;
  }>({
    isOpen: false,
    deviceId: '',
    deviceName: ''
  })
  const [combinedLimitModal, setCombinedLimitModal] = useState<{
    isOpen: boolean;
  }>({
    isOpen: false
  })
  const [combinedLimitSuccessModal, setCombinedLimitSuccessModal] = useState<{
    isOpen: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    isEdit: boolean;
  }>({
    isOpen: false,
    selectedOutlets: [],
    combinedLimit: 0,
    isEdit: false
  })
  const [combinedLimitInfo, setCombinedLimitInfo] = useState<{
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    device_control?: string;
    department?: string;
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0,
    device_control: 'on',
    department: ''
  })
  
  // Track all department combined limits
  const [allDepartmentCombinedLimits, setAllDepartmentCombinedLimits] = useState<Record<string, {
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
    device_control?: string;
    department?: string;
  }>>({})
  const [deleteSuccessModal, setDeleteSuccessModal] = useState<{
    isOpen: boolean;
    deviceName: string;
  }>({
    isOpen: false,
    deviceName: ''
  })
  const [noPowerLimitModal, setNoPowerLimitModal] = useState<{
    isOpen: boolean;
    device: Device | null;
  }>({
    isOpen: false,
    device: null
  })
  const [monthlyLimitModal, setMonthlyLimitModal] = useState<{
    isOpen: boolean;
    device: Device | null;
    reason: string;
    currentMonthlyEnergy?: number;
    combinedLimit?: number;
  }>({
    isOpen: false,
    device: null,
    reason: ''
  })
  const [editRestrictionModal, setEditRestrictionModal] = useState<{
    isOpen: boolean;
    device: Device | null;
    combinedLimit: number | string;
  }>({
    isOpen: false,
    device: null,
    combinedLimit: 0
  })
  const [devices, setDevices] = useState<Device[]>([])

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
  
  // Fetch devices data from Firebase
  useEffect(() => {
    const devicesRef = ref(realtimeDb, 'devices')
    
    const unsubscribe = onValue(devicesRef, (snapshot) => {
      try {
        console.log(`SetUp: Firebase data updated at ${new Date().toLocaleTimeString()}`)
        const data = snapshot.val()
        console.log('SetUp: Firebase data received:', data)
        
        if (data) {
        const devicesArray: Device[] = []
        let deviceId = 1

        // Get today's date in the format used by daily_logs (day_YYYY_MM_DD)
        const today = new Date()
        const todayString = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`

        Object.keys(data).forEach((outletKey) => {
          const outlet = data[outletKey]
          if (outlet.sensor_data) {
            // Use lifetime_energy as current power usage (already in kW from database)
            const lifetimeEnergyKw = outlet.lifetime_energy || 0
            const powerUsageDisplay = `${formatNumber(lifetimeEnergyKw * 1000)} Wh`
            const powerUsage = lifetimeEnergyKw / 1000 // Keep in kW for calculations
            const powerLimitRaw = outlet.relay_control?.auto_cutoff?.power_limit || 0
            const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
            const enabled = outlet.relay_control?.auto_cutoff?.enabled || false
            const status = outlet.control?.device || 'off'
            const totalEnergyWatts = outlet.daily_logs?.[todayString]?.total_energy || 0
            // Use total_energy for today's energy (already in kW from database)
            const todayEnergyDisplay = `${formatNumber(totalEnergyWatts * 1000)} Wh`
            const totalEnergy = totalEnergyWatts / 1000 // Keep in kW for calculations
            
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
            
            // Debug: Log the actual data being retrieved
            console.log(`SetUp: Outlet ${outletKey}:`, {
              powerUsage,
              powerLimit,
              enabled,
              status,
              totalEnergy,
              officeValue,
              officeInfo,
              office_info: outlet.office_info,
              hasOfficeInfo: !!outlet.office_info,
              relayControl: outlet.relay_control,
              hasRelayControl: !!outlet.relay_control,
              hasPowerLimit: !!outlet.relay_control?.auto_cutoff?.power_limit,
              fullOutletData: outlet
            })
            
            // Helper function to check if device should be active based on schedule
            // IMPORTANT: Uses disabled_by_unplug from schedule as the PRIMARY basis for turning devices off
            // Daily logs are ONLY used for power limit checks, NOT for unplug detection
            const isDeviceActiveBySchedule = (schedule: any, controlState: string): boolean => {
              // PRIMARY CHECK: RESPECT disabled_by_unplug from schedule - this is the basis for automatically turning devices off
              // If schedule is disabled by unplug, device should NEVER be active, regardless of daily logs
              if (schedule?.disabled_by_unplug === true) {
                return false
              }

              // If no schedule exists, use control state
              if (!schedule || !schedule.timeRange) {
                return controlState === 'on'
              }

              // If control is off, device is inactive regardless of schedule
              if (controlState !== 'on') {
                return false
              }

              const now = new Date()
              const currentTime = now.getHours() * 60 + now.getMinutes() // Convert to minutes
              const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.

              // Parse schedule time range (e.g., "8:00 AM - 5:00 PM")
              const timeRange = schedule.timeRange
              if (!timeRange || typeof timeRange !== 'string' || !timeRange.includes(' - ')) {
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
                if (parts.length < 2 || !parts[0] || !parts[1]) {
                  throw new Error('Invalid time format - missing AM/PM')
                }
                const [time, modifier] = parts
                const timeParts = time.split(':')
                if (timeParts.length < 2 || !timeParts[0] || !timeParts[1]) {
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

              let startTime: number, endTime: number
              try {
                startTime = convertTo24Hour(startTimeStr)
                endTime = convertTo24Hour(endTimeStr)
              } catch (error) {
                return controlState === 'on'
              }

              // Check if current time is within schedule
              // Turn off exactly at end time - device is active only when current time is less than end time
              const isWithinTimeRange = currentTime >= startTime && currentTime < endTime

              // Check if current day is in schedule
              const frequency = schedule.frequency
              let isCorrectDay = false

              if (!frequency || typeof frequency !== 'string' || frequency.trim() === '') {
                isCorrectDay = true // Default to daily if no frequency
              } else {
                const frequencyLower = frequency.toLowerCase()
                if (frequencyLower === 'daily') {
                  isCorrectDay = true
                } else if (frequencyLower === 'weekdays') {
                  isCorrectDay = currentDay >= 1 && currentDay <= 5 // Monday to Friday
                } else if (frequencyLower === 'weekends') {
                  isCorrectDay = currentDay === 0 || currentDay === 6 // Sunday or Saturday
                } else if (frequency.includes(',')) {
                  try {
                    // Custom days (e.g., "MONDAY, WEDNESDAY, FRIDAY")
                    const dayMap: { [key: string]: number } = {
                      'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
                      'friday': 5, 'saturday': 6, 'sunday': 0
                    }
                    const scheduledDays = frequency.split(',').map((day: string) => {
                      if (!day || typeof day !== 'string') return undefined
                      return dayMap[day.trim().toLowerCase()]
                    }).filter((day: number | undefined) => day !== undefined) as number[]
                    isCorrectDay = scheduledDays.includes(currentDay)
                  } catch (error) {
                    isCorrectDay = true // Default to daily if parsing fails
                  }
                }
              }

              return isWithinTimeRange && isCorrectDay
            }

            // Use schedule-aware status logic with status consideration
            const outletStatus = outlet.status || 'ON'
            
            // Debug: Log the control state reading
            console.log(`SetUp: Outlet ${outletKey} control object:`, outlet.control)
            console.log(`SetUp: Outlet ${outletKey} control.device value:`, outlet.control?.device)
            
            // Use Dashboard.tsx approach: simple status from control.device
            const controlState = outlet.control?.device || 'off'
            console.log(`SetUp: Outlet ${outletKey} control.device: "${controlState}"`)
            
            // Check for idle status from root level
            const sensorStatus = outlet.status
            const isIdleFromSensor = sensorStatus === 'idle'
            
            // Idle detection logic
            const currentTime = Date.now()
            const currentTotalEnergy = outlet.daily_logs?.[todayString]?.total_energy || 0
            
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
            let deviceStatus: 'Active' | 'Inactive' | 'Warning' | 'Idle' | 'UNPLUG'
            
            // PRIORITY 1: UNPLUG - Check if device is unplugged (from root status or disabled_by_unplug flag)
            // This MUST be checked first - UNPLUG takes precedence over Active/Inactive
            if (sensorStatus === 'UNPLUG' || sensorStatus === 'unplug' || outlet.schedule?.disabled_by_unplug === true) {
              deviceStatus = 'UNPLUG'
            } else if ((isIdleFromSensor || isIdleFromLogic) && controlState === 'on') {
              // PRIORITY 2: Show Idle if sensor reports idle OR if device is supposed to be ON but not responding
              deviceStatus = 'Idle'
            } else {
              // PRIORITY 3: Active/Inactive based on control state (only if NOT unplugged)
              deviceStatus = controlState === 'on' ? 'Active' : 'Inactive'
            }
            
            console.log(`SetUp: ${outletKey} - Final status: ${deviceStatus} (control: ${controlState}, sensorIdle: ${isIdleFromSensor}, logicIdle: ${isIdleFromLogic}, energy: ${currentTotalEnergy})`)

            // Auto-turnoff logic disabled to prevent interference with data uploads
            // Clear any existing auto-turnoff timers to prevent interference
            clearAutoTurnoffTimer(outletKey, setAutoTurnoffTimers)

            // Auto-turnoff functionality disabled to prevent interference with data uploads
            // Reset auto-turnoff function when outlet turns on again
            // if (controlChanged && controlState === 'on') {
            //   resetAutoTurnoffFunction(outletKey, setAutoTurnoffTimers)
            // }

            // Debug: Log schedule data for troubleshooting
            if (outlet.schedule) {
              console.log(`SetUp: Schedule data for ${outletKey}:`, outlet.schedule)
              console.log(`SetUp: Schedule keys for ${outletKey}:`, Object.keys(outlet.schedule))
              console.log(`SetUp: Schedule has timeRange:`, !!outlet.schedule.timeRange)
              console.log(`SetUp: Schedule has startTime:`, !!outlet.schedule.startTime)
              console.log(`SetUp: Schedule has frequency:`, !!outlet.schedule.frequency)
            }

            // Get current (ampere) from sensor_data - with 2 decimal places
            const currentAmpere = outlet.sensor_data?.current || 0
            const currentAmpereDisplay = `${currentAmpere.toFixed(2)}A`
            
            // Get department from office_info
            const deviceDepartment = outlet.office_info?.department ? 
              outlet.office_info.department.toLowerCase().replace(/\s+/g, '-') : 
              undefined
            
            const deviceData: Device = {
              id: String(deviceId).padStart(3, '0'),
              outletName: outletKey, // Use the actual outlet key from Firebase
              officeRoom: officeInfo, // Use office info from database
              appliances: outlet.office_info?.appliance || 'Unassigned',
              enablePowerScheduling: outlet.office_info?.enable_power_scheduling || false,
              limit: powerLimit === "No Limit" ? "No Limit" : `${(powerLimit * 1000).toFixed(3)} Wh`,
              powerUsage: powerUsageDisplay, // Use the new display format
              currentAmpere: currentAmpereDisplay,
              todayUsage: todayEnergyDisplay, // Use the new display format
              monthUsage: calculateMonthlyEnergy(outlet), // Calculate monthly energy
              status: deviceStatus,
              department: deviceDepartment,
              schedule: outlet.schedule && (outlet.schedule.timeRange || outlet.schedule.startTime || outlet.schedule.frequency) ? {
                timeRange: outlet.schedule.timeRange || (outlet.schedule.startTime && outlet.schedule.endTime && 
                  typeof outlet.schedule.startTime === 'string' && typeof outlet.schedule.endTime === 'string' ? 
                  (() => {
                    // Convert 24-hour format to 12-hour format for display
                    const convertTo12Hour = (time24h: string) => {
                      if (!time24h || typeof time24h !== 'string') return ''
                      try {
                        const parts = time24h.split(':')
                        if (parts.length < 2 || !parts[0] || !parts[1]) return ''
                        const hour = parseInt(parts[0], 10)
                        if (isNaN(hour)) return ''
                        const minutes = parts[1]
                        const ampm = hour >= 12 ? 'PM' : 'AM'
                        const hour12 = hour % 12 || 12
                        return `${hour12}:${minutes} ${ampm}`
                      } catch (error) {
                        return ''
                      }
                    }
                    const startTime12 = convertTo12Hour(outlet.schedule.startTime)
                    const endTime12 = convertTo12Hour(outlet.schedule.endTime)
                    return `${startTime12} - ${endTime12}`
                  })() : ''),
                frequency: outlet.schedule.frequency || 'Daily'
              } : undefined
            }
            devicesArray.push(deviceData)
            deviceId++
          }
        })

        console.log('SetUp: Setting devices array:', devicesArray)
        setDevices(devicesArray)
        
        // NOTE: Monthly limit checking is handled by the scheduler useEffect (checkScheduleAndUpdateDevices)
        // Do NOT call checkCombinedMonthlyLimit here to avoid spamming database updates
      } else {
        console.log('SetUp: No data in Firebase - all devices deleted or database empty')
        setDevices([])
      }
      } catch (error) {
        console.error('SetUp: Error processing Firebase data:', error)
        // Don't crash the app - just log the error
      }
    })

      return () => off(devicesRef, 'value', unsubscribe)
   }, [allDepartmentCombinedLimits])

  // Function to check monthly limits
  // IMPORTANT: This function checks daily logs ONLY for power limit enforcement
// It does NOT check for unplug detection - unplug detection is based on disabled_by_unplug in schedule
const checkMonthlyLimit = (deviceData: any): boolean => {
    try {
      // NOTE: This function uses daily_logs ONLY for power limit checks
      // Unplug detection is based on disabled_by_unplug in schedule, NOT daily logs
      const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
      if (powerLimit <= 0) return false // No monthly limit set
      
      // Calculate monthly energy from daily logs
      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
      let totalMonthlyEnergy = 0
      
      // Sum up energy for all days in the current month
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
        const dayData = deviceData.daily_logs?.[dateKey]
        if (dayData && dayData.total_energy) {
          totalMonthlyEnergy += dayData.total_energy // Already in kW from database
        }
      }
      
      console.log('SetUp: Monthly limit check:', {
        powerLimit: `${powerLimit}kW`,
        monthlyTotalEnergy: `${totalMonthlyEnergy}kW`,
        exceeded: totalMonthlyEnergy >= powerLimit
      })
      
      return totalMonthlyEnergy >= powerLimit
    } catch (error) {
      console.error('SetUp: Error checking monthly limit:', error)
      return false
    }
  }

  // Real-time scheduler that checks every minute and updates control.device
  useEffect(() => {
    // Helper function to check if combined monthly limit is exceeded for a single device (returns boolean)
    const checkCombinedMonthlyLimitHelper = (deviceData: any, combinedLimitInfo: any): boolean => {
      try {
        if (!combinedLimitInfo?.enabled) return false
        
        const combinedLimitWatts = combinedLimitInfo.combinedLimit
        if (!combinedLimitWatts || combinedLimitWatts === "No Limit" || combinedLimitWatts <= 0) return false
        
        // Calculate monthly energy from daily logs
        const now = new Date()
        const currentYear = now.getFullYear()
        const currentMonth = now.getMonth() + 1
        const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
        let totalMonthlyEnergy = 0
        
        // Sum up energy for all days in the current month
        for (let day = 1; day <= daysInMonth; day++) {
          const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
          const dayData = deviceData?.daily_logs?.[dateKey]
          if (dayData && dayData.total_energy) {
            totalMonthlyEnergy += dayData.total_energy // Already in kW from database
          }
        }
        
        const totalMonthlyEnergyWh = totalMonthlyEnergy * 1000 // Convert to Wh
        
        return totalMonthlyEnergyWh >= combinedLimitWatts
      } catch (error) {
        console.error('SetUp: Error checking combined monthly limit:', error)
        return false
      }
    }
    
    const checkScheduleAndUpdateDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          console.log(`SetUp: Real-time scheduler check at ${new Date().toLocaleTimeString()}`)
          
          // HIERARCHY: Check monthly limit FIRST (highest priority) - AUTO TURN OFF
          // This automatically turns off all devices if monthly limit is exceeded
          // Check ALL departments' combined limits
          console.log('🔍 SetUp: Running monthly limit check FIRST for all departments...')
          
          const departmentKeys = Object.keys(allDepartmentCombinedLimits)
          for (const deptKey of departmentKeys) {
            const deptLimitInfo = allDepartmentCombinedLimits[deptKey]
            if (deptLimitInfo?.enabled && deptLimitInfo?.selectedOutlets?.length > 0) {
              await checkCombinedMonthlyLimit(devicesData, {
                ...deptLimitInfo,
                department: deptKey
              })
            }
          }
          
          // CRITICAL: Re-fetch device data AFTER monthly limit check
          // The checkCombinedMonthlyLimit may have set status='OFF' in Firebase
          // We need fresh data to respect those changes
          const freshSnapshot = await get(devicesRef)
          if (!freshSnapshot.exists()) {
            console.log('SetUp: No device data after monthly limit check')
            return
          }
          const freshDevicesData = freshSnapshot.val()
          console.log('🔄 SetUp: Re-fetched device data after monthly limit enforcement')
          
          // Check monthly limit status for all departments' combined groups
          const departmentLimitStatus: Record<string, { exceeded: boolean; totalEnergy: number; limit: number }> = {}
          
          for (const deptKey of departmentKeys) {
            const deptLimitInfo = allDepartmentCombinedLimits[deptKey]
            if (deptLimitInfo?.enabled && deptLimitInfo?.selectedOutlets?.length > 0) {
              const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(freshDevicesData, deptLimitInfo.selectedOutlets)
              const combinedLimitWatts = deptLimitInfo.combinedLimit
              
              // Skip limit check if "No Limit" is set
              if (String(combinedLimitWatts) !== "No Limit" && combinedLimitWatts > 0) {
                departmentLimitStatus[deptKey] = {
                  exceeded: totalMonthlyEnergy >= combinedLimitWatts,
                  totalEnergy: totalMonthlyEnergy,
                  limit: combinedLimitWatts
                }
                
                if (totalMonthlyEnergy >= combinedLimitWatts) {
                  console.log(`🚨 SetUp: MONTHLY LIMIT EXCEEDED for department ${deptKey}`)
                  console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
                } else {
                  console.log(`✅ SetUp: Monthly limit OK for department ${deptKey}`)
                  console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
                }
              }
            }
          }
          
          for (const [outletKey, outletData] of Object.entries(freshDevicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules
            if (deviceData.schedule && 
                (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
              
              const currentControlState = deviceData.control?.device || 'off'
              const currentStatus = deviceData.status || 'ON'
              const currentMainStatus = deviceData.relay_control?.main_status || 'ON'

              // NOTE: "Idle" is a display-only status calculated in the component, not stored in Firebase
              // We don't check for idle status here - instead, we check the schedule time
              // If the device should be ON by schedule, it stays ON regardless of idle detection

              // PRIMARY CHECK: RESPECT disabled_by_unplug from schedule - this is the BASIS for automatically turning devices off
              // NOTE: disabled_by_unplug in schedule is the basis for unplug detection, NOT daily logs
              // Daily logs are ONLY used for power limit checks, never for unplug detection
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`SetUp: Device ${outletKey} is disabled by unplug (based on schedule.disabled_by_unplug) - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`SetUp: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
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
                  console.log(`SetUp: Set main_status to OFF for unplugged device ${outletKey}`)
                }
                continue
              }

              // RESPECT bypass mode FIRST - if main_status is ON, device is in bypass mode (manually overridden to stay ON)
              // In bypass mode, schedule should NOT control the device - it stays ON regardless of schedule
              if (currentMainStatus === 'ON') {
                console.log(`SetUp: Device ${outletKey} has main_status = 'ON' - respecting bypass mode, skipping schedule check`)
                continue
              }

              // RESPECT manual override - if status is OFF AND main_status is OFF, don't override it (device is manually disabled)
              // This is a true manual override where user explicitly turned device OFF
              if (currentStatus === 'OFF' && currentMainStatus === 'OFF') {
                console.log(`SetUp: Device ${outletKey} has status = 'OFF' and main_status = 'OFF' - respecting manual override, skipping schedule check`)
                continue
              }
              
              // If status is 'OFF' but main_status is not 'OFF' (or is 'ON'), it might be from a previous schedule turn-off
              // Allow the schedule to control it (it will turn ON if schedule says so, or OFF if schedule says so)
              // The scheduler will update both control.device and main_status based on schedule
              
              // CRITICAL: Check if device is past schedule end time BEFORE any other logic
              if (deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
                const now = new Date()
                const currentTime = now.getHours() * 60 + now.getMinutes()
                let endTime: number = 0
                
                if (deviceData.schedule.startTime && deviceData.schedule.endTime &&
                    typeof deviceData.schedule.startTime === 'string' && typeof deviceData.schedule.endTime === 'string') {
                  try {
                    const [endHours, endMinutes] = deviceData.schedule.endTime.split(':').map(Number)
                    if (!isNaN(endHours) && !isNaN(endMinutes)) {
                      endTime = endHours * 60 + endMinutes
                    }
                  } catch (error) {
                    // If parsing fails, skip this check
                  }
                } else if (deviceData.schedule.timeRange && typeof deviceData.schedule.timeRange === 'string' &&
                           deviceData.schedule.timeRange.includes(' - ')) {
                  try {
                    const timeRangeParts = deviceData.schedule.timeRange.split(' - ')
                    if (timeRangeParts.length >= 2 && timeRangeParts[1]) {
                      const endTimeStr = timeRangeParts[1]
                      const convertTo24Hour = (time12h: string): number => {
                        if (!time12h || typeof time12h !== 'string') return 0
                        const parts = time12h.split(' ')
                        if (parts.length < 2) return 0
                        const [time, modifier] = parts
                        if (!time || !modifier) return 0
                        const timeParts = time.split(':')
                        if (timeParts.length < 2) return 0
                        let [hours, minutes] = timeParts.map(Number)
                        if (isNaN(hours) || isNaN(minutes)) return 0
                        if (hours === 12) hours = 0
                        if (modifier === 'PM') hours += 12
                        return hours * 60 + minutes
                      }
                      endTime = convertTo24Hour(endTimeStr)
                    }
                  } catch (error) {
                    // If parsing fails, skip this check
                  }
                }
                
                // If device is past schedule end time, FORCE it OFF and set main_status to OFF
                if (endTime > 0 && currentTime >= endTime) {
                  console.log(`🔒 SetUp: Device ${outletKey} is past schedule end time - FORCING OFF and locking main_status`)
                  
                  // Force device OFF
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Lock main_status to OFF to prevent any re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`🔒 SetUp: Device ${outletKey} LOCKED OFF - past schedule end time (current: ${Math.floor(currentTime / 60)}:${(currentTime % 60).toString().padStart(2, '0')}, end: ${Math.floor(endTime / 60)}:${(endTime % 60).toString().padStart(2, '0')})`)
                  continue
                }
              }
              
              // Check if device is in any department's combined group (normalize outlet names for comparison)
              const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
              const outletNameWithSpace = outletKey.replace(/_/g, ' ')
              
              // Find which department this device belongs to and if it's in that department's combined limit
              let deviceDepartmentLimit: { department: string; limitInfo: any; device_control?: string } | null = null
              
              // First, get the device's department
              const deviceDept = deviceData.office_info?.department
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
              
              const isInCombinedGroup = !!deviceDepartmentLimit
              
              // CRITICAL: If device is in a department's combined group and that department's device_control is "off", force device OFF
              if (isInCombinedGroup && deviceDepartmentLimit?.device_control === 'off') {
                console.log(`🔒 SetUp: FORCING ${outletKey} OFF - ${deviceDepartmentLimit.department} combined_limit_settings/device_control is OFF (monthly limit enforcement)`)
                // Force device OFF
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: 'off'
                })
                await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                  main_status: 'OFF'
                })
                // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                // For idle devices, leave status as is - the display logic will show "Inactive" when control='off'
                if (currentControlState === 'on') {
                  // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                  console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
                } else {
                  // Device was already off - safe to set status='OFF'
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'OFF'
                  })
                }
                continue
              }
              
              // CRITICAL: Check limits FIRST before any schedule logic
              // PRIORITY #1: Monthly limit check (for combined group devices)
              // PRIORITY #2: Combined monthly limit check (for combined group devices)
              // PRIORITY #3: Individual monthly limit check (for non-combined group devices)
              
              // CRITICAL: Initialize newControlState to current state, not 'off'
              // This prevents devices from being turned off by default before schedule/limit checks
              // If a device is idle (control='on'), it should stay 'on' unless schedule/limits say otherwise
              let newControlState = currentControlState // Start with current state
              let limitsExceeded = false
              
              if (isInCombinedGroup && deviceDepartmentLimit) {
                // For devices in combined group: Check monthly limit FIRST
                const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
                  ...deviceDepartmentLimit.limitInfo,
                  department: deviceDepartmentLimit.department
                })
                if (!monthlyLimitCheck.canTurnOn) {
                  // CRITICAL: If monthly limit exceeded, FORCE OFF and skip schedule check entirely
                  limitsExceeded = true
                  newControlState = 'off'
                  console.log(`🔒 SetUp: FORCING ${outletKey} OFF - MONTHLY LIMIT EXCEEDED for department ${deviceDepartmentLimit.department} - SKIPPING SCHEDULE CHECK`)
                  
                  // Also check device_control - if it's 'off' due to monthly limit, enforce it
                  if (deviceDepartmentLimit.device_control === 'off') {
                    await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                      device: 'off'
                    })
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                    // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                    // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                    if (currentControlState === 'on') {
                      // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                      console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
                    } else {
                      // Device was already off - safe to set status='OFF'
                      await update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'OFF'
                      })
                    }
                    console.log(`🔒 SetUp: Enforced device_control='off' for ${outletKey} due to monthly limit exceeded in department ${deviceDepartmentLimit.department}`)
                  }
                } else {
                  // Monthly limit OK, now check combined monthly limit
                  const isMonthlyLimitExceeded = checkCombinedMonthlyLimitHelper(deviceData, {
                    ...deviceDepartmentLimit.limitInfo,
                    department: deviceDepartmentLimit.department
                  })
                  if (isMonthlyLimitExceeded) {
                    limitsExceeded = true
                    newControlState = 'off' // Force OFF if combined monthly limit exceeded
                    console.log(`🔒 SetUp: FORCING ${outletKey} OFF - COMBINED MONTHLY LIMIT EXCEEDED for department ${deviceDepartmentLimit.department} - SKIPPING SCHEDULE CHECK`)
                  }
                }
              } else {
                // For devices NOT in combined group: Check individual monthly limit
                const isMonthlyLimitExceeded = checkMonthlyLimit(deviceData)
                if (isMonthlyLimitExceeded) {
                  limitsExceeded = true
                  newControlState = 'off' // Force OFF if monthly limit exceeded
                  console.log(`🔒 SetUp: FORCING ${outletKey} OFF - INDIVIDUAL MONTHLY LIMIT EXCEEDED - SKIPPING SCHEDULE CHECK`)
                }
              }
              
              // ONLY check schedule if limits are NOT exceeded
              // IMPORTANT: Each device is processed independently - unplugged devices don't block others
              if (!limitsExceeded) {
                // Check if device has combined schedule (stored in device's schedule with isCombinedSchedule: true)
                const hasCombinedSchedule = deviceData.schedule?.isCombinedSchedule === true
                
                // Use the device's schedule (which may be a combined schedule)
                // Combined schedules are stored directly in the device's schedule with isCombinedSchedule: true
                const scheduleToCheck = deviceData.schedule
                
                const shouldBeActive = isDeviceActiveBySchedule(scheduleToCheck, 'on', deviceData, isInCombinedGroup)
                newControlState = shouldBeActive ? 'on' : 'off'
                
                // Log detailed schedule information for debugging
                const now = new Date()
                const currentTime = now.getHours() * 60 + now.getMinutes()
                const scheduleInfo = scheduleToCheck ? {
                  timeRange: scheduleToCheck.timeRange,
                  startTime: scheduleToCheck.startTime,
                  endTime: scheduleToCheck.endTime,
                  frequency: scheduleToCheck.frequency,
                  isCombinedSchedule: hasCombinedSchedule
                } : 'No schedule'
                
                console.log(`✅ SetUp: Limits OK for ${outletKey} - Schedule check:`, {
                  shouldBeActive,
                  newControlState,
                  currentTime: `${Math.floor(currentTime / 60)}:${(currentTime % 60).toString().padStart(2, '0')}`,
                  schedule: scheduleInfo,
                  scheduleType: hasCombinedSchedule ? 'Combined' : 'Individual'
                })
              }
              
              console.log(`SetUp: Final status determination for ${outletKey}:`, {
                limitsExceeded: limitsExceeded,
                finalDecision: newControlState,
                currentState: currentControlState,
                needsUpdate: currentControlState !== newControlState,
                isInCombinedGroup: isInCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                // FINAL SAFETY CHECK: Never turn ON a device if limits are exceeded
                // Re-check limits before turning ON to prevent race conditions
                if (newControlState === 'on') {
                  console.log(`🔍 SetUp: FINAL SAFETY CHECK before turning ON ${outletKey}`)
                  
                  // Re-fetch latest device data
                  const latestDeviceRef = ref(realtimeDb, `devices/${outletKey}`)
                  const latestDeviceSnapshot = await get(latestDeviceRef)
                  const latestDeviceData = latestDeviceSnapshot.val()
                  
                  // Check if device is disabled by unplug
                  if (latestDeviceData?.schedule?.disabled_by_unplug === true) {
                    console.log(`🔒 SetUp: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - device is disabled by unplug`)
                    // Force it to stay off
                    await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                      device: 'off'
                    })
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                    continue
                  }
                  
                  // Re-check limits one final time before allowing ON
                  // Re-check which department this device belongs to
                  const latestDeviceDept = latestDeviceData?.office_info?.department
                  const latestDeviceDeptKey = latestDeviceDept ? latestDeviceDept.toLowerCase().replace(/\s+/g, '-') : null
                  let latestDeviceDepartmentLimit: { department: string; limitInfo: any } | null = null
                  
                  if (latestDeviceDeptKey && allDepartmentCombinedLimits[latestDeviceDeptKey]) {
                    const deptLimitInfo = allDepartmentCombinedLimits[latestDeviceDeptKey]
                    if (deptLimitInfo.enabled && deptLimitInfo.selectedOutlets) {
                      const isInDeptLimit = deptLimitInfo.selectedOutlets.some((selectedOutlet: string) => {
                        const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                        return normalizedSelected === normalizedOutletKey || 
                               selectedOutlet === outletKey ||
                               selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                      })
                      
                      if (isInDeptLimit) {
                        latestDeviceDepartmentLimit = {
                          department: latestDeviceDeptKey,
                          limitInfo: deptLimitInfo
                        }
                      }
                    }
                  }
                  
                  // Fallback: Check all departments
                  if (!latestDeviceDepartmentLimit) {
                    for (const [deptKey, deptLimitInfo] of Object.entries(allDepartmentCombinedLimits)) {
                      const typedDeptLimitInfo = deptLimitInfo as {
                        enabled: boolean;
                        selectedOutlets: string[];
                        combinedLimit: number;
                      }
                      
                      if (typedDeptLimitInfo.enabled && typedDeptLimitInfo.selectedOutlets) {
                        const isInDeptLimit = typedDeptLimitInfo.selectedOutlets.some((selectedOutlet: string) => {
                          const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                          return normalizedSelected === normalizedOutletKey || 
                                 selectedOutlet === outletKey ||
                                 selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                        })
                        
                        if (isInDeptLimit) {
                          latestDeviceDepartmentLimit = {
                            department: deptKey,
                            limitInfo: typedDeptLimitInfo
                          }
                          break
                        }
                      }
                    }
                  }
                  
                  if (latestDeviceDepartmentLimit) {
                    const finalMonthlyCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
                      ...latestDeviceDepartmentLimit.limitInfo,
                      department: latestDeviceDepartmentLimit.department
                    })
                    if (!finalMonthlyCheck.canTurnOn) {
                      console.log(`🔒 SetUp: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - MONTHLY LIMIT EXCEEDED for department ${latestDeviceDepartmentLimit.department}`)
                      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                        device: 'off'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                      // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                      // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                      const latestControlState = latestDeviceData?.control?.device || 'off'
                      if (latestControlState === 'on') {
                        // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                        console.log(`✅ SetUp: FINAL SAFETY CHECK - Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
                      } else {
                        // Device was already off - safe to set status='OFF'
                        await update(ref(realtimeDb, `devices/${outletKey}`), {
                          status: 'OFF'
                        })
                        console.log(`🔒 SetUp: Set status='OFF' for ${outletKey} to prevent re-activation loop`)
                      }
                      continue
                    }
                    
                    const finalDailyCheck = checkCombinedMonthlyLimitHelper(latestDeviceData, {
                      ...latestDeviceDepartmentLimit.limitInfo,
                      department: latestDeviceDepartmentLimit.department
                    })
                    if (finalDailyCheck) {
                      console.log(`🔒 SetUp: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - COMBINED MONTHLY LIMIT EXCEEDED for department ${latestDeviceDepartmentLimit.department}`)
                      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                        device: 'off'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                      // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                      // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                      const latestControlState = latestDeviceData?.control?.device || 'off'
                      if (latestControlState === 'on') {
                        // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                        console.log(`✅ SetUp: FINAL SAFETY CHECK - Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
                      } else {
                        // Device was already off - safe to set status='OFF'
                        await update(ref(realtimeDb, `devices/${outletKey}`), {
                          status: 'OFF'
                        })
                        console.log(`🔒 SetUp: Set status='OFF' for ${outletKey} to prevent re-activation loop`)
                      }
                      continue
                    }
                  } else {
                    const finalDailyCheck = checkMonthlyLimit(latestDeviceData)
                    if (finalDailyCheck) {
                      console.log(`🔒 SetUp: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - INDIVIDUAL MONTHLY LIMIT EXCEEDED`)
                      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                        device: 'off'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                      // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                      // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                      const latestControlState = latestDeviceData?.control?.device || 'off'
                      if (latestControlState === 'on') {
                        // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                        console.log(`✅ SetUp: FINAL SAFETY CHECK - Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
                      } else {
                        // Device was already off - safe to set status='OFF'
                        await update(ref(realtimeDb, `devices/${outletKey}`), {
                          status: 'OFF'
                        })
                        console.log(`🔒 SetUp: Set status='OFF' for ${outletKey} to prevent re-activation loop`)
                      }
                      continue
                    }
                  }
                  
                  console.log(`✅ SetUp: FINAL SAFETY CHECK PASSED for ${outletKey} - All limits OK, proceeding with turn ON`)
                }
                
                console.log(`SetUp: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
                
                // CRITICAL: When automatically turning devices ON/OFF based on schedule, don't change main_status or status unnecessarily
                // main_status should only be changed by manual user actions (bypass/override), not by automatic scheduler
                // status should only be changed when actually turning devices off due to limits, not for idle devices
                if (newControlState === 'on') {
                  // IMPORTANT: When automatically turning ON based on schedule, do NOT set main_status to 'ON'
                  // Leave main_status and status as is - they should only be changed by manual user actions
                  // Do NOT set status='ON' - let the display logic determine if device is Active/Idle
                  console.log(`✅ SetUp: Turned ON ${outletKey} based on schedule - leaving main_status and status unchanged (main_status: ${currentMainStatus}, status: ${currentStatus})`)
                } else if (newControlState === 'off') {
                  // When turning OFF based on schedule (not limits), set main_status to 'OFF' to prevent re-activation
                  if (currentMainStatus !== 'OFF') {
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                    console.log(`🔒 SetUp: Set main_status to 'OFF' for ${outletKey} to prevent re-activation (schedule-based turn-off)`)
                  }
                  
                  // CRITICAL: Only set status='OFF' if limits are exceeded (to prevent re-activation loop)
                  // For normal schedule-based turn-offs, do NOT set status='OFF' - this allows idle detection to work
                  // The display logic will show "Inactive" when control.device is 'off'
                  // and "Idle" when control.device is 'on' but no updates for 15 seconds
                  // Setting status='OFF' would override the idle detection and show "OFF" instead of "Idle"
                  if (limitsExceeded) {
                    // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                    // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                    if (currentControlState === 'on') {
                      // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                      console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection (limits exceeded)`)
                    } else {
                      // Device was already off - safe to set status='OFF'
                      await update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'OFF'
                      })
                      console.log(`🔒 SetUp: Set status='OFF' for ${outletKey} to prevent re-activation loop (limits exceeded)`)
                    }
                  } else {
                    // For schedule-based turn-offs, do NOT set status='OFF'
                    // This allows the idle detection logic to work properly
                    // If device was idle (control='on' but no activity), don't change its status
                    // The display logic will show "Inactive" when control.device is 'off'
                    console.log(`✅ SetUp: Not setting status='OFF' for ${outletKey} - allowing idle detection to work (schedule-based turn-off, no limits exceeded)`)
                  }
                }
              } else {
                console.log(`SetUp: No update needed for ${outletKey} - control state already ${currentControlState}`)
              }
            }
          }
        }
      } catch (error) {
        console.error('SetUp: Error in real-time scheduler:', error)
      }
    }
    
    // Universal Power Limit Monitor - works for ALL devices regardless of schedule
    const checkPowerLimitsAndTurnOffDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          console.log(`SetUp: Power limit monitor running at ${new Date().toLocaleTimeString()}`)
          
          for (const [outletKey, outletData] of Object.entries(devicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            const currentControlState = deviceData.control?.device || 'off'
            const currentStatus = deviceData.status || 'ON'
            const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
            
            // Skip if device is already off
            if (currentControlState === 'off') {
              continue
            }
            
            // Check if status is 'OFF' - if so, skip automatic power limit enforcement (device is manually disabled)
            if (currentStatus === 'OFF') {
              console.log(`SetUp: Device ${outletKey} status is OFF - skipping automatic power limit enforcement (device manually disabled)`)
              continue
            }
            
            // Check if main_status is 'ON' - if so, skip automatic power limit enforcement (device is in bypass mode)
            if (currentMainStatus === 'ON') {
              console.log(`SetUp: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // Check if device is in a combined group
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            
            // Only check individual monthly limit if device is NOT in combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            if (!isInCombinedGroup) {
              console.log(`SetUp: Device ${outletKey} status is ${currentStatus} - checking individual power limits`)
              
              // Check if status is 'OFF' - if so, skip individual power limit enforcement (device is manually disabled)
              if (currentStatus === 'OFF') {
                console.log(`SetUp: Device ${outletKey} status is OFF - skipping individual power limit enforcement (device manually disabled)`)
                continue
              }
              
              // Check if main_status is 'ON' - if so, skip individual power limit enforcement (device is in bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`SetUp: Device ${outletKey} main_status is ON - respecting bypass mode, skipping individual power limit enforcement`)
                continue
              }
              
              // Check power limit (monthly energy limit) - Use checkMonthlyLimit function
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Check monthly limit using the checkMonthlyLimit function
                const isMonthlyLimitExceeded = checkMonthlyLimit(deviceData)
                
                console.log(`SetUp: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  powerLimitRaw: powerLimit,
                  exceedsLimit: isMonthlyLimitExceeded,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If monthly energy exceeds power limit, turn off the device
                if (isMonthlyLimitExceeded) {
                  console.log(`SetUp: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (monthly limit exceeded)`)
                  
                  // Get current control state before turning off
                  const currentControlState = deviceData?.control?.device || 'off'
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
                  // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
                  if (currentControlState === 'on') {
                    // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                    console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
                  } else {
                    // Device was already off - safe to set status='OFF'
                    await update(ref(realtimeDb, `devices/${outletKey}`), {
                      status: 'OFF'
                    })
                    console.log(`SetUp: Device ${outletKey} turned OFF due to power limit exceeded`)
                  }
                }
              }
            } else {
              console.log(`SetUp: Device ${outletKey} is in combined group - skipping individual monthly limit check (combined monthly limit takes precedence)`)
              
              // For devices in combined groups, also check if status is 'OFF'
              if (currentStatus === 'OFF') {
                console.log(`SetUp: Device ${outletKey} status is OFF - skipping combined group power limit enforcement (device manually disabled)`)
                continue
              }
              
              // For devices in combined groups, also check if main_status is 'ON' (bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`SetUp: Device ${outletKey} main_status is ON - respecting bypass mode, skipping combined group power limit enforcement`)
                continue
              }
            }
          }
        }
      } catch (error) {
        console.error('SetUp: Error in power limit monitor:', error)
      }
    }
    
    // Monthly limit check function with debounce
    const checkMonthlyLimits = async () => {
      try {
        const now = Date.now()
        
        // Check if enough time has passed since last check
        if (now - lastMonthlyLimitCheck < MONTHLY_LIMIT_DEBOUNCE_MS) {
          console.log('⏳ Monthly limit check debounced - too soon since last check')
          return
        }
        
        // Update last check time
        setLastMonthlyLimitCheck(now)
        
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          // Check ALL departments' combined limits
          const departmentKeys = Object.keys(allDepartmentCombinedLimits)
          
          if (departmentKeys.length === 0) {
            console.log('SetUp: No department combined limits configured - skipping monthly limit check')
            return
          }
          
          // Check each department's combined limit
          for (const deptKey of departmentKeys) {
            const deptLimitInfo = allDepartmentCombinedLimits[deptKey]
            
            if (deptLimitInfo?.enabled && deptLimitInfo?.selectedOutlets?.length > 0) {
              console.log(`SetUp: Checking combined monthly limit for department: ${deptKey}`)
              await checkCombinedMonthlyLimit(devicesData, {
                ...deptLimitInfo,
                department: deptKey
              })
            }
          }
          
          console.log(`SetUp: Completed monthly limit check for ${departmentKeys.length} department(s)`)
        }
      } catch (error) {
        console.error('SetUp: Error in monthly limit check:', error)
      }
    }
    
    // CRITICAL: Add delay before running schedulers to avoid conflicts with Schedule.tsx
    // This gives Schedule.tsx time to finish any updates before SetUp.tsx starts
    const INITIAL_DELAY = 2000 // 2 seconds delay
    
    // Run functions after initial delay to avoid conflicts
    const initialTimeout = setTimeout(() => {
      console.log('🔄 SetUp: Starting schedulers after initial delay to avoid conflicts')
      // CRITICAL: Run monthly limit check to update device_control and enforcement_reason
      // This ensures device_control is set to 'on' when limit is not exceeded
      checkMonthlyLimits()
      
      // Run schedule check to turn devices on/off based on schedule
      checkScheduleAndUpdateDevices()
      
      // Run power limit check
      checkPowerLimitsAndTurnOffDevices()
    }, INITIAL_DELAY)
    
    // Add manual test functions for debugging
    ;(window as any).testSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).testMonthlyLimits = checkMonthlyLimits
    ;(window as any).forcePowerLimitCheck = async () => {
      console.log('🔧 MANUAL: Forcing power limit check...')
      await checkPowerLimitsAndTurnOffDevices()
    }
    ;(window as any).testSpecificDevice = async (outletKey: string) => {
      console.log(`Testing specific device: ${outletKey}`)
      try {
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        const deviceData = deviceSnapshot.val()
        
        if (deviceData) {
          console.log(`Device ${outletKey} data:`, deviceData)
          
          if (deviceData.schedule) {
            const currentControlState = deviceData.control?.device || 'off'
            const currentStatus = deviceData.status || 'ON'
            
            console.log(`Current state: control=${currentControlState}, status=${currentStatus}`)
            
            // Check if device is in combined group for test function
            const outletDisplayName = outletKey.replace('_', ' ')
            const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                     combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
            const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInCombinedGroup)
            const newControlState = shouldBeActive ? 'on' : 'off'
            
            console.log(`Schedule check result: shouldBeActive=${shouldBeActive}, newControlState=${newControlState}`)
            
            if (currentControlState !== newControlState) {
              console.log(`Would update: ${currentControlState} -> ${newControlState}`)
            } else {
              console.log(`No update needed: already ${currentControlState}`)
            }
          } else {
            console.log(`Device ${outletKey} has no schedule`)
          }
        } else {
          console.log(`Device ${outletKey} not found`)
        }
      } catch (error) {
        console.error(`Error testing device ${outletKey}:`, error)
      }
    }
    
    // Add force monthly limit check function
    ;(window as any).forceMonthlyLimitCheck = async () => {
      console.log('🔧 FORCING monthly limit check...')
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        
        if (devicesSnapshot.exists()) {
          const devicesData = devicesSnapshot.val()
          console.log('🔧 Current devices data:', devicesData)
          console.log('🔧 Current combined limit info:', combinedLimitInfo)
          
          await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
        } else {
          console.log('❌ No devices data found')
        }
      } catch (error) {
        console.error('❌ Error in forced monthly limit check:', error)
      }
    }
    
    // Add function to check combined limit settings
    ;(window as any).checkCombinedLimitSettings = async () => {
      console.log('🔍 Checking combined limit settings...')
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const snapshot = await get(combinedLimitRef)
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('📊 Combined limit settings:', data)
          console.log('Enabled:', data.enabled)
          console.log('Selected outlets:', data.selected_outlets)
          console.log('Combined limit (watts):', data.combined_limit_watts)
        } else {
          console.log('❌ No combined limit settings found!')
        }
      } catch (error) {
        console.error('❌ Error checking combined limit settings:', error)
      }
    }
    
    // Add function to manually set combined limit settings for testing
    ;(window as any).setCombinedLimitSettings = async (outlets: string[], limitWatts: number) => {
      console.log('🔧 Setting combined limit settings...')
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        await update(combinedLimitRef, {
          enabled: true,
          selected_outlets: outlets,
          combined_limit_watts: limitWatts
        })
        console.log('✅ Combined limit settings updated:', { outlets, limitWatts })
      } catch (error) {
        console.error('❌ Error setting combined limit settings:', error)
      }
    }

    // Add function to clean up orphaned outlets from combined limit settings
    ;(window as any).cleanupOrphanedOutlets = async () => {
      console.log('🧹 Cleaning up orphaned outlets from combined limit settings...')
      try {
        // Get current devices
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        const currentDevices = devicesSnapshot.exists() ? Object.keys(devicesSnapshot.val()) : []
        
        console.log('📱 Current devices:', currentDevices)
        
        // Get combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (!combinedLimitSnapshot.exists()) {
          console.log('❌ No combined limit settings found!')
          return
        }
        
        const combinedLimitData = combinedLimitSnapshot.val()
        const currentSelectedOutlets = combinedLimitData.selected_outlets || []
        
        console.log('🔍 Current selected outlets:', currentSelectedOutlets)
        
        // Find orphaned outlets (outlets in selected_outlets but not in current devices)
        const orphanedOutlets = currentSelectedOutlets.filter((outlet: string) => 
          !currentDevices.includes(outlet)
        )
        
        if (orphanedOutlets.length === 0) {
          console.log('✅ No orphaned outlets found!')
          return
        }
        
        console.log('🗑️ Found orphaned outlets:', orphanedOutlets)
        
        // Remove orphaned outlets from selected_outlets
        const cleanedSelectedOutlets = currentSelectedOutlets.filter((outlet: string) => 
          currentDevices.includes(outlet)
        )
        
        // Update combined limit settings
        await update(combinedLimitRef, {
          ...combinedLimitData,
          selected_outlets: cleanedSelectedOutlets
        })
        
        console.log('✅ Successfully cleaned up orphaned outlets!')
        console.log('📊 Before cleanup:', currentSelectedOutlets)
        console.log('📊 After cleanup:', cleanedSelectedOutlets)
        console.log('🗑️ Removed outlets:', orphanedOutlets)
        
      } catch (error) {
        console.error('❌ Error cleaning up orphaned outlets:', error)
      }
    }

    // Add function to test outlet deletion from combined limit settings
    ;(window as any).testOutletDeletionFromCombinedLimit = async (outletName: string) => {
      console.log(`🧪 TESTING: Simulating deletion of ${outletName} from combined limit settings...`)
      try {
        // Get current combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (!combinedLimitSnapshot.exists()) {
          console.log('❌ No combined limit settings found!')
          return
        }
        
        const combinedLimitData = combinedLimitSnapshot.val()
        const currentSelectedOutlets = combinedLimitData.selected_outlets || []
        
        console.log('🔍 Current selected outlets:', currentSelectedOutlets)
        console.log('🔍 Outlet to test:', outletName)
        console.log('🔍 Outlet name type:', typeof outletName)
        console.log('🔍 Selected outlets types:', currentSelectedOutlets.map((outlet: string) => typeof outlet))
        
        // Check if outlet exists in selected_outlets (case-insensitive)
        const outletFound = currentSelectedOutlets.some((outlet: string) => 
          outlet.toLowerCase() === outletName.toLowerCase()
        )
        
        if (outletFound) {
          console.log(`✅ Found ${outletName} in selected_outlets - would be removed during deletion`)
          
          // Simulate the removal (case-insensitive)
          const updatedSelectedOutlets = currentSelectedOutlets.filter(
            (outlet: string) => outlet.toLowerCase() !== outletName.toLowerCase()
          )
          
          console.log('📊 Before removal:', currentSelectedOutlets)
          console.log('📊 After removal:', updatedSelectedOutlets)
          console.log(`🗑️ Would remove: ${outletName}`)
        } else {
          console.log(`❌ ${outletName} not found in selected_outlets - no removal needed`)
          console.log('🔍 Available outlets:', currentSelectedOutlets)
        }
        
      } catch (error) {
        console.error('❌ Error testing outlet deletion:', error)
      }
    }

    // Add function to debug current device names vs combined limit settings
    ;(window as any).debugOutletNames = async () => {
      console.log('🔍 DEBUGGING: Comparing device names with combined limit settings...')
      try {
        // Get current devices
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        const currentDevices = devicesSnapshot.exists() ? Object.keys(devicesSnapshot.val()) : []
        
        // Get combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (combinedLimitSnapshot.exists()) {
          const combinedLimitData = combinedLimitSnapshot.val()
          const selectedOutlets = combinedLimitData.selected_outlets || []
          
          console.log('📱 Current devices:', currentDevices)
          console.log('📊 Selected outlets in combined limit:', selectedOutlets)
          
          // Check for mismatches
          const orphanedOutlets = selectedOutlets.filter((outlet: string) => 
            !currentDevices.includes(outlet)
          )
          
          const missingOutlets = currentDevices.filter(device => 
            !selectedOutlets.includes(device)
          )
          
          console.log('🗑️ Orphaned outlets (in combined limit but not in devices):', orphanedOutlets)
          console.log('❓ Missing outlets (in devices but not in combined limit):', missingOutlets)
          
        } else {
          console.log('❌ No combined limit settings found!')
        }
        
      } catch (error) {
        console.error('❌ Error debugging outlet names:', error)
      }
    }

    // Add function to inspect all data for a specific outlet
    ;(window as any).inspectOutletData = async (outletName: string) => {
      console.log(`🔍 INSPECTING: All data for outlet "${outletName}"...`)
      try {
        const outletRef = ref(realtimeDb, `devices/${outletName}`)
        const outletSnapshot = await get(outletRef)
        
        if (outletSnapshot.exists()) {
          const outletData = outletSnapshot.val()
          console.log(`📊 Complete data for ${outletName}:`, outletData)
          console.log(`📊 Data keys for ${outletName}:`, Object.keys(outletData))
          
          // Inspect each data section
          if (outletData.sensor_data) {
            console.log(`📊 Sensor data:`, outletData.sensor_data)
          }
          if (outletData.daily_logs) {
            console.log(`📊 Daily logs (${Object.keys(outletData.daily_logs).length} entries):`, Object.keys(outletData.daily_logs))
          }
          if (outletData.office_info) {
            console.log(`📊 Office info:`, outletData.office_info)
          }
          if (outletData.schedule) {
            console.log(`📊 Schedule:`, outletData.schedule)
          }
          if (outletData.relay_control) {
            console.log(`📊 Relay control:`, outletData.relay_control)
          }
          if (outletData.control) {
            console.log(`📊 Control settings:`, outletData.control)
          }
          if (outletData.lifetime_energy !== undefined) {
            console.log(`📊 Lifetime energy:`, outletData.lifetime_energy)
          }
          if (outletData.lifetime_hours !== undefined) {
            console.log(`📊 Lifetime hours:`, outletData.lifetime_hours)
          }
          if (outletData.lifetime_usage_millis !== undefined) {
            console.log(`📊 Lifetime usage millis:`, outletData.lifetime_usage_millis)
          }
          
          console.log(`✅ Found complete data for ${outletName} - this will ALL be deleted when outlet is removed`)
        } else {
          console.log(`❌ No data found for outlet "${outletName}"`)
        }
        
      } catch (error) {
        console.error('❌ Error inspecting outlet data:', error)
      }
    }

    // Add function to manually remove outlet from combined limit settings
    ;(window as any).removeOutletFromCombinedLimit = async (outletName: string) => {
      console.log(`🔧 MANUALLY REMOVING: ${outletName} from combined limit settings...`)
      try {
        // Convert outlet name to different formats for matching
        const deviceFormatName = outletName // "Outlet_1"
        const combinedFormatName = outletName.replace(/_/g, ' ') // "Outlet 1"
        
        console.log('🔍 Outlet name formats:', {
          deviceFormat: deviceFormatName,
          combinedFormat: combinedFormatName
        })
        
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (combinedLimitSnapshot.exists()) {
          const combinedLimitData = combinedLimitSnapshot.val()
          const currentSelectedOutlets = combinedLimitData.selected_outlets || []
          
          console.log('🔍 Current selected outlets:', currentSelectedOutlets)
          console.log('🔍 Outlet to remove (device format):', deviceFormatName)
          console.log('🔍 Outlet to remove (combined format):', combinedFormatName)
          
          // Check if outlet exists in selected_outlets (try both formats)
          const outletFound = currentSelectedOutlets.some((outlet: string) => 
            outlet.toLowerCase() === deviceFormatName.toLowerCase() || 
            outlet.toLowerCase() === combinedFormatName.toLowerCase()
          )
          
          if (outletFound) {
            console.log(`✅ Found ${outletName} in selected_outlets - removing it...`)
            
            // Remove the outlet from the selected_outlets array (try both formats)
            const updatedSelectedOutlets = currentSelectedOutlets.filter(
              (outlet: string) => 
                outlet.toLowerCase() !== deviceFormatName.toLowerCase() && 
                outlet.toLowerCase() !== combinedFormatName.toLowerCase()
            )
            
            console.log('📊 Before removal:', currentSelectedOutlets)
            console.log('📊 After removal:', updatedSelectedOutlets)
            
            // Update the combined limit settings
            await update(combinedLimitRef, {
              ...combinedLimitData,
              selected_outlets: updatedSelectedOutlets
            })
            
            console.log(`✅ Successfully removed ${outletName} from combined limit settings!`)
          } else {
            console.log(`❌ ${outletName} not found in selected_outlets - no removal needed`)
            console.log('🔍 Available outlets:', currentSelectedOutlets)
          }
        } else {
          console.log('❌ No combined limit settings found!')
        }
        
      } catch (error) {
        console.error('❌ Error removing outlet from combined limit settings:', error)
      }
    }
    
    // Add function to test hierarchy enforcement
    ;(window as any).testHierarchy = async () => {
      console.log('🧪 Testing HIERARCHY ENFORCEMENT...')
      console.log('1. Setting combined limit to 500Wh for Outlet_2 and Outlet_4')
      await (window as any).setCombinedLimitSettings(['Outlet_2', 'Outlet_4'], 500000)
      
      console.log('2. Forcing monthly limit check...')
      await (window as any).forceMonthlyLimitCheck()
      
      console.log('3. Testing schedule - should be blocked by monthly limit')
      await (window as any).testSchedule()
      
      console.log('4. Checking if devices are OFF due to monthly limit...')
      setTimeout(async () => {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          console.log('📊 Device statuses after hierarchy test:')
          Object.keys(devicesData).forEach(outletKey => {
            const device = devicesData[outletKey]
            const controlState = device.control?.device || 'off'
            const deviceStatus = device.status || 'ON'
            console.log(`${outletKey}: control=${controlState}, status=${deviceStatus}`)
          })
        }
      }, 5000)
    }
    
    // Add function to inspect daily logs for debugging
    ;(window as any).inspectDailyLogs = async (outletKey: string) => {
      console.log(`🔍 Inspecting daily logs for ${outletKey}...`)
      try {
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const snapshot = await get(deviceRef)
        if (snapshot.exists()) {
          const deviceData = snapshot.val()
          console.log(`📊 Device data for ${outletKey}:`, deviceData)
          
          if (deviceData.daily_logs) {
            const dailyLogKeys = Object.keys(deviceData.daily_logs)
            console.log(`📊 Daily log keys (${dailyLogKeys.length}):`, dailyLogKeys)
            
            // Show current month's logs
            const now = new Date()
            const currentYear = now.getFullYear()
            const currentMonth = now.getMonth() + 1
            const currentMonthPrefix = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}`
            const currentMonthLogs = dailyLogKeys.filter(key => key.startsWith(currentMonthPrefix))
            console.log(`📊 Current month (${currentMonthPrefix}) logs:`, currentMonthLogs)
            
            // Show sample log data
            if (currentMonthLogs.length > 0) {
              const sampleLog = deviceData.daily_logs[currentMonthLogs[0]]
              console.log(`📊 Sample log data:`, sampleLog)
            }
            
            // Calculate total energy for current month
            let totalEnergy = 0
            currentMonthLogs.forEach(logKey => {
              const logData = deviceData.daily_logs[logKey]
              if (logData && logData.total_energy) {
                totalEnergy += logData.total_energy
                console.log(`📊 ${logKey}: ${logData.total_energy} kW`)
              }
            })
            console.log(`📊 Total energy for current month: ${totalEnergy} kW = ${totalEnergy * 1000} W`)
          } else {
            console.log(`❌ No daily_logs found for ${outletKey}`)
          }
        } else {
          console.log(`❌ Device ${outletKey} not found.`)
        }
      } catch (error) {
        console.error('❌ Error inspecting daily logs:', error)
      }
    }
    
    // Add function to reset monthly limit check and clear duplicates
    ;(window as any).resetMonthlyLimitCheck = () => {
      console.log('🔄 Resetting monthly limit check...')
      setLastMonthlyLimitCheck(0)
      console.log('✅ Monthly limit check reset - next check will run immediately')
    }
    
    // Add comprehensive test function for monthly energy calculation
    ;(window as any).testMonthlyEnergyCalculation = async () => {
      console.log('🧪 TESTING MONTHLY ENERGY CALCULATION...')
      try {
        // 1. Get current devices data
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (!snapshot.exists()) {
          console.log('❌ No devices data found')
          return
        }
        
        const devicesData = snapshot.val()
        console.log('📊 Devices data loaded:', Object.keys(devicesData))
        
        // 2. Get combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const limitSnapshot = await get(combinedLimitRef)
        
        if (!limitSnapshot.exists()) {
          console.log('❌ No combined limit settings found')
          return
        }
        
        const limitData = limitSnapshot.val()
        console.log('📊 Combined limit settings:', limitData)
        
        // 3. Test monthly energy calculation
        const selectedOutlets = limitData.selected_outlets || []
        const combinedLimit = limitData.combined_limit_watts || 0
        
        console.log('🧪 Testing with outlets:', selectedOutlets)
        console.log('🧪 Combined limit:', combinedLimit, 'Wh')
        
        const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, selectedOutlets)
        
        console.log('🧪 CALCULATION RESULTS:')
        console.log(`📊 Total monthly energy: ${totalMonthlyEnergy.toFixed(3)} Wh`)
        console.log(`📊 Combined limit: ${combinedLimit} Wh`)
        console.log(`📊 Exceeds limit: ${totalMonthlyEnergy >= combinedLimit}`)
        console.log(`📊 Percentage: ${combinedLimit > 0 ? ((totalMonthlyEnergy / combinedLimit) * 100).toFixed(1) : 0}%`)
        
        // 4. Test enforcement
        if (totalMonthlyEnergy >= combinedLimit) {
          console.log('🚨 LIMIT EXCEEDED - Testing enforcement...')
          await checkCombinedMonthlyLimit(devicesData, {
            enabled: limitData.enabled,
            selectedOutlets: selectedOutlets,
            combinedLimit: combinedLimit
          })
        } else {
          console.log('✅ Limit not exceeded - no enforcement needed')
        }
        
      } catch (error) {
        console.error('❌ Error testing monthly energy calculation:', error)
      }
    }
    
    // Add test function for device removal from combined groups
    ;(window as any).testDeviceRemoval = async (outletName: string) => {
      console.log(`🧪 TESTING DEVICE REMOVAL: ${outletName}`)
      try {
        const result = await removeDeviceFromCombinedGroup(outletName)
        console.log('🔧 Removal result:', result)
        
        if (result.success) {
          console.log(`✅ Successfully removed ${outletName} from combined group and turned it OFF`)
        } else {
          console.log(`❌ Failed to remove ${outletName}: ${result.reason}`)
        }
      } catch (error) {
        console.error('❌ Error testing device removal:', error)
      }
    }
    
    // Add test function to simulate combined limit save with removal
    ;(window as any).testCombinedLimitSaveWithRemoval = async (outletToRemove: string) => {
      console.log(`🧪 TESTING COMBINED LIMIT SAVE WITH REMOVAL: ${outletToRemove}`)
      try {
        // Get current combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const currentSnapshot = await get(combinedLimitRef)
        
        if (currentSnapshot.exists()) {
          const currentData = currentSnapshot.val()
          const currentSelectedOutlets = currentData.selected_outlets || []
          
          // Remove the specified outlet
          const newSelectedOutlets = currentSelectedOutlets.filter((outlet: string) => outlet !== outletToRemove)
          
          console.log('🔍 Simulating removal:', {
            current: currentSelectedOutlets,
            new: newSelectedOutlets,
            removed: outletToRemove
          })
          
          // Simulate the save process
          const testData = {
            selectedOutlets: newSelectedOutlets,
            combinedLimit: currentData.combined_limit_watts || 0,
            deviceControl: 'on',
            enableScheduling: true
          }
          
          await handleSaveCombinedLimit(testData)
          console.log('✅ Test completed - check if device was turned OFF')
        } else {
          console.log('❌ No combined limit settings found')
        }
      } catch (error) {
        console.error('❌ Error testing combined limit save with removal:', error)
      }
    }

    console.log('SetUp: Manual test functions available:')
    console.log('- window.testSchedule() - Run schedule check')
    console.log('- window.testPowerLimits() - Run power limit check')
    console.log('- window.testMonthlyLimits() - Run monthly limit check')
    console.log('- window.testSpecificDevice("Outlet_1") - Test specific device')
    console.log('- window.forceMonthlyLimitCheck() - Force monthly limit check immediately')
    console.log('- window.checkCombinedLimitSettings() - Check combined limit settings')
    console.log('- window.setCombinedLimitSettings(["Outlet_2", "Outlet_4"], 500000) - Set combined limit (500Wh)')
    console.log('- window.testHierarchy() - Test hierarchy enforcement (monthly limit > schedule)')
    console.log('- window.inspectDailyLogs("Outlet_1") - Inspect daily logs for debugging')
    console.log('- window.resetMonthlyLimitCheck() - Reset monthly limit check to clear duplicates')
    console.log('- window.testMonthlyEnergyCalculation() - Test complete monthly energy calculation and enforcement')
    console.log('- window.testDeviceRemoval("Outlet 1") - Test removing device from combined group')
    console.log('- window.testCombinedLimitSaveWithRemoval("Outlet 1") - Test combined limit save with device removal')
    
    // HIERARCHY: Set up intervals in priority order (matching ActiveDevice.tsx)
    // 1. Monthly limit check - HIGHEST PRIORITY (every 10 seconds) - updates device_control and enforcement_reason
    const monthlyLimitInterval = setInterval(checkMonthlyLimits, 10000) // 10 seconds
    
    // 2. Schedule check - SECOND PRIORITY (every 10 seconds, but respects monthly limits)
    const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds
    
    // 3. Power limit check - THIRD PRIORITY (every 12 seconds, but respects monthly limits)
    const powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 12000) // 12 seconds
    
    // Cleanup intervals and timeout on unmount
    return () => {
      clearTimeout(initialTimeout)
      clearInterval(monthlyLimitInterval)
      clearInterval(scheduleInterval)
      clearInterval(powerLimitInterval)
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
      
    }
  }, [allDepartmentCombinedLimits])

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
                console.log(`SetUp: Initialized basis for unplug detection on ${outletKey} (no schedule)`)
              } catch (error) {
                console.error(`SetUp: Error initializing basis for ${outletKey}:`, error)
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
                console.log(`SetUp: Initialized basis for unplug detection on ${outletKey} (with schedule)`)
              } catch (error) {
                console.error(`SetUp: Error initializing basis for ${outletKey}:`, error)
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
                console.log(`🔌 SetUp: PLUG DETECTED: ${outletKey} - timestamp changed from "${existing.lastTimestamp}" to "${sensorTimestamp}", resetting unplug state`)
                
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
                    console.log(`✅ SetUp: RESET UNPLUG STATE: ${outletKey} - device plugged back in, disabled_by_unplug set to false, status reset to normal`)
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
          
          // Check if device needs unplug handling BEFORE updating state
          const existingTimestamp = deviceTimestamps[outletKey]
          let needsUnplugHandling = false
          
          if (existingTimestamp && existingTimestamp.lastTimestamp === sensorTimestamp && sensorTimestamp) {
            const timeSinceLastUpdate = currentTime - existingTimestamp.lastTimestampTime
            if (timeSinceLastUpdate >= 30000) {
              needsUnplugHandling = true
            }
          }
          
          // Initialize or update device timestamp tracking
          setDeviceTimestamps(prev => {
            const existing = prev[outletKey]
            
            // If timestamp hasn't changed, check if it's been 30 seconds since we first saw this timestamp
            if (existing && existing.lastTimestamp === sensorTimestamp && sensorTimestamp) {
              // Calculate time since we first detected this timestamp value
              const timeSinceLastUpdate = currentTime - existing.lastTimestampTime
              
              // If 30 seconds have passed since timestamp last changed
              if (timeSinceLastUpdate >= 30000) {
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
          
          // Handle unplug detection OUTSIDE of setState to avoid race conditions
          if (needsUnplugHandling) {
            // Check if already handled (prevent duplicate handling)
            const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
            const deviceSnapshot = await get(deviceRef)
            const latestDeviceData = deviceSnapshot.val()
            
            // Only handle if not already disabled by unplug
            if (latestDeviceData?.schedule?.disabled_by_unplug !== true) {
              const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
              try {
                // Get or create schedule object for basis/disabled_by_unplug
                const scheduleSnapshot = await get(scheduleRef)
                const currentSchedule = scheduleSnapshot.val() || {}
                
                // First, mark as unplugged (this is the critical flag that prevents scheduler from turning it on)
                await update(scheduleRef, {
                  basis: currentSchedule.basis || basis || Date.now(),
                  disabled_by_unplug: true
                })
                
                // Then turn off the device
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: 'off'
                })
                
                // Finally, disable schedule by turning off main_status
                await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                  main_status: 'OFF'
                })
                
                // Set root status to UNPLUG for display in Schedule.tsx table
                await update(ref(realtimeDb, `devices/${outletKey}`), {
                  status: 'UNPLUG'
                })
                
                throttledLog('unplug-detection', `🔌 SetUp: UNPLUG DETECTED: ${outletKey} - timestamp unchanged for 30+ seconds. Device turned OFF, schedule disabled, and root status set to UNPLUG.`)
              } catch (err) {
                console.error(`SetUp: Error handling unplug detection for ${outletKey}:`, err)
              }
            }
          }
        }
      } catch (error) {
        console.error('SetUp: Error checking unplugged devices:', error)
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
  }, [devices])

  // Real-time monthly limit monitoring
  useEffect(() => {
    if (!combinedLimitInfo.enabled || combinedLimitInfo.selectedOutlets.length === 0) {
      logger.log('🚫 Monthly limit monitoring disabled - no combined limit set')
      return
    }
    
    // DISABLED: Real-time monthly limit monitoring to prevent database spamming
    // Monthly limit checks are handled by the scheduler (checkScheduleAndUpdateDevices) every 10 seconds
    // This prevents multiple simultaneous calls that cause last_enforcement to spam
    logger.log('🔍 Monthly limit monitoring handled by scheduler (every 10 seconds) - real-time listener disabled to prevent spam')
    
      // NOTE: The scheduler useEffect already calls checkCombinedMonthlyLimit, so we don't need this real-time listener
      // This matches the pattern in Schedule.tsx which also doesn't use a real-time listener for monthly limits
   }, [allDepartmentCombinedLimits])

  // Filter devices based on search term
  const filteredDevices = devices.filter(device =>
    device.outletName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    device.officeRoom.toLowerCase().includes(searchTerm.toLowerCase()) ||
    device.id.includes(searchTerm)
  )

  // Handle device actions
  const handleEditDevice = (deviceId: string) => {
    const deviceToEdit = devices.find(device => device.id === deviceId)
    if (deviceToEdit) {
      // Check if device is part of a combined limit
      const deviceOutletName = deviceToEdit.outletName
      const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
      const isUsingCombinedLimit = combinedLimitInfo.enabled && 
        (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
         combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
      
      if (isUsingCombinedLimit) {
        // Show restriction modal instead of edit modal
        setEditRestrictionModal({
          isOpen: true,
          device: deviceToEdit,
          combinedLimit: combinedLimitInfo.combinedLimit
        })
      } else {
        // Show normal edit modal
        setEditModal({
          isOpen: true,
          device: deviceToEdit
        })
      }
    }
  }

  const handleDeleteDevice = (deviceId: string) => {
    setDeleteModal({
      isOpen: true,
      deviceId: deviceId,
      deviceName: devices.find(d => d.id === deviceId)?.outletName || ''
    })
  }

  // Handle device toggle (ON/OFF)
  // Main status can override schedule and power limit restrictions
  const handleToggleDevice = async (device: Device) => {
    try {
      const outletKey = device.outletName
      const currentStatus = device.status === 'Active' ? 'ON' : 'OFF'
      const newStatus = currentStatus === 'ON' ? 'OFF' : 'ON'
      
      // Check if trying to turn ON a device
      if (newStatus === 'ON') {
        // FIRST CHECK: If device is disabled by unplug, prevent turning it ON
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        const deviceData = deviceSnapshot.val()
        
        if (deviceData?.schedule?.disabled_by_unplug === true) {
          alert(`Cannot turn ON ${device.outletName}. The device is disabled because it was unplugged. Please check the device connection and reset the schedule.`)
          console.log(`SetUp: Manual toggle blocked - Device ${outletKey} is disabled by unplug`)
          return
        }
        // First check monthly limit before allowing device to turn ON
        const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, combinedLimitInfo)
        if (!monthlyLimitCheck.canTurnOn) {
          // Try to remove device from combined group first
          console.log(`🔧 Monthly limit exceeded for ${outletKey} - attempting to remove from combined group`)
          const removeResult = await removeDeviceFromCombinedGroup(outletKey)
          
          if (removeResult.success) {
            console.log(`✅ Successfully removed ${outletKey} from combined group - device can now be turned on`)
            // Device has been removed from combined group, continue with turn on process
            // The device will now be treated as a non-combined device
          } else {
            console.log(`❌ Failed to remove ${outletKey} from combined group: ${removeResult.reason}`)
            // Show monthly limit modal as fallback
            setMonthlyLimitModal({
              isOpen: true,
              device: device,
              reason: monthlyLimitCheck.reason || 'Monthly limit exceeded',
              currentMonthlyEnergy: monthlyLimitCheck.currentMonthlyEnergy,
              combinedLimit: monthlyLimitCheck.combinedLimit
            })
            return
          }
        }
        
        // Then check combined power limit
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (combinedLimitSnapshot.exists()) {
          const combinedLimitData = combinedLimitSnapshot.val()
          
          if (combinedLimitData.enabled) {
            const selectedOutlets = combinedLimitData.selected_outlets || []
            const combinedLimitWatts = combinedLimitData.combined_limit_watts || 0
            
            // Check if this device is part of the combined limit group
            if (selectedOutlets.includes(device.outletName) && combinedLimitWatts > 0) {
              // Get devices data to calculate current combined power
              const devicesRef = ref(realtimeDb, 'devices')
              const devicesSnapshot = await get(devicesRef)
              
              if (devicesSnapshot.exists()) {
                const devicesData = devicesSnapshot.val()
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                
                // Calculate current combined power consumption
                let totalCombinedPower = 0
                
                selectedOutlets.forEach((outletName: string) => {
                  const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
                  const outletData = devicesData[outletKey]
                  
                  if (outletData) {
                    const todayLogs = outletData.daily_logs?.[todayDateKey]
                    const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                    const todayTotalEnergyWatts = todayTotalEnergy * 1000 // Convert to watts
                    totalCombinedPower += todayTotalEnergyWatts
                  }
                })
                
                console.log(`SetUp: Combined limit check for ${outletKey}:`, {
                  selectedOutlets,
                  totalCombinedPower: `${totalCombinedPower.toFixed(3)}Wh`,
                  combinedLimitWatts: `${combinedLimitWatts}Wh`,
                  wouldExceedLimit: totalCombinedPower >= combinedLimitWatts
                })
                
                // If turning on this device would exceed the combined limit, prevent it
                if (totalCombinedPower >= combinedLimitWatts) {
                  alert(`Cannot turn ON ${device.outletName}. Combined power limit of ${combinedLimitWatts}Wh has been reached for the selected outlets.`)
                  return
                }
              }
            }
          }
        }
        
        // Check if device is in a combined group (re-check after potential removal)
        const outletDisplayName = outletKey.replace('_', ' ')
        const isInCombinedGroup = combinedLimitInfo?.enabled && 
                                 combinedLimitInfo?.selectedOutlets?.includes(outletDisplayName)
        
        // Only check individual monthly limit if:
        // 1. Device is NOT in a combined group, OR
        // 2. Device was in a combined group but monthly limit was exceeded and removal failed
        if (!isInCombinedGroup) {
          // Get device data from Firebase to check monthly energy consumption
          const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
          const deviceSnapshot = await get(deviceRef)
          const deviceData = deviceSnapshot.val()
          const powerLimit = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
          
          if (powerLimit <= 0) {
            // Show warning modal for device without power limit
            setNoPowerLimitModal({
              isOpen: true,
              device: device
            })
            return
          }
          
          // Check monthly limit using the checkMonthlyLimit function
          const isMonthlyLimitExceeded = checkMonthlyLimit(deviceData)
          
          console.log(`SetUp: Power limit check for ${outletKey}:`, {
            powerLimit: `${(powerLimit * 1000)}W`,
            exceedsLimit: isMonthlyLimitExceeded,
            isInCombinedGroup: isInCombinedGroup,
            monthlyLimitOK: monthlyLimitCheck.canTurnOn
          })
          
          // Check if monthly energy consumption exceeds the power limit
          if (isMonthlyLimitExceeded) {
            const currentTime = new Date().toLocaleTimeString()
            const currentDate = new Date().toLocaleDateString()
            
            // Calculate monthly total energy for display
            const now = new Date()
            const currentYear = now.getFullYear()
            const currentMonth = now.getMonth() + 1
            const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
            let totalMonthlyEnergy = 0
            
            for (let day = 1; day <= daysInMonth; day++) {
              const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
              const dayData = deviceData?.daily_logs?.[dateKey]
              if (dayData && dayData.total_energy) {
                totalMonthlyEnergy += dayData.total_energy
              }
            }
            
            // Show warning that device cannot be turned ON due to power limit exceeded
            setNoPowerLimitModal({
              isOpen: true,
              device: {
                ...device,
                // Add additional info for the modal using type assertion
                ...(device as any),
                todayTotalEnergy: totalMonthlyEnergy,
                powerLimit: powerLimit,
                currentDate: currentDate,
                currentTime: currentTime
              }
            })
            return
          }
        } else {
          console.log(`SetUp: Skipping individual monthly limit check for ${outletKey} - device is in combined group with monthly limit OK`)
        }
        
        console.log(`Turning ON ${outletKey} - main status will override schedule restrictions`)
      }
      
      console.log(`Toggling ${outletKey} from ${currentStatus} to ${newStatus}`)
      
      // Update both relay status and main status in Firebase
      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
        status: newStatus,
        main_status: newStatus
      })
      
      console.log(`Successfully toggled ${outletKey} to ${newStatus}`)
    } catch (error) {
      console.error('Error toggling device:', error)
    }
  }

  // Helper function to convert outlet name formats
  const convertOutletNameFormat = (outletName: string, targetFormat: 'device' | 'combined') => {
    if (targetFormat === 'device') {
      // Convert "Outlet 1" to "Outlet_1"
      return outletName.replace(/\s+/g, '_')
    } else {
      // Convert "Outlet_1" to "Outlet 1"
      return outletName.replace(/_/g, ' ')
    }
  }

  // Handle actual deletion from Firebase database
  const handleConfirmDelete = async () => {
    const deviceToDelete = devices.find(d => d.id === deleteModal.deviceId)
    if (!deviceToDelete) {
      console.error('Device not found for deletion:', deleteModal.deviceId)
      return
    }

    try {
      console.log('SetUp: Starting COMPLETE deletion of device:', deviceToDelete.outletName)
      
      // Convert outlet name to different formats for matching
      const deviceFormatName = deviceToDelete.outletName // "Outlet_1"
      const combinedFormatName = convertOutletNameFormat(deviceToDelete.outletName, 'combined') // "Outlet 1"
      
      console.log('🔍 SetUp: Outlet name formats:', {
        deviceFormat: deviceFormatName,
        combinedFormat: combinedFormatName
      })
      
      // 1. Remove the outlet from combined limit settings if it exists there
      try {
        console.log('🔍 DEBUG: Starting combined limit cleanup for outlet:', deviceToDelete.outletName)
        
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (combinedLimitSnapshot.exists()) {
          const combinedLimitData = combinedLimitSnapshot.val()
          const currentSelectedOutlets = combinedLimitData.selected_outlets || []
          
          console.log('🔍 DEBUG: Current combined limit data:', combinedLimitData)
          console.log('🔍 DEBUG: Current selected outlets:', currentSelectedOutlets)
          console.log('🔍 DEBUG: Outlet to delete (device format):', deviceFormatName)
          console.log('🔍 DEBUG: Outlet to delete (combined format):', combinedFormatName)
          console.log('🔍 DEBUG: Selected outlets types:', currentSelectedOutlets.map((outlet: string) => typeof outlet))
          
          // Check if the outlet to delete is in the selected outlets (try both formats)
          const outletFound = currentSelectedOutlets.some((outlet: string) => 
            outlet.toLowerCase() === deviceFormatName.toLowerCase() || 
            outlet.toLowerCase() === combinedFormatName.toLowerCase()
          )
          
          console.log('🔍 DEBUG: Outlet found in selected outlets:', outletFound)
          
          if (outletFound) {
            console.log('✅ SetUp: Removing outlet from combined limit settings:', combinedFormatName)
            
            // Remove the outlet from the selected_outlets array (try both formats)
            const updatedSelectedOutlets = currentSelectedOutlets.filter(
              (outlet: string) => 
                outlet.toLowerCase() !== deviceFormatName.toLowerCase() && 
                outlet.toLowerCase() !== combinedFormatName.toLowerCase()
            )
            
            console.log('🔍 DEBUG: Updated selected outlets:', updatedSelectedOutlets)
            
            // Update the combined limit settings
            await update(combinedLimitRef, {
              ...combinedLimitData,
              selected_outlets: updatedSelectedOutlets
            })
            
            console.log('✅ SetUp: Successfully removed outlet from combined limit settings. Updated outlets:', updatedSelectedOutlets)
          } else {
            console.log('❌ SetUp: Outlet not found in combined limit settings, no removal needed')
            console.log('🔍 DEBUG: Available outlets in selected_outlets:', currentSelectedOutlets)
            console.log('🔍 DEBUG: Looking for outlet:', deviceToDelete.outletName)
          }
        } else {
          console.log('❌ SetUp: No combined limit settings found, skipping removal')
        }
      } catch (combinedLimitError) {
        console.error('❌ SetUp: Error removing outlet from combined limit settings:', combinedLimitError)
        console.error('❌ SetUp: Combined limit error details:', {
          outletName: deviceToDelete.outletName,
          error: combinedLimitError,
          stack: combinedLimitError instanceof Error ? combinedLimitError.stack : 'No stack trace available'
        })
        // Continue with device deletion even if combined limit update fails
      }

      // 2. Remove the outlet from combined schedule settings if it exists there
      try {
        const combinedScheduleRef = ref(realtimeDb, 'combined_schedule_settings')
        const combinedScheduleSnapshot = await get(combinedScheduleRef)
        
        if (combinedScheduleSnapshot.exists()) {
          const combinedScheduleData = combinedScheduleSnapshot.val()
          const currentSelectedOutlets = combinedScheduleData.selected_outlets || []
          
          // Check if the outlet to delete is in the selected outlets (try both formats)
          const outletFound = currentSelectedOutlets.some((outlet: string) => 
            outlet.toLowerCase() === deviceFormatName.toLowerCase() || 
            outlet.toLowerCase() === combinedFormatName.toLowerCase()
          )
          
          if (outletFound) {
            console.log('SetUp: Removing outlet from combined schedule settings:', combinedFormatName)
            
            // Remove the outlet from the selected_outlets array (try both formats)
            const updatedSelectedOutlets = currentSelectedOutlets.filter(
              (outlet: string) => 
                outlet.toLowerCase() !== deviceFormatName.toLowerCase() && 
                outlet.toLowerCase() !== combinedFormatName.toLowerCase()
            )
            
            // Update the combined schedule settings
            await update(combinedScheduleRef, {
              ...combinedScheduleData,
              selected_outlets: updatedSelectedOutlets
            })
            
            console.log('SetUp: Successfully removed outlet from combined schedule settings. Updated outlets:', updatedSelectedOutlets)
          } else {
            console.log('SetUp: Outlet not found in combined schedule settings, no removal needed')
          }
        } else {
          console.log('SetUp: No combined schedule settings found, skipping removal')
        }
      } catch (combinedScheduleError) {
        console.error('SetUp: Error removing outlet from combined schedule settings:', combinedScheduleError)
        // Continue with device deletion even if combined schedule update fails
      }

      // 3. Remove device logs related to this outlet
      try {
        console.log('SetUp: Removing device logs for outlet:', deviceToDelete.outletName)
        const deviceLogsRef = ref(realtimeDb, 'device_logs')
        const deviceLogsSnapshot = await get(deviceLogsRef)
        
        if (deviceLogsSnapshot.exists()) {
          const deviceLogsData = deviceLogsSnapshot.val()
          const logsToRemove: string[] = []
          
          // Find all logs related to this outlet
          Object.keys(deviceLogsData).forEach(logKey => {
            const logEntry = deviceLogsData[logKey]
            if (logEntry && logEntry.outletName === deviceToDelete.outletName) {
              logsToRemove.push(logKey)
            }
          })
          
          // Remove the logs
          for (const logKey of logsToRemove) {
            const logRef = ref(realtimeDb, `device_logs/${logKey}`)
            await remove(logRef)
          }
          
          console.log(`SetUp: Removed ${logsToRemove.length} device logs for outlet:`, deviceToDelete.outletName)
        } else {
          console.log('SetUp: No device logs found, skipping removal')
        }
      } catch (deviceLogsError) {
        console.error('SetUp: Error removing device logs:', deviceLogsError)
        // Continue with device deletion even if device logs removal fails
      }

      // 4. Remove user logs related to this outlet
      try {
        console.log('SetUp: Removing user logs for outlet:', deviceToDelete.outletName)
        const userLogsRef = ref(realtimeDb, 'user_logs')
        const userLogsSnapshot = await get(userLogsRef)
        
        if (userLogsSnapshot.exists()) {
          const userLogsData = userLogsSnapshot.val()
          const logsToRemove: string[] = []
          
          // Find all logs related to this outlet
          Object.keys(userLogsData).forEach(logKey => {
            const logEntry = userLogsData[logKey]
            if (logEntry && logEntry.outletName === deviceToDelete.outletName) {
              logsToRemove.push(logKey)
            }
          })
          
          // Remove the logs
          for (const logKey of logsToRemove) {
            const logRef = ref(realtimeDb, `user_logs/${logKey}`)
            await remove(logRef)
          }
          
          console.log(`SetUp: Removed ${logsToRemove.length} user logs for outlet:`, deviceToDelete.outletName)
        } else {
          console.log('SetUp: No user logs found, skipping removal')
        }
      } catch (userLogsError) {
        console.error('SetUp: Error removing user logs:', userLogsError)
        // Continue with device deletion even if user logs removal fails
      }

      // 5. Remove general logs related to this outlet
      try {
        console.log('SetUp: Removing general logs for outlet:', deviceToDelete.outletName)
        const logsRef = ref(realtimeDb, 'logs')
        const logsSnapshot = await get(logsRef)
        
        if (logsSnapshot.exists()) {
          const logsData = logsSnapshot.val()
          const logsToRemove: string[] = []
          
          // Find all logs related to this outlet
          Object.keys(logsData).forEach(logKey => {
            const logEntry = logsData[logKey]
            if (logEntry && logEntry.outletName === deviceToDelete.outletName) {
              logsToRemove.push(logKey)
            }
          })
          
          // Remove the logs
          for (const logKey of logsToRemove) {
            const logRef = ref(realtimeDb, `logs/${logKey}`)
            await remove(logRef)
          }
          
          console.log(`SetUp: Removed ${logsToRemove.length} general logs for outlet:`, deviceToDelete.outletName)
        } else {
          console.log('SetUp: No general logs found, skipping removal')
        }
      } catch (logsError) {
        console.error('SetUp: Error removing general logs:', logsError)
        // Continue with device deletion even if general logs removal fails
      }
      
      // 6. Finally, remove the entire outlet from Firebase database
      console.log('🗑️ SetUp: Starting complete device deletion from devices collection...')
      
      // First, let's see what data exists for this outlet
      const outletRef = ref(realtimeDb, `devices/${deviceToDelete.outletName}`)
      const outletSnapshot = await get(outletRef)
      
      if (outletSnapshot.exists()) {
        const outletData = outletSnapshot.val()
        console.log('🔍 SetUp: Outlet data that will be deleted:', outletData)
        console.log('🔍 SetUp: Outlet data keys:', Object.keys(outletData))
        
        // Log specific data sections that will be deleted
        if (outletData.sensor_data) {
          console.log('🔍 SetUp: Sensor data will be deleted:', outletData.sensor_data)
        }
        if (outletData.daily_logs) {
          console.log('🔍 SetUp: Daily logs will be deleted:', Object.keys(outletData.daily_logs))
        }
        if (outletData.office_info) {
          console.log('🔍 SetUp: Office info will be deleted:', outletData.office_info)
        }
        if (outletData.schedule) {
          console.log('🔍 SetUp: Schedule will be deleted:', outletData.schedule)
        }
        if (outletData.relay_control) {
          console.log('🔍 SetUp: Relay control will be deleted:', outletData.relay_control)
        }
        if (outletData.control) {
          console.log('🔍 SetUp: Control settings will be deleted:', outletData.control)
        }
        if (outletData.lifetime_energy !== undefined) {
          console.log('🔍 SetUp: Lifetime energy will be deleted:', outletData.lifetime_energy)
        }
        if (outletData.lifetime_hours !== undefined) {
          console.log('🔍 SetUp: Lifetime hours will be deleted:', outletData.lifetime_hours)
        }
        if (outletData.lifetime_usage_millis !== undefined) {
          console.log('🔍 SetUp: Lifetime usage millis will be deleted:', outletData.lifetime_usage_millis)
        }
      } else {
        console.log('❌ SetUp: No outlet data found at path:', `devices/${deviceToDelete.outletName}`)
      }
      
      console.log('🗑️ SetUp: Deleting outlet at path:', `devices/${deviceToDelete.outletName}`)
      
      // Remove the entire outlet and ALL its data from the devices collection
      const deleteResult = await remove(outletRef)
      console.log('🗑️ SetUp: Delete result:', deleteResult)
      
      // Verify the deletion was successful
      const verifySnapshot = await get(outletRef)
      if (!verifySnapshot.exists()) {
        console.log('✅ SetUp: VERIFICATION SUCCESSFUL - Outlet completely deleted from devices collection!')
      } else {
        console.log('❌ SetUp: VERIFICATION FAILED - Outlet still exists in devices collection!')
      }
      
      console.log('✅ SetUp: COMPLETE device deletion successful! All outlet data has been removed from database.')
      
      // Show success modal
      setDeleteSuccessModal({ 
        isOpen: true, 
        deviceName: deviceToDelete.outletName 
      })
      
      // Close delete confirmation modal
      setDeleteModal({ ...deleteModal, isOpen: false })
      
    } catch (error) {
      console.error('SetUp: Error deleting device from database:', error)
      console.error('SetUp: Error details:', {
        deviceId: deleteModal.deviceId,
        deviceName: deviceToDelete?.outletName,
        error: error
      })
      
      // Close delete confirmation modal on error
      setDeleteModal({ ...deleteModal, isOpen: false })
    }
  }

  // Handle modal actions
  const handleOpenModal = () => {
    setIsModalOpen(true)
  }

  const handleCloseModal = () => {
    setIsModalOpen(false)
  }

  const handleOpenCombinedLimitModal = () => {
    setCombinedLimitModal({ isOpen: true })
  }

  const handleCloseCombinedLimitModal = () => {
    setCombinedLimitModal({ isOpen: false })
  }

  const handleCloseCombinedLimitSuccessModal = () => {
    setCombinedLimitSuccessModal({
      isOpen: false,
      selectedOutlets: [],
      combinedLimit: 0,
      isEdit: false
    })
  }

  const handleSaveCombinedLimit = async (data: { selectedOutlets: string[]; combinedLimit: number; deviceControl: string; enableScheduling: boolean; department?: string }) => {
    try {
      console.log('Saving combined limit:', data)
      
      if (!data.department) {
        throw new Error('Department is required to save combined limit settings')
      }
      
      const departmentPath = getDepartmentCombinedLimitPath(data.department)
      
      // IMPORTANT: Handle devices that were REMOVED from combined group FIRST
      // Get current combined limit settings BEFORE updating to compare with new settings
      const departmentCombinedLimitRef = ref(realtimeDb, departmentPath)
      const currentCombinedLimitSnapshot = await get(departmentCombinedLimitRef)
      
      if (currentCombinedLimitSnapshot.exists()) {
        const currentData = currentCombinedLimitSnapshot.val()
        const currentSelectedOutlets = currentData.selected_outlets || []
        
        // Find devices that were removed from the combined group
        const removedOutlets = currentSelectedOutlets.filter((outlet: string) => 
          !data.selectedOutlets.includes(outlet)
        )
        
        console.log('🔍 Combined limit removal check:', {
          currentSelectedOutlets,
          newSelectedOutlets: data.selectedOutlets,
          removedOutlets
        })
        
        if (removedOutlets.length > 0) {
          console.log('🔒 Devices removed from combined group, turning them OFF and removing combined schedule:', removedOutlets)
          
          // Remove removed outlets from combined_schedule_settings
          try {
            const combinedScheduleRef = ref(realtimeDb, 'combined_schedule_settings')
            const combinedScheduleSnapshot = await get(combinedScheduleRef)
            
            if (combinedScheduleSnapshot.exists()) {
              const combinedScheduleData = combinedScheduleSnapshot.val()
              const currentScheduleOutlets = combinedScheduleData.selected_outlets || []
              
              // Remove the removed outlets from combined schedule
              const updatedScheduleOutlets = currentScheduleOutlets.filter((outlet: string) => 
                !removedOutlets.includes(outlet)
              )
              
              if (updatedScheduleOutlets.length !== currentScheduleOutlets.length) {
                await update(combinedScheduleRef, {
                  selected_outlets: updatedScheduleOutlets
                })
                console.log(`✅ SetUp: Removed ${removedOutlets.length} outlet(s) from combined_schedule_settings`)
              }
            }
          } catch (error) {
            console.error('❌ Error updating combined_schedule_settings:', error)
          }
          
          // Turn OFF all devices that were removed from combined group
          for (const outletName of removedOutlets) {
            // Handle both formats: "Outlet 1" and "Outlet_1" - replace ALL spaces/special chars
            const outletKey = outletName.includes(' ') ? outletName.replace(/\s+/g, '_').replace(/'/g, '') : outletName
            
            console.log(`🔧 Processing removal: "${outletName}" -> "${outletKey}"`)
            
            try {
              // Get current control state before turning off
              const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
              const deviceSnapshot = await get(deviceRef)
              const currentControlState = deviceSnapshot.val()?.control?.device || 'off'
              
              const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
              await update(controlRef, { device: 'off' })
              
              // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
              // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
              if (currentControlState === 'on') {
                // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
              } else {
                // Device was already off - safe to set status='OFF'
                const statusRef = ref(realtimeDb, `devices/${outletKey}`)
                await update(statusRef, { status: 'OFF' })
              }
              
              // Clear combined schedule settings for removed outlet
              // Clear enable_power_scheduling flag
              const officeInfoRef = ref(realtimeDb, `devices/${outletKey}/office_info`)
              const officeInfoSnapshot = await get(officeInfoRef)
              if (officeInfoSnapshot.exists()) {
                await update(officeInfoRef, {
                  enable_power_scheduling: false
                })
                console.log(`✅ SetUp: Cleared enable_power_scheduling for ${outletKey}`)
              }
              
              // Clear schedule data if it was part of combined schedule
              const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
              const scheduleSnapshot = await get(scheduleRef)
              if (scheduleSnapshot.exists()) {
                const scheduleData = scheduleSnapshot.val()
                // Clear all schedule data including combined schedule flags
                await update(scheduleRef, {
                  timeRange: null,
                  startTime: null,
                  endTime: null,
                  days: null,
                  frequency: null,
                  enabled: false,
                  isCombinedSchedule: null,
                  combinedScheduleId: null
                })
                console.log(`✅ SetUp: Cleared combined schedule data (including isCombinedSchedule and combinedScheduleId) for ${outletKey}`)
              }
              
              console.log(`🔒 SetUp: Successfully turned OFF ${outletKey} and removed combined schedule after removal from combined group (now subject to individual monthly limits)`)
            } catch (error) {
              console.error(`❌ Error turning off removed device ${outletKey}:`, error)
            }
          }
        } else {
          console.log('ℹ️ No devices were removed from combined group')
        }
      }
      
      // If no outlets are selected, disable the combined limit and clean up all schedule data
      if (data.selectedOutlets.length === 0) {
        console.log('⚠️ No outlets selected - disabling combined limit and cleaning up all schedule data')
        
        // Get all previously selected outlets to clean up their schedule data
        let previousOutlets: string[] = []
        if (currentCombinedLimitSnapshot.exists()) {
          const currentData = currentCombinedLimitSnapshot.val()
          previousOutlets = currentData.selected_outlets || []
        }
        
        // Clean up schedule data for all previously selected outlets
        for (const outletName of previousOutlets) {
          const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
          
          try {
            const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
            const scheduleSnapshot = await get(scheduleRef)
            
            if (scheduleSnapshot.exists()) {
              await update(scheduleRef, {
                isCombinedSchedule: null,
                combinedScheduleId: null
              })
              console.log(`✅ SetUp: Removed isCombinedSchedule and combinedScheduleId from ${outletKey}`)
            }
          } catch (error) {
            console.error(`❌ Error cleaning up schedule for ${outletKey}:`, error)
          }
        }
        
        // Disable the combined limit
        await update(departmentCombinedLimitRef, {
          enabled: false,
          selected_outlets: [],
          combined_limit_watts: 0,
          device_control: data.deviceControl,
          scheduling_only: false,
          department: data.department,
          updated_at: new Date().toISOString()
        })
        
        console.log(`✅ SetUp: Disabled combined limit for department ${data.department} (no outlets selected)`)
      } else {
        // Save combined limit settings to database under department-specific path
        await update(departmentCombinedLimitRef, {
          enabled: true,
          selected_outlets: data.selectedOutlets,
          combined_limit_watts: data.combinedLimit === 0 ? "No Limit" : data.combinedLimit,
          device_control: data.deviceControl,
          scheduling_only: data.combinedLimit === 0,
          department: data.department,
          created_at: new Date().toISOString(),
          created_by: 'user' // You can replace this with actual user info
        })
        
        console.log(`✅ SetUp: Saved combined limit settings to ${departmentPath}`)
        
        // Update device control for all selected outlets
        console.log('Updating device control for selected outlets:', data.selectedOutlets)
        for (const outletName of data.selectedOutlets) {
          const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
          const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
          const statusRef = ref(realtimeDb, `devices/${outletKey}`)
          
          try {
            // Get current control state before updating (needed for both 'on' and 'off' cases)
            const deviceStatusSnapshot = await get(statusRef)
            const currentControlState = deviceStatusSnapshot.val()?.control?.device || 'off'
            
            // If setting device control to 'on', check and reset disabled_by_unplug and status from UNPLUG BEFORE updating
            if (data.deviceControl === 'on') {
              // Reset disabled_by_unplug flag
              const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
              const scheduleSnapshot = await get(scheduleRef)
              const scheduleData = scheduleSnapshot.val() || {}
              
              if (scheduleData.disabled_by_unplug === true) {
                await update(scheduleRef, {
                  disabled_by_unplug: false
                })
                console.log(`Combined limit: Reset disabled_by_unplug to false for ${outletKey}`)
              }
              
              const deviceStatusData = deviceStatusSnapshot.val()
              
              // Reset status from UNPLUG to ON (already handled below, but explicitly reset if currently UNPLUG)
              if (deviceStatusData?.status === 'UNPLUG' || deviceStatusData?.status === 'unplug') {
                await update(statusRef, {
                  status: 'ON'
                })
                console.log(`Combined limit: Reset status from UNPLUG to ON for ${outletKey}`)
              } else {
                // Update status to ON if not already UNPLUG
                await update(statusRef, {
                  status: 'ON'
                })
              }
            }
            
            // Update control state
            await update(controlRef, {
              device: data.deviceControl
            })
            
            // If setting device control to 'off' manually from Edit Monthly Power Limit modal, DO NOT change root status
            // Only update control.device - leave root status as is
            // This preserves the current status (could be 'ON', 'OFF', 'UNPLUG', 'Idle', etc.)
            if (data.deviceControl === 'off') {
              console.log(`✅ SetUp: Device ${outletKey} control set to 'off' from Edit Monthly Power Limit modal - leaving root status unchanged`)
            }
            
            console.log(`Updated device control for ${outletKey} to ${data.deviceControl}`)
          } catch (error) {
            console.error(`Error updating device control for ${outletKey}:`, error)
          }
        }
      }
      
      // Clear scheduling data if scheduling is disabled
      if (!data.enableScheduling) {
        console.log('Clearing scheduling data for selected outlets:', data.selectedOutlets)
        
        // Clear combined schedule settings
        try {
          const combinedScheduleRef = ref(realtimeDb, 'combined_schedule_settings')
          await update(combinedScheduleRef, {
            enabled: false,
            selected_outlets: [],
            schedule_data: null,
            created_at: null,
            created_by: null
          })
          console.log('Cleared combined schedule settings')
        } catch (error) {
          console.error('Error clearing combined schedule settings:', error)
        }
        
        // Clear individual device schedule data
        for (const outletName of data.selectedOutlets) {
          const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
          
          try {
            // Clear schedule data including combined schedule flags
            const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
            await update(scheduleRef, {
              timeRange: null,
              startTime: null,
              endTime: null,
              days: null,
              enabled: false,
              isCombinedSchedule: null,
              combinedScheduleId: null
            })
            
            // Clear enable_power_scheduling flag
            const officeInfoRef = ref(realtimeDb, `devices/${outletKey}/office_info`)
            await update(officeInfoRef, {
              enable_power_scheduling: false
            })
            
            console.log(`Cleared scheduling data for ${outletKey}`)
          } catch (error) {
            console.error(`Error clearing scheduling data for ${outletKey}:`, error)
          }
        }
      } else {
        // Enable scheduling if it's checked
        console.log('Enabling scheduling for selected outlets:', data.selectedOutlets)
        for (const outletName of data.selectedOutlets) {
          const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
          
          try {
            // Enable power scheduling flag
            const officeInfoRef = ref(realtimeDb, `devices/${outletKey}/office_info`)
            await update(officeInfoRef, {
              enable_power_scheduling: true
            })
            
            // Update basis and disabled_by_unplug if schedule exists
            const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
            const scheduleSnapshot = await get(scheduleRef)
            const existingSchedule = scheduleSnapshot.val()
            
            if (existingSchedule && (existingSchedule.timeRange || existingSchedule.startTime)) {
              // Create basis timestamp for unplug detection
              const basis = Date.now()
              await update(scheduleRef, {
                basis: basis,
                disabled_by_unplug: false
              })
              console.log(`Updated basis and disabled_by_unplug for ${outletKey}`)
            }
            
            console.log(`Enabled scheduling for ${outletKey}`)
          } catch (error) {
            console.error(`Error enabling scheduling for ${outletKey}:`, error)
          }
        }
      }
      
      console.log('Combined limit, device control, and scheduling data saved successfully')
      
      // Reset unplug detection state for all selected outlets when combined limit is updated
      setDeviceTimestamps(prev => {
        const newState = { ...prev }
        data.selectedOutlets.forEach(outletName => {
          const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
          delete newState[outletKey]
        })
        return newState
      })
      
      // Log the combined limit activity
      const activity = combinedLimitInfo.enabled ? 'Edit combined limit' : 'Set combined limit'
      const limitValue = data.combinedLimit === 0 ? 'No Limit' : data.combinedLimit
      await logCombinedLimitActivity(activity, data.selectedOutlets, limitValue)
      
      // Close modal
      setCombinedLimitModal({ isOpen: false })
      
      // Update local state
      setCombinedLimitInfo({
        enabled: true,
        selectedOutlets: data.selectedOutlets,
        combinedLimit: data.combinedLimit,
        department: data.department || ''
      })
      
      // Show success modal
      setCombinedLimitSuccessModal({
        isOpen: true,
        selectedOutlets: data.selectedOutlets,
        combinedLimit: data.combinedLimit,
        isEdit: combinedLimitInfo.enabled
      })
      
    } catch (error) {
      console.error('Error saving combined limit:', error)
      alert('Failed to save combined limit. Please try again.')
    }
  }

  // Fetch combined limit information
  // Real-time listener for combined limit information - listens to all departments
  useEffect(() => {
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    
    // Set up real-time listener for all departments
    const unsubscribe = onValue(combinedLimitRef, (snapshot) => {
      if (snapshot.exists()) {
        const allDepartmentsData = snapshot.val()
        console.log('SetUp: Real-time update - all departments combined limit data:', allDepartmentsData)
        
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
            combinedLimit: foundData.combined_limit_watts || 0,
            device_control: foundData.device_control || 'on',
            department: foundData.department || ''
          })
        } else {
          // No enabled department found
          setCombinedLimitInfo({
            enabled: false,
            selectedOutlets: [],
            combinedLimit: 0,
            device_control: 'on',
            department: ''
          })
        }
      } else {
        console.log('SetUp: No combined limit settings found in database')
        setAllDepartmentCombinedLimits({})
        setCombinedLimitInfo({
          enabled: false,
          selectedOutlets: [],
          combinedLimit: 0,
          device_control: 'on',
          department: ''
        })
      }
    }, (error) => {
      console.error('SetUp: Error listening to combined limit info:', error)
      setAllDepartmentCombinedLimits({})
      setCombinedLimitInfo({
        enabled: false,
        selectedOutlets: [],
        combinedLimit: 0,
        device_control: 'on',
        department: ''
      })
    })
    
    // Cleanup listener on unmount
    return () => unsubscribe()
  }, [])

  // Combined Power Limit Monitor - checks combined power consumption and turns off devices when limit is reached
  useEffect(() => {
    const checkCombinedPowerLimits = async () => {
      try {
        // Get combined limit settings
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const combinedLimitSnapshot = await get(combinedLimitRef)
        
        if (!combinedLimitSnapshot.exists()) {
          return // No combined limit set
        }
        
        const combinedLimitData = combinedLimitSnapshot.val()
        
        if (!combinedLimitData.enabled) {
          return // Combined limit is disabled
        }
        
        const selectedOutlets = combinedLimitData.selected_outlets || []
        const combinedLimitWatts = combinedLimitData.combined_limit_watts || 0
        
        // Skip power limit check if "No Limit" is set
        if (combinedLimitWatts === "No Limit") {
          console.log('SetUp: Combined limit is set to "No Limit" - skipping power limit check')
          return
        }
        
        if (selectedOutlets.length === 0 || combinedLimitWatts <= 0) {
          return // Invalid settings
        }
        
        // Get devices data
        const devicesRef = ref(realtimeDb, 'devices')
        const devicesSnapshot = await get(devicesRef)
        
        if (!devicesSnapshot.exists()) {
          return
        }
        
        const devicesData = devicesSnapshot.val()
        
        // Calculate combined monthly energy consumption
        const totalCombinedPower = calculateCombinedMonthlyEnergy(devicesData, selectedOutlets)
        const activeDevices: string[] = []
        
        // Find active devices
        selectedOutlets.forEach((outletName: string) => {
          const outletKey = outletName.replace(/\s+/g, '_').replace(/'/g, '')
          const outletData = devicesData[outletKey]
          
          if (outletData) {
            // Check if device is currently active
            const controlState = outletData.control?.device || 'off'
            if (controlState === 'on') {
              activeDevices.push(outletKey)
            }
          }
        })
        
        console.log(`SetUp: Combined monthly limit check:`, {
          selectedOutlets,
          totalCombinedPower: `${totalCombinedPower.toFixed(3)}W`,
          combinedLimitWatts: `${combinedLimitWatts}W`,
          exceedsLimit: totalCombinedPower >= combinedLimitWatts,
          activeDevices: activeDevices.length
        })
        
        // If combined monthly energy exceeds limit, turn off all active devices
        if (totalCombinedPower >= combinedLimitWatts && activeDevices.length > 0) {
          console.log(`SetUp: COMBINED MONTHLY LIMIT EXCEEDED - Turning OFF all active devices (${totalCombinedPower.toFixed(3)}Wh >= ${combinedLimitWatts}Wh)`)
          
          // Turn off all active devices
          for (const outletKey of activeDevices) {
            try {
              // Get current control state before turning off
              const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
              const deviceSnapshot = await get(deviceRef)
              const currentControlState = deviceSnapshot.val()?.control?.device || 'off'
              
              await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                device: 'off'
              })
              
              // CRITICAL: Only set status='OFF' if device is not currently idle (control was 'on')
              // If device was idle (control='on' but no activity), setting status='OFF' would override idle detection
              if (currentControlState === 'on') {
                // Device was on (possibly idle) - don't set status='OFF', let display logic handle it
                console.log(`✅ SetUp: Device ${outletKey} was ON (possibly idle) - not setting status='OFF' to preserve idle detection`)
              } else {
                // Device was already off - safe to set status='OFF'
                await update(ref(realtimeDb, `devices/${outletKey}`), {
                  status: 'OFF'
                })
                console.log(`SetUp: Device ${outletKey} turned OFF due to combined power limit exceeded`)
              }
            } catch (error) {
              console.error(`SetUp: Error turning off device ${outletKey}:`, error)
            }
          }
          
          // Log the combined limit action
          console.log(`SetUp: Combined power limit action completed - ${activeDevices.length} devices turned off`)
        }
        
      } catch (error) {
        console.error('SetUp: Error in combined power limit monitor:', error)
      }
    }
    
    // Run immediately
    checkCombinedPowerLimits()
    
    // Set up interval to check every 30 seconds
    const interval = setInterval(checkCombinedPowerLimits, 30000)
    
    // Cleanup interval on unmount
    return () => clearInterval(interval)
  }, [])

  const handleSaveDevice = (deviceData: any) => {
    console.log('Saving device:', deviceData)
    console.log('Appliance:', deviceData.appliance)
    console.log('Enable Scheduling:', deviceData.enableScheduling)
    console.log('Enable Power Limit:', deviceData.enablePowerLimit)
    console.log('Device Control:', deviceData.deviceControl)
    
    // Don't update devices array - let the real-time listener handle all device updates
    // The real-time listener will automatically pick up the changes when a device is saved
    // This prevents overwriting the status display for existing devices
    
    // Only check combined monthly limits if needed
    // The real-time listener will handle device updates naturally
    const devicesRef = ref(realtimeDb, 'devices')
    onValue(devicesRef, (snapshot) => {
      const data = snapshot.val()
      if (data) {
        // Check combined monthly limits after device is saved
        checkCombinedMonthlyLimit(data, combinedLimitInfo)
      }
    }, { onlyOnce: true }) // Only get data once to check limits
  }

  const handleEditSave = (updatedDevice: Device & { enableScheduling: boolean; enablePowerLimit: boolean }) => {
    console.log('SetUp: handleEditSave called for device:', updatedDevice.outletName)
    console.log('SetUp: Updated device data:', updatedDevice)
    
    // Don't update local state - let the real-time listener handle it
    // The database has been updated, so the listener will automatically refresh the table
    
    // Reset warning for this device if power usage changed significantly
    const oldDevice = devices.find(d => d.id === updatedDevice.id)
    if (oldDevice) {
      // Parse old usage - handle both W and kW formats
      const oldUsage = oldDevice.powerUsage.includes('kW') ? 
        parseFloat(oldDevice.powerUsage.replace(' kW', '')) : 
        parseFloat(oldDevice.powerUsage.replace(' Wh', '')) / 1000
      // Parse new usage - handle both W and kW formats
      const newUsage = updatedDevice.powerUsage.includes('kW') ? 
        parseFloat(updatedDevice.powerUsage.replace(' kW', '')) : 
        parseFloat(updatedDevice.powerUsage.replace(' Wh', '')) / 1000
      const oldLimit = parseInt(oldDevice.limit.replace('Wh', '').replace('W', ''))
      const newLimit = parseInt(updatedDevice.limit.replace('Wh', '').replace('W', ''))
      
    }
    
    // Small delay to ensure database update is processed before showing success modal
    setTimeout(() => {
      console.log('SetUp: Showing success modal for:', updatedDevice.outletName)
      setEditSuccessModal({ isOpen: true, deviceName: updatedDevice.outletName });
    }, 500)
    
    console.log('SetUp: handleEditSave completed - table will update via real-time listener')
  }


  // Track previous device statuses to detect transitions
  const [prevDeviceStatuses, setPrevDeviceStatuses] = useState<Record<string, Device['status']>>({})


  // Function to handle going to setup section
  const handleGoToSetup = () => {
    // Close the modal first
    setNoPowerLimitModal({ ...noPowerLimitModal, isOpen: false })
    
    // Scroll to the add device button to encourage adding a power limit
    const addDeviceBtn = document.querySelector('.add-device-btn')
    if (addDeviceBtn) {
      addDeviceBtn.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  // Update previous statuses on mount and whenever devices change
  useEffect(() => {
    setPrevDeviceStatuses(Object.fromEntries(devices.map(d => [d.id, d.status])))
  }, [])
  useEffect(() => {
    setPrevDeviceStatuses(Object.fromEntries(devices.map(d => [d.id, d.status])))
  }, [devices])



  // When a device is added, scroll to its row and briefly highlight
  useEffect(() => {
    if (!recentlyAddedId) return
    const rowEl = document.getElementById(`device-row-${recentlyAddedId}`)
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    const timer = setTimeout(() => setRecentlyAddedId(null), 2500)
    return () => clearTimeout(timer)
  }, [recentlyAddedId])


  // Get status badge styling (updated to match Dashboard.tsx)
  const getStatusBadge = (status: string) => {
    const statusClasses: { [key: string]: string } = {
      'Active': 'status-active',
      'Inactive': 'status-inactive',
      'Warning': 'status-warning',
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
    <div className="setup-wrap">
      {/* Header Section */}
      <section className="setup-hero">
        <div className="hero-left">
          <div className="hero-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="18" height="5" rx="2" fill="#ffffff"/>
              <rect x="3" y="10" width="10" height="10" rx="2" fill="#ffffff"/>
              <rect x="14" y="10" width="7" height="10" rx="2" fill="#ffffff"/>
              <path d="M12 16h.01M8 16h.01M16 16h.01" stroke="#0b3e86" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="hero-text">
            <h1>Devices <span className="device-count-pill">{devices.length}</span></h1>
            <p>Setup your devices</p>
          </div>
        </div>
        <div className="hero-actions">
          <button 
            className="add-device-btn" 
            type="button"
            aria-label="Add new device"
            onClick={handleOpenModal}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Add device
          </button>
          <button 
            className="combined-limit-btn" 
            type="button"
            aria-label={combinedLimitInfo.enabled ? "Edit combined power limit" : "Set combined power limit"}
            onClick={handleOpenCombinedLimitModal}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {combinedLimitInfo.enabled ? 'Monthly Device Limit' : 'Monthly Device Limit'}
          </button>
        </div>
      </section>

      {/* Main Content Area */}
      <section className="setup-content">
        <div className="content-header">
          <h2>Connected Devices</h2>
          <div className="search-container">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="11" cy="11" r="8" stroke="#9ca3af" strokeWidth="2"/>
              <path d="m21 21-4.35-4.35" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Search device"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-field"
              aria-label="Search devices"
            />
          </div>
        </div>

        <div className="setup-table-container">
          <table className="setup-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>OUTLET NAME</th>
                <th>OFFICE / ROOM</th>
                <th>APPLIANCES</th>
                <th>LIMIT</th>
                <th>CURRENT POWER USAGE</th>
                <th>CURRENT (A)</th>
                <th>TODAY'S ENERGY</th>
                <th>MONTH ENERGY</th>
                <th>STATUS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => (
                <tr key={device.id} id={`device-row-${device.id}`} className={recentlyAddedId === device.id ? 'row-recent' : ''}>
                  <td className="device-id">{device.id}</td>
                  <td className="outlet-name">{device.outletName}</td>
                  <td className="office-room">{device.officeRoom}</td>
                  <td className="appliances">{device.appliances}</td>
                  <td className="limit">
                    {(() => {
                      // Check if device is using combined limit from its department
                      const deviceOutletName = device.outletName
                      const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
                      const deviceDepartment = device.department
                      
                      // Check if device belongs to a department and if that department has combined limits
                      let foundDepartmentLimit: { combinedLimit: number; department: string } | null = null
                      
                      if (deviceDepartment) {
                        // Check if this device's department has combined limit settings
                        const deptLimitInfo = allDepartmentCombinedLimits[deviceDepartment]
                        if (deptLimitInfo && deptLimitInfo.enabled && deptLimitInfo.selectedOutlets) {
                          // Check if this device is in the department's selected outlets
                          const isInDeptCombinedLimit = deptLimitInfo.selectedOutlets.includes(deviceOutletName) || 
                                                       deptLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace)
                          
                          if (isInDeptCombinedLimit) {
                            foundDepartmentLimit = {
                              combinedLimit: deptLimitInfo.combinedLimit,
                              department: deviceDepartment
                            }
                          }
                        }
                      }
                      
                      // Fallback: Check all departments if device department is not set (backward compatibility)
                      if (!foundDepartmentLimit) {
                        for (const [deptKey, deptLimitInfo] of Object.entries(allDepartmentCombinedLimits)) {
                          if (deptLimitInfo.enabled && deptLimitInfo.selectedOutlets) {
                            const isInThisDept = deptLimitInfo.selectedOutlets.includes(deviceOutletName) || 
                                               deptLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace)
                            
                            if (isInThisDept) {
                              foundDepartmentLimit = {
                                combinedLimit: deptLimitInfo.combinedLimit,
                                department: deptKey
                              }
                              break
                            }
                          }
                        }
                      }
                      
                      console.log(`SetUp: Checking device ${device.outletName}:`, {
                        deviceDepartment,
                        foundDepartmentLimit,
                        allDepartmentCombinedLimits: Object.keys(allDepartmentCombinedLimits)
                      })
                      
                      if (foundDepartmentLimit) {
                        return (
                          <div className="combined-limit-display">
                            <div className="combined-limit-indicator">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                              <span>{String(foundDepartmentLimit.combinedLimit) === "No Limit" ? "No Limit" : `${foundDepartmentLimit.combinedLimit}Wh`}</span>
                            </div>
                          </div>
                        )
                      } else {
                        // Ensure proper Wh unit formatting without creating Whh
                        return device.limit.includes('Wh') ? device.limit : device.limit.replace(' W', ' Wh')
                      }
                    })()}
                  </td>
                  <td className="power-usage">
                    {device.powerUsage}
                  </td>
                  <td className="current-ampere">{device.currentAmpere}</td>
                  <td className="today-usage">{device.todayUsage}</td>
                  <td className="month-usage">{device.monthUsage || '0.000 W'}</td>
                  <td className="status-cell">
                    <div className="status-container">
                      {getStatusBadge(device.status)}
                      {device.schedule && (
                        <div className={`schedule-indicator ${isDeviceActiveBySchedule(device.schedule, 'on', device, combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.includes(device.outletName)) ? 'active' : 'inactive'}`}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                            <polyline points="12,6 12,12 16,14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="actions">
                    <button
                      className="action-btn edit-btn"
                      onClick={() => handleEditDevice(device.id)}
                      aria-label={`Edit ${device.outletName}`}
                      title="Edit device"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                    </button>
                    <button
                      className="action-btn delete-btn"
                      onClick={() => handleDeleteDevice(device.id)}
                      aria-label={`Delete ${device.outletName}`}
                      title="Delete device"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {filteredDevices.length === 0 && (
            <div className="no-devices">
              <div className="no-devices-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="4" width="18" height="5" rx="2" fill="#e5e7eb"/>
                  <rect x="3" y="10" width="10" height="10" rx="2" fill="#e5e7eb"/>
                  <rect x="14" y="10" width="7" height="10" rx="2" fill="#e5e7eb"/>
                </svg>
              </div>
              <h3>No devices found</h3>
              <p>Try adjusting your search terms to find devices.</p>
            </div>
          )}
        </div>
      </section>

      {/* Add Device Modal */}
      <AddDeviceModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        onSave={handleSaveDevice}
      />

      {/* Combined Limit Modal */}
      <CombinedLimitModal
        isOpen={combinedLimitModal.isOpen}
        onClose={handleCloseCombinedLimitModal}
        onSave={handleSaveCombinedLimit}
        existingData={combinedLimitInfo}
      />

      {/* Combined Limit Success Modal */}
      <CombinedLimitSuccessModal
        isOpen={combinedLimitSuccessModal.isOpen}
        onClose={handleCloseCombinedLimitSuccessModal}
        selectedOutlets={combinedLimitSuccessModal.selectedOutlets}
        combinedLimit={combinedLimitSuccessModal.combinedLimit}
        isEdit={combinedLimitSuccessModal.isEdit}
      />

      {/* Edit Device Modal */}
      <EditDeviceModal
        isOpen={editModal.isOpen}
        onClose={() => setEditModal({ ...editModal, isOpen: false })}
        device={editModal.device}
        onSave={handleEditSave}
        combinedLimitInfo={combinedLimitInfo}
      />

      {/* Edit Restriction Modal */}
      <EditRestrictionModal
        isOpen={editRestrictionModal.isOpen}
        onClose={() => setEditRestrictionModal({ ...editRestrictionModal, isOpen: false })}
        device={editRestrictionModal.device}
        combinedLimit={editRestrictionModal.combinedLimit}
      />

      {/* Edit Success Modal */}
      <SuccessModal 
        isOpen={editSuccessModal.isOpen} 
        onClose={() => {
          setEditSuccessModal({ ...editSuccessModal, isOpen: false })
        }}
        title="Device Updated Successfully!"
        message={`"${editSuccessModal.deviceName}" has been updated with the new settings.`}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ ...deleteModal, isOpen: false })}
        onConfirm={handleConfirmDelete}
        deviceName={deleteModal.deviceName}
      />

      {/* Delete Success Modal */}
      <DeleteSuccessModal
        isOpen={deleteSuccessModal.isOpen}
        onClose={() => {
          setDeleteSuccessModal({ ...deleteSuccessModal, isOpen: false });
          // Don't manually update local state - let the real-time listener handle it
          console.log('SetUp: Delete success modal closed - table will update via real-time listener');
        }}
        deviceName={deleteSuccessModal.deviceName}
      />


      {/* No Power Limit Warning Modal */}
      {noPowerLimitModal.isOpen && (
        <NoPowerLimitWarningModal
          isOpen={noPowerLimitModal.isOpen}
          onClose={() => setNoPowerLimitModal({ ...noPowerLimitModal, isOpen: false })}
          device={noPowerLimitModal.device}
          onGoToSetup={handleGoToSetup}
        />
      )}

      {/* Monthly Limit Warning Modal */}
      {monthlyLimitModal.isOpen && (
        <MonthlyLimitWarningModal
          isOpen={monthlyLimitModal.isOpen}
          onClose={() => setMonthlyLimitModal({ ...monthlyLimitModal, isOpen: false })}
          device={monthlyLimitModal.device}
          reason={monthlyLimitModal.reason}
          currentMonthlyEnergy={monthlyLimitModal.currentMonthlyEnergy}
          combinedLimit={monthlyLimitModal.combinedLimit}
        />
      )}
    </div>
  )
}
