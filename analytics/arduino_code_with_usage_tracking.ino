#include <WiFi.h>
#include <FirebaseESP32.h>
#include <PZEM004Tv30.h>
#include <NTPClient.h>
#include <WiFiUdp.h>
#include <Preferences.h>

// ====== DEVICE CONFIGURATION ======
#define DEVICE_ID "Outlet_1" 

// ====== WIFI CREDENTIALS ======
const char* ssid = "Converge_2GHz_9cDFyk";
const char* password = "HNUtu6x7";

// ====== FIREBASE CONFIG ======
#define FIREBASE_HOST "https://bastaproject-328c8-default-rtdb.firebaseio.com/"
#define FIREBASE_AUTH "6aHHW2GOb6p1bR57CqBKK5RrpUMlAKp7tZnWZd3a"

// ====== HARDWARE PINS ======
#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17
#define RELAY_PIN 5
#define LED_RED 25
#define LED_GREEN 26
#define LED_YELLOW 27
#define BATTERY_MONITOR_PIN 34

// ====== GLOBAL OBJECTS ======
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
HardwareSerial PZEMSerial(2);
PZEM004Tv30 pzem(PZEMSerial, PZEM_RX_PIN, PZEM_TX_PIN);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 28800, 60000); // UTC+8 for Philippines
Preferences preferences;

// ====== GLOBAL VARIABLES ======
bool deviceOn = false;
float batteryVoltage = 0.0;
float accumulatedEnergy = 0.0;
float lifetimeEnergy = 0.0;
float maxPowerToday = 0.0;
float sumPowerReadings = 0.0;
int powerReadingCount = 0;
unsigned long lastMillis = 0;
String currentDay = "";

// ====== USAGE TIME TRACKING ======
unsigned long deviceOnTime = 0;           // Total time device was ON today (milliseconds)
unsigned long deviceOffTime = 0;          // Total time device was OFF today (milliseconds)
unsigned long lastDeviceStateChange = 0;  // Last time device state changed
bool lastDeviceState = false;             // Previous device state

// ====== BATTERY MONITORING ======
unsigned long lastBatteryCheck = 0;
const unsigned long BATTERY_CHECK_INTERVAL = 30000;
unsigned long lowBatteryBlinkTime = 0;
bool lowBatteryAlert = false;
bool redLedState = false;

// ====== SCHEDULE TRACKING ======
unsigned long lastScheduleCheck = 0;
const unsigned long SCHEDULE_CHECK_INTERVAL = 10000;
unsigned long lastSecondCheck = 0;
const unsigned long SECOND_CHECK_INTERVAL = 1000;
bool scheduleActive = false;
String lastStartTime = "";
String lastEndTime = "";
String lastFrequency = "";

// ====== BATTERY THRESHOLDS ======
const float BATTERY_LOW = 3.5;
const float BATTERY_CRITICAL = 3.2;
const float BATTERY_FULL = 4.2;

void setup() {
  Serial.begin(115200);
  Serial.println("🚀 Initializing: " + String(DEVICE_ID));
  
  // Initialize storage
  preferences.begin("energy-monitor", false);
  loadPersistentData();

  // Initialize hardware
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(BATTERY_MONITOR_PIN, INPUT);
  
  digitalWrite(LED_RED, LOW);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(RELAY_PIN, HIGH);

  // Connect to WiFi
  connectToWiFi();

  // Initialize services
  config.host = FIREBASE_HOST;
  config.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  PZEMSerial.begin(9600, SERIAL_8N1, PZEM_RX_PIN, PZEM_TX_PIN);
  timeClient.begin();
  timeClient.update();

  updateCurrentDay();
  initializeFirebasePaths();
  
  Serial.println("✅ Setup complete: " + String(DEVICE_ID));
}

void loadPersistentData() {
  String prefix = String(DEVICE_ID) + "_";
  accumulatedEnergy = preferences.getFloat((prefix + "daily_energy").c_str(), 0.0);
  lifetimeEnergy = preferences.getFloat((prefix + "lifetime_energy").c_str(), 0.0);
  maxPowerToday = preferences.getFloat((prefix + "max_power").c_str(), 0.0);
  currentDay = preferences.getString((prefix + "current_day").c_str(), "");
  
  // Load usage time tracking data
  deviceOnTime = preferences.getULong((prefix + "device_on_time").c_str(), 0);
  deviceOffTime = preferences.getULong((prefix + "device_off_time").c_str(), 0);
}

