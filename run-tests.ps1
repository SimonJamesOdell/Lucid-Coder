#!/usr/bin/env pwsh

# LucidCoder Test Runner
# Runs comprehensive tests for both frontend and backend

param(
    [switch]$ForceInstall
)

Write-Host "🧪 LucidCoder Test Suite" -ForegroundColor Cyan
Write-Host "=========================" -ForegroundColor Cyan

$ErrorActionPreference = "Continue"
$backendSuccess = $true
$frontendSuccess = $true

function Ensure-Dependencies {
    param(
        [string]$Label
    )

    if ($ForceInstall -or -not (Test-Path -Path "node_modules")) {
        Write-Host "Installing $Label test dependencies..." -ForegroundColor Gray
        npm install --silent --no-audit --no-fund
        return ($LASTEXITCODE -eq 0)
    }

    Write-Host "Skipping $Label dependency install (node_modules present)" -ForegroundColor Gray
    return $true
}

# Backend Tests
Write-Host "`n🔧 Running Backend Tests..." -ForegroundColor Yellow
Push-Location backend

if (-not (Ensure-Dependencies -Label "backend")) {
    Write-Host "❌ Backend dependency installation failed" -ForegroundColor Red
    $backendSuccess = $false
} else {
    Write-Host "✅ Backend dependencies installed" -ForegroundColor Green
    
    Write-Host "Running backend tests..." -ForegroundColor Gray
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Backend tests failed" -ForegroundColor Red
        $backendSuccess = $false
    } else {
        Write-Host "✅ Backend tests passed" -ForegroundColor Green
    }
}

Pop-Location

# Frontend Tests
Write-Host "`n⚛️ Running Frontend Tests..." -ForegroundColor Yellow
Push-Location frontend

if (-not (Ensure-Dependencies -Label "frontend")) {
    Write-Host "❌ Frontend dependency installation failed" -ForegroundColor Red
    $frontendSuccess = $false
} else {
    Write-Host "✅ Frontend dependencies installed" -ForegroundColor Green
    
    Write-Host "Running frontend tests..." -ForegroundColor Gray
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Frontend tests failed" -ForegroundColor Red
        $frontendSuccess = $false
    } else {
        Write-Host "✅ Frontend tests passed" -ForegroundColor Green
    }
}

Pop-Location

# Summary
Write-Host "`n📊 Test Summary" -ForegroundColor Cyan
Write-Host "===============" -ForegroundColor Cyan

if ($backendSuccess) {
    Write-Host "✅ Backend Tests: PASSED" -ForegroundColor Green
} else {
    Write-Host "❌ Backend Tests: FAILED" -ForegroundColor Red
}

if ($frontendSuccess) {
    Write-Host "✅ Frontend Tests: PASSED" -ForegroundColor Green  
} else {
    Write-Host "❌ Frontend Tests: FAILED" -ForegroundColor Red
}

if ($backendSuccess -and $frontendSuccess) {
    Write-Host "`n🎉 All tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n💥 Some tests failed!" -ForegroundColor Red
    exit 1
}