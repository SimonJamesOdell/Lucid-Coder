import React from 'react';
import GoalsPanel from './GoalsPanel';

const GoalsModal = ({ isOpen, onClose }) => {
  return <GoalsPanel mode="modal" isOpen={isOpen} onRequestClose={onClose} />;
};

export default GoalsModal;
