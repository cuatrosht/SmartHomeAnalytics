import { useState, useEffect, useMemo, memo } from 'react'
import { ref, onValue, off, update, get } from 'firebase/database'
import { realtimeDb } from '../firebase/config'
import { logDeviceControlActivity, logSystemActivity } from '../utils/deviceLogging'
import './ActiveDevice.css'

// Function to format schedule days to M, T, W, TH, F, SAT, SUN format
const formatScheduleDays = (frequency: string): string => {
  if (!frequency || frequency.toLowerCase() === 'daily') {
    return 'Daily'
  }
  
  // Map of day names to abbreviations
  const dayAbbreviations: { [key: string]: string } = {
    'monday': 'M',
    'tuesday': 'T',
    'wednesday': 'W',
    'thursday': 'TH',
    'friday': 'F',
    'saturday': 'SAT',
    'sunday': 'SUN',
    'mon': 'M',
    'tue': 'T',
    'wed': 'W',
    'thu': 'TH',
    'fri': 'F',
    'sat': 'SAT',
    'sun': 'SUN',
    'm': 'M',
    't': 'T',
    'w': 'W',
    'th': 'TH',
    'f': 'F',
    's': 'SAT'
  }
  
  // Split by comma and map to abbreviations
  if (!frequency || typeof frequency !== 'string') {
    return ''
  }
  
  const days = frequency.split(',').map(day => {
    if (!day || typeof day !== 'string') return ''
    const trimmedDay = day.trim().toLowerCase()
    return dayAbbreviations[trimmedDay] || day.trim()
  }).filter(day => day.length > 0)
  
  return days.join(', ')
}

// Function to calculate monthly energy for a device
const calculateMonthlyEnergy = (outlet: any): string => {
  try {
    const formatNum = (num: number, decimals: number = 3): string => {
      try {
        if (typeof num !== 'number' || isNaN(num)) {
          return '0.' + '0'.repeat(decimals)
        }
        const validDecimals = typeof decimals === 'number' && !isNaN(decimals) && decimals >= 0 ? decimals : 3
        return num.toLocaleString('en-US', {
          minimumFractionDigits: validDecimals,
          maximumFractionDigits: validDecimals
        })
      } catch (error) {
        console.error('Error formatting number:', error)
        return '0.' + '0'.repeat(decimals || 3)
      }
    }

    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    
    // Get all days in the current month
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate()
    let totalMonthlyEnergy = 0
    
    // Sum up energy for all days in the current month
    if (outlet && outlet.daily_logs && typeof outlet.daily_logs === 'object') {
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
        const dayData = outlet.daily_logs[dateKey]
        if (dayData && typeof dayData === 'object' && dayData.total_energy) {
          const energy = typeof dayData.total_energy === 'number' ? dayData.total_energy : 0
          if (!isNaN(energy) && energy >= 0) {
            totalMonthlyEnergy += energy // Already in kW from database
          }
        }
      }
    }
    
    // Convert to watts and format
    return `${formatNum(totalMonthlyEnergy * 1000)} W`
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
    
    // Check if this device is part of the combined limit group (normalize names for comparison)
    const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
    const isInCombinedGroup = combinedLimitInfo.selectedOutlets.some((selectedOutlet: string) => {
      const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
      return normalizedSelected === normalizedOutletKey || 
             selectedOutlet === outletKey ||
             selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
    })
    
    if (!isInCombinedGroup) {
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
    
    console.log('ActiveDevice: Monthly limit check before turn ON:', {
      outletKey,
      normalizedOutletKey,
      isInCombinedGroup,
      totalMonthlyEnergy,
      combinedLimitWatts,
      selectedOutlets: combinedLimitInfo.selectedOutlets,
      wouldExceed: totalMonthlyEnergy >= combinedLimitWatts
    })
    
    // Skip limit check if "No Limit" is set
    if (combinedLimitWatts === "No Limit") {
      return { canTurnOn: true, reason: 'No monthly limit set', currentMonthlyEnergy: totalMonthlyEnergy, combinedLimit: combinedLimitWatts }
    }
    
    // Check if turning ON this device would exceed the monthly limit
    if (totalMonthlyEnergy >= combinedLimitWatts) {
      return {
        canTurnOn: false,
        reason: `Monthly limit exceeded: ${(totalMonthlyEnergy / 1000).toFixed(3)} kW / ${(combinedLimitWatts / 1000).toFixed(3)} kW`,
        currentMonthlyEnergy: totalMonthlyEnergy,
        combinedLimit: combinedLimitWatts
      }
    }
    
    return { canTurnOn: true }
  } catch (error) {
    console.error('ActiveDevice: Error checking monthly limit before turn ON:', error)
    return { canTurnOn: true } // Allow turn ON if there's an error
  }
}

// Helper function to get department-specific combined limit path
const getDepartmentCombinedLimitPath = (department: string) => {
  if (!department) return 'combined_limit_settings'
  return `combined_limit_settings/${department}`
}