void savePersistentData() {
  String prefix = String(DEVICE_ID) + "_";
  preferences.putFloat((prefix + "daily_energy").c_str(), accumulatedEnergy);
  preferences.putFloat((prefix + "lifetime_energy").c_str(), lifetimeEnergy);
  preferences.putFloat((prefix + "max_power").c_str(), maxPowerToday);
  preferences.putString((prefix + "current_day").c_str(), currentDay);
  
  // Save usage time tracking data
  preferences.putULong((prefix + "device_on_time").c_str(), deviceOnTime);
  preferences.putULong((prefix + "device_off_time").c_str(), deviceOffTime);
}

void connectToWiFi() {
  WiFi.begin(ssid, password);
  Serial.print("📶 Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_RED, !digitalRead(LED_RED));
  }
  Serial.println(" Connected!");
  digitalWrite(LED_RED, LOW);
}

void updateCurrentDay() {
  // Force NTP update to get accurate time
  if (!timeClient.update()) {
    Serial.println("⚠️ Failed to update NTP time");
    return;
  }
  
  time_t epochTime = timeClient.getEpochTime();
  
  // Use local time instead of GMT
  struct tm *ptm = localtime((time_t *)&epochTime);
  if (ptm == NULL) {
    Serial.println("⚠️ Failed to get local time");
    return;
  }
  
  char dateBuffer[15];
  sprintf(dateBuffer, "day_%04d_%02d_%02d", ptm->tm_year + 1900, ptm->tm_mon + 1, ptm->tm_mday);
  String today = String(dateBuffer);

  // Debug logging
  Serial.println("🕐 Current time: " + String(timeClient.getFormattedTime()) + " | Date: " + today);

  if (today != currentDay && currentDay != "") {
    Serial.println("📅 New day detected: " + currentDay + " → " + today);
    Serial.println("🔄 Resetting daily data...");
    
    // Save previous day's data before reset
    savePersistentData();
    
    // Reset daily counters
    accumulatedEnergy = 0.0;
    maxPowerToday = 0.0;
    sumPowerReadings = 0.0;
    powerReadingCount = 0;
    
    // Reset usage time tracking
    deviceOnTime = 0;
    deviceOffTime = 0;
    lastDeviceStateChange = 0;
    lastDeviceState = false;
    
    Serial.println("✅ Daily data reset complete");
  }
  currentDay = today;
}

void initializeFirebasePaths() {
  String basePath = "/devices/" + String(DEVICE_ID);
  if (!Firebase.getString(fbdo, basePath + "/control/device")) {
    Firebase.setString(fbdo, basePath + "/control/device", "off");
  }
  if (!Firebase.getString(fbdo, basePath + "/schedule/startTime")) {
    Firebase.setString(fbdo, basePath + "/schedule/startTime", "00:00");
  }
  if (!Firebase.getString(fbdo, basePath + "/schedule/endTime")) {
    Firebase.setString(fbdo, basePath + "/schedule/endTime", "00:00");
  }
  if (!Firebase.getString(fbdo, basePath + "/schedule/frequency")) {
    Firebase.setString(fbdo, basePath + "/schedule/frequency", "");
  }
}

float readBatteryVoltage() {
  int analogValue = analogRead(BATTERY_MONITOR_PIN);
  return (analogValue / 4095.0) * 3.3 * 2;
}

void checkBattery() {
  unsigned long currentMillis = millis();
  if (currentMillis - lastBatteryCheck >= BATTERY_CHECK_INTERVAL) {
    lastBatteryCheck = currentMillis;
    batteryVoltage = readBatteryVoltage();
    
    Firebase.setFloat(fbdo, "/devices/" + String(DEVICE_ID) + "/battery/voltage", batteryVoltage);
    Firebase.setInt(fbdo, "/devices/" + String(DEVICE_ID) + "/battery/percentage", calculateBatteryPercentage(batteryVoltage));
    
    if (batteryVoltage < BATTERY_CRITICAL) {
      Serial.println("🔴 CRITICAL BATTERY! Shutting down...");
      emergencyShutdown();
    } else if (batteryVoltage < BATTERY_LOW) {
      lowBatteryAlert = true;
      Serial.println("🟡 LOW BATTERY: " + String(batteryVoltage) + "V");
    } else {
      lowBatteryAlert = false;
    }
  }
  
  if (lowBatteryAlert) {
    if (currentMillis - lowBatteryBlinkTime >= 500) {
      lowBatteryBlinkTime = currentMillis;
      redLedState = !redLedState;
      digitalWrite(LED_RED, redLedState);
    }
  }
}

int calculateBatteryPercentage(float voltage) {
  if (voltage >= BATTERY_FULL) return 100;
  if (voltage <= 3.0) return 0;
  return (int)((voltage - 3.0) / (BATTERY_FULL - 3.0) * 100);
}

void emergencyShutdown() {
  deviceOn = false;
  digitalWrite(RELAY_PIN, HIGH);
  Firebase.setString(fbdo, "/devices/" + String(DEVICE_ID) + "/control/device", "off");
  savePersistentData();
  delay(2000);
  esp_deep_sleep_start();
}

