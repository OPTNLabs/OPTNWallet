#!/bin/bash

# Exit on any error
set -e

# Define paths and variables
APP_PATH=$(pwd)
ANDROID_PROJECT_PATH="$APP_PATH/android"
APK_PATH="$ANDROID_PROJECT_PATH/app/build/outputs/apk/debug/app-debug.apk"
DEVICE_ID=$(adb devices | grep -v "List" | grep -v "^$" | awk '{print $1}')

# Function to check if ADB (Android Debug Bridge) is available
check_adb() {
  if ! command -v adb &> /dev/null; then
    echo "ADB is not installed. Please install Android SDK Platform Tools."
    exit 1
  fi
}

# Function to check if Gradle is installed
check_gradle() {
  if ! command -v gradle &> /dev/null; then
    echo "Gradle is not installed. Please install Gradle."
    exit 1
  fi
}

# Function to sync Capacitor with Android
capacitor_sync() {
  echo "Syncing Capacitor with Android..."
  npx cap sync android
}

# Function to build the Android APK
build_apk() {
  echo "Building APK..."
  cd "$ANDROID_PROJECT_PATH"
  gradle assembleDebug
}

# Function to install the APK on the connected device
install_apk() {
  echo "Installing APK on the device..."
  adb -s $DEVICE_ID install -r "$APK_PATH"
  echo "APK installed successfully."
}

# Check for device connection
check_device() {
  if [ -z "$DEVICE_ID" ]; then
    echo "No Android device connected. Please connect your device and enable USB debugging."
    exit 1
  fi
}

# Main script execution
check_adb
check_gradle
check_device
capacitor_sync
build_apk
install_apk

echo "Build and installation completed!"
