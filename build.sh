#!/bin/bash

npm run build; npx cap copy; npx cap sync; cd android/; ./gradlew assembleDebug; adb install -r app/build/outputs/apk/debug/app-debug.apk; cd ..