void updateLEDStatus() {
  digitalWrite(LED_RED, LOW);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_YELLOW, LOW);
  
  if (lowBatteryAlert) return;
  
  if (batteryVoltage < BATTERY_LOW) {
    digitalWrite(LED_RED, HIGH);
  } else if (deviceOn) {
    digitalWrite(LED_GREEN, HIGH);
  } else {
    digitalWrite(LED_YELLOW, HIGH);
  }
}

int timeToMinutes(String timeStr) {
  int colonIndex = timeStr.indexOf(':');
  if (colonIndex == -1) return -1;
  int hours = timeStr.substring(0, colonIndex).toInt();
  int minutes = timeStr.substring(colonIndex + 1).toInt();
  return hours * 60 + minutes;
}

bool isDaySelected(String frequency, int dayOfWeek) {
  if (frequency == "") return false;
  frequency.toLowerCase();
  String days[] = {"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"};
  String currentDayName = days[dayOfWeek];
  
  if (frequency == "weekdays" || frequency == "weekday") return (dayOfWeek >= 1 && dayOfWeek <= 5);
  if (frequency == "weekends" || frequency == "weekend") return (dayOfWeek == 0 || dayOfWeek == 6);
  if (frequency == "everyday" || frequency == "daily") return true;
  return frequency.indexOf(currentDayName) != -1;
}

void checkSchedule() {
  unsigned long currentMillis = millis();
  if (currentMillis - lastScheduleCheck >= SCHEDULE_CHECK_INTERVAL) {
    lastScheduleCheck = currentMillis;
    checkScheduleSettings();
  }
  if (currentMillis - lastSecondCheck >= SECOND_CHECK_INTERVAL) {
    lastSecondCheck = currentMillis;
    applySchedulePrecisely();
  }
}

void checkScheduleSettings() {
  String basePath = "/devices/" + String(DEVICE_ID);
  String startTime = "", endTime = "", frequency = "";
  
  if (Firebase.getString(fbdo, basePath + "/schedule/startTime")) startTime = fbdo.stringData();
  if (Firebase.getString(fbdo, basePath + "/schedule/endTime")) endTime = fbdo.stringData();
  if (Firebase.getString(fbdo, basePath + "/schedule/frequency")) frequency = fbdo.stringData();
  
  if (startTime != lastStartTime || endTime != lastEndTime || frequency != lastFrequency) {
    lastStartTime = startTime;
    lastEndTime = endTime;
    lastFrequency = frequency;
    scheduleActive = false;
  }
}

void applySchedulePrecisely() {
  if (lastStartTime == "" || lastEndTime == "" || lastFrequency == "") return;
  
  // Force NTP update for accurate time
  if (!timeClient.update()) {
    Serial.println("⚠️ Failed to update NTP time for schedule");
    return;
  }
  
  int currentHour = timeClient.getHours();
  int currentMinute = timeClient.getMinutes();
  int currentSecond = timeClient.getSeconds();
  int currentMinutes = currentHour * 60 + currentMinute;
  int dayOfWeek = timeClient.getDay();
  
  int startMinutes = timeToMinutes(lastStartTime);
  int endMinutes = timeToMinutes(lastEndTime);
  
  if (startMinutes < 0 || endMinutes < 0 || !isDaySelected(lastFrequency, dayOfWeek)) {
    if (scheduleActive) scheduleActive = false;
    return;
  }
  
  bool atStartTime = (currentMinutes == startMinutes && currentSecond <= 2);
  bool atEndTime = (currentMinutes == endMinutes && currentSecond <= 2);
  
  bool shouldBeOn = false;
  if (startMinutes < endMinutes) {
    shouldBeOn = (currentMinutes >= startMinutes && currentMinutes < endMinutes);
  } else {
    shouldBeOn = (currentMinutes >= startMinutes || currentMinutes < endMinutes);
  }
  
  if ((shouldBeOn && !deviceOn) || atStartTime) {
    deviceOn = true;
    digitalWrite(RELAY_PIN, LOW);
    Firebase.setString(fbdo, "/devices/" + String(DEVICE_ID) + "/control/device", "on");
    Serial.println("⏰ SCHEDULE: Device ON");
  } else if ((!shouldBeOn && deviceOn) || atEndTime) {
    deviceOn = false;
    digitalWrite(RELAY_PIN, HIGH);
    Firebase.setString(fbdo, "/devices/" + String(DEVICE_ID) + "/control/device", "off");
    Serial.println("⏰ SCHEDULE: Device OFF");
  }
}

