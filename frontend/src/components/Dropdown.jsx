import React, { useState, useRef, useEffect } from 'react';
import './Dropdown.css';

const Dropdown = ({ title, children, disabled = false, className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleToggle = () => {
    if (!disabled) {
      setIsOpen(!isOpen);
    }
  };

  const handleItemClick = () => {
    setIsOpen(false);
  };

  return (
    <div 
      className={`dropdown ${className} ${disabled ? 'disabled' : ''}`} 
      ref={dropdownRef}
    >
      <button 
        className="dropdown-trigger"
        onClick={handleToggle}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        {title}
        <span className={`dropdown-arrow ${isOpen ? 'open' : ''}`}>▼</span>
      </button>
      
      {isOpen && !disabled && (
        <div className="dropdown-menu" onClick={handleItemClick}>
          {children}
        </div>
      )}
    </div>
  );
};

export const DropdownItem = ({ children, onClick, disabled = false, className = '' }) => (
  <button 
    className={`dropdown-item ${className} ${disabled ? 'disabled' : ''}`}
    onClick={onClick}
    disabled={disabled}
  >
    {children}
  </button>
);

export const DropdownDivider = () => (
  <div className="dropdown-divider"></div>
);

export const DropdownLabel = ({ children, className = '' }) => (
  <div className={`dropdown-label ${className}`}>
    {children}
  </div>
);

export default Dropdown;