import React, { useState, useEffect, useRef } from 'react'
import { ref, onValue, off, update, remove, get } from 'firebase/database'
import { realtimeDb } from '../firebase/config'
import { logCombinedLimitActivity, logIndividualLimitActivity, logScheduleActivity, logDeviceControlActivity } from '../utils/deviceLogging'
import './SetUp.css'

// Helper function to format numbers with commas
const formatNumber = (num: number, decimals: number = 3): string => {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
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
      totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,
      combinedLimitWatts: `${combinedLimitWatts}W`,
      selectedOutlets: combinedLimitInfo.selectedOutlets,
      exceedsLimit: totalMonthlyEnergy >= combinedLimitWatts,
      percentage: combinedLimitWatts > 0 ? `${((totalMonthlyEnergy / combinedLimitWatts) * 100).toFixed(1)}%` : 'N/A'
    })
    
    // If monthly energy exceeds or equals the combined limit, turn off all devices in the group
    if (totalMonthlyEnergy >= combinedLimitWatts) {
      console.log('🚨 MONTHLY LIMIT EXCEEDED!')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
      console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP...')
      
      // Turn off all devices in the combined limit group
      const turnOffPromises = combinedLimitInfo.selectedOutlets.map(async (outletKey: string) => {
        try {
          // Convert display format to Firebase format
          const firebaseKey = outletKey.replace(' ', '_')
          
          // Turn off device control
          const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
          await update(controlRef, { device: 'off' })
          
          // Turn off main status to prevent immediate re-activation
          const mainStatusRef = ref(realtimeDb, `devices/${firebaseKey}/relay_control`)
          await update(mainStatusRef, { main_status: 'OFF' })
          
          console.log(`✅ TURNED OFF: ${outletKey} (${firebaseKey}) due to monthly limit`)
          return { outletKey, success: true }
        } catch (error) {
          console.error(`❌ FAILED to turn off ${outletKey}:`, error)
          return { outletKey, success: false, error }
        }
      })
      
      // Wait for all turn-off operations to complete
      const results = await Promise.all(turnOffPromises)
      const successCount = results.filter(r => r.success).length
      const failCount = results.filter(r => !r.success).length
      
      console.log(`🔒 MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${failCount} failed`)
    } else {
      console.log('✅ Monthly limit not exceeded - devices can remain active')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
    }
  } catch (error) {
    console.error('❌ Error checking combined monthly limit:', error)
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
    
    // IMPORTANT: When device is removed from combined group, turn it OFF
    // This is because it's no longer protected by combined monthly limit
    // and will now be subject to individual daily limits
    try {
      const deviceControlRef = ref(realtimeDb, `devices/${outletKey}/control`)
      await update(deviceControlRef, { device: 'off' })
      
      // Also set main_status to OFF to prevent automatic turn-on
      const deviceMainStatusRef = ref(realtimeDb, `devices/${outletKey}/relay_control`)
      await update(deviceMainStatusRef, { main_status: 'OFF' })
      
      console.log(`🔒 SetUp: Turned OFF ${outletKey} after removing from combined group (now subject to individual daily limits)`)
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
  todayUsage: string
  monthUsage?: string
  status: 'Active' | 'Inactive' | 'Warning' | 'Idle'
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
  }
  relay_control?: {
    auto_cutoff?: {
      enabled: boolean
      power_limit: number
    }
    status?: string
    main_status?: string
  }
}

