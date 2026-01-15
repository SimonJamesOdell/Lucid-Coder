#!/usr/bin/env pwsh

# LucidCoder Coverage Reporter
# Generates comprehensive coverage reports for both frontend and backend

Write-Host 'LucidCoder Coverage Report' -ForegroundColor Cyan
Write-Host '=============================' -ForegroundColor Cyan

# Backend Coverage
Write-Host ''
Write-Host 'Generating Backend Coverage...' -ForegroundColor Yellow
Push-Location backend

npm run test:coverage
if ($LASTEXITCODE -eq 0) {
    Write-Host 'Backend coverage generated: backend/coverage/index.html' -ForegroundColor Green
} else {
    Write-Host 'Backend coverage generation failed' -ForegroundColor Red
}

Pop-Location

# Frontend Coverage  
Write-Host ''
Write-Host 'Generating Frontend Coverage...' -ForegroundColor Yellow
Push-Location frontend

npm run test:coverage
if ($LASTEXITCODE -eq 0) {
    Write-Host 'Frontend coverage generated: frontend/coverage/index.html' -ForegroundColor Green
} else {
    Write-Host 'Frontend coverage generation failed' -ForegroundColor Red
}

Pop-Location

Write-Host ''
Write-Host 'Coverage reports complete!' -ForegroundColor Green
Write-Host 'Backend: backend/coverage/index.html' -ForegroundColor Gray
Write-Host 'Frontend: frontend/coverage/index.html' -ForegroundColor Gray