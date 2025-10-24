import { ref, push, get } from 'firebase/database';
import { realtimeDb, auth } from '../firebase/config';

export interface DeviceLogEntry {
  user: string;
  activity: string;
  officeRoom: string;
  outletSource: string;
  applianceConnected: string;
  timestamp: string;
  userId?: string;
  userRole?: string;
}

/**
 * Logs device activity to the database
 * @param activity - The activity being performed
 * @param outletSource - The outlet/source identifier
 * @param officeRoom - The office/room location
 * @param applianceConnected - The connected appliance
 * @param user - The user performing the action (optional, will try to get from auth)
 */
export const logDeviceActivity = async (
  activity: string,
  outletSource: string,
  officeRoom: string,
  applianceConnected: string,
  user?: string
): Promise<void> => {
  try {
    // Get current user info if not provided
    let currentUser = user;
    let currentUserId = '';
    let currentUserRole = '';

    if (!currentUser) {
      // Try to get current user from Firebase Auth first
      if (auth.currentUser) {
        currentUser = auth.currentUser.displayName || auth.currentUser.email || 'Authenticated User';
        currentUserId = auth.currentUser.uid;
        currentUserRole = 'user';
      } else {
        // Fallback to localStorage
        const userData = localStorage.getItem('currentUser');
        if (userData) {
          const parsedUser = JSON.parse(userData);
          currentUser = parsedUser.displayName || parsedUser.email || 'Unknown User';
          currentUserId = parsedUser.uid || '';
          currentUserRole = parsedUser.role || 'Coordinator';
        } else {
          currentUser = 'Unknown User';
          currentUserRole = 'unknown';
        }
      }
    }

    // Get device info from database to ensure we have the latest data
    const deviceRef = ref(realtimeDb, `devices/${outletSource.replace(' ', '_')}`);
    const deviceSnapshot = await get(deviceRef);
    
    let finalOfficeRoom = officeRoom;
    let finalAppliance = applianceConnected;
    
    if (deviceSnapshot.exists()) {
      const deviceData = deviceSnapshot.val();
      finalOfficeRoom = deviceData.office_info?.office_room || officeRoom;
      finalAppliance = deviceData.appliances || applianceConnected;
    }

    const logEntry: DeviceLogEntry = {
      user: currentUser,
      activity,
      officeRoom: finalOfficeRoom,
      outletSource,
      applianceConnected: finalAppliance,
      timestamp: new Date().toISOString(),
      userId: currentUserId,
      userRole: currentUserRole
    };

    // Push to device_logs in Firebase
    const logsRef = ref(realtimeDb, 'device_logs');
    await push(logsRef, logEntry);

    console.log('✅ Device activity logged:', logEntry);
  } catch (error) {
    console.error('❌ Error logging device activity:', error);
  }
};

/**
 * Logs combined limit activities
 */
export const logCombinedLimitActivity = async (
  activity: 'Set combined limit' | 'Edit combined limit' | 'Remove combined limit' | 'Disable combined limit',
  selectedOutlets: string[],
  combinedLimit: number | string,
  user?: string
): Promise<void> => {
  try {
    console.log('🔍 LOGGING COMBINED LIMIT ACTIVITY:', {
      activity,
      selectedOutlets,
      combinedLimit,
      user
    });
    
    // Create shorter outlet list (e.g., "Outlet1 to 5" instead of full list)
    let outletList = '';
    if (selectedOutlets.length === 1) {
      outletList = selectedOutlets[0].replace('Outlet ', 'Outlet');
    } else if (selectedOutlets.length > 1) {
      // Extract numbers and create range
      const numbers = selectedOutlets.map(outlet => outlet.replace('Outlet ', '')).sort((a, b) => parseInt(a) - parseInt(b));
      if (numbers.length > 1) {
        outletList = `Outlet${numbers[0]} to ${numbers[numbers.length - 1]}`;
      } else {
        outletList = selectedOutlets.join(', ').replace('Outlet ', 'Outlet');
      }
    }
    
    // Shorten activity name
    const shortActivity = activity.replace('combined limit', 'Monthly Limit');
    
    console.log('🔍 FINAL LOGGING DATA:', {
      shortActivity,
      outletList,
      user
    });
    
    await logDeviceActivity(
      `${shortActivity} (${outletList})`,
      'Multiple Outlets',
      'System',
      'Combined Group',
      user
    );
    
    console.log('✅ COMBINED LIMIT ACTIVITY LOGGED SUCCESSFULLY');
  } catch (error) {
    console.error('❌ Error logging combined limit activity:', error);
  }
};

/**
 * Logs individual device limit activities
 */
export const logIndividualLimitActivity = async (
  activity: 'Set individual limit' | 'Edit individual limit' | 'Remove individual limit',
  outletSource: string,
  limit: number | string,
  officeRoom: string,
  appliance: string,
  user?: string
): Promise<void> => {
  try {
    const limitText = limit === 'No Limit' || limit === 0 ? 'No Limit' : `${limit}Wh`;
    
    await logDeviceActivity(
      `${activity} - ${limitText}`,
      outletSource,
      officeRoom,
      appliance,
      user
    );
  } catch (error) {
    console.error('❌ Error logging individual limit activity:', error);
  }
};

/**
 * Logs schedule activities
 */
export const logScheduleActivity = async (
  activity: 'Set schedule' | 'Edit schedule' | 'Remove schedule' | 'Enable scheduling' | 'Disable scheduling',
  outletSource: string,
  scheduleDetails: string,
  officeRoom: string,
  appliance: string,
  user?: string
): Promise<void> => {
  try {
    await logDeviceActivity(
      `${activity} - ${scheduleDetails}`,
      outletSource,
      officeRoom,
      appliance,
      user
    );
  } catch (error) {
    console.error('❌ Error logging schedule activity:', error);
  }
};

/**
 * Logs device control activities (turn on/off)
 */
export const logDeviceControlActivity = async (
  action: 'Turn on outlet' | 'Turn off outlet',
  outletSource: string,
  officeRoom: string,
  appliance: string,
  user?: string
): Promise<void> => {
  try {
    await logDeviceActivity(
      action,
      outletSource,
      officeRoom,
      appliance,
      user
    );
  } catch (error) {
    console.error('❌ Error logging device control activity:', error);
  }
};

/**
 * Logs automatic system activities
 */
export const logSystemActivity = async (
  activity: string,
  outletSource: string,
  officeRoom: string,
  appliance: string,
  reason?: string
): Promise<void> => {
  try {
    const fullActivity = reason ? `${activity} (${reason})` : activity;
    
    await logDeviceActivity(
      fullActivity,
      outletSource,
      officeRoom,
      appliance,
      'System'
    );
  } catch (error) {
    console.error('❌ Error logging system activity:', error);
  }
};
