import React from 'react';

const CompatibilitySection = ({
  compatibilityStatus,
  compatibilityPlan,
  compatibilityChanges,
  compatibilityConsent,
  setCompatibilityConsent,
  structureConsent,
  setStructureConsent
}) => {
  return (
    <div className="form-section">
      <h3>Compatibility updates</h3>
      <p>
        LucidCoder can update the imported project so the dev server binds to 0.0.0.0 and
        works over the network.
      </p>
      <div className="tech-detect-status">
        {compatibilityStatus.isLoading && <span>Scanning for required changes…</span>}
        {!compatibilityStatus.isLoading && compatibilityStatus.error && (
          <span>{compatibilityStatus.error}</span>
        )}
        {!compatibilityStatus.isLoading && !compatibilityStatus.error && compatibilityPlan && (
          compatibilityChanges.length > 0 ? (
            <ul>
              {compatibilityChanges.map((change, index) => (
                <li key={`${change.key || 'change'}-${index}`}>{change.description}</li>
              ))}
            </ul>
          ) : (
            <span>No compatibility changes required.</span>
          )
        )}
        {!compatibilityStatus.isLoading && !compatibilityStatus.error && compatibilityPlan?.structure?.needsMove && (
          <p>Frontend files will be moved into a frontend/ folder.</p>
        )}
      </div>
      <div className="radio-group">
        <label className={`radio-card ${compatibilityConsent ? 'selected' : ''}`}>
          <input
            type="checkbox"
            checked={compatibilityConsent}
            onChange={(event) => setCompatibilityConsent(event.target.checked)}
            disabled={compatibilityStatus.isLoading}
          />
          <div>
            <div className="radio-title">Allow compatibility updates</div>
            <div className="radio-subtitle">
              LucidCoder may edit project files to make the dev server accessible on your network.
            </div>
          </div>
        </label>
        <label className={`radio-card ${structureConsent ? 'selected' : ''}`}>
          <input
            type="checkbox"
            checked={structureConsent}
            onChange={(event) => setStructureConsent(event.target.checked)}
            disabled={compatibilityStatus.isLoading}
          />
          <div>
            <div className="radio-title">Move frontend files into a frontend folder</div>
            <div className="radio-subtitle">
              If the project is frontend-only, LucidCoder can move root files into frontend/.
            </div>
          </div>
        </label>
      </div>
    </div>
  );
};

export default CompatibilitySection;
