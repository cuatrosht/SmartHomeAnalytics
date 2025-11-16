import React, { useState, useEffect, useRef } from 'react';
import { ref, onValue, off, update, remove, get } from 'firebase/database';
import { realtimeDb } from '../firebase/config';
import { logDeviceActivity } from '../utils/deviceLogging';
import { auth } from '../firebase/config';
import './UserManagment.css';

// REMOVED: Helper functions for automatic scheduling - no longer needed
// getDepartmentCombinedLimitPath, calculateCombinedMonthlyEnergy, and removeDeviceFromCombinedGroup were removed

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
  // REMOVED: combinedLimitInfo and allDepartmentCombinedLimits state variables - no longer needed for automatic scheduling
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

  // REMOVED: Real-time scheduler - no longer needed for automatic scheduling

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

  // REMOVED: Real-time listener for combined limit info - no longer needed for automatic scheduling

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

  // REMOVED: isDeviceActiveBySchedule function - no longer needed for automatic scheduling

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

