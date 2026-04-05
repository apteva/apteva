#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BINARY_NAME = os.platform() === 'win32' ? 'apteva.exe' : 'apteva';
const BINARY_PATH = path.join(__dirname, BINARY_NAME);

// Check if Go binary exists
if (!fs.existsSync(BINARY_PATH)) {
  console.log('Building apteva...');
  try {
    execSync('go build -o ' + BINARY_NAME + ' .', {
      cwd: __dirname,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Failed to build apteva. Make sure Go is installed.');
    console.error('Install Go: https://go.dev/dl/');
    process.exit(1);
  }
}

// Run the binary, passing through all args and stdio
const child = spawn(BINARY_PATH, process.argv.slice(2), {
  stdio: 'inherit',
  cwd: process.cwd(),
});

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => {
  console.error('Failed to start apteva:', err.message);
  process.exit(1);
});