// ====== NEW FUNCTION: TRACK DEVICE USAGE TIME ======
void trackDeviceUsageTime() {
  unsigned long currentTime = millis();
  
  if (lastDeviceStateChange > 0) {
    unsigned long timeDiff = currentTime - lastDeviceStateChange;
    
    if (lastDeviceState) {
      // Device was ON, add to ON time
      deviceOnTime += timeDiff;
    } else {
      // Device was OFF, add to OFF time
      deviceOffTime += timeDiff;
    }
  }
  
  // Update state tracking
  if (deviceOn != lastDeviceState) {
    lastDeviceStateChange = currentTime;
    lastDeviceState = deviceOn;
  }
}

void updateDeviceData() {
  String basePath = "/devices/" + String(DEVICE_ID);
  String dailyPath = basePath + "/daily_logs/" + currentDay;

  // Read sensor data
  float voltage = pzem.voltage();
  float current = pzem.current();
  float power = pzem.power();
  float frequency = pzem.frequency();
  float pf = pzem.pf();

  // Energy calculation
  unsigned long now = millis();
  float deltaHours = (lastMillis > 0) ? (now - lastMillis) / 3600000.0 : 0;
  lastMillis = now;

  if (deviceOn && power >= 0 && deltaHours > 0) {
    float deltaEnergy = (power * deltaHours) / 1000.0;
    accumulatedEnergy += deltaEnergy;
    lifetimeEnergy += deltaEnergy;
    if (power > maxPowerToday) maxPowerToday = power;
    sumPowerReadings += power;
    powerReadingCount++;
    if (now % 60000 < 1000) savePersistentData();
  }

  // Calculate usage time in hours and minutes
  float usageTimeHours = deviceOnTime / 3600000.0;  // Convert ms to hours
  float usageTimeMinutes = deviceOnTime / 60000.0;  // Convert ms to minutes

  // Upload to Firebase
  float avgPower = (powerReadingCount > 0) ? sumPowerReadings / powerReadingCount : 0;
  Firebase.setFloat(fbdo, basePath + "/sensor_data/voltage", voltage);
  Firebase.setFloat(fbdo, basePath + "/sensor_data/current", current);
  Firebase.setFloat(fbdo, basePath + "/sensor_data/power", power);
  Firebase.setFloat(fbdo, basePath + "/sensor_data/frequency", frequency);
  Firebase.setFloat(fbdo, basePath + "/sensor_data/power_factor", pf);
  
  // Daily logs with usage time
  Firebase.setFloat(fbdo, dailyPath + "/total_energy", accumulatedEnergy);
  Firebase.setFloat(fbdo, dailyPath + "/avg_power", avgPower);
  Firebase.setFloat(fbdo, dailyPath + "/peak_power", maxPowerToday);
  Firebase.setFloat(fbdo, dailyPath + "/usage_time_hours", usageTimeHours);      // NEW
  Firebase.setFloat(fbdo, dailyPath + "/usage_time_minutes", usageTimeMinutes);  // NEW
  
  Firebase.setFloat(fbdo, basePath + "/lifetime_energy", lifetimeEnergy);
  Firebase.setString(fbdo, basePath + "/sensor_data/timestamp", String(timeClient.getEpochTime()));

  // Update overall consumption
  updateOverallConsumption(power, accumulatedEnergy, deviceOn);
}

void updateOverallConsumption(float currentPower, float dailyEnergy, bool isActive) {
  String deviceNum = String(DEVICE_ID).substring(7);
  Firebase.setFloat(fbdo, "/overall/device_" + deviceNum + "/current_power", currentPower);
  Firebase.setFloat(fbdo, "/overall/device_" + deviceNum + "/daily_energy", dailyEnergy);
  Firebase.setBool(fbdo, "/overall/device_" + deviceNum + "/active", isActive);
  Firebase.setString(fbdo, "/overall/device_" + deviceNum + "/last_updated", String(timeClient.getEpochTime()));
}

void loop() {
  // Update time less frequently to avoid NTP server overload
  static unsigned long lastTimeUpdate = 0;
  if (millis() - lastTimeUpdate > 30000) { // Update every 30 seconds
    timeClient.update();
    lastTimeUpdate = millis();
  }
  
  updateCurrentDay();
  checkBattery();
  checkSchedule();
  trackDeviceUsageTime();
  
  // Read device control
  if (Firebase.getString(fbdo, "/devices/" + String(DEVICE_ID) + "/control/device")) {
    String state = fbdo.stringData().toLowerCase();
    if (state == "on" && !deviceOn && !scheduleActive) {
      deviceOn = true;
      digitalWrite(RELAY_PIN, LOW);
    } else if (state == "off" && deviceOn && !scheduleActive) {
      deviceOn = false;
      digitalWrite(RELAY_PIN, HIGH);
    }
  }

  updateDeviceData();
  if (!lowBatteryAlert) updateLEDStatus();
  
  delay(1000);
}
