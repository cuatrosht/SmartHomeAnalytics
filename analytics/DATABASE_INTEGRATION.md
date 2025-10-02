# Database Integration & Relay Control Hierarchy

## Overview

The Analytics System has been updated to integrate with Firebase Realtime Database and implement a comprehensive relay control hierarchy. This system now provides real-time monitoring and control of connected devices with automatic status management based on schedules, power limits, and manual controls.

## Database Structure

The system connects to Firebase Realtime Database at:
```
https://bastaproject-328c8-default-rtdb.firebaseio.com/
```

### Device Data Structure

Each device follows this structure:
```json
{
  "devices": {
    "Outlet_1": {
      "daily_logs": {
        "day_2025_08_12": {
          "avg_power": 287.5,
          "peak_power": 850.4,
          "total_energy": 3.275
        }
      },
      "office_info": {
        "assigned_date": "2025-08-25T13:26:21.698Z",
        "office": "computer-lab-2"
      },
      "relay_control": {
        "auto_cutoff": {
          "enabled": true,
          "power_limit": 310
        },
        "status": "OFF",
        "main_status": "OFF"
      },
      "schedule": {
        "endTime": "17:30",
        "frequency": "Weekdays",
        "startTime": "08:48",
        "timeRange": "8:48 AM - 5:30 PM"
      },
      "sensor_data": {
        "current": 1.25,
        "power": 120,
        "voltage": 220
      }
    }
  }
}
```

## Relay Control Hierarchy

The system implements a three-tier control hierarchy:

### 1. Main Status (Highest Priority)
- **Purpose**: Master control switch for each device
- **Location**: `relay_control.main_status`
- **Values**: `"ON"` or `"OFF"`
- **Behavior**: 
  - When OFF, device is completely disabled regardless of other settings
  - When ON, device can be active regardless of schedule restrictions or power limit violations
  - Provides manual override capability for emergency or special situations

### 2. Relay Status (Medium Priority)
- **Purpose**: Physical relay control and schedule enforcement
- **Location**: `relay_control.status`
- **Values**: `"ON"` or `"OFF"`
- **Behavior**: Controls the actual power relay and follows schedule rules

### 3. Auto Cutoff (Lowest Priority)
- **Purpose**: Safety mechanism for power limit enforcement
- **Location**: `relay_control.auto_cutoff`
- **Behavior**: Automatically disables device when power consumption exceeds limits

## Component Integration

### ActiveDevice.tsx
- **Real-time Database Connection**: Uses Firebase `onValue` listener for live updates
- **Status Determination**: Automatically calculates device status based on main status, relay status, and power usage
- **Action Toggle**: Updates both `relay_control.status` and `relay_control.main_status` in database
- **Real-time Updates**: UI automatically reflects database changes without manual refresh

### SetUp.tsx
- **Device Management**: Full CRUD operations with database integration
- **Power Limit Configuration**: Updates `relay_control.auto_cutoff.power_limit`
- **Status Control**: Updates both relay and main status when editing devices
- **Real-time Monitoring**: Automatic status updates based on power consumption and limits

### Schedule.tsx
- **Schedule Management**: Creates and manages device schedules
- **Automatic Control**: Updates relay and main status based on schedule rules
- **Real-time Enforcement**: Automatically enables/disables devices based on current time and schedule

## Status Logic

### Device Status Calculation
```typescript
const getAutomaticStatus = (powerUsage: number, powerLimit: number, mainStatus: string, relayStatus: string): 'Active' | 'Inactive' => {
  // 1. Check main status (highest priority)
  if (mainStatus === 'OFF') return 'Inactive'
  
  // 2. Check relay status
  if (relayStatus === 'OFF') return 'Inactive'
  
  // 3. Check power consumption (main status ON can override)
  if (powerUsage === 0) return 'Active' // Main status ON overrides no power consumption
  
  // 4. Main status ON overrides all power limit restrictions
  // Device shows as Active regardless of power consumption when main status is ON
  return 'Active'
}
```