// Function to check and enforce combined monthly limits (with override support)
const checkCombinedMonthlyLimit = async (devicesData: any, combinedLimitInfo: any) => {
  try {
    console.log('🔍 ActiveDevice: Monthly limit check - Input data:', {
      combinedLimitInfo,
      devicesDataKeys: Object.keys(devicesData || {}),
      enabled: combinedLimitInfo?.enabled,
      selectedOutlets: combinedLimitInfo?.selectedOutlets,
      combinedLimit: combinedLimitInfo?.combinedLimit,
      department: combinedLimitInfo?.department
    })
    
    if (!combinedLimitInfo?.enabled || !combinedLimitInfo?.selectedOutlets || combinedLimitInfo.selectedOutlets.length === 0) {
      console.log('🚫 ActiveDevice: Monthly limit check skipped - not enabled or no outlets selected')
      return
    }
    
    if (!combinedLimitInfo?.department) {
      console.log('🚫 ActiveDevice: Monthly limit check skipped - no department specified')
      return
    }
    
    const totalMonthlyEnergy = calculateCombinedMonthlyEnergy(devicesData, combinedLimitInfo.selectedOutlets)
    const combinedLimitWatts = combinedLimitInfo.combinedLimit
    
    // CRITICAL: Handle "No Limit" case - always allow devices to be ON
    if (String(combinedLimitWatts) === "No Limit" || combinedLimitWatts === 0 || combinedLimitWatts <= 0) {
      console.log('✅ ActiveDevice: Combined limit is set to "No Limit" or 0 - setting device_control to "on"')
      const departmentPath = getDepartmentCombinedLimitPath(combinedLimitInfo.department)
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
        console.log(`✅ ActiveDevice: Set ${departmentPath}/device_control='on' (No Limit set)`)
      }
      return
    }
    
    console.log('📊 ActiveDevice: Monthly limit check results:', {
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
      const departmentPath = getDepartmentCombinedLimitPath(combinedLimitInfo.department)
      const combinedLimitRef = ref(realtimeDb, departmentPath)
      const currentSettings = await get(combinedLimitRef)
      const currentDeviceControl = currentSettings.val()?.device_control
      
      // If device_control is already 'off', skip all updates to prevent spam
      if (currentDeviceControl === 'off') {
        console.log(`✅ ActiveDevice: Monthly limit already enforced (device_control='off') - skipping update to prevent spam`)
        return
      }
      
      console.log('🚨 ActiveDevice: MONTHLY LIMIT EXCEEDED!')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W >= Limit: ${combinedLimitWatts}W`)
      console.log('🔒 TURNING OFF ALL DEVICES IN THE GROUP...')
      
      // Turn off all devices in the combined limit group (respecting override/bypass mode)
      const turnOffPromises = combinedLimitInfo.selectedOutlets.map(async (outletKey: string) => {
        try {
          // Convert display format to Firebase format - replace ALL spaces/special chars
          const firebaseKey = outletKey.replace(/\s+/g, '_').replace(/'/g, '')
          const deviceData = devicesData[firebaseKey]
          
          console.log(`🔍 ActiveDevice: Processing ${outletKey} -> Firebase key: ${firebaseKey}`)
          
          if (!deviceData) {
            console.error(`❌ ActiveDevice: Device ${firebaseKey} not found in Firebase!`)
            return { outletKey, success: false, error: 'Device not found' }
          }
          
          // RESPECT override/bypass mode - if main_status is 'ON', skip turning off (device is manually overridden)
          const currentMainStatus = deviceData?.relay_control?.main_status || 'ON'
          if (currentMainStatus === 'ON') {
            console.log(`⚠️ ActiveDevice: Skipping ${outletKey} - main_status is ON (bypass mode/override active)`)
            return { outletKey, success: true, skipped: true, reason: 'Bypass mode active' }
          }
          
          // Turn off device control
          const controlRef = ref(realtimeDb, `devices/${firebaseKey}/control`)
          await update(controlRef, { device: 'off' })
          console.log(`✅ ActiveDevice: Set control.device='off' for ${firebaseKey}`)
          
          // Turn off status to prevent immediate re-activation
          const statusRef = ref(realtimeDb, `devices/${firebaseKey}`)
          await update(statusRef, { status: 'OFF' })
          console.log(`✅ ActiveDevice: Set status='OFF' for ${firebaseKey}`)
          
          console.log(`✅ ActiveDevice: COMPLETELY TURNED OFF ${outletKey} (${firebaseKey}) due to monthly limit`)
          
          return { outletKey, success: true }
        } catch (error) {
          console.error(`❌ ActiveDevice: FAILED to turn off ${outletKey}:`, error)
          return { outletKey, success: false, error }
        }
      })
      
      // Wait for all turn-off operations to complete
      const results = await Promise.all(turnOffPromises)
      const successCount = results.filter(r => r.success && !r.skipped).length
      const skippedCount = results.filter(r => r.skipped).length
      const failCount = results.filter(r => !r.success && !r.skipped).length
      
      // CRITICAL: Set combined_limit_settings/{department}/device_control to "off" to prevent devices from turning back ON
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
      console.log(`🔒 ActiveDevice: Set ${departmentPath}/device_control='off' to prevent re-activation`)
      } else {
        console.log(`✅ ActiveDevice: device_control already 'off' - skipping update to prevent spam`)
      }
      
      console.log(`🔒 ActiveDevice: MONTHLY LIMIT ENFORCEMENT COMPLETE: ${successCount} turned off, ${skippedCount} skipped (bypass mode), ${failCount} failed`)
    } else {
      console.log('✅ ActiveDevice: Monthly limit not exceeded - devices can remain active')
      console.log(`📊 Current: ${totalMonthlyEnergy.toFixed(3)}W < Limit: ${combinedLimitWatts}W`)
      
      // Set combined_limit_settings/{department}/device_control to "on" to allow devices to turn ON
      const departmentPath = getDepartmentCombinedLimitPath(combinedLimitInfo.department)
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
        console.log(`✅ ActiveDevice: Set ${departmentPath}/device_control='on' (limit not exceeded) - allowing devices to turn ON`)
      } else {
        console.log(`✅ ActiveDevice: device_control already 'on' and enforcement_reason already cleared - no update needed`)
      }
    }
  } catch (error) {
    console.error('❌ ActiveDevice: Error checking combined monthly limit:', error)
  }
}

// Memoized Modal Components to prevent blinking during realtime updates
const SuccessModal = memo(({ successModal, setModalOpen, setSuccessModal }: {
  successModal: { isOpen: boolean; deviceName: string; action: string };
  setModalOpen: (open: boolean) => void;
  setSuccessModal: (modal: { isOpen: boolean; deviceName: string; action: string }) => void;
}) => {
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
})

const BypassModal = memo(({ bypassModal, setModalOpen, setBypassModal, toggleDeviceStatus, userRole = 'Coordinator' }: {
  bypassModal: { isOpen: boolean; device: any; reason: string };
  setModalOpen: (open: boolean) => void;
  setBypassModal: (modal: { isOpen: boolean; device: any; reason: string }) => void;
  toggleDeviceStatus: (deviceId: string, bypassConfirmed: boolean) => void;
  userRole?: 'Coordinator' | 'admin';
}) => {
  if (!bypassModal.isOpen || !bypassModal.device) return null

  const device = bypassModal.device

  const handleBypassConfirm = () => {
    setModalOpen(false)
    setBypassModal({ isOpen: false, device: null, reason: '' })
    // Call toggle with bypass confirmed
    toggleDeviceStatus(device.id, true)
  }

  const handleBypassCancel = () => {
    setModalOpen(false)
    setBypassModal({ isOpen: false, device: null, reason: '' })
  }

  return (
    <div className="modal-overlay warning-overlay" onClick={handleBypassCancel}>
      <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
        <div className="warning-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2"/>
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="#f59e0b"/>
          </svg>
        </div>
        {userRole === 'admin' ? (
          <>
            <h3>Bypass Restrictions?</h3>
            <p><strong>"{device.outletName}" has restrictions that prevent it from being turned ON.</strong></p>
            <div className="warning-details">
              <div className="warning-stat">
                <span className="label">Device:</span>
                <span className="value">{device.outletName}</span>
              </div>
              <div className="warning-stat">
                <span className="label">Location:</span>
                <span className="value">{device.officeRoom}</span>
              </div>
              <div className="warning-stat">
                <span className="label">Restriction:</span>
                <span className="value">{bypassModal.reason}</span>
              </div>
            </div>
            <p className="warning-message">
              Do you want to bypass these restrictions and turn ON this device anyway?
            </p>
          </>
        ) : (
          <>
            <h3>Device Restrictions Active</h3>
            <p><strong>"{device.outletName}" cannot be turned ON due to active restrictions.</strong></p>
            <div className="warning-details">
              <div className="warning-stat">
                <span className="label">Device:</span>
                <span className="value">{device.outletName}</span>
              </div>
              <div className="warning-stat">
                <span className="label">Location:</span>
                <span className="value">{device.officeRoom}</span>
              </div>
              <div className="warning-stat">
                <span className="label">Restriction:</span>
                <span className="value">{bypassModal.reason}</span>
              </div>
            </div>
            <p className="warning-message">
              As a Coordinator, you cannot bypass these restrictions. Only GSO can override device restrictions.
            </p>
          </>
        )}
        {userRole === 'admin' && (
          <div className="bypass-info">
            <div className="bypass-info-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" fill="#dbeafe" stroke="#3b82f6" strokeWidth="2"/>
                <path d="M12 16v-4m0-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" fill="#3b82f6"/>
              </svg>
              <span className="bypass-info-title">Important Notice</span>
            </div>
            <p className="bypass-info-text">
              When you bypass restrictions and turn ON this device, the **main_status** will be set to ON. 
              This will **enable manual override mode** for this device. 
              The device will remain ON until manually turned off, and automatic systems will not interfere with it.
            </p>
          </div>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="btn-secondary"
            onClick={handleBypassCancel}
          >
            {userRole === 'admin' ? 'Cancel' : 'Close'}
          </button>
          {userRole === 'admin' && (
            <button
              type="button"
              className="btn-primary"
              onClick={handleBypassConfirm}
            >
              Bypass & Turn ON
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

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
  status: 'Active' | 'Inactive' | 'Idle' | 'UNPLUG'
  todayUsage: string
  monthUsage?: string
  currentAmpere: string
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
    disabled_by_unplug?: boolean
    basis?: number
  }
}

interface ActiveDeviceProps {
  onNavigate?: (key: string) => void
  userRole?: 'Coordinator' | 'admin'
}

export default function ActiveDevice({ onNavigate, userRole = 'Coordinator' }: ActiveDeviceProps) {
  // Helper function to format numbers with commas
  const formatNumber = (num: number, decimals: number = 3): string => {
    try {
      // Validate input
      if (typeof num !== 'number' || isNaN(num)) {
        return '0.' + '0'.repeat(decimals)
      }
      
      // Ensure decimals is a valid number
      const validDecimals = typeof decimals === 'number' && !isNaN(decimals) && decimals >= 0 ? decimals : 3
      
      return num.toLocaleString('en-US', {
        minimumFractionDigits: validDecimals,
        maximumFractionDigits: validDecimals
      })
    } catch (error) {
      console.error('Error formatting number:', error)
      // Return safe default
      return '0.' + '0'.repeat(decimals || 3)
    }
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
  const [currentRate, setCurrentRate] = useState(9.3885) // Default fallback rate
  const [electricityRateData, setElectricityRateData] = useState<{
    rate: number;
    unit: string;
    updated_at: string;
    updated_by: string;
  } | null>(null)
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

  // Bypass confirmation modal state
  const [bypassModal, setBypassModal] = useState<{
    isOpen: boolean;
    device: Device | null;
    reason: string;
  }>({
    isOpen: false,
    device: null,
    reason: ''
  })

  // Idle detection state
  const [deviceActivity, setDeviceActivity] = useState<Record<string, {
    lastEnergyUpdate: number;
    lastControlUpdate: number;
    lastTotalEnergy: number;
    lastControlState: string;
    lastStateHash: string;
  }>>({})

  // Unplug detection state - track timestamps for each device
  const [deviceTimestamps, setDeviceTimestamps] = useState<Record<string, {
    lastTimestamp: string;
    lastTimestampTime: number;
    basis: number;
    lastChecked: number;
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

  // Fetch history data when modal opens or timeSegment changes
  useEffect(() => {
    if (historyModal.isOpen && historyModal.device) {
      try {
        fetchHistoryData(historyModal.device, timeSegment)
      } catch (error) {
        console.error('Error fetching history data on modal open:', error)
        setHistoryData({ totalEnergy: 0, totalCost: 0, dailyData: [] })
      }
    }
  }, [historyModal.isOpen, historyModal.device, timeSegment])

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
    if (!office || typeof office !== 'string' || office === 'Unassigned') {
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
      if (!outletKey || typeof outletKey !== 'string') {
        console.error('Invalid outletKey provided to calculateOutletCost')
        return { totalEnergy: 0, totalCost: 0, dailyData: [] }
      }

      const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
      const snapshot = await get(deviceRef)
      
      if (!snapshot.exists()) {
        return { totalEnergy: 0, totalCost: 0, dailyData: [] }
      }

      const deviceData = snapshot.val()
      if (!deviceData || typeof deviceData !== 'object') {
        return { totalEnergy: 0, totalCost: 0, dailyData: [] }
      }

      const dailyLogs = deviceData.daily_logs || {}
      
      if (!dailyLogs || typeof dailyLogs !== 'object') {
        return { totalEnergy: 0, totalCost: 0, dailyData: [] }
      }

      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      const currentDay = now.getDate()
      
      // Validate currentRate
      const rate = currentRate && currentRate > 0 ? currentRate : 9.3885
      
      let filteredData: Array<{ date: string; energy: number; cost: number }> = []
      let totalEnergy = 0
      let totalCost = 0
      
      // Filter data based on time segment
      try {
        Object.keys(dailyLogs).forEach(dateKey => {
          try {
            if (!dateKey || typeof dateKey !== 'string' || !dateKey.includes('_')) {
              return // Skip invalid dateKey
            }
            const dateParts = dateKey.split('_')
            if (dateParts.length < 4) {
              return // Skip invalid date format
            }
            const [_, year, month, day] = dateParts
            const logYear = parseInt(year, 10)
            const logMonth = parseInt(month, 10)
            const logDay = parseInt(day, 10)
            
            // Validate parsed values
            if (isNaN(logYear) || isNaN(logMonth) || isNaN(logDay)) {
              return // Skip invalid date values
            }
            
            let includeData = false
            
            switch (timeSegment) {
              case 'Day':
                includeData = logYear === currentYear && logMonth === currentMonth && logDay === currentDay
                break
              case 'Week':
                // Last 7 days including today
                try {
                  const logDate = new Date(logYear, logMonth - 1, logDay)
                  if (isNaN(logDate.getTime())) {
                    return // Skip invalid date
                  }
                  const daysDiff = Math.floor((now.getTime() - logDate.getTime()) / (1000 * 60 * 60 * 24))
                  includeData = daysDiff >= 0 && daysDiff < 7
                } catch (dateError) {
                  console.error('Error processing date for Week filter:', dateError)
                  return
                }
                break
              case 'Month':
                includeData = logYear === currentYear && logMonth === currentMonth
                break
              case 'Year':
                includeData = logYear === currentYear
                break
              default:
                includeData = false
            }
            
            if (includeData) {
              const dayData = dailyLogs[dateKey]
              if (!dayData || typeof dayData !== 'object') {
                return
              }
              
              const energy = typeof dayData.total_energy === 'number' ? dayData.total_energy : 0 // Energy in kW
              
              // Validate energy value
              if (isNaN(energy) || energy < 0) {
                return
              }
              
              // Calculate cost and truncate to 2 decimal places (no rounding)
              const dailyCost = energy * rate
              const truncatedCost = Math.floor(dailyCost * 100) / 100
              
              // Validate date string before pushing
              const dateString = `${logYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const testDate = new Date(dateString)
              if (isNaN(testDate.getTime())) {
                return // Skip invalid date string
              }
              
              filteredData.push({
                date: dateString,
                energy,
                cost: truncatedCost
              })
              
              totalEnergy += energy
              totalCost += truncatedCost
            }
          } catch (itemError) {
            console.error('Error processing date key:', dateKey, itemError)
            // Continue processing other items
          }
        })
      } catch (filterError) {
        console.error('Error filtering daily logs:', filterError)
        // Return empty data instead of crashing
        return { totalEnergy: 0, totalCost: 0, dailyData: [] }
      }
      
      // Sort by date with error handling
      try {
        filteredData.sort((a, b) => {
          try {
            const dateA = new Date(a.date).getTime()
            const dateB = new Date(b.date).getTime()
            if (isNaN(dateA) || isNaN(dateB)) {
              return 0
            }
            return dateA - dateB
          } catch (sortError) {
            console.error('Error sorting dates:', sortError)
            return 0
          }
        })
      } catch (sortError) {
        console.error('Error in sort operation:', sortError)
        // Continue with unsorted data
      }
      
      // totalCost is already sum of truncated daily costs
      return {
        totalEnergy: isNaN(totalEnergy) ? 0 : totalEnergy,
        totalCost: isNaN(totalCost) ? 0 : totalCost,
        dailyData: Array.isArray(filteredData) ? filteredData : []
      }
    } catch (error) {
      console.error('Error calculating outlet cost:', error)
      // Return safe default values to prevent white screen
      return { totalEnergy: 0, totalCost: 0, dailyData: [] }
    }
  }

  // Fetch history data when modal opens
  const fetchHistoryData = async (device: Device, segment?: 'Day' | 'Week' | 'Month' | 'Year') => {
    try {
      if (!device || !device.outletName) {
        console.error('Invalid device provided to fetchHistoryData')
        setHistoryData({ totalEnergy: 0, totalCost: 0, dailyData: [] })
        return
      }

      const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
      const segmentToUse = segment || timeSegment
      const data = await calculateOutletCost(outletKey, segmentToUse)
      setHistoryData(data)
    } catch (error) {
      console.error('Error fetching history data:', error)
      // Set empty data to prevent white screen
      setHistoryData({ totalEnergy: 0, totalCost: 0, dailyData: [] })
    }
  }

  // Helper function to check if device should be active based on schedule
  // This function determines if the SCHEDULE says the device should be active, regardless of current control state
  const isDeviceActiveBySchedule = (schedule: any, controlState: string, deviceData?: any, skipIndividualLimitCheck?: boolean): boolean => {
    // If no schedule exists, device can be active (use control state as fallback)
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
      
      // Sum up energy for all days in the current month
      for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `day_${currentYear}_${String(currentMonth).padStart(2, '0')}_${String(day).padStart(2, '0')}`
        const dayData = deviceData.daily_logs?.[dateKey]
        if (dayData && dayData.total_energy) {
          totalMonthlyEnergy += dayData.total_energy // Already in kW from database
        }
      }
      
      // If device has a power limit and monthly energy exceeds it, don't activate
      if (powerLimit > 0 && totalMonthlyEnergy >= powerLimit) {
        console.log(`Schedule check: Device ${deviceData.outletName || 'Unknown'} monthly power limit exceeded:`, {
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
          const powerUsageDisplay = `${formatNumber(lifetimeEnergyWatts * 1000)} W`
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
          const todayEnergyDisplay = `${formatNumber(todayEnergyWatts * 1000)} W`
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
            lastStateHash: currentStateHash,
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
                lastStateHash: currentStateHash,
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
          
          // Determine final status - CHECK FOR UNPLUG FIRST (HIGHEST PRIORITY)
          // UNPLUG status takes precedence over Active/Inactive - if device is unplugged, always show UNPLUG
          let deviceStatus: 'Active' | 'Inactive' | 'Idle' | 'UNPLUG'
          
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
          
          // Get current (ampere) from sensor_data - with 2 decimal places
          const currentAmpere = outlet.sensor_data?.current || 0
          const currentAmpereDisplay = `${currentAmpere.toFixed(2)}A`
          
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
              scheduleDays = formatScheduleDays(outlet.schedule.frequency)
            }
          }

          // Calculate monthly energy
          const monthUsageDisplay = calculateMonthlyEnergy(outlet)

          const deviceData: Device = {
            id: String(deviceId).padStart(3, '0'),
            outletName: outletKey.replace('_', ' '),
            appliances: applianceType,
            officeRoom: officeInfo,
            powerUsage: powerUsageDisplay,
            status: deviceStatus,
            todayUsage: todayEnergyDisplay,
            monthUsage: monthUsageDisplay,
            currentAmpere: currentAmpereDisplay,
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

  // Fetch combined limit info - listens to all departments
  useEffect(() => {
    const combinedLimitRef = ref(realtimeDb, 'combined_limit_settings')
    
    // Set up real-time listener for all departments
    const unsubscribe = onValue(combinedLimitRef, (snapshot) => {
      if (snapshot.exists()) {
        const allDepartmentsData = snapshot.val()
        console.log('ActiveDevice: Real-time update - all departments combined limit data:', allDepartmentsData)
        
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
          setCombinedLimitInfo({
            enabled: false,
            selectedOutlets: [],
            combinedLimit: 0,
            device_control: 'on',
            department: ''
          })
        }
      } else {
        console.log('ActiveDevice: No combined limit settings found')
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
      console.error('ActiveDevice: Error listening to combined limit info:', error)
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

  // Real-time scheduler that checks every minute and updates control.device
  // CRITICAL: Include combinedLimitInfo in dependencies so scheduler uses fresh data
  useEffect(() => {
    // Helper function to check if individual device monthly limit is exceeded (returns boolean)
    const checkMonthlyLimit = (deviceData: any): boolean => {
      try {
        const powerLimitRaw = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
        const powerLimit = powerLimitRaw === "No Limit" ? "No Limit" : powerLimitRaw
        if (powerLimit <= 0) return false
        
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
        
        return totalMonthlyEnergy >= powerLimit
      } catch (error) {
        console.error('ActiveDevice: Error checking monthly limit:', error)
        return false
      }
    }
    
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
        
        const totalMonthlyEnergyWh = totalMonthlyEnergy * 1000 // Convert to W
        
        return totalMonthlyEnergyWh >= combinedLimitWatts
      } catch (error) {
        console.error('ActiveDevice: Error checking combined monthly limit:', error)
        return false
      }
    }
    
    const checkScheduleAndUpdateDevices = async () => {
      try {
        // CRITICAL: Wait for combinedLimitInfo to be loaded before running scheduler
        // This prevents incorrect decisions when data isn't ready yet
        if (!combinedLimitInfo) {
          console.log('⏳ ActiveDevice: Waiting for combinedLimitInfo to load before running scheduler')
          return
        }
        
        // CRITICAL: If combined limit is enabled but no outlets selected, skip scheduler
        // This prevents errors when combined limit is partially configured
        if (combinedLimitInfo.enabled && (!combinedLimitInfo.selectedOutlets || combinedLimitInfo.selectedOutlets.length === 0)) {
          console.log('⏳ ActiveDevice: Combined limit enabled but no outlets selected - skipping scheduler')
          return
        }
        
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          
          // CRITICAL: DO NOT call checkCombinedMonthlyLimit here - it's called separately
          // This prevents conflicts with Schedule.tsx and other components
          // Only check limits when actually trying to turn devices ON/OFF
          
          // Use the devices data directly without re-fetching
          const freshDevicesData = devicesData
          console.log('🔄 ActiveDevice: Using device data for schedule check')
          
          const now = new Date()
          const currentTime = now.getHours() * 60 + now.getMinutes()
          const currentDay = now.getDay() // 0 = Sunday, 1 = Monday, etc.
          
          console.log(`ActiveDevice: Real-time scheduler check at ${now.toLocaleTimeString()}:`, {
            currentTime: `${Math.floor(currentTime / 60)}:${String(currentTime % 60).padStart(2, '0')}`,
            currentDay: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay]
          })
          
          for (const [outletKey, outletData] of Object.entries(freshDevicesData)) {
            const deviceData = outletData as FirebaseDeviceData
            
            // Only process devices with schedules and power scheduling enabled
            console.log(`ActiveDevice: Checking device ${outletKey}:`, {
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
                console.log(`⚠️ ActiveDevice: Skipping ${outletKey} - status='OFF' (manually disabled or monthly limit exceeded)`)
                continue
              }
              
              // CRITICAL: Check combined_limit_settings/{department}/device_control FIRST before any other logic
              // If device_control is 'off', respect it and don't try to turn device ON
              // BUT: Only enforce this if the device is actually in the combined group
              const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
              
              // Find which department this device belongs to and if it's in that department's combined limit
              let deviceDepartmentLimit: { department: string; limitInfo: any; device_control?: string } | null = null
              
              // First, get the device's department
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
              
              // Also check old combined limit structure for backward compatibility
              const normalizedOutletKeyForSchedule = outletKey.replace(/_/g, ' ').toLowerCase().trim()
              const isInOldCombinedGroupForSchedule = combinedLimitInfo?.enabled && 
                                                      combinedLimitInfo?.selectedOutlets?.some((selectedOutlet: string) => {
                                                        const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                                                        return normalizedSelected === normalizedOutletKeyForSchedule || 
                                                               selectedOutlet === outletKey ||
                                                               selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                                                      })
              
              const isInAnyCombinedGroup = !!deviceDepartmentLimit || isInOldCombinedGroupForSchedule
              
              // RESPECT disabled_by_unplug - if schedule is disabled by unplug, don't enable it
              if (deviceData.schedule.disabled_by_unplug === true) {
                console.log(`ActiveDevice: Device ${outletKey} is disabled by unplug - skipping schedule check`)
                
                // Ensure root status is set to UNPLUG for display in table
                const rootStatus = deviceData.status
                if (rootStatus !== 'UNPLUG' && rootStatus !== 'unplug') {
                  await update(ref(realtimeDb, `devices/${outletKey}`), {
                    status: 'UNPLUG'
                  })
                  console.log(`ActiveDevice: Updated root status to UNPLUG for ${outletKey} (disabled_by_unplug is true)`)
                }
                
                // Ensure device stays off
                if (currentControlState !== 'off') {
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                }
                continue
              }
              
              // Check if main_status is 'ON' - if so, skip automatic scheduling (device is in bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`ActiveDevice: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic schedule control`)
                continue
              }
              
              // CRITICAL: Check schedule FIRST before checking device_control or limits
              // This prevents turning devices off unnecessarily when navigating to the page
              // Only check if device is past schedule end time (this is a hard cutoff)
              let shouldBeActiveBySchedule = false
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
                  console.log(`🔒 ActiveDevice: Device ${outletKey} is past schedule end time - FORCING OFF and locking main_status`)
                  
                  // Force device OFF
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: 'off'
                  })
                  
                  // Lock main_status to OFF to prevent any re-activation
                  await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                    main_status: 'OFF'
                  })
                  
                  console.log(`🔒 ActiveDevice: Device ${outletKey} LOCKED OFF - past schedule end time (current: ${Math.floor(currentTime / 60)}:${(currentTime % 60).toString().padStart(2, '0')}, end: ${Math.floor(endTime / 60)}:${(endTime % 60).toString().padStart(2, '0')})`)
                  continue
                }
                
                // Check if schedule says device should be active (but don't update yet - check limits first)
                shouldBeActiveBySchedule = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInAnyCombinedGroup)
              } else {
                // No schedule - device can be active
                shouldBeActiveBySchedule = true
              }
              
              // CRITICAL: Only respect device_control='off' if limits are actually exceeded
              // Don't turn device off just because device_control is 'off' - verify limits first
              if (isInAnyCombinedGroup && deviceDepartmentLimit?.device_control === 'off') {
                // Verify that limits are actually exceeded before turning device off
                // If schedule says device should be ON, check limits first
                if (shouldBeActiveBySchedule && currentControlState === 'on') {
                  // Schedule says ON and device is ON - verify limits before turning off
                  const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
                    ...deviceDepartmentLimit.limitInfo,
                    department: deviceDepartmentLimit.department
                  })
                  
                  if (monthlyLimitCheck.canTurnOn) {
                    // Limits are NOT exceeded - device_control='off' is stale, ignore it
                    console.log(`✅ ActiveDevice: Device ${outletKey} device_control='off' but limits are OK - ignoring stale device_control, schedule says ON`)
                    // Continue to normal schedule check below
                  } else {
                    // Limits ARE exceeded - respect device_control='off'
                    console.log(`🔒 ActiveDevice: Respecting ${deviceDepartmentLimit.department} combined_limit_settings/device_control='off' for ${outletKey} - limits exceeded`)
                    // Device is ON (we checked above), so turn it off
                    await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                      device: 'off'
                    })
                    if (currentMainStatus !== 'OFF') {
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                    }
                    continue
                  }
                } else {
                  // Schedule says OFF or device is already OFF - respect device_control='off'
                  console.log(`🔒 ActiveDevice: Respecting ${deviceDepartmentLimit.department} combined_limit_settings/device_control='off' for ${outletKey} (schedule says OFF or device already OFF)`)
                  if (currentControlState !== 'off' || currentMainStatus !== 'OFF') {
                    await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                      device: 'off'
                    })
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                  }
                  continue
                }
              }
              
              // CRITICAL: Check limits FIRST before any schedule logic
              // PRIORITY #1: Monthly limit check (for combined group devices)
              // PRIORITY #2: Combined monthly limit check (for combined group devices)
              // PRIORITY #3: Individual monthly limit check (for non-combined group devices)
              
              // IMPORTANT: Start with current state, don't default to 'off' before checking schedule
              // This prevents unnecessary turn-offs when the device is already in the correct state
              let newControlState = currentControlState // Start with current state, not 'off'
              let limitsExceeded = false
              
              // CRITICAL: Only check limits if we're trying to turn the device ON
              // If device is already OFF and limits are exceeded, don't change anything
              // This prevents unnecessary turn-offs when navigating to the page
              // HIERARCHY (same as Schedule.tsx):
              // PRIORITY #1: Combined monthly limit check (for devices in combined group) - ONLY check this, skip individual limit
              // PRIORITY #2: Individual monthly limit check (for devices NOT in combined group ONLY)
              if (currentControlState === 'on') {
                if (isInAnyCombinedGroup && deviceDepartmentLimit) {
                  // For devices in combined group: Check COMBINED monthly limit ONLY
                  // DO NOT check individual monthly limit if device is in combined group
                  const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
                    ...deviceDepartmentLimit.limitInfo,
                    department: deviceDepartmentLimit.department
                  })
                  if (!monthlyLimitCheck.canTurnOn) {
                    // CRITICAL: If combined monthly limit exceeded, FORCE OFF and skip schedule check entirely
                    limitsExceeded = true
                    newControlState = 'off'
                    console.log(`🔒 ActiveDevice: FORCING ${outletKey} OFF - COMBINED MONTHLY LIMIT EXCEEDED for department ${deviceDepartmentLimit.department} - SKIPPING SCHEDULE CHECK`)
                    
                    // Also check device_control - if it's 'off' due to monthly limit, enforce it
                    if (deviceDepartmentLimit.device_control === 'off') {
                      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                        device: 'off'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'OFF'
                      })
                      console.log(`🔒 ActiveDevice: Enforced device_control='off' for ${outletKey} due to combined monthly limit exceeded in department ${deviceDepartmentLimit.department}`)
                    }
                  } else {
                    // Combined monthly limit OK - device can stay ON
                    // IMPORTANT: Do NOT check individual monthly limit if device is in combined group
                    console.log(`✅ ActiveDevice: Combined monthly limit OK for ${outletKey} - skipping individual limit check (device is in combined group)`)
                  }
                } else {
                  // For devices NOT in combined group: Check individual monthly limit ONLY
                  const isMonthlyLimitExceeded = checkMonthlyLimit(deviceData)
                  if (isMonthlyLimitExceeded) {
                    limitsExceeded = true
                    newControlState = 'off' // Force OFF if monthly limit exceeded
                    console.log(`🔒 ActiveDevice: FORCING ${outletKey} OFF - INDIVIDUAL MONTHLY LIMIT EXCEEDED - SKIPPING SCHEDULE CHECK`)
                  }
                }
              } else {
                // Device is already OFF - don't check limits, just check schedule to see if it should turn ON
                console.log(`✅ ActiveDevice: Device ${outletKey} is already OFF - skipping limit check, will check schedule to see if it should turn ON`)
              }
              
              // ONLY check schedule if limits are NOT exceeded
              // IMPORTANT: Each device is processed independently - unplugged devices don't block others
              if (!limitsExceeded) {
                const shouldBeActive = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInAnyCombinedGroup)
                
                // CRITICAL: If device is already in the correct state, don't change anything
                // This prevents ActiveDevice.tsx from interfering with Schedule.tsx's decisions and unnecessary updates
                if (currentControlState === 'on' && shouldBeActive && currentMainStatus === 'ON') {
                  console.log(`✅ ActiveDevice: Device ${outletKey} is already ON (control='on', main_status='ON') and schedule confirms it should be ON - skipping update to avoid conflicts`)
                  continue
                }
                
                // CRITICAL: If device is already OFF and schedule says it should be OFF, don't change anything
                // This prevents unnecessary updates
                if (currentControlState === 'off' && !shouldBeActive && currentMainStatus === 'OFF') {
                  console.log(`✅ ActiveDevice: Device ${outletKey} is already OFF (control='off', main_status='OFF') and schedule confirms it should be OFF - skipping update`)
                  continue
                }
                
                newControlState = shouldBeActive ? 'on' : 'off'
                console.log(`✅ ActiveDevice: Limits OK for ${outletKey} - Schedule says: ${shouldBeActive ? 'ON' : 'OFF'}`)
              }
              
              console.log(`ActiveDevice: Final status determination for ${outletKey}:`, {
                limitsExceeded: limitsExceeded,
                finalDecision: newControlState,
                currentState: currentControlState,
                needsUpdate: currentControlState !== newControlState,
                isInAnyCombinedGroup: isInAnyCombinedGroup
              })
              
              // Only update if status needs to change
              if (currentControlState !== newControlState) {
                // FINAL SAFETY CHECK: Never turn ON a device if limits are exceeded
                // Re-check limits before turning ON to prevent race conditions
                if (newControlState === 'on') {
                  console.log(`🔍 ActiveDevice: FINAL SAFETY CHECK before turning ON ${outletKey}`)
                  
                  // Re-fetch latest device data
                  const latestDeviceRef = ref(realtimeDb, `devices/${outletKey}`)
                  const latestDeviceSnapshot = await get(latestDeviceRef)
                  const latestDeviceData = latestDeviceSnapshot.val()
                  
                  // Check if device is disabled by unplug
                  if (latestDeviceData?.schedule?.disabled_by_unplug === true) {
                    console.log(`🔒 ActiveDevice: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - device is disabled by unplug`)
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
                  const latestDeviceDept = (latestDeviceData?.office_info as any)?.department
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
                    // Device is in combined group - check COMBINED monthly limit ONLY
                    // DO NOT check individual monthly limit if device is in combined group
                    const finalMonthlyCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
                      ...latestDeviceDepartmentLimit.limitInfo,
                      department: latestDeviceDepartmentLimit.department
                    })
                    if (!finalMonthlyCheck.canTurnOn) {
                      console.log(`🔒 ActiveDevice: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - COMBINED MONTHLY LIMIT EXCEEDED for department ${latestDeviceDepartmentLimit.department}`)
                      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                        device: 'off'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'OFF'
                      })
                      console.log(`🔒 ActiveDevice: Set status='OFF' for ${outletKey} to prevent re-activation loop`)
                      continue
                    }
                    // Combined monthly limit OK - do NOT check individual limit (device is in combined group)
                    console.log(`✅ ActiveDevice: FINAL SAFETY CHECK - Combined monthly limit OK for ${outletKey} - skipping individual limit check (device is in combined group)`)
                  } else {
                    // Device is NOT in any combined group - check individual monthly limit ONLY
                    const finalDailyCheck = checkMonthlyLimit(latestDeviceData)
                    if (finalDailyCheck) {
                      console.log(`🔒 ActiveDevice: FINAL SAFETY CHECK - Preventing turn ON for ${outletKey} - INDIVIDUAL MONTHLY LIMIT EXCEEDED`)
                      await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                        device: 'off'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                        main_status: 'OFF'
                      })
                      await update(ref(realtimeDb, `devices/${outletKey}`), {
                        status: 'OFF'
                      })
                      console.log(`🔒 ActiveDevice: Set status='OFF' for ${outletKey} to prevent re-activation loop`)
                      continue
                    }
                  }
                  
                  console.log(`✅ ActiveDevice: FINAL SAFETY CHECK PASSED for ${outletKey} - All limits OK, proceeding with turn ON`)
                }
                
                console.log(`🔄 ActiveDevice: Real-time update: ${outletKey} control state from ${currentControlState} to ${newControlState}`)
                
                // Update control.device only if it needs to change
                if (currentControlState !== newControlState) {
                  await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                    device: newControlState
                  })
                  console.log(`✅ ActiveDevice: Updated control.device from '${currentControlState}' to '${newControlState}' for ${outletKey}`)
                  
                  // CRITICAL: When automatically turning devices ON/OFF based on schedule, don't change main_status
                  // main_status should only be changed by manual user actions (bypass/override), not by automatic scheduler
                  // Only update main_status when turning OFF due to limits (to prevent re-activation)
                  if (newControlState === 'off' && limitsExceeded && currentMainStatus !== 'OFF') {
                    // CRITICAL: When turning OFF due to limits, set main_status to 'OFF' to prevent re-activation
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                    console.log(`🔒 ActiveDevice: Set main_status to 'OFF' for ${outletKey} to prevent re-activation (limits exceeded)`)
                    
                    // Also set status='OFF' to prevent re-activation loop
                    await update(ref(realtimeDb, `devices/${outletKey}`), {
                      status: 'OFF'
                    })
                    console.log(`🔒 ActiveDevice: Set status='OFF' for ${outletKey} to prevent re-activation loop`)
                  } else if (newControlState === 'on') {
                    // IMPORTANT: When automatically turning ON based on schedule, do NOT set main_status to 'ON'
                    // Leave main_status as is - it should only be changed by manual user actions
                    console.log(`✅ ActiveDevice: Turned ON ${outletKey} based on schedule - leaving main_status unchanged (${currentMainStatus})`)
                  } else if (newControlState === 'off' && currentMainStatus !== 'OFF') {
                    // When turning OFF based on schedule (not limits), set main_status to 'OFF' to prevent re-activation
                    await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
                      main_status: 'OFF'
                    })
                    console.log(`🔒 ActiveDevice: Set main_status to 'OFF' for ${outletKey} to prevent re-activation (schedule-based turn-off)`)
                  } else {
                    console.log(`✅ ActiveDevice: main_status already correct (${currentMainStatus}) for ${outletKey} - no update needed`)
                  }
                } else {
                  console.log(`✅ ActiveDevice: Device ${outletKey} already in correct state - no updates needed`)
                }
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
            
            // Check if main_status is 'ON' - if so, skip automatic power limit enforcement (device is in bypass mode)
            if (currentMainStatus === 'ON') {
              console.log(`ActiveDevice: Device ${outletKey} main_status is ON - respecting bypass mode, skipping automatic power limit enforcement`)
              continue
            }
            
            // Check if device is in a combined group (check all departments)
            const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
            const outletDisplayName = outletKey.replace('_', ' ')
            
            // Find which department this device belongs to and if it's in that department's combined limit
            let deviceDepartmentLimit: { department: string; limitInfo: any } | null = null
            
            // First, get the device's department
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
                  deviceDepartmentLimit = {
                    department: deviceDeptKey,
                    limitInfo: deptLimitInfo
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
                    deviceDepartmentLimit = {
                      department: deptKey,
                      limitInfo: typedDeptLimitInfo
                    }
                    break
                  }
                }
              }
            }
            
            // Also check old combined limit structure for backward compatibility
            const isInOldCombinedGroup = combinedLimitInfo?.enabled && 
                                       combinedLimitInfo?.selectedOutlets?.some((selectedOutlet: string) => {
                                         const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                                         return normalizedSelected === normalizedOutletKey || 
                                                selectedOutlet === outletKey ||
                                                selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ')
                                       })
            
            const isInAnyCombinedGroup = !!deviceDepartmentLimit || isInOldCombinedGroup
            
            // CRITICAL: Only check individual monthly limit if device is NOT in any combined group
            // For devices in combined groups, the monthly limit check handles the power limit enforcement
            // DO NOT check individual limit if device has combined limit for its department
            if (!isInAnyCombinedGroup) {
              console.log(`ActiveDevice: Device ${outletKey} main status is ${currentMainStatus} - checking individual power limits`)
              
              // Check if main_status is 'ON' - if so, skip individual power limit enforcement (device is in bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`ActiveDevice: Device ${outletKey} main_status is ON - respecting bypass mode, skipping individual power limit enforcement`)
                continue
              }
              
              // Check power limit
              const powerLimit = deviceData.relay_control?.auto_cutoff?.power_limit || 0
              
              if (powerLimit > 0) {
                // Calculate monthly energy consumption from daily_logs
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
                
                console.log(`ActiveDevice: Power limit check for ${outletKey}:`, {
                  powerLimit: `${(powerLimit * 1000)}W`,
                  totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000)}W`,
                  currentMonth: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
                  exceedsLimit: totalMonthlyEnergy >= powerLimit,
                  currentControlState: currentControlState,
                  isInAnyCombinedGroup: isInAnyCombinedGroup
                })
                
                // If monthly energy exceeds power limit, check for recent database activity before turning off
                if (totalMonthlyEnergy >= powerLimit) {
                  // Check for recent database activity to prevent turning off during data uploads
                  const currentTime = Date.now()
                  const lastEnergyUpdate = deviceActivity[outletKey]?.lastEnergyUpdate || 0
                  const timeSinceLastUpdate = currentTime - lastEnergyUpdate
                  
                  // If there's been database activity in the last 2 minutes, don't turn off automatically
                  const hasRecentActivity = timeSinceLastUpdate < 120000 // 2 minutes
                  
                  console.log(`ActiveDevice: POWER LIMIT EXCEEDED for ${outletKey}:`, {
                    totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(3)}W`,
                    powerLimit: `${(powerLimit * 1000)}W`,
                    timeSinceLastUpdate: `${Math.round(timeSinceLastUpdate / 1000)}s`,
                    hasRecentActivity: hasRecentActivity,
                    willTurnOff: !hasRecentActivity
                  })
                  
                  if (!hasRecentActivity) {
                    // Only turn off if there's no recent database activity
                    console.log(`ActiveDevice: Turning OFF ${outletKey} - no recent database activity`)
                    
                    // Only update control.device for automatic power limit enforcement - do NOT change main_status
                    await update(ref(realtimeDb, `devices/${outletKey}/control`), {
                      device: 'off'
                    })
                    
                    console.log(`ActiveDevice: Device ${outletKey} turned OFF due to power limit exceeded`)
                  } else {
                    console.log(`ActiveDevice: Keeping ${outletKey} ON - recent database activity detected (${Math.round(timeSinceLastUpdate / 1000)}s ago)`)
                  }
                  
                  // Note: Automatic power limit enforcement is not logged to avoid cluttering device logs
                }
              }
            } else {
              console.log(`ActiveDevice: Device ${outletKey} is in combined group - skipping individual monthly limit check (combined monthly limit takes precedence)`)
              
              // For devices in combined groups, also check if main_status is 'ON' (bypass mode)
              if (currentMainStatus === 'ON') {
                console.log(`ActiveDevice: Device ${outletKey} main_status is ON - respecting bypass mode, skipping combined group power limit enforcement`)
                continue
              }
              
              // Note: Monthly limit check is handled separately by checkMonthlyLimitAndTurnOffDevices() function
              // This prevents duplicate checks and ensures monthly limits are checked efficiently
            }
          }
        }
      } catch (error) {
        console.error('ActiveDevice: Error in power limit monitor:', error)
      }
    }
    
    // Monthly limit check function
    // IMPORTANT: This function only checks and enforces limits - it does NOT turn devices off unnecessarily
    // Devices are only turned off if limits are actually exceeded, not as a precaution
    const checkMonthlyLimitAndTurnOffDevices = async () => {
      try {
        // CRITICAL: Wait for combinedLimitInfo to be loaded before running
        if (!combinedLimitInfo) {
          console.log('⏳ ActiveDevice: Waiting for combinedLimitInfo to load before monthly limit check')
          return
        }
        
        const devicesRef = ref(realtimeDb, 'devices')
        const snapshot = await get(devicesRef)
        
        if (snapshot.exists()) {
          const devicesData = snapshot.val()
          await checkCombinedMonthlyLimit(devicesData, combinedLimitInfo)
        }
      } catch (error) {
        console.error('ActiveDevice: Error in monthly limit check:', error)
      }
    }
    
    // CRITICAL: Add delay before running schedulers to avoid conflicts with Schedule.tsx
    // This gives Schedule.tsx time to finish any updates before ActiveDevice.tsx starts
    const INITIAL_DELAY = 2000 // 2 seconds delay
    
    // Store interval IDs for cleanup
    let scheduleInterval: NodeJS.Timeout | null = null
    let powerLimitInterval: NodeJS.Timeout | null = null
    let monthlyLimitInterval: NodeJS.Timeout | null = null
    
    // Run functions after initial delay to avoid conflicts
    // IMPORTANT: Run schedule check FIRST, then limit checks
    // This ensures schedule is checked before limits, preventing unnecessary turn-offs
    const initialTimeout = setTimeout(() => {
      console.log('🔄 ActiveDevice: Starting schedulers after initial delay to avoid conflicts')
      
      // Run schedule check FIRST - this checks schedule before limits
      checkScheduleAndUpdateDevices()
      
      // Then run limit checks after a short delay to let schedule check complete
      setTimeout(() => {
        checkPowerLimitsAndTurnOffDevices()
        checkMonthlyLimitAndTurnOffDevices()
      }, 1000) // 1 second delay after schedule check
      
      // Set up intervals after initial delay
      scheduleInterval = setInterval(checkScheduleAndUpdateDevices, 10000) // 10 seconds
      powerLimitInterval = setInterval(checkPowerLimitsAndTurnOffDevices, 12000) // 12 seconds
      monthlyLimitInterval = setInterval(checkMonthlyLimitAndTurnOffDevices, 10000) // 10 seconds
    }, INITIAL_DELAY)
    
    // Add manual test function for debugging
    ;(window as any).testSchedule = checkScheduleAndUpdateDevices
    ;(window as any).testPowerLimits = checkPowerLimitsAndTurnOffDevices
    ;(window as any).testMonthlyLimits = checkMonthlyLimitAndTurnOffDevices
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
    
    // Cleanup intervals on unmount
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
  }, [allDepartmentCombinedLimits]) // CRITICAL: Re-run scheduler when allDepartmentCombinedLimits changes

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
                console.log(`ActiveDevice: Initialized basis for unplug detection on ${outletKey} (no schedule)`)
              } catch (error) {
                console.error(`ActiveDevice: Error initializing basis for ${outletKey}:`, error)
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
                console.log(`ActiveDevice: Initialized basis for unplug detection on ${outletKey} (with schedule)`)
              } catch (error) {
                console.error(`ActiveDevice: Error initializing basis for ${outletKey}:`, error)
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
                console.log(`🔌 ActiveDevice: PLUG DETECTED: ${outletKey} - timestamp changed from "${existing.lastTimestamp}" to "${sensorTimestamp}", resetting unplug state`)
                
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
                    console.log(`✅ ActiveDevice: RESET UNPLUG STATE: ${outletKey} - device plugged back in, disabled_by_unplug set to false, status reset to normal`)
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
                      console.log(`🔌 ActiveDevice: UNPLUG DETECTED: ${outletKey} - timestamp unchanged for 30+ seconds. Device turned OFF, schedule disabled, and root status set to UNPLUG.`)
                    }).catch(err => {
                      console.error(`ActiveDevice: Error disabling schedule or setting UNPLUG status for ${outletKey}:`, err)
                    })
                  }).catch(err => {
                    console.error(`ActiveDevice: Error turning off device ${outletKey}:`, err)
                  })
                }).catch(err => {
                  console.error(`ActiveDevice: Error marking ${outletKey} as unplugged:`, err)
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
        console.error('ActiveDevice: Error checking unplugged devices:', error)
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

  // Filter devices based on search query
  const filteredDevices = useMemo(() => {
    return activeDevices.filter(device =>
      device.outletName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      device.appliances.toLowerCase().includes(searchQuery.toLowerCase()) ||
      device.officeRoom.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [activeDevices, searchQuery])

  // Toggle device status (ON/OFF) - updates both relay status and main status
  // Shows bypass confirmation modal when restrictions exist
  const toggleDeviceStatus = async (deviceId: string, bypassConfirmed: boolean = false) => {
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

      const outletKey = device.outletName.replace(/\s+/g, '_').replace(/'/g, '')
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
        // Device is currently OFF, so we want to turn it ON
        if (bypassConfirmed) {
          // Bypass confirmed: turn on device regardless of restrictions
          console.log(`ActiveDevice: BYPASS CONFIRMED - Turning ON ${outletKey} - bypassing all validation checks`)
          newControlState = 'on'
          newMainStatus = 'ON'
        } else {
          // Check for restrictions and show bypass modal if needed
          console.log(`ActiveDevice: Checking restrictions for ${outletKey}`)
          // Get device data from Firebase to check today's energy consumption
          const deviceRef = ref(realtimeDb, `devices/${outletKey}`)
          const deviceSnapshot = await get(deviceRef)
          const deviceData = deviceSnapshot.val()
          
          // Check if device is in a combined group - find which department
          const outletDisplayName = outletKey.replace('_', ' ')
          const normalizedOutletKey = outletKey.replace(/_/g, ' ').toLowerCase().trim()
          
          // Find which department this device belongs to and if it's in that department's combined limit
          let deviceDepartmentLimit: { department: string; limitInfo: any; device_control?: string } | null = null
          
          // First, get the device's department
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
                       selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ') ||
                       selectedOutlet === outletDisplayName
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
                         selectedOutlet.replace(/_/g, ' ') === outletKey.replace(/_/g, ' ') ||
                         selectedOutlet === outletDisplayName
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
          
          // Also check old combined limit structure for backward compatibility
          const outletDisplayNameForToggle = outletKey.replace('_', ' ')
          const isInOldCombinedGroupForToggle = combinedLimitInfo?.enabled && 
                                               combinedLimitInfo?.selectedOutlets?.some((selectedOutlet: string) => {
                                                 const normalizedSelected = selectedOutlet.replace(/_/g, ' ').toLowerCase().trim()
                                                 const normalizedOutlet = outletDisplayNameForToggle.replace(/_/g, ' ').toLowerCase().trim()
                                                 return normalizedSelected === normalizedOutlet || 
                                                        selectedOutlet === outletDisplayNameForToggle ||
                                                        selectedOutlet.replace(/_/g, ' ') === outletDisplayNameForToggle.replace(/_/g, ' ')
                                               })
          
          const isInAnyCombinedGroupForToggle = !!deviceDepartmentLimit || isInOldCombinedGroupForToggle
          
          let hasRestrictions = false
          let restrictionReason = ''
          
          // Check individual monthly limit if device is NOT in any combined group
          if (!isInAnyCombinedGroupForToggle) {
            const powerLimit = deviceData?.relay_control?.auto_cutoff?.power_limit || 0
            
            // Check if device has no power limit set
            if (powerLimit <= 0) {
              hasRestrictions = true
              restrictionReason = 'No power limit set - device requires power limit configuration'
            }
            
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
            
            console.log(`Power limit check for ${outletKey}:`, {
              powerLimit: `${(powerLimit * 1000)}W`,
              totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000)}W`,
              currentMonth: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
              exceedsLimit: totalMonthlyEnergy >= powerLimit,
              isInAnyCombinedGroup: isInAnyCombinedGroupForToggle
            })
            
            // Check if monthly total energy consumption exceeds the power limit
            if (totalMonthlyEnergy >= powerLimit) {
              hasRestrictions = true
              restrictionReason = `Monthly power limit exceeded: ${(totalMonthlyEnergy * 1000).toFixed(0)}W / ${(powerLimit * 1000)}W`
            }
          } else if (deviceDepartmentLimit) {
            console.log(`ActiveDevice: Skipping individual monthly limit check for ${outletKey} - device is in combined group (combined monthly limit takes precedence)`)
            
            // CRITICAL: Check if device_control is "off" for combined group
            if (deviceDepartmentLimit.device_control === 'off') {
              hasRestrictions = true
              restrictionReason = `Combined group monthly limit exceeded for department ${deviceDepartmentLimit.department} - devices locked OFF`
              console.log(`🔒 ActiveDevice: Device ${outletKey} cannot turn ON - ${deviceDepartmentLimit.department} combined_limit_settings/device_control is OFF`)
            } else {
              // Check monthly limit for devices in combined groups
              const monthlyLimitCheck = await checkMonthlyLimitBeforeTurnOn(outletKey, {
                ...deviceDepartmentLimit.limitInfo,
                department: deviceDepartmentLimit.department
              })
              if (!monthlyLimitCheck.canTurnOn) {
                hasRestrictions = true
                restrictionReason = monthlyLimitCheck.reason || 'Monthly limit exceeded'
              }
            }
          }
          
          // Check if device is within its scheduled time
          if (deviceData.schedule && (deviceData.schedule.timeRange || deviceData.schedule.startTime)) {
            const isWithinSchedule = isDeviceActiveBySchedule(deviceData.schedule, 'on', deviceData, isInAnyCombinedGroupForToggle)
            if (!isWithinSchedule) {
              hasRestrictions = true
              const now = new Date()
              const schedule = deviceData.schedule
              
              if (schedule.timeRange && schedule.timeRange !== 'No schedule') {
                restrictionReason = `Outside scheduled time: ${schedule.timeRange} (Current: ${now.toLocaleTimeString()})`
              } else if (schedule.startTime && schedule.endTime) {
                restrictionReason = `Outside scheduled time: ${schedule.startTime} - ${schedule.endTime} (Current: ${now.toLocaleTimeString()})`
              } else {
                restrictionReason = 'Outside scheduled time'
              }
            }
          }
          
          // If restrictions exist, show bypass confirmation modal
          if (hasRestrictions) {
            setBypassModal({
              isOpen: true,
              device: device,
              reason: restrictionReason
            })
            // Clear loading state before returning
            setUpdatingDevices(prev => {
              const newSet = new Set(prev)
              newSet.delete(deviceId)
              return newSet
            })
            return
          }
          
          // No restrictions: turn on device normally
          // CRITICAL: Do NOT set main_status to 'ON' when turning ON normally
          // main_status should only be set to 'ON' when bypass is confirmed via the bypass modal
          // This ensures that automatic systems can still control the device
          newControlState = 'on'
          // Explicitly set main_status to 'OFF' so automatic systems can control it
          // Only bypass modal button should set main_status to 'ON'
          newMainStatus = 'OFF'
        }
      }
      
      console.log(`Toggling ${outletKey} from control:${currentControlState}/main:${currentMainStatus} to control:${newControlState}/main:${newMainStatus}`)
      
      // If setting device control to 'on', reset disabled_by_unplug and status from UNPLUG BEFORE updating
      if (newControlState === 'on') {
        // Reset disabled_by_unplug flag
        const scheduleRef = ref(realtimeDb, `devices/${outletKey}/schedule`)
        const scheduleSnapshot = await get(scheduleRef)
        const scheduleData = scheduleSnapshot.val() || {}
        
        if (scheduleData.disabled_by_unplug === true) {
          await update(scheduleRef, {
            disabled_by_unplug: false
          })
          console.log(`ActiveDevice: Reset disabled_by_unplug to false for ${outletKey}`)
        }
        
        // Reset status from UNPLUG to ON
        const deviceStatusRef = ref(realtimeDb, `devices/${outletKey}`)
        const deviceStatusSnapshot = await get(deviceStatusRef)
        const deviceStatusData = deviceStatusSnapshot.val()
        
        if (deviceStatusData?.status === 'UNPLUG' || deviceStatusData?.status === 'unplug') {
          await update(deviceStatusRef, {
            status: 'ON'
          })
          console.log(`ActiveDevice: Reset status from UNPLUG to ON for ${outletKey}`)
        } else {
          // Update status to ON if not already UNPLUG
          await update(deviceStatusRef, {
            status: 'ON'
          })
        }
      }
      
      // Update main status when turning ON/OFF
      // CRITICAL: main_status is only set to 'ON' when bypass is confirmed via bypass modal
      // When turning ON normally (no restrictions), main_status is set to 'OFF' so automatic systems can control it
      // When turning OFF, order doesn't matter
      if (newControlState === 'on') {
        // Turn ON: Update main_status, then control.device
        // If bypass was confirmed, main_status will be 'ON' (bypass mode)
        // If no restrictions, main_status will be 'OFF' (automatic systems can control)
        await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
          main_status: newMainStatus
        })
        
        await update(ref(realtimeDb, `devices/${outletKey}/control`), {
          device: newControlState
        })
      } else {
        // Turn OFF: Update both in parallel (order doesn't matter)
        await update(ref(realtimeDb, `devices/${outletKey}/control`), {
          device: newControlState
        })
        
        await update(ref(realtimeDb, `devices/${outletKey}/relay_control`), {
          main_status: newMainStatus
        })
      }
      
      // If turning off, also update status to OFF
      if (newControlState === 'off') {
        const deviceStatusRef = ref(realtimeDb, `devices/${outletKey}`)
        await update(deviceStatusRef, {
          status: 'OFF'
        })
      }
      
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
      'Idle': 'status-idle',
      'UNPLUG': 'status-unplug'
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

  // Success Modal Component - now memoized outside main component

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

  // Bypass Confirmation Modal Component - now memoized outside main component

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
                <th>MONTH ENERGY</th>
                <th>CURRENT (A)</th>
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
                        try {
                          if (!modalOpen) {
                            setModalOpen(true)
                            setHistoryModal({ isOpen: true, device })
                            // Data will be fetched by useEffect, but we can also fetch here for immediate response
                            fetchHistoryData(device, timeSegment)
                          }
                        } catch (error) {
                          console.error('Error opening history modal:', error)
                          // Still open the modal, useEffect will handle data fetching
                          setModalOpen(true)
                          setHistoryModal({ isOpen: true, device })
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
                  <td className="month-usage">{device.monthUsage || '0.000 W'}</td>
                  <td className="current-ampere">{device.currentAmpere}</td>
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
      <SuccessModal 
        successModal={successModal}
        setModalOpen={setModalOpen}
        setSuccessModal={setSuccessModal}
      />
      
      {/* Error Modal */}
      <ErrorModal />


      {/* Schedule Conflict Modal */}
      <ScheduleConflictModal />

      {/* Bypass Confirmation Modal */}
      <BypassModal 
        bypassModal={bypassModal}
        setModalOpen={setModalOpen}
        setBypassModal={setBypassModal}
        toggleDeviceStatus={toggleDeviceStatus}
        userRole={userRole}
      />

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
                  <span className="value">{formatNumber(((powerLimitModal.device as any)?.todayTotalEnergy * 1000) || 0)} W</span>
                </div>
                <div className="limit-stat">
                  <span className="label">Power Limit:</span>
                  <span className="value">{((powerLimitModal.device as any)?.powerLimit * 1000) || '0'} W</span>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="modal-icon history">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#dbeafe" stroke="#3b82f6" strokeWidth="2"/>
                    <polyline points="12,6 12,12 16,14" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <h3 style={{ margin: 0, marginTop: '-20px' }}>Outlet History</h3>
              </div>
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
                      try {
                        setTimeSegment('Day')
                        if (historyModal.device) {
                          fetchHistoryData(historyModal.device, 'Day')
                        }
                      } catch (error) {
                        console.error('Error setting Day filter:', error)
                      }
                    }}
                  >
                    Day
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Week' ? 'active' : ''}`} 
                    onClick={() => {
                      try {
                        setTimeSegment('Week')
                        if (historyModal.device) {
                          fetchHistoryData(historyModal.device, 'Week')
                        }
                      } catch (error) {
                        console.error('Error setting Week filter:', error)
                      }
                    }}
                  >
                    Week
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Month' ? 'active' : ''}`} 
                    onClick={() => {
                      try {
                        setTimeSegment('Month')
                        if (historyModal.device) {
                          fetchHistoryData(historyModal.device, 'Month')
                        }
                      } catch (error) {
                        console.error('Error setting Month filter:', error)
                      }
                    }}
                  >
                    Month
                  </button>
                  <button 
                    className={`segment-btn ${timeSegment === 'Year' ? 'active' : ''}`} 
                    onClick={() => {
                      try {
                        setTimeSegment('Year')
                        if (historyModal.device) {
                          fetchHistoryData(historyModal.device, 'Year')
                        }
                      } catch (error) {
                        console.error('Error setting Year filter:', error)
                      }
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
                    <div className="summary-value">{formatNumber(historyData.totalEnergy * 1000)} W</div>
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
                      <th>Energy (W)</th>
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


