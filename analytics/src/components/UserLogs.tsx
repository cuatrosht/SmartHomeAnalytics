import React from 'react'
import './UserManagment.css'

type Props = { onBack?: () => void }

const UserLogs: React.FC<Props> = ({ onBack }) => {
  return (
    <div className="user-management">
      <div className="um-header">
        <div className="um-header-left">
          <div className="um-user-info">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 3v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>User Logs</span>
          </div>
        </div>
        <div className="um-header-right">
          <button className="um-logs-btn" onClick={onBack}>Back</button>
        </div>
      </div>

      <div className="um-content">
        <div className="um-content-header">
          <h2>Recent Activity</h2>
          <div className="um-controls">
            <div className="um-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
                <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <input type="text" placeholder="Search logs..." />
            </div>
          </div>
        </div>

        <div className="um-table-container">
          <table className="um-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Activity</th>
                <th>Office/ Room</th>
                <th>Outlet/ Source</th>
                <th>Appliance Connected</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>John Karl Portugal</td>
                <td>Edit schedule</td>
                <td>Laboratory 1</td>
                <td>Outlet 1</td>
                <td>Aircon</td>
              </tr>
              <tr>
                <td>John Karl Portugal</td>
                <td>Turn off appliance</td>
                <td>Dean's office</td>
                <td>Outlet 2</td>
                <td>Printer</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default UserLogs