### Schedule-Aware Status
```typescript
const isDeviceActiveBySchedule = (schedule: any, relayStatus: string): boolean => {
  // If no schedule, use relay status
  if (!schedule) return relayStatus === 'ON'
  
  // If relay is OFF, device is inactive
  if (relayStatus !== 'ON') return false
  
  // Check if current time is within schedule
  const now = new Date()
  const currentTime = now.getHours() * 60 + now.getMinutes()
  const currentDay = now.getDay()
  
  // Parse schedule times and check conditions
  // ... schedule logic implementation
}
```

## Real-time Features

### Automatic Updates
- **Power Consumption**: Real-time monitoring of current power usage
- **Status Changes**: Automatic status updates based on power limits and schedules
- **Schedule Enforcement**: Devices automatically enable/disable based on time and day
- **Safety Features**: Automatic cutoff when power limits are exceeded

### Main Status Override System
- **Manual Control Priority**: Main status ON overrides all automated restrictions
- **Schedule Bypass**: Devices can be active outside scheduled times when main status is ON
- **Power Limit Override**: Power limit violations are ignored when main status is ON
- **Emergency Control**: Provides immediate manual control regardless of automated settings
- **Real-time Override**: Changes take effect immediately across all components
- **Simplified Status**: Devices only show as Active or Inactive (Warning status removed)

### Manual Controls
- **Toggle Switch**: Manual ON/OFF control that updates both relay and main status
- **Schedule Override**: Manual control can override schedule restrictions
- **Power Limit Management**: Real-time power limit configuration and monitoring

## Usage Examples

### Adding a New Device
1. Navigate to SetUp component
2. Click "Add Device"
3. Select available outlet
4. Choose office location
5. Set power limit
6. Device automatically appears in ActiveDevice with real-time monitoring

### Setting Device Schedule
1. Navigate to Schedule component
2. Click "Set Schedule" for desired device
3. Set start and end times
4. Choose frequency (Daily, Weekdays, Weekends, or custom days)
5. Schedule automatically controls device power based on time

### Manual Device Control
1. Navigate to ActiveDevice component
2. Use toggle switch to turn device ON/OFF
3. **Main Status Override**: When turned ON, device bypasses schedule restrictions and power limit violations
4. Status automatically updates in real-time
5. All components reflect the change immediately
6. **Emergency Override**: Main status ON provides emergency control regardless of automated restrictions

### Schedule Component Integration
- **Database-based Status**: Schedule component now uses the same status determination logic as ActiveDevice
- **Real-time Updates**: Uses Firebase listeners for live status changes
- **Schedule Enforcement**: Only applies when main status is OFF
- **Manual Override**: Main status ON bypasses all schedule restrictions
- **Consistent Status**: Uses same 'Active'/'Inactive' status across all components
- **Status Calculation**: Based on relay_control.main_status, relay_control.status, and power usage data

## Testing

### Firebase Connection Test
Run the test script to verify database connectivity:
```bash
cd analytics
node test-firebase.js
```

### Real-time Monitoring Test
1. Open ActiveDevice component
2. Toggle a device ON/OFF
3. Verify status updates in real-time
4. Check database reflects changes immediately

## Error Handling

### Database Connection Issues
- Automatic retry mechanisms
- Graceful fallback to offline mode
- User-friendly error messages

### Data Validation
- Input validation for all user inputs
- Power limit range checking
- Schedule time validation
- Office assignment validation

## Performance Considerations

### Real-time Listeners
- Efficient Firebase listeners with proper cleanup
- Debounced updates to prevent excessive database calls
- Optimized data fetching with minimal payload

### Status Updates
- Smart status calculation to prevent unnecessary updates
- Batch updates when possible
- Efficient re-rendering with React state management

## Security

### Database Rules
- Firebase security rules protect data integrity
- User authentication for sensitive operations
- Rate limiting for API calls

### Data Validation
- Server-side validation of all inputs
- Sanitization of user data
- Protection against malicious inputs

## Future Enhancements

### Planned Features
- **User Authentication**: Secure login system
- **Role-based Access**: Different permission levels
- **Advanced Analytics**: Historical data analysis
- **Mobile App**: Native mobile application
- **API Integration**: Third-party system integration

### Scalability
- **Device Limits**: Support for hundreds of devices
- **Real-time Performance**: Optimized for high-frequency updates
- **Data Archiving**: Long-term data storage and retrieval