// Add Device Modal Props
interface AddDeviceModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (deviceData: {
    deviceType: string
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
  error
}: {
  id: string
  value: string
  placeholder: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (v: string) => void
  error?: boolean
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
    <div className={`styled-select${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        id={id}
        className={`styled-select-btn${error ? ' error' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
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
  const exceedsLimit = !hasNoLimit && (device as any).todayTotalEnergy >= (device as any).powerLimit

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
    message = `"${device.outletName}" cannot be turned ON because today's energy consumption has exceeded the power limit.`
    statusLabel = 'Today\'s Energy:'
    statusValue = `${formatNumber(((device as any).todayTotalEnergy * 1000) || 0)} Wh`
    actionLabel = 'Power Limit:'
    actionValue = `${((device as any).powerLimit * 1000) || '0'} Wh`
    warningMessage = 'Today\'s total energy consumption has reached or exceeded the daily power limit. The device cannot be activated until tomorrow or the power limit is increased.'
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
  const [todayEnergy, setTodayEnergy] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchTodayEnergy = async () => {
      try {
        const outletKey = device.outletName.replace(' ', '_')
        const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceSnapshot = await get(deviceRef)
        const deviceData = deviceSnapshot.val()
        
        const today = new Date()
        const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
        const todayLogs = deviceData?.daily_logs?.[todayDateKey]
        const todayTotalEnergy = todayLogs?.total_energy || 0
        
        setTodayEnergy(todayTotalEnergy)
      } catch (error) {
        console.error('Error fetching today\'s energy data:', error)
        // Fallback to current usage
        const currentPowerUsage = device.powerUsage.includes('kW') ? 
          parseFloat(device.powerUsage.replace(' kW', '')) : 
          parseFloat(device.powerUsage.replace(' Wh', '')) / 1000
        setTodayEnergy(currentPowerUsage)
      } finally {
        setLoading(false)
      }
    }

    fetchTodayEnergy()
  }, [device])

  if (loading) return null

  if (todayEnergy !== null && newPowerLimit < todayEnergy) {
    return (
      <div className="field-warning field-warning-error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" fill="#fef2f2" stroke="#dc2626" strokeWidth="2"/>
          <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" fill="#dc2626"/>
        </svg>
        <span>Power limit ({(newPowerLimit * 1000).toFixed(3)} Wh) is below today's energy consumption ({(todayEnergy * 1000).toFixed(3)} Wh). Increase the limit or reduce usage first.</span>
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
    officeRoom: '',
    enabled: true
  })

  const [enableScheduling, setEnableScheduling] = useState(false)
  const [enablePowerLimit, setEnablePowerLimit] = useState(true)

  const [errors, setErrors] = useState<Record<string, string>>({})

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

  // Initialize form data when device changes
  useEffect(() => {
    if (device) {
      const powerLimitValue = device.limit.replace(' Wh', '').replace(' W', '').replace(' kW', '')
      setFormData({
        outletName: device.outletName,
        powerLimit: powerLimitValue,
        status: device.status,
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
        enableScheduling: device.enablePowerScheduling || isNoLimit
      })
      
      setErrors({})
    }
  }, [device])

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
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
        // Check if power limit is less than today's energy consumption
        if (device) {
          try {
            // Get today's energy consumption from database
            const outletKey = device.outletName.replace(' ', '_')
            const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
            const deviceSnapshot = await get(deviceRef)
            const deviceData = deviceSnapshot.val()
            
            const today = new Date()
            const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
            const todayLogs = deviceData?.daily_logs?.[todayDateKey]
            const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
            
            const newPowerLimitkW = parseFloat(formData.powerLimit) / 1000 // Convert from Wh to kW
            
            if (newPowerLimitkW < todayTotalEnergy) {
              newErrors.powerLimit = `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than today's energy consumption (${(todayTotalEnergy * 1000).toFixed(3)} Wh)`
            }
          } catch (error) {
            console.error('Error fetching today\'s energy data:', error)
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
      
      // Additional validation: prevent setting power limit below today's energy consumption
      if (device && powerLimitToValidate > 0) {
        try {
          // Get today's energy consumption from database
          const outletKey = device.outletName.replace(' ', '_')
          const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
          const deviceSnapshot = await get(deviceRef)
          const deviceData = deviceSnapshot.val()
          
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
          
          const newPowerLimitkW = powerLimitToValidate / 1000 // Convert from Wh to kW
          
          if (newPowerLimitkW < todayTotalEnergy) {
            setErrors(prev => ({ 
              ...prev, 
              powerLimit: `Power limit (${(newPowerLimitkW * 1000).toFixed(3)} Wh) cannot be less than today's energy consumption (${(todayTotalEnergy * 1000).toFixed(3)} Wh)` 
            }))
            return
          }
        } catch (error) {
          console.error('Error fetching today\'s energy data:', error)
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
      
      try {
        console.log('Edit modal: Starting database update for:', device.outletName)
        console.log('Edit modal: Power limit to set:', formData.powerLimit)
        console.log('Edit modal: Enabled status to set:', formData.enabled)
        console.log('Edit modal: Office to set:', formData.officeRoom)
        
        // Update Firebase database
        const outletKey = device.outletName.replace(' ', '_')
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

        // Update office information with scheduling settings
        const officeRef = ref(realtimeDb, `devices/${outletKey}/office_info`)
        if (formData.officeRoom.trim()) {
          // Map display names back to database values
          const officeMapping: Record<string, string> = {
            'Computer Laboratory 1': 'computer-lab-1',
            'Computer Laboratory 2': 'computer-lab-2',
            'Computer Laboratory 3': 'computer-lab-3',
            "Dean's Office": 'deans-office',
            'Faculty Office': 'faculty-office'
          }
          
          const officeValue = officeMapping[formData.officeRoom] || formData.officeRoom
          console.log('Edit modal: Updating office info at path:', `devices/${outletKey}/office_info`)
          console.log('Edit modal: Scheduling settings:', { enableScheduling, enablePowerLimit })
          
          const officeUpdate = await update(officeRef, {
            office: officeValue,
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
          console.log('Edit modal: Scheduling is enabled - keeping existing schedule data')
          // Schedule data remains unchanged when scheduling is enabled
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
        const updatedDevice: Device & { enableScheduling: boolean; enablePowerLimit: boolean } = {
          ...device,
          outletName: formData.outletName || device.outletName,
          limit: formData.powerLimit === 'No Limit' ? 'No Limit' : `${powerLimitToUse.toFixed(3)} Wh`,
          status: formData.enabled ? 'Active' : 'Inactive',
          officeRoom: formData.officeRoom || '—',
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
    const hasUsageExceedLimit = device && formData.powerLimit && formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) > 0 && 
      parseFloat(formData.powerLimit) < (device.powerUsage.includes('kW') ? 
        parseFloat(device.powerUsage.replace(' kW', '')) : 
        parseFloat(device.powerUsage.replace(' Wh', '')) / 1000)
    return !hasPowerLimitIssue && !hasUsageExceedLimit
  }

  const getSaveButtonTitle = () => {
    const hasPowerLimitIssue = formData.enabled && enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0))
    const hasUsageExceedLimit = device && formData.powerLimit && formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) > 0 && 
      parseFloat(formData.powerLimit) < (device.powerUsage.includes('kW') ? 
        parseFloat(device.powerUsage.replace(' kW', '')) : 
        parseFloat(device.powerUsage.replace(' Wh', '')) / 1000)
    
    if (hasPowerLimitIssue) return 'Cannot save: Power limit is required to turn ON device'
    if (hasUsageExceedLimit) return 'Cannot save: Power limit is below today\'s energy consumption'
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
                          : "Enter value in Wh (watt-hours). This limit will be applied to today's energy consumption."
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
              
              {/* Show warning when power limit is below today's energy consumption */}
              {device && formData.powerLimit && parseFloat(formData.powerLimit) > 0 && (
                <PowerLimitWarningField 
                  device={device} 
                  newPowerLimit={parseFloat(formData.powerLimit)} 
                />
              )}
            </div>

            <div className="form-group">
              <label htmlFor="editOfficeRoom">
                Change office/room
              </label>
              <select
                id="editOfficeRoom"
                value={formData.officeRoom}
                onChange={(e) => handleInputChange('officeRoom', e.target.value)}
              >
                <option value="">— No office assigned —</option>
                <option value="Computer Laboratory 1">Computer Laboratory 1</option>
                <option value="Computer Laboratory 2">Computer Laboratory 2</option>
                <option value="Computer Laboratory 3">Computer Laboratory 3</option>
                <option value="Dean's Office">Dean's Office</option>
                <option value="Faculty Office">Faculty Office</option>
              </select>
              <div className="field-hint">Select "— No office assigned —" to clear the assignment</div>
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
  onSave: (data: { selectedOutlets: string[]; combinedLimit: number; deviceControl: string; enableScheduling: boolean }) => void;
  existingData?: {
    enabled: boolean;
    selectedOutlets: string[];
    combinedLimit: number;
  };
}) {
  const [selectedOutlets, setSelectedOutlets] = useState<string[]>([])
  const [combinedLimit, setCombinedLimit] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [availableOutlets, setAvailableOutlets] = useState<string[]>([])
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

  // Fetch available outlets from database and populate existing data
  useEffect(() => {
    const fetchOutlets = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          const outlets = Object.keys(devicesData).map(outletKey => 
            outletKey.replace('_', ' ')
          )
          setAvailableOutlets(outlets)
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
                  const outletKey = outletName.replace(' ', '_')
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
        }
        setIsFormInitialized(true)
      }
    } else {
      // Reset initialization flag and user editing state when modal closes
      setIsFormInitialized(false)
      setIsUserEditing(false)
    }
  }, [isOpen, existingData, isFormInitialized])

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
        enableScheduling
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
            {/* Outlet Selection */}
            <div className={`field-group ${errors.outlets ? 'error' : ''}`}>
              <label>
                Select Outlets <span className="required">*</span>
              </label>
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
                  {availableOutlets.map((outlet) => (
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
                  ))}
                </div>
              </div>
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
            {selectedOutlets.length > 0 && (enablePowerLimit || enableScheduling) && (
              <div className="limit-summary">
                <h4>Summary</h4>
                <div className="summary-details">
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
              disabled={!existingData && (selectedOutlets.length === 0 || !combinedLimit)}
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

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
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
      
      setFormData(prev => ({ 
        ...prev, 
        [field]: value,
        outletName: value,
        // Auto-populate office, appliance, and power limit from existing data if available
        office: outletData?.office_info?.office || prev.office,
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

  const validateForm = () => {
    const newErrors: Record<string, string> = {}
    
    if (!formData.deviceType) newErrors.deviceType = 'Device type is required'
    if (!formData.office) newErrors.office = 'Office is required'
    if (enablePowerLimit && (!formData.powerLimit || (formData.powerLimit !== 'No Limit' && parseFloat(formData.powerLimit) <= 0))) {
      newErrors.powerLimit = 'Power limit must be greater than 0 Wh'
    }
    if (!formData.appliance) newErrors.appliance = 'Appliance type is required'
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (validateForm()) {
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
        
        const officeUpdate = await update(officeRef, {
          office: formData.office,
          assigned_date: new Date().toISOString(),
          appliance: formData.appliance,
          enable_power_scheduling: enableScheduling // ✅ Update scheduling setting
        })
        console.log('Office update result:', officeUpdate)

        // Update device control (ON/OFF)
        const controlRef = ref(realtimeDb, `devices/${formData.deviceType}/control`)
        console.log('Updating device control at path:', `devices/${formData.deviceType}/control`)
        
        const controlUpdate = await update(controlRef, {
          device: deviceControl
        })
        console.log('Device control update result:', controlUpdate)

        // Update relay control main status
        const relayControlRef = ref(realtimeDb, `devices/${formData.deviceType}/relay_control`)
        console.log('Updating relay control at path:', `devices/${formData.deviceType}/relay_control`)
        
        const relayControlUpdate = await update(relayControlRef, {
          main_status: deviceControl === 'on' ? 'ON' : 'OFF'
        })
        console.log('Relay control update result:', relayControlUpdate)

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
          powerLimit: formData.powerLimit === 'No Limit' ? 'No Limit' : `${formData.powerLimit} W`,
          enableScheduling,
          enablePowerLimit,
          deviceControl
        }
        
        onSave(deviceDataWithUnit)
        setFormData({
          deviceType: '',
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

                <div className={`form-group ${errors.office ? 'error' : ''}`}>
                  <label htmlFor="office">
                    Select office <span className="required">*</span>
                  </label>
                  <StyledSelect
                    id="office"
                    value={formData.office}
                    placeholder="Choose office"
                    options={[
                      { value: 'computer-lab-1', label: 'Computer Laboratory 1' },
                      { value: 'computer-lab-2', label: 'Computer Laboratory 2' },
                      { value: 'computer-lab-3', label: 'Computer Laboratory 3' },
                      { value: 'deans-office', label: "Dean's Office" },
                      { value: 'faculty-office', label: 'Faculty Office' }
                    ]}
                    onChange={(v) => handleInputChange('office', v)}
                    error={!!errors.office}
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
                        : "Enter value in Wh (watt-hours). This limit will be applied to today's energy consumption."
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
  }>({
    enabled: false,
    selectedOutlets: [],
    combinedLimit: 0
  })
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

  // Auto-turnoff timer state for non-idle devices
  const [autoTurnoffTimers, setAutoTurnoffTimers] = useState<Record<string, NodeJS.Timeout | null>>({})

  // Fetch devices data from Firebase
  useEffect(() => {
    const devicesRef = ref(realtimeDb, 'devices')
    
    const unsubscribe = onValue(devicesRef, (snapshot) => {
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
            const isDeviceActiveBySchedule = (schedule: any, controlState: string): boolean => {
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

              const startTime = convertTo24Hour(startTimeStr)
              const endTime = convertTo24Hour(endTimeStr)

              // Check if current time is within schedule
              // Turn off exactly at end time - device is active only when current time is less than end time
              const isWithinTimeRange = currentTime >= startTime && currentTime < endTime

              // Check if current day is in schedule
              const frequency = schedule.frequency?.toLowerCase() || ''
              let isCorrectDay = false

              if (frequency === 'daily') {
                isCorrectDay = true
              } else if (frequency === 'weekdays') {
                isCorrectDay = currentDay >= 1 && currentDay <= 5 // Monday to Friday
              } else if (frequency === 'weekends') {
                isCorrectDay = currentDay === 0 || currentDay === 6 // Sunday or Saturday
              } else if (frequency.includes(',')) {
                // Custom days (e.g., "MONDAY, WEDNESDAY, FRIDAY")
                const dayMap: { [key: string]: number } = {
                  'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 
                  'friday': 5, 'saturday': 6, 'sunday': 0
                }
                const scheduledDays = frequency.split(',').map((day: string) => dayMap[day.trim().toLowerCase()])
                isCorrectDay = scheduledDays.includes(currentDay)
              }

              return isWithinTimeRange && isCorrectDay
            }

            // Use schedule-aware status logic with main status consideration
            const mainStatus = outlet.relay_control?.main_status || 'ON'
            
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
            
            // Determine final status
            let deviceStatus: 'Active' | 'Inactive' | 'Warning' | 'Idle'
            if ((isIdleFromSensor || isIdleFromLogic) && controlState === 'on') {
              // Show Idle if sensor reports idle OR if device is supposed to be ON but not responding
              deviceStatus = 'Idle'
            } else {
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

            const deviceData: Device = {
              id: String(deviceId).padStart(3, '0'),
              outletName: outletKey, // Use the actual outlet key from Firebase
              officeRoom: officeInfo, // Use office info from database
              appliances: outlet.office_info?.appliance || 'Unassigned',
              enablePowerScheduling: outlet.office_info?.enable_power_scheduling || false,
              limit: powerLimit === "No Limit" ? "No Limit" : `${(powerLimit * 1000).toFixed(3)} Wh`,
              powerUsage: powerUsageDisplay, // Use the new display format
              todayUsage: todayEnergyDisplay, // Use the new display format
              monthUsage: calculateMonthlyEnergy(outlet), // Calculate monthly energy
              status: deviceStatus,
              schedule: outlet.schedule && (outlet.schedule.timeRange || outlet.schedule.startTime || outlet.schedule.frequency) ? {
                timeRange: outlet.schedule.timeRange || (outlet.schedule.startTime && outlet.schedule.endTime ? 
                  (() => {
                    // Convert 24-hour format to 12-hour format for display
                    const convertTo12Hour = (time24h: string) => {
                      if (!time24h) return ''
                      const [hours, minutes] = time24h.split(':')
                      const hour = parseInt(hours, 10)
                      const ampm = hour >= 12 ? 'PM' : 'AM'
                      const hour12 = hour % 12 || 12
                      return `${hour12}:${minutes} ${ampm}`
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
        
        // Check combined monthly limits after setting devices
        checkCombinedMonthlyLimit(data, combinedLimitInfo)
      } else {
        console.log('SetUp: No data in Firebase - all devices deleted or database empty')
        setDevices([])
      }
    })

    return () => off(devicesRef, 'value', unsubscribe)
  }, [combinedLimitInfo])

  // Function to check daily limits
  const checkDailyLimit = (deviceData: any): boolean => {
    try {
      const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
      if (powerLimit <= 0) return false // No daily limit set
      
      const today = new Date()
      const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
      const todayLogs = deviceData.daily_logs?.[todayDateKey]
      const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
      
      console.log('SetUp: Daily limit check:', {
        powerLimit: `${powerLimit}kW`,
        todayTotalEnergy: `${todayTotalEnergy}kW`,
        exceeded: todayTotalEnergy >= powerLimit
      })
      
      return todayTotalEnergy >= powerLimit
    } catch (error) {
      console.error('SetUp: Error checking daily limit:', error)
      return false
    }
  }

  // Real-time scheduler that checks every minute and updates control.device
  useEffect(() => {
    const checkScheduleAndUpdateDevices = async () => {
      try {
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          console.log(`SetUp: Real-time scheduler check at ${new Date().toLocaleTimeString()}`)
          
          // HIERARCHY: Check monthly limit FIRST (highest priority) - AUTO TURN OFF
          // This automatically turns off all devices if monthly limit is exceeded
          console.log('🔍 SetUp: Running monthly limit check FIRST...')
          await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
          
          // Check monthly limit status for combined group
          let monthlyLimitExceeded = false
          if (combinedLimitInfo?.enabled && combinedLimitInfo?.selectedOutlets?.length > 0) {
            const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
            const combinedLimitWatts = combinedLimitInfo.combinedLimit
            
            // Skip limit check if "No Limit" is set
            if (String(combinedLimitWatts) === "No Limit") {
              console.log(`📊 SetUp: Combined limit is set to "No Limit" - proceeding with normal schedule processing`)
              monthlyLimitExceeded = false
            } else if (totalMonthlyEnergy >= combinedLimitWatts) {
              monthlyLimitExceeded = true
              console.log(`🚨 SetUp: MONTHLY LIMIT EXCEEDED for combined group`)
              console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
              console.log(`🔍 SetUp: Will check individual device limits within combined group`)
            } else {
              console.log(`✅ SetUp: Monthly limit OK - proceeding with normal schedule processing`)
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
              
              // RESPECT manual override - if main_status is OFF, don't override it
              if (currentMainStatus === 'OFF') {
                console.log(`SetUp: Device ${outletKey} has main_status = 'OFF' - respecting manual override, skipping schedule check`)
                continue
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
                  console.log(`🔒 SetUp: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to individual daily limit exceeded (monthly limit also exceeded)`)
                } else if (shouldBeActive) {
                  newControlState = 'on' // Allow ON if schedule says ON and daily limit OK
                  console.log(`✅ SetUp: AUTOMATIC UPDATE - Allowing ${outletKey} ON (schedule says ON, individual daily limit OK despite monthly limit exceeded)`)
                }
              } else if (isInCombinedGroup && !monthlyLimitExceeded) {
                // For devices in combined group when monthly limit is OK:
                // ONLY check monthly limit - DO NOT check individual daily limit
                // The combined monthly limit takes precedence over individual limits
                const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, combinedLimitInfo)
                if (!monthlyLimitCheck.canTurnOn) {
                  newControlState = 'off' // Force OFF if monthly limit exceeded
                  console.log(`🔒 SetUp: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to monthly limit exceeded`)
                } else if (shouldBeActive) {
                  newControlState = 'on' // Allow ON if schedule says ON and monthly limit OK
                  console.log(`✅ SetUp: AUTOMATIC UPDATE - Allowing ${outletKey} ON (schedule says ON, monthly limit OK - individual daily limit ignored for combined group)`)
                }
              } else {
                // For devices NOT in combined group:
                // Only check individual daily limit
                const isDailyLimitExceeded = checkDailyLimit(deviceData)
                if (isDailyLimitExceeded) {
                  newControlState = 'off' // Force OFF if daily limit exceeded
                  console.log(`🔒 SetUp: AUTOMATIC UPDATE - Forcing ${outletKey} OFF due to daily limit exceeded`)
                } else if (shouldBeActive) {
                  newControlState = 'on' // Allow ON if schedule says ON and daily limit OK
                  console.log(`✅ SetUp: AUTOMATIC UPDATE - Allowing ${outletKey} ON (schedule says ON, daily limit OK)`)
                }
              }
              
              console.log(`SetUp: Final status determination for ${outletKey}:`, {
                shouldBeActive: shouldBeActive,
                newControlState: newControlState,
                currentControlState: currentControlState,
                isInCombinedGroup: isInCombinedGroup,
                monthlyLimitExceeded: monthlyLimitExceeded,
                needsUpdate: currentControlState !== newControlState
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                console.log(`SetUp: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                  device: newControlState
                })
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
              console.log(`SetUp: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check power limit (daily energy limit) - Copy from ActiveDevice.tsx
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Get today's total energy consumption from daily_logs
                const today = new Date()
                const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
                const todayLogs = deviceData?.daily_logs?.[todayDateKey]
                const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
                
                console.log(`SetUp: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  powerLimitRaw: powerLimit,
                  todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
                  todayTotalEnergyRaw: todayTotalEnergy,
                  todayDateKey: todayDateKey,
                  exceedsLimit: todayTotalEnergy >= powerLimit,
                  comparison: `${todayTotalEnergy} >= ${powerLimit} = ${todayTotalEnergy >= powerLimit}`,
                  currentControlState: currentControlState,
                  isInCombinedGroup: isInCombinedGroup
                })
                
                // If today's energy exceeds power limit, turn off the device
                if (todayTotalEnergy >= powerLimit) {
                  console.log(`SetUp: POWER LIMIT EXCEEDED - Turning OFF ${outletKey} (${(todayTotalEnergy * 1000).toFixed(3)}W >= ${(powerLimit * 1000)}W)`)
                  
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Also turn off main status to prevent immediate re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`SetUp: Device ${outletKey} turned OFF due to power limit exceeded`)
                }
              }
            } else {
              console.log(`SetUp: Device ${outletKey} is in combined group - skipping individual daily limit check (monthly limit takes precedence)`)
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
          await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
        }
      } catch (error) {
        console.error('SetUp: Error in monthly limit check:', error)
      }
    }
    
    // DISABLED: All immediate checks to prevent conflicts with centralized Schedule.tsx
    // checkMonthlyLimits()
    // checkScheduleAndUpdateDevices()
    // checkPowerLimitsAndTurnOffDevices()
    
    // Only run power limit check (no conflicts with schedule)
    checkPowerLimitsAndTurnOffDevices()
    
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
            const currentMainStatus = deviceData.relay_control?.main_status || 'ON'
            
            console.log(`Current state: control=${currentControlState}, main_status=${currentMainStatus}`)
            
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
            const mainStatus = device.relay_control?.main_status || 'ON'
            console.log(`${outletKey}: control=${controlState}, main_status=${mainStatus}`)
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
    
    // HIERARCHY: Set up intervals in priority order
    // DISABLED: Monthly limit check interval to prevent conflicts with schedule logic
    // const monthlyLimitInterval = setInterval(checkMonthlyLimits, 3000) // 3 seconds - HIGHEST PRIORITY
    
    // 2. Schedule check - SECOND PRIORITY (every 10 seconds, but respects monthly limits)
    // DISABLED: Schedule checking is now centralized in Schedule.tsx to prevent conflicts
    // const scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds
    
    // 3. Power limit check - THIRD PRIORITY (every 5 seconds, but respects monthly limits)
    const powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 5000) // 5 seconds
    
    // Cleanup intervals on unmount
    return () => {
      // clearInterval(scheduleInterval) // Disabled
      clearInterval(powerLimitInterval)
      // clearInterval(monthlyLimitInterval) // Disabled
      
      // Cleanup auto-turnoff timers
      Object.values(autoTurnoffTimers).forEach(timer => {
        if (timer) {
          clearTimeout(timer)
        }
      })
    }
  }, [combinedLimitInfo])

  // Real-time monthly limit monitoring
  useEffect(() => {
    if (!combinedLimitInfo.enabled || combinedLimitInfo.selectedOutlets.length === 0) {
      console.log('🚫 Monthly limit monitoring disabled - no combined limit set')
      return
    }
    
    console.log('🔍 Starting real-time monthly limit monitoring for outlets:', combinedLimitInfo.selectedOutlets)

    const devicesRef = ref(realtimeDb, 'devices')
    
    const unsubscribe = onValue(devicesRef, async (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val()
        console.log('📡 Real-time monthly limit check triggered by Firebase data change')
        
        // Use debounced monthly limit check
        const now = Date.now()
        if (now - lastMonthlyLimitCheck >= MONTHLY_LIMIT_DEBOUNCE_MS) {
          setLastMonthlyLimitCheck(now)
          await checkCombinedMonthlyLimit(data, combinedLimitInfo)
        } else {
          console.log('⏳ Real-time monthly limit check debounced')
        }
      }
    })

    return () => {
      console.log('🛑 Stopping monthly limit monitoring')
      off(devicesRef, 'value', unsubscribe)
    }
  }, [combinedLimitInfo])

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
      
      // Check if trying to turn ON a device without power limit or exceeding limit
      if (newStatus === 'ON') {
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
                  const outletKey = outletName.replace(' ', '_')
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
        
        // Only check individual daily limit if:
        // 1. Device is NOT in a combined group, OR
        // 2. Device was in a combined group but monthly limit was exceeded and removal failed
        if (!isInCombinedGroup) {
          // Get device data from Firebase to check today's energy consumption
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
          
          // Get today's total energy consumption from daily_logs
          const today = new Date()
          const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
          const todayLogs = deviceData?.daily_logs?.[todayDateKey]
          const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
          
          console.log(`SetUp: Power limit check for ${outletKey}:`, {
            powerLimit: `${(powerLimit * 1000)}W`,
            todayTotalEnergy: `${(todayTotalEnergy * 1000)}W`,
            todayDateKey: todayDateKey,
            exceedsLimit: todayTotalEnergy >= powerLimit,
            isInCombinedGroup: isInCombinedGroup,
            monthlyLimitOK: monthlyLimitCheck.canTurnOn
          })
          
          // Check if today's total energy consumption exceeds the power limit
          if (todayTotalEnergy >= powerLimit) {
            const currentTime = new Date().toLocaleTimeString()
            const currentDate = new Date().toLocaleDateString()
            
            // Show warning that device cannot be turned ON due to power limit exceeded
            setNoPowerLimitModal({
              isOpen: true,
              device: {
                ...device,
                // Add additional info for the modal using type assertion
                ...(device as any),
                todayTotalEnergy: todayTotalEnergy,
                powerLimit: powerLimit,
                currentDate: currentDate,
                currentTime: currentTime
              }
            })
            return
          }
        } else {
          console.log(`SetUp: Skipping individual daily limit check for ${outletKey} - device is in combined group with monthly limit OK`)
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

  const handleSaveCombinedLimit = async (data: { selectedOutlets: string[]; combinedLimit: number; deviceControl: string; enableScheduling: boolean }) => {
    try {
      console.log('Saving combined limit:', data)
      
      // IMPORTANT: Handle devices that were REMOVED from combined group FIRST
      // Get current combined limit settings BEFORE updating to compare with new settings
      const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
      const currentCombinedLimitSnapshot = await get(combinedLimitRef)
      
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
          console.log('🔒 Devices removed from combined group, turning them OFF:', removedOutlets)
          
          // Turn OFF all devices that were removed from combined group
          for (const outletName of removedOutlets) {
            // Handle both formats: "Outlet 1" and "Outlet_1"
            const outletKey = outletName.includes(' ') ? outletName.replace(' ', '_') : outletName
            
            console.log(`🔧 Processing removal: "${outletName}" -> "${outletKey}"`)
            
            try {
              const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
              await update(controlRef, { device: 'off' })
              
              // Also set main_status to OFF to prevent automatic turn-on
              const relayControlRef = ref(realtimeDb, `devices/${outletKey}/relay_control`)
              await update(relayControlRef, { main_status: 'OFF' })
              
              console.log(`🔒 SetUp: Successfully turned OFF ${outletKey} after removal from combined group (now subject to individual daily limits)`)
            } catch (error) {
              console.error(`❌ Error turning off removed device ${outletKey}:`, error)
            }
          }
        } else {
          console.log('ℹ️ No devices were removed from combined group')
        }
      }
      
      // Save combined limit settings to database
      await update(combinedLimitRef, {
        enabled: true,
        selected_outlets: data.selectedOutlets,
        combined_limit_watts: data.combinedLimit === 0 ? "No Limit" : data.combinedLimit,
        device_control: data.deviceControl,
        scheduling_only: data.combinedLimit === 0,
        created_at: new Date().toISOString(),
        created_by: 'user' // You can replace this with actual user info
      })
      
      // Update device control for all selected outlets
      console.log('Updating device control for selected outlets:', data.selectedOutlets)
      for (const outletName of data.selectedOutlets) {
        const outletKey = outletName.replace(' ', '_')
        const controlRef = ref(realtimeDb, `devices/${outletKey}/control`)
        
        try {
          await update(controlRef, {
            device: data.deviceControl
          })
          
          // Also update relay_control for consistency
          const relayControlRef = ref(realtimeDb, `devices/${outletKey}/relay_control`)
          await update(relayControlRef, {
            main_status: data.deviceControl === 'on' ? 'ON' : 'OFF'
          })
          
          console.log(`Updated device control for ${outletKey} to ${data.deviceControl}`)
        } catch (error) {
          console.error(`Error updating device control for ${outletKey}:`, error)
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
          const outletKey = outletName.replace(' ', '_')
          
          try {
            // Clear schedule data
            const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
            await update(scheduleRef, {
              timeRange: null,
              startTime: null,
              endTime: null,
              days: null,
              enabled: false
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
          const outletKey = outletName.replace(' ', '_')
          
          try {
            // Enable power scheduling flag
            const officeInfoRef = ref(realtimeDb, `devices/${outletKey}/office_info`)
            await update(officeInfoRef, {
              enable_power_scheduling: true
            })
            
            console.log(`Enabled scheduling for ${outletKey}`)
          } catch (error) {
            console.error(`Error enabling scheduling for ${outletKey}:`, error)
          }
        }
      }
      
      console.log('Combined limit, device control, and scheduling data saved successfully')
      
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
        combinedLimit: data.combinedLimit
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
  useEffect(() => {
    const fetchCombinedLimitInfo = async () => {
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const snapshot = await get(combinedLimitRef)
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('SetUp: Fetched combined limit data:', data)
          setCombinedLimitInfo({
            enabled: data.enabled || false,
            selectedOutlets: data.selected_outlets || [],
            combinedLimit: data.combined_limit_watts || 0
          })
        } else {
          console.log('SetUp: No combined limit settings found in database')
        }
      } catch (error) {
        console.error('Error fetching combined limit info:', error)
      }
    }

    fetchCombinedLimitInfo()
  }, [])

  // Also refetch combined limit info when devices change (in case combined limit was set elsewhere)
  useEffect(() => {
    const fetchCombinedLimitInfo = async () => {
      try {
        const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
        const snapshot = await get(combinedLimitRef)
        
        if (snapshot.exists()) {
          const data = snapshot.val()
          console.log('SetUp: Refetching combined limit data:', data)
          setCombinedLimitInfo({
            enabled: data.enabled || false,
            selectedOutlets: data.selected_outlets || [],
            combinedLimit: data.combined_limit_watts || 0
          })
        }
      } catch (error) {
        console.error('Error refetching combined limit info:', error)
      }
    }

    // Refetch every 30 seconds to catch any updates (reduced frequency to prevent input interference)
    const interval = setInterval(fetchCombinedLimitInfo, 30000)
    
    return () => clearInterval(interval)
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
        const today = new Date()
        const todayDateKey = `day_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}_${String(today.getDate()).padStart(2, '0')}`
        
        // Calculate combined power consumption
        let totalCombinedPower = 0
        const activeDevices: string[] = []
        
        selectedOutlets.forEach((outletName: string) => {
          const outletKey = outletName.replace(' ', '_')
          const outletData = devicesData[outletKey]
          
          if (outletData) {
            // Get today's total energy consumption
            const todayLogs = outletData.daily_logs?.[todayDateKey]
            const todayTotalEnergy = todayLogs?.total_energy || 0 // This is in kW
            const todayTotalEnergyWatts = todayTotalEnergy * 1000 // Convert to watts
            
            totalCombinedPower += todayTotalEnergyWatts
            
            // Check if device is currently active
            const controlState = outletData.control?.device || 'off'
            if (controlState === 'on') {
              activeDevices.push(outletKey)
            }
          }
        })
        
        console.log(`SetUp: Combined power limit check:`, {
          selectedOutlets,
          totalCombinedPower: `${totalCombinedPower.toFixed(3)}W`,
          combinedLimitWatts: `${combinedLimitWatts}W`,
          exceedsLimit: totalCombinedPower >= combinedLimitWatts,
          activeDevices: activeDevices.length
        })
        
        // If combined power exceeds limit, turn off all active devices
        if (totalCombinedPower >= combinedLimitWatts && activeDevices.length > 0) {
          console.log(`SetUp: COMBINED POWER LIMIT EXCEEDED - Turning OFF all active devices (${totalCombinedPower.toFixed(3)}Wh >= ${combinedLimitWatts}Wh)`)
          
          // Turn off all active devices
          for (const outletKey of activeDevices) {
            try {
              await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                device: 'off'
              })
              
              // Also turn off main status to prevent immediate re-activation
              await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                main_status: 'OFF'
              })
              
              console.log(`SetUp: Device ${outletKey} turned OFF due to combined power limit exceeded`)
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
    
    // Force refresh the data from Firebase to get updated power limits
    const devicesRef = ref(realtimeDb, 'devices')
    
    // Get the latest data from Firebase
    onValue(devicesRef, (snapshot) => {
      const data = snapshot.val()
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
            const powerLimit = outlet.relay_control?.auto_cutoff?.power_limit || 0
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
            
            // Convert status to match Device interface with main status consideration
            const mainStatus = outlet.relay_control?.main_status || 'ON'
            let deviceStatus: 'Active' | 'Inactive' | 'Warning' = 'Inactive'
            
            if (mainStatus === 'OFF') {
              deviceStatus = 'Inactive'
            } else if (status === 'ON') {
              if (powerLimit >= 0 && (powerUsage * 1000) >= (powerLimit * 1000)) {
                deviceStatus = 'Inactive'
              } else if (powerLimit > 0 && (powerLimit * 1000) - (powerUsage * 1000) <= 50) {
                deviceStatus = 'Warning'
              } else {
                deviceStatus = 'Active'
              }
            }

            const deviceData: Device = {
              id: String(deviceId).padStart(3, '0'),
              outletName: outletKey,
              officeRoom: officeInfo,
              appliances: outlet.office_info?.appliance || 'Unassigned',
              enablePowerScheduling: outlet.office_info?.enable_power_scheduling || false,
              limit: `${(powerLimit * 1000).toFixed(3)} Wh`,
              powerUsage: powerUsageDisplay, // Use the new display format
              todayUsage: todayEnergyDisplay, // Use the new display format
              monthUsage: calculateMonthlyEnergy(outlet), // Calculate monthly energy
              status: deviceStatus
            }
            devicesArray.push(deviceData)
            deviceId++
          }
        })

        setDevices(devicesArray)
        
        // Check combined monthly limits after setting devices
        checkCombinedMonthlyLimit(data, combinedLimitInfo)
      }
    }, { onlyOnce: true }) // Only get data once for immediate update
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
      'Idle': 'status-idle'
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

        <div className="devices-table-container">
          <table className="devices-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>OUTLET NAME</th>
                <th>OFFICE / ROOM</th>
                <th>APPLIANCES</th>
                <th>LIMIT</th>
                <th>CURRENT POWER USAGE</th>
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
                      // Check if device is using combined limit (handle both "Outlet_1" and "Outlet 1" formats)
                      const deviceOutletName = device.outletName
                      const deviceOutletNameWithSpace = deviceOutletName.replace('_', ' ')
                      const isUsingCombinedLimit = combinedLimitInfo.enabled && 
                        (combinedLimitInfo.selectedOutlets.includes(deviceOutletName) || 
                         combinedLimitInfo.selectedOutlets.includes(deviceOutletNameWithSpace))
                      
                      console.log(`SetUp: Checking device ${device.outletName}:`, {
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
                  <td className="power-usage">
                    {device.powerUsage}
                  </td>
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
