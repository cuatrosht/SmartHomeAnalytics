# Energy Unit Analysis: Wh vs W

## Summary
**You should use "Wh" (watt-hours) for energy consumption and "W" (watts) for power.**

## Understanding the Difference

### W (Watts) - Power
- **What it is**: Instantaneous rate of energy consumption
- **When to use**: Current power, average power, peak power, power limits
- **Example**: "The device is consuming 100W right now"

### Wh (Watt-hours) - Energy
- **What it is**: Total amount of energy consumed over time
- **When to use**: Total energy, daily consumption, monthly consumption, lifetime energy
- **Example**: "The device consumed 2.160 Wh today"

## How Your System Works

### Arduino Code (Data Source)
From `arduino_code_with_usage_tracking.ino`:
- **Line 414**: `deltaEnergy = (power * deltaHours) / 1000.0` → Calculates energy in **kWh**
- **Line 436**: Stores `total_energy` in **kWh** (kilowatt-hours)
- **Line 437**: Stores `avg_power` in **W** (watts)
- **Line 404**: Reads `power` in **W** (watts)

### Database Storage
- `total_energy`: Stored in **kWh** (kilowatt-hours)
- `lifetime_energy`: Stored in **kWh** (kilowatt-hours)
- `avg_power`: Stored in **W** (watts)
- `peak_power`: Stored in **W** (watts)
- `power`: Stored in **W** (watts)

### Frontend Display (Current Issues)
Your code converts kWh to Wh for display (multiply by 1000), which is correct, but the unit labels are inconsistent.

## Correct Usage Guide

### ✅ Use "Wh" (Watt-hours) for:
1. **Total Energy Consumption**
   - `total_energy` (after converting from kWh: `total_energy * 1000`)
   - `lifetime_energy` (after converting from kWh)
   - Monthly consumption
   - Daily consumption
   - Today's consumption

2. **Energy Limits** (when they represent energy consumption limits)
   - Monthly energy limits
   - Combined energy limits

### ✅ Use "W" (Watts) for:
1. **Power Values**
   - `avg_power` (average power)
   - `peak_power` (peak power)
   - `power` (current/instantaneous power)

2. **Power Limits** (when they represent power limits, not energy limits)
   - Note: Your system uses "power_limit" but it's actually an **energy limit** in kWh, so when displayed it should be "Wh"

## Issues Found in Your Code

### ❌ Incorrect: Using "W" for Energy Values

1. **Line 504-505** (Dashboard.tsx):
   ```typescript
   totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000).toFixed(3)}W`,  // ❌ Should be "Wh"
   powerLimit: `${(powerLimit * 1000)}W`,  // ❌ Should be "Wh" (it's an energy limit)
   ```

2. **Line 830** (Dashboard.tsx):
   ```typescript
   totalEnergy: `${(totalLifetimeEnergy * 1000).toFixed(3)} W`,  // ❌ Should be "Wh"
   ```

3. **Line 1365-1366** (Dashboard.tsx):
   ```typescript
   totalMonthlyEnergy: `${totalMonthlyEnergy.toFixed(3)}W`,  // ❌ Should be "Wh"
   combinedLimitWatts: `${combinedLimitWatts}W`,  // ❌ Should be "Wh"
   ```

4. **Line 2449-2450** (Dashboard.tsx):
   ```typescript
   powerLimit: `${(powerLimit * 1000)}W`,  // ❌ Should be "Wh"
   totalMonthlyEnergy: `${(totalMonthlyEnergy * 1000)}W`,  // ❌ Should be "Wh"
   ```

5. **Line 5219** (Dashboard.tsx):
   ```typescript
   return `Energy Usage: ${formatNumber(value)} W`  // ❌ Should be "Wh"
   ```

### ⚠️ Incorrect Comment

**Line 890** (Dashboard.tsx):
```typescript
const avgPower = todayLogs.avg_power || 0 // Average power in Wh  // ❌ Should say "W"
```

## Recommendations

### 1. Fix All Energy Displays to Use "Wh"
Replace all instances where energy values (after converting from kWh) are displayed with "W" to use "Wh" instead.

### 2. Keep Power Values as "W"
Keep all power-related values (`avg_power`, `peak_power`, `current_power`) as "W".

### 3. Clarify Power Limits vs Energy Limits
Your `power_limit` field actually stores **energy limits** in kWh. Consider:
- Renaming to `energy_limit` for clarity, OR
- Always displaying as "Wh" when converted for display

## Quick Reference

| Data Type | Database Unit | Display Unit | Example |
|-----------|--------------|--------------|---------|
| `total_energy` | kWh | **Wh** | "2.160 Wh" |
| `lifetime_energy` | kWh | **Wh** | "113.870 Wh" |
| Monthly consumption | kWh | **Wh** | "9.770 Wh" |
| Daily consumption | kWh | **Wh** | "2.160 Wh" |
| `avg_power` | W | **W** | "100 W" |
| `peak_power` | W | **W** | "150 W" |
| `power` (current) | W | **W** | "95 W" |
| `power_limit` (energy limit) | kWh | **Wh** | "1000 Wh" |

## Conclusion

**Use "Wh" for all energy consumption values and "W" for all power values.**

The main issue is that energy values (which are in kWh in the database and converted to Wh for display) are incorrectly labeled as "W" in many places. These should all be "Wh".


